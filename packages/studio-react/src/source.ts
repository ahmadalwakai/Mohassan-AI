import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { parseFragment } from 'parse5';
import { StudioError } from '../../studio/src/index.ts';
import { assertNoLinks, boundedText, canonicalDirectory, credentialLike, safeRelative, sensitivePath } from '../../coding/src/security.ts';
import type { StudioElement } from '@mohassan/contracts';

export interface ReactStudioSnapshot {
  framework: 'react' | 'next';
  entryPath: string;
  files: { path: string; content: string }[];
}
export interface ReactStudioElement extends StudioElement { editableStyles: boolean }
export interface ReactStudioEdit {
  elementId: string;
  text?: string;
  styles?: { color?: string; backgroundColor?: string; fontSize?: number };
}
interface SourceElement {
  file: ts.SourceFile;
  path: string;
  node: ts.JsxElement | ts.JsxSelfClosingElement;
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  styleObject: ts.ObjectLiteralExpression | null;
  dto: ReactStudioElement;
}
const bounds = { files: 40, fileBytes: 64_000, totalBytes: 128_000, elements: 1000, astNodes: 25000, depth: 120 };
const codePath = (path: string) => /\.(?:tsx|jsx|ts|js|mjs)$/i.test(path);
const editableCodePath = (path: string) => codePath(path) && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(path);
const skippedDirectories = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '.turbo', '.vercel']);
const ignoredMetadata = /^(?:readme(?:\.[\w.-]+)?|license(?:\.[\w.-]+)?|copying(?:\.[\w.-]+)?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[\w-]+)?\.json|jsconfig(?:\.[\w-]+)?\.json|next-env\.d\.ts|\.gitignore|\.gitattributes|(?:next|vite|webpack|babel|postcss|eslint|tailwind)\.config\.[\w.]+)$/i;

export function checkReactSnapshot(snapshot: ReactStudioSnapshot): void {
  if (!snapshot || !['react', 'next'].includes(snapshot.framework) || typeof snapshot.entryPath !== 'string' || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > bounds.files) {
    throw new StudioError('INVALID_REACT_SNAPSHOT', 'نسخة React غير صالحة أو تتجاوز عدد الملفات المدعوم.');
  }
  try { safeRelative(snapshot.entryPath); } catch { throw new StudioError('UNSAFE_REACT_PATH', 'مسار بداية React غير صالح.'); }
  if (!codePath(snapshot.entryPath) || /\.d\.ts$/i.test(snapshot.entryPath)) throw new StudioError('REACT_ENTRY_REQUIRED', 'اختر ملف مكوّن React مثل src/App.tsx أو app/page.tsx.');
  const seen = new Set<string>(); let total = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new StudioError('INVALID_REACT_FILE', 'ملف React غير صالح.');
    try { safeRelative(file.path); } catch { throw new StudioError('UNSAFE_REACT_PATH', 'مسار ملف React غير صالح.'); }
    const normalized = file.path.toLowerCase();
    if (seen.has(normalized) || sensitivePath(file.path) || file.path.split('/').some(part => ['.data', '.next', '.git', 'node_modules'].includes(part.toLowerCase())) || !codePath(file.path) && !/\.css$/i.test(file.path) && file.path !== 'package.json') {
      throw new StudioError('UNSUPPORTED_REACT_FILE', 'نسخة React تحتوي ملفًا حساسًا أو غير مدعوم أو مسارًا مكررًا.');
    }
    seen.add(normalized);
    const bytes = Buffer.byteLength(file.content);
    if (bytes > bounds.fileBytes || file.content.includes('\0') || credentialLike(file.content)) throw new StudioError('UNSAFE_REACT_SOURCE', 'ملف المصدر يتجاوز حدود النص الآمن أو يحتوي صيغة اعتماد حساسة.');
    total += bytes;
    if (file.path === 'package.json') {
      try {
        const manifest: unknown = JSON.parse(file.content);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid manifest');
      } catch { throw new StudioError('INVALID_REACT_PACKAGE', 'ملف package.json غير صالح. لا تُنفّذ تعليماته في المعاينة.'); }
    }
  }
  if (total > bounds.totalBytes) throw new StudioError('REACT_PROJECT_TOO_LARGE', 'تجاوز مشروع React حد المحتوى المدعوم.');
  if (!snapshot.files.some(file => file.path === snapshot.entryPath)) throw new StudioError('REACT_ENTRY_NOT_FOUND', 'ملف بداية React غير موجود داخل النسخة.');
}

