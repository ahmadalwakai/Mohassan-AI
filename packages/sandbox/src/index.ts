import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface SandboxFile { path: string; content: string }
export interface SandboxRunInput { files: SandboxFile[]; testFiles: string[]; syntaxFiles?: string[]; signal?: AbortSignal; timeoutMs?: number }
export interface SandboxTestResult {
  exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number;
  provider: string; network: 'denied'; isolation: 'appcontainer'; isolationVerified: boolean; snapshotHash: string;
}
export interface SandboxAvailability { available: boolean; provider: string; message: string }
export interface SandboxRunner { available(): Promise<SandboxAvailability>; run(input: SandboxRunInput): Promise<SandboxTestResult> }
export class SandboxUnavailableError extends Error { readonly code = 'SANDBOX_UNAVAILABLE'; }
const provider = 'windows-appcontainer';
const nativeDirectory = fileURLToPath(new URL('../native/', import.meta.url));
const NativeResult = z.object({ exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), durationMs: z.number(), isolationVerified: z.literal(true), tokenIsAppContainer: z.literal(true), integrityRid: z.number().nonnegative().max(4096), capabilityCount: z.literal(0), jobAssigned: z.literal(true), jobLimitsVerified:z.literal(true),activeProcessLimit:z.literal(1),memoryLimitBytes:z.literal(512*1024*1024) });
const NativeResponse = z.object({ ok: z.literal(true), results: z.array(NativeResult).min(1) });

export function snapshotHash(files: readonly SandboxFile[]): string {
  return createHash('sha256').update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(({ path, content }) => ({ path, content })))).digest('hex');
}
function safePath(path: string): boolean {
  return typeof path === 'string' && path.length <= 240 && /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(path)
    && !path.split('/').some((part) => ['.', '..', '.git', '.data', 'node_modules'].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function validate(input: SandboxRunInput) {
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100 || new Set(input.files.map((file) => file.path.toLowerCase())).size !== input.files.length) throw new SandboxUnavailableError('ملفات نسخة الاختبار غير صالحة.');
  if (input.files.some((file) => typeof file.content !== 'string' || !safePath(file.path)) || input.files.reduce((size, file) => size + Buffer.byteLength(file.content, 'utf8'), 0) > 512 * 1024) throw new SandboxUnavailableError('تجاوزت نسخة الاختبار حدود الملفات أو المسارات.');
  const known = new Set(input.files.map((file) => file.path));
  if (!Array.isArray(input.testFiles) || !input.testFiles.length || input.testFiles.length > 30 || (input.syntaxFiles?.length ?? 0) > 100 || [...input.testFiles, ...(input.syntaxFiles ?? [])].some((path) => !known.has(path) || !safePath(path) || !/\.(?:mjs|cjs|js|ts)$/.test(path))) throw new SandboxUnavailableError('قائمة فحوص النسخة غير صالحة.');
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) throw new SandboxUnavailableError('مهلة الاختبار غير صالحة.');
}
async function removeOwnedTemp(directory: string, tempBase: string) {
  const target = await realpath(directory);
  const inside = relative(tempBase, target);
  if (!isAbsolute(target) || !inside || isAbsolute(inside) || inside.startsWith('..') || !basename(target).startsWith('mohassan-sandbox-')) throw new Error('Invalid sandbox cleanup target.');
  await rm(target, { recursive: true, force: true });
}

