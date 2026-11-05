import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { build, type Loader, type Plugin } from 'esbuild';
import { renderStudio, StudioError, type StudioElement } from '@mohassan/studio';
import { snapshotHash, type SandboxRunInput } from '@mohassan/sandbox';
import type { SandboxTestResult } from '@mohassan/contracts';
import { checkReactSnapshot, instrumentReactSnapshot, reactSourceHash, type ReactStudioSnapshot } from './source.ts';

const require = createRequire(import.meta.url);
const maximumHtmlBytes = 44_000;
const maximumBundleBytes = 480_000;
const hashPattern = /^[a-f0-9]{64}$/;

export interface ReactStudioVerification {
  provider: string;
  sourceHash: string;
  snapshotHash: string;
  network: 'denied';
  isolation: 'appcontainer'|'microvm';
  isolationVerified: true;
  durationMs: number;
}
export interface ReactStudioArtifact {
  sourceHash: string;
  html: string;
  css: string;
  elements: StudioElement[];
  warnings: string[];
  verification: ReactStudioVerification;
}
export interface ReactStudioSandbox {
  available(): Promise<{available:boolean;provider:string|null;message:string}>;
  run(input: SandboxRunInput): Promise<SandboxTestResult>;
}

function fault(code: string, message: string, statusCode = 400): StudioError {
  return new StudioError(code, message, statusCode);
}