/** Import is bounded data reading only; package scripts and project modules are never run here. */
export async function inspectReactProject(path: string, entryPath: string, roots: readonly string[], framework: 'react' | 'next'): Promise<ReactStudioSnapshot> {
  try {
    const directory = await canonicalDirectory(path, roots);
    const files: ReactStudioSnapshot['files'] = []; let entries = 0; let total = 0;
    async function walk(folder: string, prefix: string, depth: number) {
      if (depth > 20) throw new StudioError('REACT_PROJECT_TOO_LARGE', 'تجاوز المشروع عمق المجلدات المدعوم.');
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        // Generated dependency/build trees are never traversed, inspected or executed.
        if (skippedDirectories.has(entry.name.toLowerCase())) continue;
        const filePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        safeRelative(filePath);
        if (sensitivePath(filePath) || entry.name.toLowerCase() === '.data') throw new StudioError('SENSITIVE_REACT_PATH', 'المجلد يحتوي مسارًا حساسًا؛ لم يُقرأ محتواه.');
        if (++entries > 400) throw new StudioError('REACT_PROJECT_TOO_LARGE', 'تجاوز المشروع عدد المسارات المدعوم.');
        const absolute = join(folder, entry.name);
        await assertNoLinks(absolute);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.isFile() && stat.nlink !== 1) throw new StudioError('UNSUPPORTED_REACT_PATH', 'المشروع يحتوي رابطًا أو ملفًا خاصًا غير مدعوم.');
        if (stat.isDirectory()) { await walk(absolute, filePath, depth + 1); continue; }
        if (ignoredMetadata.test(entry.name)) continue;
        if (!codePath(filePath) && !/\.css$/i.test(filePath) && filePath !== 'package.json') throw new StudioError('UNSUPPORTED_REACT_FILE', 'اختر مشروع React صغيرًا بملفات JS/TS/JSX/TSX وCSS دون أصول ثنائية.');
        if (files.length >= bounds.files) throw new StudioError('REACT_PROJECT_TOO_LARGE', 'تجاوز المشروع عدد الملفات المدعوم.');
        const content = await boundedText(absolute, bounds.fileBytes);
        total += Buffer.byteLength(content);
        if (total > bounds.totalBytes) throw new StudioError('REACT_PROJECT_TOO_LARGE', 'تجاوز المشروع حد المحتوى المدعوم.');
        files.push({ path: filePath, content });
      }
    }
    await walk(directory, '', 0);
    const snapshot = { framework, entryPath, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
    checkReactSnapshot(snapshot); return snapshot;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') throw new StudioError(error.code, 'تعذر استيراد React ضمن حدود القراءة المصرح بها.');
    throw new StudioError('REACT_IMPORT_FAILED', 'تعذر قراءة مشروع React. تحقق من مساره وصلاحياته.');
  }
}