export class WindowsAppContainerSandbox implements SandboxRunner {
  readonly provider = provider;
  probeEvidence?: SandboxTestResult;
  private availability: Promise<SandboxAvailability> | undefined;
  constructor(private readonly options: { powerShellPath?: string } = {}) {}
  /**
   * Windows PowerShell in System32 is unpackaged. A packaged host (Store pwsh) makes the profile a child
   * AppContainer that inherits the package's capabilities, so it is never resolved from PATH here.
   */
  private powerShellPath(): string {
    return this.options.powerShellPath ?? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  }
  available(): Promise<SandboxAvailability> {
    return this.availability ??= this.probe().catch(() => ({ available: false, provider, message: 'تعذر إثبات حدود AppContainer؛ التنفيذ متوقف.' }));
  }
  async run(input: SandboxRunInput): Promise<SandboxTestResult> {
    validate(input);
    if (!(await this.available()).available) throw new SandboxUnavailableError('لا يوجد عزل نظام مثبت؛ لم يُشغّل أي كود مشروع.');
    return this.execute(input);
  }
  private async execute(input: SandboxRunInput, probe = false): Promise<SandboxTestResult> {
    if (process.platform !== 'win32') throw new SandboxUnavailableError('موفر AppContainer يحتاج Windows.');
    validate(input);
    if (input.signal?.aborted) throw new SandboxUnavailableError('أُلغي الاختبار قبل بدء أي عملية.');
    const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 10_000, 20_000));
    const tempBase = await realpath(tmpdir());
    const root = await mkdtemp(join(tempBase, 'mohassan-sandbox-'));
    const start = Date.now();
    try {
      const work = join(root, 'work'), temp = join(root, 'temp'), tools = join(root, 'tools');
      await Promise.all([mkdir(work), mkdir(temp), mkdir(tools)]);
      for (const file of input.files) { const target = join(work, ...file.path.split('/')); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content, { flag: 'wx' }); }
      const node = join(tools, 'node.exe'); await copyFile(process.execPath, node);
      const commands = [
        ...(input.syntaxFiles ?? []).map((path) => ({ arguments: ['--preserve-symlinks', '--preserve-symlinks-main', '--check', `./${path}`] })),
        { arguments: ['--preserve-symlinks', '--preserve-symlinks-main', '--test', '--test-isolation=none', ...input.testFiles.map((path) => `./${path}`)] },
      ];
      const requestPath = join(root, 'request.json'), cancelPath = join(root, 'cancel');
      await writeFile(requestPath, JSON.stringify({ node, work, temp, commands, timeoutMs, cancelPath }), { flag: 'wx' });
      const powerShellPath = this.powerShellPath();
      const raw = await new Promise<string>((accept, reject) => {
        const child = spawn(powerShellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(nativeDirectory, 'run.ps1'), '-RequestPath', requestPath], {
          windowsHide: true, shell: false,
          env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: tempBase, TMP: tempBase, PATH: 'C:\\Windows\\System32', ...(probe ? { MOHASSAN_SANDBOX_PROBE_SECRET: 'synthetic-environment-sentinel' } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '', errorOutput = '';
        const limit = setTimeout(() => { child.kill(); reject(new SandboxUnavailableError('انتهت مهلة مشغّل العزل الموثوق.')); }, Math.min(90_000, timeoutMs * commands.length + 20_000));
        let forceStop: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { void writeFile(cancelPath, 'cancel').catch(() => {}); forceStop = setTimeout(() => child.kill(), 2500); };
        input.signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (data) => { output += data.toString(); if (output.length > 1_000_000) { child.kill(); reject(new SandboxUnavailableError('تجاوز سجل الاختبار الحد المسموح.')); } });
        child.stderr.on('data', (data) => { if (errorOutput.length < 8192) errorOutput += data.toString(); });
        child.once('error', () => reject(new SandboxUnavailableError('تعذر بدء مشغّل العزل الموثوق.')));
        child.once('close', () => { clearTimeout(limit); if (forceStop) clearTimeout(forceStop); input.signal?.removeEventListener('abort', abort); if (!output.trim()) reject(new SandboxUnavailableError('لم يرجع مشغّل العزل دليلًا صالحًا.')); else accept(output.trim()); });
      });
      let parsed: z.infer<typeof NativeResponse>;
      try { parsed = NativeResponse.parse(JSON.parse(raw)); } catch { throw new SandboxUnavailableError('فشل إثبات عزل العملية؛ لم تُقبل نتيجة الاختبار.'); }
      const results = parsed.results;
      const last = results[results.length - 1];
      const after = [];
      for (const file of input.files) after.push({ path: file.path, content: await readFile(join(work, ...file.path.split('/')), 'utf8') });
      if (snapshotHash(after) !== snapshotHash(input.files)) throw new SandboxUnavailableError('تغيرت نسخة الملفات أثناء الاختبار؛ رُفض الدليل.');
      return { exitCode: last.exitCode, stdout: results.map((result) => result.stdout).join('\n').slice(0, 65536), stderr: results.map((result) => result.stderr).join('\n').slice(0, 65536), timedOut: results.some((result) => result.timedOut), durationMs: Date.now() - start, provider, network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(input.files) };
    } finally { await removeOwnedTemp(root, tempBase); }
  }
  private async probe(): Promise<SandboxAvailability> {
    if (process.platform !== 'win32') return { available: false, provider, message: 'AppContainer متاح على Windows فقط.' };
    const tempBase = await realpath(tmpdir()); const outside = await mkdtemp(join(tempBase, 'mohassan-sandbox-sentinel-'));
    const sentinel = join(outside, '.env.synthetic'); await writeFile(sentinel, 'synthetic-outside-boundary-value');
    const server = createServer((socket) => socket.end());
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Network probe listener unavailable.');
      await new Promise<void>((accept, reject) => { const connection = createConnection(address.port, '127.0.0.1'); connection.once('connect', () => { connection.destroy(); accept(); }); connection.once('error', reject); });
      await new Promise<void>((accept, reject) => { const connection = createConnection(443, '1.1.1.1'); connection.once('connect', () => { connection.destroy(); accept(); }); connection.once('error', reject); connection.setTimeout(1500, () => { connection.destroy(); reject(new Error('External network control unavailable.')); }); });
      const code = `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';\ntest('OS boundary',async()=>{assert.equal(process.env.MOHASSAN_SANDBOX_PROBE_SECRET,undefined);assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),e=>['EACCES','EPERM'].includes(e.code));assert.throws(()=>fs.writeFileSync(import.meta.filename,'changed'),e=>['EACCES','EPERM'].includes(e.code));assert.throws(()=>fs.unlinkSync(import.meta.filename),e=>['EACCES','EPERM'].includes(e.code));fs.writeFileSync(process.env.TEMP+'/allowed.txt','ok');for(const[host,port]of[['127.0.0.1',${address.port}],['1.1.1.1',443]]){const network=await new Promise(resolve=>{const socket=net.createConnection(port,host);socket.once('connect',()=>{socket.destroy();resolve('connected')});socket.once('error',e=>resolve(e.code));socket.setTimeout(1500,()=>{socket.destroy();resolve('unproven_timeout')});});console.log('BOUNDARY_NETWORK='+host+':'+network);assert.ok(['EACCES','EPERM','ETIMEDOUT'].includes(network));}console.log('MOHASSAN_BOUNDARY_PROVEN');});`;
      const result = await this.execute({ files: [{ path: 'boundary.test.mjs', content: code }], testFiles: ['boundary.test.mjs'], timeoutMs: 4000 }, true);
      this.probeEvidence = result;
      return result.exitCode === 0 && result.stdout.includes('MOHASSAN_BOUNDARY_PROVEN') ? { available: true, provider, message: 'ثبت AppContainer منخفض السلامة وبلا قدرات شبكة، مع Job وحدود ونسخة مصدر للقراءة فقط.' } : { available: false, provider, message: 'لم يجتز AppContainer اختبار الملفات أو الشبكة أو البيئة؛ التنفيذ متوقف.' };
    } finally { await new Promise<void>((accept) => server.close(() => accept())); await removeOwnedTemp(outside, tempBase); }
  }
}