function projectModule(files: Map<string, string>, importer: string, requested: string): string {
  if (!requested.startsWith('./') && !requested.startsWith('../')) throw fault('REACT_IMPORT_UNSUPPORTED', 'المعاينة تقبل استيرادات المشروع المحلية وReact فقط.');
  if (requested.includes('\\') || /[:?#%\0]/.test(requested)) throw fault('REACT_IMPORT_UNSUPPORTED', 'مسار الاستيراد غير مدعوم في المعاينة.');
  const path = posix.normalize(posix.join(posix.dirname(importer), requested));
  if (path.startsWith('../') || path === '..' || path.startsWith('/')) throw fault('REACT_IMPORT_OUTSIDE_SNAPSHOT', 'الاستيراد خارج ملفات نسخة المراجعة.');
  const candidates = [path, ...['.tsx', '.jsx', '.ts', '.js', '.mjs', '.css'].map(extension => path + extension), ...['.tsx', '.jsx', '.ts', '.js', '.mjs'].map(extension => `${path}/index${extension}`)];
  // TypeScript source commonly imports its eventual emitted .js module name.
  if (/\.js$/.test(path)) candidates.push(path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx');
  const found = candidates.find(candidate => files.has(candidate) && /\.(?:tsx|jsx|ts|js|mjs|css)$/.test(candidate));
  if (!found) throw fault('REACT_LOCAL_IMPORT_MISSING', 'تعذر العثور على ملف استيراد داخل نسخة المشروع.');
  return found;
}

function insideRoot(root: string, path: string): boolean {
  const portion = relative(root, path);
  return portion === '' || portion !== '..' && !portion.startsWith('..' + sep) && !isAbsolute(portion);
}

/** Compiles virtual source files only. esbuild parses code here; project modules are never imported or evaluated by this process. */
async function compileReact(snapshot: ReactStudioSnapshot, instrumented: ReturnType<typeof instrumentReactSnapshot>): Promise<string> {
  const files = new Map(instrumented.files.map(file => [file.path, file.content]));
  const reactRoot = dirname(require.resolve('react/package.json'));
  const domRoot = dirname(require.resolve('react-dom/package.json'));
  const trustedModules = new Map<string, string>([
    ['react', require.resolve('react')], ['react/jsx-runtime', require.resolve('react/jsx-runtime')],
    ['react/jsx-dev-runtime', require.resolve('react/jsx-dev-runtime')], ['react-dom/server', require.resolve('react-dom/server')],
  ]);
  const localLayout = snapshot.framework === 'next'
    ? ['.tsx', '.jsx', '.ts', '.js'].map(extension => posix.join(posix.dirname(snapshot.entryPath), 'layout' + extension)).find(path => files.has(path))
    : undefined;
  const wrapper = `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import App from 'studio-project:${snapshot.entryPath}';${localLayout ? `import Layout from 'studio-project:${localLayout}';` : ''}export function render(){const page=React.createElement(App);return renderToStaticMarkup(${localLayout ? 'React.createElement(Layout,null,page)' : 'page'});}`;
  let specificFault: StudioError | undefined;
  const plugin: Plugin = {
    name: 'mohassan-trusted-react-inputs',
    setup(builder) {
      builder.onResolve({filter:/.*/}, args => {
        try {
          if (args.kind === 'entry-point' && args.path === 'studio-wrapper') return {path:'studio-wrapper',namespace:'studio-wrapper'};
          if (args.namespace === 'studio-wrapper') {
            if (args.path.startsWith('studio-project:')) return {path:args.path.slice('studio-project:'.length),namespace:'studio-project'};
            const trusted = trustedModules.get(args.path);
            if (trusted) return {path:trusted,namespace:'file'};
            throw fault('REACT_IMPORT_UNSUPPORTED', 'استيراد غير مسموح في مشغّل المعاينة.');
          }
          if (args.namespace === 'studio-project') {
            if (['react','react/jsx-runtime','react/jsx-dev-runtime'].includes(args.path)) return {path:trustedModules.get(args.path)!,namespace:'file'};
            return {path:projectModule(files,args.importer,args.path),namespace:'studio-project'};
          }
          // Only trusted React code is in the file namespace. Its own Node builtins
          // resolve normally and run later within AppContainer, never on the host.
          if (args.namespace === 'file' && (!insideRoot(reactRoot, args.importer) && !insideRoot(domRoot, args.importer))) throw fault('REACT_TRUSTED_RUNTIME_MISMATCH', 'تعذر إثبات مكتبات تشغيل المعاينة.');
          return undefined;
        } catch (error) {
          specificFault = error instanceof StudioError ? error : fault('REACT_BUILD_FAILED', 'تعذر تجميع ملفات React المحددة.');
          return {errors:[{text:specificFault.message}]};
        }
      });
      builder.onLoad({filter:/.*/,namespace:'studio-wrapper'}, () => ({contents:wrapper,loader:'js'}));
      builder.onLoad({filter:/.*/,namespace:'studio-project'}, args => {
        const content = files.get(args.path);
        if (content === undefined) return {errors:[{text:'ملف المعاينة غير موجود.'}]};
        if (/\.css$/.test(args.path)) return {contents:'',loader:'js'};
        const extension = args.path.split('.').pop()!;
        return {contents:content,loader:(extension === 'mjs' ? 'js' : extension) as Loader};
      });
      builder.onLoad({filter:/.*/,namespace:'file'}, async args => {
        if (!insideRoot(reactRoot,args.path) && !insideRoot(domRoot,args.path)) return {errors:[{text:'مكتبة تشغيل خارج النطاق الموثوق.'}]};
        return {contents:await readFile(args.path,'utf8'),loader:'js'};
      });
    },
  };
  try {
    const bundled = await build({entryPoints:['studio-wrapper'],plugins:[plugin],bundle:true,write:false,platform:'node',format:'cjs',target:'node24',minify:true,legalComments:'none',logLevel:'silent',jsx:'automatic',tsconfigRaw:{compilerOptions:{jsx:'react-jsx',experimentalDecorators:false}},define:{'process.env.NODE_ENV':'"production"'},charset:'utf8',treeShaking:true,packages:'bundle'});
    if (bundled.outputFiles.length !== 1) throw fault('REACT_BUILD_FAILED', 'تعذر إنتاج ملف معاينة واحد محدود.');
    const code = bundled.outputFiles[0]!.text;
    if (Buffer.byteLength(code) > maximumBundleBytes) throw fault('REACT_BUNDLE_TOO_LARGE', 'تجاوزت حزمة React حد المعاينة المعزولة.');
    return code;
  } catch (error) {
    if (specificFault) throw specificFault;
    if (error instanceof StudioError) throw error;
    throw fault('REACT_BUILD_FAILED', 'تعذر تجميع React. تحقق من الصياغة والاستيرادات المدعومة.');
  }
}

function validateReceipt(receipt: SandboxTestResult, input: SandboxRunInput, provider: string) {
  if (!receipt || receipt.provider !== provider || receipt.network !== 'denied' || receipt.isolation !== 'appcontainer'
    || receipt.isolationVerified !== true || receipt.snapshotHash !== snapshotHash(input.files)
    || !Number.isFinite(receipt.durationMs) || receipt.durationMs < 0) throw fault('REACT_RENDER_UNVERIFIED', 'لم يثبت عزل معاينة React أو إصدار الملفات المختبر.', 503);
  if (receipt.exitCode !== 0 || receipt.timedOut) throw fault('REACT_RENDER_FAILED', 'فشل عرض مكوّن React داخل العزل أو تجاوز المهلة. النسخة السابقة محفوظة.', 422);
  if (typeof receipt.stdout !== 'string' || Buffer.byteLength(receipt.stdout) > 65536) throw fault('REACT_RENDER_OUTPUT_INVALID', 'تجاوز سجل المعاينة حد المخرجات.');
}

/** Build once on an explicit mutation. GET preview uses only the retained inert artifact. */
export async function buildReactStudio(snapshot: ReactStudioSnapshot, sandbox: ReactStudioSandbox): Promise<ReactStudioArtifact> {
  checkReactSnapshot(snapshot);
  const capability = await sandbox.available();
  if (!capability.available || typeof capability.provider !== 'string' || !capability.provider) throw fault('REACT_SANDBOX_UNAVAILABLE', 'يلزم عزل مثبت لتشغيل مكوّنات React. لم يُشغّل كود المشروع.', 503);
  const instrumented = instrumentReactSnapshot(snapshot);
  const sourceHash = reactSourceHash(snapshot);
  const bundle = await compileReact(snapshot,instrumented);
  const marker = `MOHASSAN_REACT_${randomBytes(20).toString('hex')}=`;
  const harness = `const test=require('node:test');const encode=Buffer.from.bind(Buffer);const log=console.log.bind(console);test('isolated React rendering',()=>{const app=require('./render.cjs');const html=app.render();if(typeof html!=='string'||Buffer.byteLength(html,'utf8')>${maximumHtmlBytes})throw new Error('React markup limit');log(${JSON.stringify(marker)}+encode(html,'utf8').toString('base64'));});`;
  // A compiler-owned package boundary prevents Node from probing a parent
  // package.json outside the read-only snapshot while resolving CommonJS.
  const input: SandboxRunInput = {files:[{path:'package.json',content:'{"private":true,"type":"commonjs"}'},{path:'render.cjs',content:bundle},{path:'render.test.cjs',content:harness}],testFiles:['render.test.cjs'],timeoutMs:10_000};
  let receipt: SandboxTestResult;
  try {receipt = await sandbox.run(input);} catch {throw fault('REACT_RENDER_FAILED', 'تعذر إكمال عرض React داخل العزل. النسخة السابقة محفوظة.', 503);}
  validateReceipt(receipt,input,capability.provider);
  const records = receipt.stdout.split(/\r?\n/).map(line=>line.replace(/^#\s?/,'')) .filter(line=>line.startsWith(marker));
  if (records.length !== 1) throw fault('REACT_RENDER_OUTPUT_INVALID', 'لم يرجع مشغّل React ناتج عرض واحدًا صالحًا.');
  const encoded = records[0]!.slice(marker.length);
  if (!encoded || encoded.length > 60_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw fault('REACT_RENDER_OUTPUT_INVALID', 'صيغة ناتج React غير صالحة.');
  const bytes = Buffer.from(encoded,'base64');
  let html: string;
  try {html = new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {throw fault('REACT_RENDER_OUTPUT_INVALID','ترميز ناتج المعاينة غير صالح.');}
  if (!html.trim() || bytes.byteLength > maximumHtmlBytes || html.includes('\0')) throw fault('REACT_RENDER_OUTPUT_INVALID','ناتج React فارغ أو يتجاوز الحدود.');
  if (Buffer.byteLength(instrumented.css) > 64_000) throw fault('REACT_CSS_TOO_LARGE','تجاوز تنسيق المشروع حد ملف المعاينة.');
  const artifact: ReactStudioArtifact = {sourceHash,html,css:instrumented.css,elements:instrumented.elements,warnings:[...instrumented.warnings,'معاينة React تعرض الناتج الأولي فقط؛ التفاعلات وخدمات Next غير مشغلة.'],verification:{provider:receipt.provider,sourceHash,snapshotHash:receipt.snapshotHash,network:'denied',isolation:'appcontainer',isolationVerified:true,durationMs:receipt.durationMs}};
  // Treat rendered HTML as untrusted, even though the OS execution was verified.
  renderReactStudioArtifact(artifact,'react-validation-nonce-000000',sourceHash);
  return artifact;
}

/** Rebuild only the safe document/nonce from a previously verified, inert render result. */
export function renderReactStudioArtifact(artifact: ReactStudioArtifact, nonce: string, revision: string) {
  if (!artifact || !hashPattern.test(artifact.sourceHash) || typeof artifact.html !== 'string' || Buffer.byteLength(artifact.html) > maximumHtmlBytes
    || typeof artifact.css !== 'string' || Buffer.byteLength(artifact.css) > 64_000 || !Array.isArray(artifact.elements) || artifact.elements.length > 1000
    || !Array.isArray(artifact.warnings) || artifact.warnings.some(warning=>typeof warning!=='string' || warning.length>1000)
    || artifact.verification?.sourceHash !== artifact.sourceHash || artifact.verification.network !== 'denied' || !['appcontainer','microvm'].includes(artifact.verification.isolation)
    || artifact.verification.isolationVerified !== true || !hashPattern.test(artifact.verification.snapshotHash)) throw fault('REACT_ARTIFACT_INVALID', 'دليل معاينة React المحفوظ غير صالح.', 409);
  const rendered = renderStudio({entryPath:'preview.html',files:[{path:'preview.html',content:`<link rel="stylesheet" href="preview.css">${artifact.html}`},{path:'preview.css',content:artifact.css}]},nonce,revision,{sourceElements:artifact.elements,sourceAttribute:'data-mohassan-source-id'});
  return {...rendered,warnings:[...new Set([...artifact.warnings,...rendered.warnings])],verification:{...artifact.verification}};
}

export async function renderReactStudio(snapshot: ReactStudioSnapshot, nonce: string, revision: string, sandbox: ReactStudioSandbox) {
  return renderReactStudioArtifact(await buildReactStudio(snapshot,sandbox),nonce,revision);
}