export function reactSourceHash(snapshot: ReactStudioSnapshot): string {
  checkReactSnapshot(snapshot);
  return createHash('sha256').update(JSON.stringify({ framework: snapshot.framework, entryPath: snapshot.entryPath, files: [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en')) })).digest('hex');
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : null;
}
function literalValue(node: ts.Expression): string | number | null | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}
function textValue(text: string): string {
  // Match JSX's indentation handling, then decode entities as text (no DOM or JS runs).
  const lines = text.replace(/\t/g, ' ').split(/\r\n|\n|\r/);
  let lastNonempty = lines.length - 1;
  while (lastNonempty >= 0 && !lines[lastNonempty].trim()) lastNonempty--;
  const normalized = lines.map((line, index) => {
    const value = (index ? line.replace(/^ +/, '') : line).replace(index < lines.length - 1 ? / +$/ : /$^/, '');
    return value ? value + (index < lastNonempty ? ' ' : '') : '';
  }).join('');
  const fragment = parseFragment(normalized);
  return fragment.childNodes.map(child => 'value' in child ? child.value : '').join('');
}
function staticText(node: ts.JsxElement | ts.JsxSelfClosingElement): string | null {
  if (ts.isJsxSelfClosingElement(node)) return null;
  if (node.children.every(ts.isJsxText)) return node.children.map(child => ts.isJsxText(child) ? textValue(child.text) : '').join('');
  if (node.children.length === 1) {
    const child = node.children[0];
    if (ts.isJsxExpression(child) && child.expression && (ts.isStringLiteral(child.expression) || ts.isNoSubstitutionTemplateLiteral(child.expression))) return child.expression.text;
  }
  return null;
}

function priorityCSS(snapshot: ReactStudioSnapshot): boolean {
  return snapshot.files.some(file => /\.css$/i.test(file.path) && /!\s*important\b/i.test(file.content.replace(/\/\*[\s\S]*?\*\//g, '')));
}

function analyze(snapshot: ReactStudioSnapshot): { files: Map<string, ts.SourceFile>; elements: SourceElement[] } {
  checkReactSnapshot(snapshot);
  const files = new Map<string, ts.SourceFile>(); const elements: SourceElement[] = [];
  const hasPriorityRules = priorityCSS(snapshot);
  let nodes = 0;
  for (const source of [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    if (!codePath(source.path)) continue;
    const kind = /\.ts$/i.test(source.path) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
    const file = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true, kind);
    const diagnostics = /\.d\.ts$/i.test(source.path) ? [] : ts.transpileModule(source.content, {fileName:source.path, reportDiagnostics:true, compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).diagnostics;
    if (diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new StudioError('REACT_SYNTAX_ERROR', `تعذر تحليل صياغة الملف ${source.path}.`);
    files.set(source.path, file);
    function visit(node: ts.Node, depth: number) {
      if (++nodes > bounds.astNodes || depth > bounds.depth) throw new StudioError('REACT_SOURCE_TOO_COMPLEX', 'تجاوز مصدر React حدود العقد أو عمق التحليل.');
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve') throw new StudioError('DYNAMIC_REACT_IMPORT', 'require.resolve غير مدعوم في شبكة استيراد المعاينة المحدودة.');
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new StudioError('DYNAMIC_REACT_IMPORT', 'الاستيراد الديناميكي غير المحدد غير مدعوم؛ استخدم مسارًا نصيًا ثابتًا.');
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(file).toLowerCase().startsWith('data-mohassan-')) throw new StudioError('RESERVED_REACT_ATTRIBUTE', 'سمات ربط المصدر محجوزة للاستوديو ولا تقبل من ملفات المشروع.');
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && editableCodePath(source.path)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(file);
        if (/^[a-z][a-z0-9-]*$/.test(tag)) {
          if (elements.length >= bounds.elements) throw new StudioError('REACT_TOO_MANY_ELEMENTS', 'تجاوز المشروع عدد عناصر React القابلة للربط.');
          const attributes = opening.attributes.properties;
          const styles = attributes.filter((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(file) === 'style');
          const style = styles[0];
          const expression = style?.initializer && ts.isJsxExpression(style.initializer) ? style.initializer.expression : undefined;
          const object = expression && ts.isObjectLiteralExpression(expression) ? expression : null;
          const keys = object?.properties.map(property => ts.isPropertyAssignment(property) ? propertyName(property.name) : null) ?? [];
          const editableStyles = !hasPriorityRules && !attributes.some(ts.isJsxSpreadAttribute) && styles.length <= 1 && (!style || Boolean(object && keys.every(key => key !== null) && new Set(keys).size === keys.length && object.properties.every(property => {
            if (!ts.isPropertyAssignment(property)) return false;
            const value = literalValue(property.initializer);
            return value !== undefined && !(typeof value === 'string' && /!\s*important\b/i.test(value));
          })));
          const values = {color:'',backgroundColor:'',fontSize:''};
          for (const property of object?.properties ?? []) if (ts.isPropertyAssignment(property)) {
            const key = propertyName(property.name), value = literalValue(property.initializer);
            if ((key === 'color' || key === 'backgroundColor' || key === 'fontSize') && value !== undefined && value !== null) values[key] = key === 'fontSize' && typeof value === 'number' ? `${value}px` : String(value);
          }
          const text = staticText(node);
          elements.push({file,path:source.path,node,opening,styleObject:object,dto:{id:`n${elements.length + 1}`,tag,file:source.path,line:file.getLineAndCharacterOfPosition(opening.getStart(file)).line + 1,text,styles:values,editableText:text !== null,editableStyles}});
        }
      }
      ts.forEachChild(node, child => visit(child, depth + 1));
    }
    visit(file, 0);
  }
  return {files,elements};
}

/** Only the compiler receives instrumented files; saved source remains untouched. */
export function instrumentReactSnapshot(snapshot: ReactStudioSnapshot): {files: {path:string;content:string}[];elements:ReactStudioElement[];css:string;warnings:string[]} {
  const analysis = analyze(snapshot);
  const files = snapshot.files.map(file => {
    const locations = analysis.elements.filter(element => element.path === file.path).map(element => ({offset:element.opening.end - (ts.isJsxSelfClosingElement(element.opening) ? 2 : 1),id:element.dto.id}));
    let content = file.content;
    for (const location of locations.sort((a, b) => b.offset - a.offset)) content = content.slice(0, location.offset) + ` data-mohassan-source-id="${location.id}"` + content.slice(location.offset);
    return {path:file.path,content};
  });
  const warnings: string[] = [];
  if (priorityCSS(snapshot)) warnings.push('تحتوي CSS قواعد !important؛ تعديل التنسيق المباشر متوقف لهذه النسخة حتى تراجع قواعد الأولوية في الكود.');
  if (analysis.elements.some(element => !element.dto.editableText || !element.dto.editableStyles)) warnings.push('تُعرض العناصر الديناميكية، ويقتصر التحرير المباشر على النصوص والتنسيقات التي يثبت ربطها بالمصدر.');
  if (snapshot.framework === 'next') warnings.push('هذه معاينة React معزولة لصفحة Next؛ لا تشغّل خادم Next أو التوجيه أو إجراءات الخادم.');
  return {files,elements:analysis.elements.map(element => element.dto),css:snapshot.files.filter(file => /\.css$/i.test(file.path)).sort((a,b)=>a.path.localeCompare(b.path,'en')).map(file=>file.content).join('\n'),warnings};
}

export function applyReactStudioEdit(snapshot: ReactStudioSnapshot, edit: ReactStudioEdit): ReactStudioSnapshot {
  if (!edit || typeof edit.elementId !== 'string' || Object.keys(edit).some(key => !['elementId','text','styles'].includes(key)) || edit.text === undefined && edit.styles === undefined) throw new StudioError('INVALID_REACT_EDIT', 'اختر تعديلًا صريحًا لعنصر React.');
  if (edit.text !== undefined && (typeof edit.text !== 'string' || edit.text.length > 4000 || edit.text.includes('\0') || credentialLike(edit.text))) throw new StudioError('INVALID_REACT_TEXT', 'النص غير صالح أو يتجاوز الحد المدعوم.');
  if (edit.styles !== undefined && (!edit.styles || typeof edit.styles !== 'object' || Array.isArray(edit.styles) || !Object.keys(edit.styles).length || Object.keys(edit.styles).some(key => !['color','backgroundColor','fontSize'].includes(key)))) throw new StudioError('INVALID_REACT_STYLE', 'تنسيق React غير صالح.');
  for (const key of ['color','backgroundColor'] as const) if (edit.styles?.[key] !== undefined && (typeof edit.styles[key] !== 'string' || !/^#[\da-f]{6}$/i.test(edit.styles[key]!))) throw new StudioError('INVALID_REACT_STYLE', 'اختر لونًا بصيغة HEX من ست خانات.');
  if (edit.styles?.fontSize !== undefined && (!Number.isInteger(edit.styles.fontSize) || edit.styles.fontSize < 8 || edit.styles.fontSize > 96)) throw new StudioError('INVALID_REACT_STYLE', 'حجم الخط من 8 إلى96 بكسل.');
  const selected = analyze(snapshot).elements.find(element => element.dto.id === edit.elementId);
  if (!selected) throw new StudioError('REACT_ELEMENT_NOT_FOUND', 'العنصر غير موجود في إصدار React الحالي.', 409);
  const patches: {start:number;end:number;value:string}[] = [];
  if (edit.text !== undefined) {
    if (!selected.dto.editableText || !ts.isJsxElement(selected.node)) throw new StudioError('REACT_TEXT_MAPPING_UNAVAILABLE', 'هذا النص ديناميكي أو يحتوي عناصر فرعية؛ لا يقبل استبدالًا مباشرًا.');
    patches.push({start:selected.node.openingElement.end,end:selected.node.closingElement.getStart(selected.file),value:`{${JSON.stringify(edit.text)}}`});
  }
  if (edit.styles) {
    if (!selected.dto.editableStyles) throw new StudioError('REACT_STYLE_MAPPING_UNAVAILABLE', 'تنسيق هذا العنصر ديناميكي أو قادم من spread؛ لا يقبل تعديلًا مباشرًا.');
    const entries = Object.entries(edit.styles);
    if (!selected.styleObject) {
      const at = selected.opening.end - (ts.isJsxSelfClosingElement(selected.opening) ? 2 : 1);
      patches.push({start:at,end:at,value:` style={{${entries.map(([key,value])=>`${key}:${JSON.stringify(value)}`).join(',')}}}`});
    } else {
      const object = selected.styleObject;
      const append: string[] = [];
      for (const [key,value] of entries) {
        const property = object.properties.find((item):item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && propertyName(item.name) === key);
        if (property) patches.push({start:property.initializer.getStart(selected.file),end:property.initializer.end,value:JSON.stringify(value)});
        else append.push(`${key}:${JSON.stringify(value)}`);
      }
      if (append.length) {
        const last = object.properties[object.properties.length - 1];
        const at = last ? last.end : object.getStart(selected.file) + 1;
        patches.push({start:at,end:at,value:`${last ? ',' : ''}${append.join(',')}`});
      }
    }
  }
  let content = snapshot.files.find(file => file.path === selected.path)!.content;
  for (const patch of patches.sort((a,b)=>b.start-a.start)) content = content.slice(0,patch.start) + patch.value + content.slice(patch.end);
  const next = {...snapshot,files:snapshot.files.map(file=>({...file,content:file.path===selected.path ? content : file.content}))};
  checkReactSnapshot(next); analyze(next); return next;
}

export function createReactDemo(framework: 'react' | 'next' = 'react'): ReactStudioSnapshot {
  const entryPath = framework === 'next' ? 'app/page.tsx' : 'src/App.tsx';
  const cssPath = framework === 'next' ? 'app/globals.css' : 'src/styles.css';
  const heroImport = framework === 'next' ? '../src/components/Hero' : './components/Hero';
  const files: ReactStudioSnapshot['files'] = [
    {path:entryPath,content:`'use client';\nimport { useState } from 'react';\nimport Hero from '${heroImport}';\nimport './${framework === 'next' ? 'globals' : 'styles'}.css';\n\nexport default function App() {\n  const [count] = useState(3);\n  return <main><Hero /><section className="counter-panel"><span className="eyebrow">حالة React حقيقية</span><h2>مكوّنات تعمل معًا.</h2><p id="counter">القيمة الحالية: {count}</p><p>تُرسم المكوّنات داخل عزل Windows، ثم تُعرض النتيجة للمراجعة.</p></section></main>;\n}\n`},
    {path:'src/components/Hero.tsx',content:`export default function Hero() {\n  return <section className="hero">\n    <header><strong>مدار / React</strong><span>مساحة لفكرة جديدة</span></header>\n    <span className="eyebrow">من المكوّن إلى المعاينة</span>\n    <h1 style={{color:'#174f43',fontSize:48}}>واجهة React لفكرتك القادمة.</h1>\n    <p className="lead">اختر العنوان وعدّل نصه وتنسيقه، ثم احفظ نسخة يمكنك مقارنتها بالأصل.</p>\n    <div className="hero-art"><span>01</span><strong>فكرة واضحة.<br />تجربة قريبة.</strong></div>\n  </section>;\n}\n`},
    {path:cssPath,content:`*{box-sizing:border-box}body{margin:0;direction:rtl;background:#f4f3ec;color:#223d34;font-family:Tahoma,Arial,sans-serif}.hero{padding:28px 34px 38px;position:relative;overflow:hidden}.hero header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #d6dfd3;padding-bottom:22px;margin-bottom:60px;font-size:12px}.hero header strong{font-size:22px}.hero header span{color:#7b8c78}.eyebrow{font-size:11px;color:#768b6a;letter-spacing:.5px}.hero h1{line-height:1.4;letter-spacing:-1.5px;max-width:540px;margin:20px 0}.lead{font-size:14px;line-height:2;color:#768573;max-width:490px}.hero-art{display:flex;justify-content:space-between;align-items:flex-end;margin-top:34px;background:#dfe8d6;border:1px solid #bdcdb1;border-radius:60px 6px 6px 6px;padding:30px;color:#557344;min-height:160px}.hero-art>span{font-size:42px;color:#93ac80}.hero-art strong{font-size:26px;line-height:1.5}.counter-panel{margin:0 34px 36px;border-top:1px solid #d6dfd3;padding-top:28px}.counter-panel h2{font-size:23px}.counter-panel p{font-size:12px;color:#74836d;line-height:1.9}@media(max-width:540px){.hero{padding:24px}.hero header{margin-bottom:40px}.hero h1{letter-spacing:-1px}.hero header span{font-size:9px}.counter-panel{margin:0 24px 28px}.hero-art strong{font-size:22px}}\n`},
    {path:'package.json',content:JSON.stringify({name:`mohassan-${framework}-studio-demo`,private:true,type:'module',dependencies:{react:'19.3.1','react-dom':'19.3.1',...(framework==='next'?{next:'16.4.5'}:{})}},null,2)+'\n'},
  ];
  if (framework === 'next') files.push({path:'app/layout.tsx',content:`import type { ReactNode } from 'react';\nexport default function RootLayout({children}:{children:ReactNode}) {\n  return <html lang="ar" dir="rtl"><body>{children}</body></html>;\n}\n`});
  return {framework,entryPath,files};
}
