import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { localNetworkProbe, type LocalNetworkEvidence } from './network-probe.ts';
import { verifyExecutableGates, type ExecutableGateEvidence, type ExecutableReadiness } from './gates.ts';
import { collectSandboxOutputs, safeSandboxPath as safePath, validateSandboxScript, type SandboxScriptInput, type SandboxScriptResult } from './script.ts';
import { localSideChannelProbe } from './side-channel-probe.ts';
import { QuotaSlots, quotaVolumeMaxBytes, SandboxQuotaUnavailableError, type QuotaLease } from './quota.ts';
export { verifyExecutableGates } from './gates.ts';
export { QuotaSlots, quotaVolumeMaxBytes, SandboxQuotaUnavailableError } from './quota.ts';
export type { ExecutableReadiness, ExecutableGate, ExecutableGateId } from './gates.ts';
export type { SandboxScriptInput, SandboxScriptResult, SandboxOutputFile } from './script.ts';

export interface SandboxFile { path: string; content: string }
export interface SandboxRunInput { files: SandboxFile[]; testFiles: string[]; syntaxFiles?: string[]; signal?: AbortSignal; timeoutMs?: number }
export interface SandboxTestResult {
  exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number;
  provider: string; network: 'denied'; isolation: 'appcontainer'; isolationVerified: boolean; snapshotHash: string;
  nativeControls?: { uiRestrictionMask: 255; uiRestrictionsVerified: true; lowPrivilege?: boolean; memoryLimitBytes?: number; quotaVolumeBytes?: number };
}
export interface SandboxAvailability { available: boolean; provider: string; message: string }
export interface SandboxRunner { available(): Promise<SandboxAvailability>; run(input: SandboxRunInput): Promise<SandboxTestResult>; executableReadiness?(): Promise<ExecutableReadiness>; runScript?(input: SandboxScriptInput): Promise<SandboxScriptResult> }
export class SandboxUnavailableError extends Error { readonly code = 'SANDBOX_UNAVAILABLE'; }
const provider = 'windows-appcontainer';
const nativeDirectory = fileURLToPath(new URL('../native/', import.meta.url));
const NativeResult = z.object({ exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean(), durationMs: z.number(), isolationVerified: z.literal(true), tokenIsAppContainer: z.literal(true), integrityRid: z.number().nonnegative().max(4096), capabilityCount: z.literal(0), jobAssigned: z.literal(true), jobLimitsVerified:z.literal(true),activeProcessLimit:z.literal(1),memoryLimitBytes:z.number().int().min(16*1024*1024).max(512*1024*1024),uiRestrictionMask:z.literal(255),uiRestrictionsVerified:z.literal(true),lowPrivilegeRequested:z.boolean(),tokenIsLessPrivilegedAppContainer:z.boolean(),outputComplete:z.boolean(),quotaVolumeBytes:z.number().int().min(0).max(quotaVolumeMaxBytes) });
const NativeResponse = z.object({ ok: z.literal(true), results: z.array(NativeResult).min(1) });

export function snapshotHash(files: readonly SandboxFile[]): string {
  return createHash('sha256').update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(({ path, content }) => ({ path, content })))).digest('hex');
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
  nodeRestrictionEvidence?: SandboxTestResult;
  networkProbeEvidence?: LocalNetworkEvidence[];
  scriptProbeEvidence?: SandboxScriptResult;
  lpacProbeEvidence?: SandboxScriptResult;
  lpacProbeError?: string;
  publicResourceProbeEvidence?: { ordinary: SandboxTestResult; lowPrivilege?: SandboxTestResult };
  publicResourceProbeError?: string;
  sideChannelProbeEvidence?: SandboxTestResult;
  sideChannelControlEvidence?: Awaited<ReturnType<Awaited<ReturnType<typeof localSideChannelProbe>>['verifyDenial']>>;
  sideChannelProbeError?: string;
  quotaProbeEvidence?: SandboxScriptResult;
  quotaProbeError?: string;
  private lastNativeError?: string;
  private gateEvidence: ExecutableGateEvidence = {};
  private baselineVerified = false;
  private availability: Promise<SandboxAvailability> | undefined;
  private readonly quotaSlots?: QuotaSlots;
  constructor(private readonly options: { powerShellPath?: string; quotaRoot?: string } = {}) {
    const quotaRoot = options.quotaRoot ?? process.env.SANDBOX_QUOTA_ROOT;
    if (quotaRoot) this.quotaSlots = new QuotaSlots(quotaRoot);
  }
  /**
   * Windows PowerShell in System32 is unpackaged. A packaged host (Store pwsh) makes the profile a child
   * AppContainer that inherits the package's capabilities, so it is never resolved from PATH here.
   */
  private powerShellPath(): string {
    return this.options.powerShellPath ?? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  }
  available(): Promise<SandboxAvailability> {
    return this.availability ??= this.probe().catch(() => ({ available: false, provider, message: 'تعذر إثبات حدود AppContainer؛ التنفيذ متوقف.' })).then(async baseline => {
      this.baselineVerified = baseline.available;
      await this.probeExecutableControls();
      return baseline;
    });
  }
  async executableReadiness(): Promise<ExecutableReadiness> {
    // Diagnostics never start a process. available() owns the trusted probes.
    return verifyExecutableGates({ ...this.gateEvidence, baselineVerified: this.baselineVerified });
  }
  async run(input: SandboxRunInput): Promise<SandboxTestResult> {
    validate(input);
    if (!(await this.available()).available) throw new SandboxUnavailableError('لا يوجد عزل نظام مثبت؛ لم يُشغّل أي كود مشروع.');
    return this.execute(input);
  }
  async runScript(input: SandboxScriptInput): Promise<SandboxScriptResult> {
    const checked = validateSandboxScript(input);
    // No readiness override is accepted from a caller or a manifest. G2 has no
    // backend, so imported executable skills remain unreachable on this provider.
    if (!verifyExecutableGates({ ...this.gateEvidence, baselineVerified: this.baselineVerified }).enabled) throw new SandboxUnavailableError('بوابات تنفيذ السكربتات غير مكتملة؛ لم تبدأ أي عملية.');
    return this.executeScript(checked, true, true);
  }
  private async executeScript(raw: SandboxScriptInput, lowPrivilege = true, quota = false): Promise<SandboxScriptResult> {
    const input = validateSandboxScript(raw), files = [...input.files, { path: '.mohassan-input.json', content: input.inputJson }];
    return this.execute({ files, testFiles: [input.entry], signal: input.signal, timeoutMs: input.timeoutMs }, false, true, { ...input, lowPrivilege, quota }) as Promise<SandboxScriptResult>;
  }
  private async execute(input: SandboxRunInput, probe = false, enforceNodePermissions = true, script?: SandboxScriptInput & { lowPrivilege: boolean; publicResourceProbe?: boolean; quota?: boolean }): Promise<SandboxTestResult | SandboxScriptResult> {
    this.lastNativeError = undefined;
    if (process.platform !== 'win32') throw new SandboxUnavailableError('موفر AppContainer يحتاج Windows.');
    validate(input);
    if (input.signal?.aborted) throw new SandboxUnavailableError('أُلغي الاختبار قبل بدء أي عملية.');
    // Only the fixed boundary probe may outlast the run cap: it waits for the OS connect verdict.
    const timeoutMs = Math.max(100, Math.min(input.timeoutMs ?? 10_000, probe ? 45_000 : 20_000));
    const tempBase = await realpath(tmpdir());
    const root = await mkdtemp(join(tempBase, 'mohassan-sandbox-'));
    const start = Date.now();
    let lease: QuotaLease | undefined;
    try {
      if (script?.quota) {
        if (!this.quotaSlots) throw new SandboxQuotaUnavailableError('لم تُضبط وحدات حصة القرص.');
        lease = await this.quotaSlots.acquire();
      }
      // Everything the isolated process may write lives on the quota volume when one is required.
      const writable = lease?.directory ?? root;
      const work = join(root, 'work'), temp = join(writable, 'temp'), tools = join(root, 'tools'), output = script ? join(writable, 'outputs') : '';
      await Promise.all([mkdir(work), mkdir(temp), mkdir(tools)]);
      if (script) await mkdir(output);
      for (const file of input.files) { const target = join(work, ...file.path.split('/')); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content, { flag: 'wx' }); }
      const node = join(tools, 'node.exe'); await copyFile(process.execPath, node);
      // The OS-boundary startup fixture deliberately omits these Node restrictions so
      // that ERR_ACCESS_DENIED cannot be mistaken for an AppContainer ACL proof.
      const nodeRestrictions = enforceNodePermissions ? ['--permission', '--no-addons', `--allow-fs-read=${work}`, `--allow-fs-read=${tools}`, `--allow-fs-write=${temp}`, ...(script ? [`--allow-fs-read=${output}`, `--allow-fs-write=${output}`] : [])] : [];
      const commands = script ? [{ arguments: [...nodeRestrictions, '--preserve-symlinks', '--preserve-symlinks-main', `./${script.entry}`] }] : [
        ...(input.syntaxFiles ?? []).map((path) => ({ arguments: [...nodeRestrictions, '--preserve-symlinks', '--preserve-symlinks-main', '--check', `./${path}`] })),
        { arguments: [...nodeRestrictions, '--preserve-symlinks', '--preserve-symlinks-main', '--test', '--test-isolation=none', ...input.testFiles.map((path) => `./${path}`)] },
      ];
      const requestPath = join(root, 'request.json'), cancelPath = join(root, 'cancel');
      const memoryMb = script?.memoryMb ?? 512;
      await writeFile(requestPath, JSON.stringify({ node, work, temp, commands, timeoutMs, cancelPath, output, memoryMb, lowPrivilege: script?.lowPrivilege ?? false, publicResourceProbe: script?.publicResourceProbe ?? false, quotaBytes: lease ? quotaVolumeMaxBytes : 0 }), { flag: 'wx' });
      const powerShellPath = this.powerShellPath();
      const raw = await new Promise<string>((accept, reject) => {
        const child = spawn(powerShellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(nativeDirectory, 'run.ps1'), '-RequestPath', requestPath], {
          windowsHide: true, shell: false,
          env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: tempBase, TMP: tempBase, PATH: 'C:\\Windows\\System32', ...(probe ? { MOHASSAN_SANDBOX_PROBE_SECRET: 'synthetic-environment-sentinel' } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '', errorOutput = '', fatalError: Error | undefined;
        // Reject only after close: killing the helper closes its Job handle, but
        // cleanup must not race the still-terminating native process and pipes.
        const terminate = (error: Error) => { fatalError ??= error; child.kill(); };
        const limit = setTimeout(() => terminate(new SandboxUnavailableError('انتهت مهلة مشغّل العزل الموثوق.')), Math.min(90_000, timeoutMs * commands.length + 20_000));
        let forceStop: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { void writeFile(cancelPath, 'cancel').catch(() => {}); forceStop = setTimeout(() => child.kill(), 2500); };
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        child.stdout.on('data', (data) => { if (fatalError) return; output += data.toString(); if (output.length > 1_000_000) terminate(new SandboxUnavailableError('تجاوز سجل الاختبار الحد المسموح.')); });
        child.stderr.on('data', (data) => { if (errorOutput.length < 8192) errorOutput += data.toString(); });
        child.once('error', () => { fatalError ??= new SandboxUnavailableError('تعذر بدء مشغّل العزل الموثوق.'); });
        child.once('close', () => { clearTimeout(limit); if (forceStop) clearTimeout(forceStop); input.signal?.removeEventListener('abort', abort); if (fatalError) reject(fatalError); else if (!output.trim()) reject(new SandboxUnavailableError('لم يرجع مشغّل العزل دليلًا صالحًا.')); else accept(output.trim()); });
      });
      let parsed: z.infer<typeof NativeResponse>;
      this.lastNativeError = undefined;
      try { parsed = NativeResponse.parse(JSON.parse(raw)); } catch {
        try { const failure = z.object({ ok: z.literal(false), detail: z.string().max(2000) }).safeParse(JSON.parse(raw)); if (failure.success) this.lastNativeError = failure.data.detail; } catch { /* Never trust an unstructured helper response. */ }
        throw new SandboxUnavailableError('فشل إثبات عزل العملية؛ لم تُقبل نتيجة الاختبار.');
      }
      const results = parsed.results;
      if (script && results.some(result => !result.outputComplete)) throw new SandboxUnavailableError('تجاوز stdout أو stderr الحد المسموح؛ رُفض نجاح مبتور.');
      if (results.some(result => result.memoryLimitBytes !== memoryMb * 1024 * 1024 || result.lowPrivilegeRequested !== Boolean(script?.lowPrivilege) || result.tokenIsLessPrivilegedAppContainer !== Boolean(script?.lowPrivilege) || (lease ? result.quotaVolumeBytes === 0 : result.quotaVolumeBytes !== 0))) throw new SandboxUnavailableError('لا تطابق حدود العملية الطلب الثابت.');
      const last = results[results.length - 1];
      const after = [];
      for (const file of input.files) after.push({ path: file.path, content: await readFile(join(work, ...file.path.split('/')), 'utf8') });
      if (snapshotHash(after) !== snapshotHash(input.files)) throw new SandboxUnavailableError('تغيرت نسخة الملفات أثناء الاختبار؛ رُفض الدليل.');
      const receipt: SandboxTestResult = { exitCode: last.exitCode, stdout: results.map((result) => result.stdout).join('\n').slice(0, 65536), stderr: results.map((result) => result.stderr).join('\n').slice(0, 65536), timedOut: results.some((result) => result.timedOut), durationMs: Date.now() - start, provider, network: 'denied', isolation: 'appcontainer', isolationVerified: true, snapshotHash: snapshotHash(input.files), nativeControls: { uiRestrictionMask: 255, uiRestrictionsVerified: true, lowPrivilege: last.tokenIsLessPrivilegedAppContainer, memoryLimitBytes: last.memoryLimitBytes, quotaVolumeBytes: last.quotaVolumeBytes } };
      if (!script) return receipt;
      if (receipt.exitCode !== 0 || receipt.timedOut || input.signal?.aborted) return { ...receipt, ...(input.signal?.aborted ? { exitCode: 130 } : {}), outputs: [], outputManifestHash: snapshotHash([]) };
      return { ...receipt, ...await collectSandboxOutputs(output, script.outputMaxBytes) };
    } finally { try { await lease?.release(); } finally { await removeOwnedTemp(root, tempBase); } }
  }
  private async probeDiskQuota(): Promise<void> {
    this.lastNativeError = undefined;
    // The fixture stops itself past the bound so a wrong volume cannot fill the host disk.
    const content = `import fs from 'node:fs';const block=Buffer.alloc(1048576,97),path=process.env.MOHASSAN_OUTPUT_DIR+'/fill.bin';let bytes=0,code='none';const fd=fs.openSync(path,'w');try{while(bytes<=${quotaVolumeMaxBytes}){bytes+=fs.writeSync(fd,block)}}catch(error){code=error.code}fs.closeSync(fd);fs.unlinkSync(path);console.log('QUOTA_PROBE='+JSON.stringify({bytes,code}));`;
    const input: SandboxScriptInput = { files: [{ path: 'quota.mjs', content }], entry: 'quota.mjs', inputJson: '{}', timeoutMs: 15_000, memoryMb: 128, outputMaxBytes: 1024 };
    try {
      const result = await this.execute({ files: input.files, testFiles: [input.entry], timeoutMs: input.timeoutMs }, false, false, { ...input, lowPrivilege: false, quota: true }) as SandboxScriptResult;
      this.quotaProbeEvidence = result;
      const measured = z.object({ bytes: z.number().int().positive(), code: z.string() }).parse(JSON.parse(result.stdout.match(/QUOTA_PROBE=(.+)/)?.[1] ?? 'null'));
      const capacity = result.nativeControls?.quotaVolumeBytes ?? 0;
      this.gateEvidence.hardDiskQuotaVerified = result.exitCode === 0 && !result.timedOut && capacity > 0 && measured.code === 'ENOSPC' && measured.bytes <= capacity;
      if (!this.gateEvidence.hardDiskQuotaVerified) this.quotaProbeError = `Quota fixture did not stop at the volume bound: ${JSON.stringify(measured)}`;
    } catch (error) { this.quotaProbeError = this.lastNativeError ?? (error instanceof Error ? error.message.slice(0, 500) : 'Disk quota verification failed'); }
  }
  private async probeExecutableControls(): Promise<void> {
    if (process.platform !== 'win32') return;
    await this.probeDiskQuota();
    const fixture: SandboxScriptInput = { entry: 'trusted.mjs', files: [{ path: 'trusted.mjs', content: `import fs from 'node:fs';import assert from 'node:assert/strict';const input=JSON.parse(fs.readFileSync(process.env.MOHASSAN_INPUT_PATH,'utf8'));assert.equal(input.message,'trusted-local-fixture');fs.writeFileSync(process.env.MOHASSAN_OUTPUT_DIR+'/report.txt','verified output');console.log('FIXED_SCRIPT_PROVEN');` }], inputJson: '{"message":"trusted-local-fixture"}', timeoutMs: 4000, memoryMb: 256, outputMaxBytes: 1024 };
    try {
      this.scriptProbeEvidence = await this.executeScript(fixture, false);
      const result = this.scriptProbeEvidence;
      this.gateEvidence.fixedScriptVerified = result.exitCode === 0 && !result.timedOut && result.stdout.includes('FIXED_SCRIPT_PROVEN');
      this.gateEvidence.outputCollectionVerified = this.gateEvidence.fixedScriptVerified && result.outputs.length === 1 && result.outputs[0]?.content === 'verified output';
    } catch { /* Each unproved gate remains closed. */ }
    try {
      this.lastNativeError = undefined;
      this.lpacProbeEvidence = await this.executeScript(fixture, true);
      this.gateEvidence.lowPrivilegeMarkerVerified = this.lpacProbeEvidence.nativeControls?.lowPrivilege === true;
      this.gateEvidence.lowPrivilegeTokenVerified = this.lpacProbeEvidence.exitCode === 0 && this.lpacProbeEvidence.nativeControls?.lowPrivilege === true;
      if (!this.gateEvidence.lowPrivilegeTokenVerified) this.lpacProbeError = `LPAC token verified but Node did not start: exit ${this.lpacProbeEvidence.exitCode}: ${this.lpacProbeEvidence.stderr.slice(0, 300)}`;
    } catch (error) { this.lpacProbeError = this.lastNativeError ?? (error instanceof Error ? error.message.slice(0, 500) : 'LPAC verification failed'); }
    try {
      this.lastNativeError = undefined;
      const publicProbe = async (lowPrivilege: boolean) => {
        const content = `import fs from 'node:fs';import assert from 'node:assert/strict';${lowPrivilege ? "assert.throws(()=>fs.readFileSync(process.env.MOHASSAN_PUBLIC_RESOURCE),error=>['EACCES','EPERM'].includes(error.code));console.log('PUBLIC_RESOURCE_OS_DENIED');" : "assert.equal(fs.readFileSync(process.env.MOHASSAN_PUBLIC_RESOURCE,'utf8'),'synthetic-public-resource');console.log('PUBLIC_RESOURCE_POSITIVE_CONTROL');"}`;
        const input: SandboxScriptInput = { files: [{ path: 'public.mjs', content }], entry: 'public.mjs', inputJson: '{}', timeoutMs: 4000, outputMaxBytes: 1024 };
        return this.execute({ files: input.files, testFiles: [input.entry], timeoutMs: input.timeoutMs }, false, false, { ...input, lowPrivilege, publicResourceProbe: true });
      };
      const ordinary = await publicProbe(false); this.publicResourceProbeEvidence = { ordinary };
      if (ordinary.exitCode !== 0 || ordinary.timedOut || !ordinary.stdout.includes('PUBLIC_RESOURCE_POSITIVE_CONTROL')) throw new Error('Public-resource positive control failed');
      const lowPrivilege = await publicProbe(true); this.publicResourceProbeEvidence.lowPrivilege = lowPrivilege;
      this.gateEvidence.publicResourceIsolationVerified = lowPrivilege.exitCode === 0 && !lowPrivilege.timedOut && lowPrivilege.nativeControls?.lowPrivilege === true && lowPrivilege.stdout.includes('PUBLIC_RESOURCE_OS_DENIED');
    } catch (error) { this.publicResourceProbeError = this.lastNativeError ?? (error instanceof Error ? error.message.slice(0, 500) : 'Public-resource verification failed'); }
    let channels: Awaited<ReturnType<typeof localSideChannelProbe>> | undefined;
    try {
      this.lastNativeError = undefined;
      channels = await localSideChannelProbe();
      // Deliberately no Node permission layer: its denial would not prove the
      // native boundary. Only these fixed repository-owned probes use this seam.
      const content = `import assert from 'node:assert/strict';import dgram from 'node:dgram';import net from 'node:net';
const outcomes=await Promise.all(${JSON.stringify(channels.udp)}.map(({host,port})=>new Promise(resolve=>{const socket=dgram.createSocket('udp4');let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);try{socket.close()}catch{}resolve(value)};const timer=setTimeout(()=>finish('unproven_timeout'),1500);socket.once('error',error=>finish(error.code));socket.send('isolated-local-fixture',port,host,error=>finish(error?error.code:'sent_without_os_denial'));})));
const pipe=await new Promise(resolve=>{const socket=net.createConnection(${JSON.stringify(channels.pipe)});socket.once('connect',()=>{socket.destroy();resolve('connected')});socket.once('error',error=>resolve(error.code));socket.setTimeout(1500,()=>{socket.destroy();resolve('unproven_timeout')});});
console.log('SIDE_CHANNEL_OUTCOMES='+JSON.stringify({udp:outcomes,pipe}));assert.ok([...outcomes,pipe].every(code=>['EACCES','EPERM'].includes(code)));console.log('SIDE_CHANNEL_OS_DENIAL_PROVEN');`;
      const input: SandboxScriptInput = { files: [{ path: 'channels.mjs', content }], entry: 'channels.mjs', inputJson: '{}', timeoutMs: 5000, outputMaxBytes: 1024 };
      this.sideChannelProbeEvidence = await this.execute({ files: input.files, testFiles: [input.entry], timeoutMs: input.timeoutMs }, false, false, { ...input, lowPrivilege: true });
      this.sideChannelControlEvidence = await channels.verifyDenial();
      this.gateEvidence.sideChannelsVerified = this.sideChannelProbeEvidence.exitCode === 0 && !this.sideChannelProbeEvidence.timedOut && this.sideChannelProbeEvidence.stdout.includes('SIDE_CHANNEL_OS_DENIAL_PROVEN');
    } catch (error) { this.sideChannelProbeError = this.lastNativeError ?? (error instanceof Error ? error.message.slice(0, 500) : 'Side-channel verification failed'); }
    finally {
      if (channels) {
        try { this.sideChannelControlEvidence ??= await channels.verifyDenial(); } catch { this.gateEvidence.sideChannelsVerified = false; this.sideChannelProbeError ??= 'Local side-channel controls failed'; }
        await channels.close();
      }
    }
  }
  private async probe(): Promise<SandboxAvailability> {
    if (process.platform !== 'win32') return { available: false, provider, message: 'AppContainer متاح على Windows فقط.' };
    const tempBase = await realpath(tmpdir()); const outside = await mkdtemp(join(tempBase, 'mohassan-sandbox-sentinel-'));
    // The OS profile path, because HOME and USERPROFILE can point elsewhere in a test environment.
    const localPackages = join(userInfo().homedir, 'AppData', 'Local', 'Packages');
    const sentinel = join(outside, '.env.synthetic'); await writeFile(sentinel, 'synthetic-outside-boundary-value');
    let network: Awaited<ReturnType<typeof localNetworkProbe>> | undefined;
    try {
      network = await localNetworkProbe();
      const code = `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';
test('OS boundary',async()=>{
  assert.equal(process.env.MOHASSAN_SANDBOX_PROBE_SECRET,undefined);
  assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),e=>['EACCES','EPERM'].includes(e.code));
  assert.throws(()=>fs.writeFileSync(import.meta.filename,'changed'),e=>['EACCES','EPERM'].includes(e.code));
  assert.throws(()=>fs.unlinkSync(import.meta.filename),e=>['EACCES','EPERM'].includes(e.code));
  fs.writeFileSync(process.env.TEMP+'/allowed.txt','ok');
  // The container profile sits on the system volume, outside any quota, so it must stay unwritable.
  const profile=process.env.TEMP.match(/mohassan[.]run[.][0-9a-f]+/)[0];
  for(const folder of ['AC','AC/Temp'])assert.throws(()=>fs.writeFileSync(${JSON.stringify(localPackages)}+'/'+profile+'/'+folder+'/probe.txt','x'),e=>['EACCES','EPERM'].includes(e.code));
  const outcomes=await Promise.all(${JSON.stringify(network.endpoints)}.map(async({host,port})=>{
    const denied=await new Promise(resolve=>{const socket=net.createConnection(port,host);socket.once('connect',()=>{socket.destroy();resolve('connected')});socket.once('error',e=>resolve(e.code));socket.setTimeout(35000,()=>{socket.destroy();resolve('unproven_timeout')});});
    console.log('BOUNDARY_NETWORK='+host+':'+denied);return denied;
  }));
  assert.ok(outcomes.every(denied=>['EACCES','EPERM','ETIMEDOUT'].includes(denied)));
  console.log('MOHASSAN_BOUNDARY_PROVEN');
});`;
      const result = await this.execute({ files: [{ path: 'boundary.test.mjs', content: code }], testFiles: ['boundary.test.mjs'], timeoutMs: 40_000 }, true, false);
      this.probeEvidence = result;
      this.gateEvidence.fixedUnpackagedHostVerified = this.powerShellPath() === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      this.gateEvidence.nativeUiRestrictionsVerified = result.nativeControls?.uiRestrictionsVerified === true;
      const restrictionCode = `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';import {Worker} from 'node:worker_threads';test('Node restrictions',()=>{assert.ok(process.permission);assert.equal(fs.readFileSync(import.meta.filename,'utf8').length>0,true);assert.throws(()=>fs.writeFileSync(import.meta.filename,'changed'),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}),{code:'ERR_ACCESS_DENIED'});fs.writeFileSync(process.env.TEMP+'/node-permission-allowed.txt','ok');assert.throws(()=>spawn(process.execPath,['-e','process.exit(0)']),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>new Worker('process.exit(0)',{eval:true}),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>process.dlopen({exports:{}},process.env.TEMP+'/nonexistent.node'),{code:'ERR_DLOPEN_DISABLED'});console.log('MOHASSAN_NODE_RESTRICTIONS_PROVEN');});`;
      this.nodeRestrictionEvidence = await this.execute({ files: [{ path: 'restrictions.test.mjs', content: restrictionCode }], testFiles: ['restrictions.test.mjs'], timeoutMs: 4000 });
      this.gateEvidence.nodeRestrictionsVerified = this.nodeRestrictionEvidence.exitCode === 0 && !this.nodeRestrictionEvidence.timedOut && this.nodeRestrictionEvidence.stdout.includes('MOHASSAN_NODE_RESTRICTIONS_PROVEN');
      // Windows can report an OS ETIMEDOUT for AppContainer loopback denial.
      // Never accept that alone: the receiver must remain reachable from the host
      // before and after the isolated attempt and must observe no isolated connection.
      this.networkProbeEvidence = await network.verifyDenial();
      return result.exitCode === 0 && !result.timedOut && result.stdout.includes('MOHASSAN_BOUNDARY_PROVEN') && this.gateEvidence.nodeRestrictionsVerified ? { available: true, provider, message: 'ثبت AppContainer منخفض السلامة وبلا قدرات شبكة، مع Job وحدود ونسخة مصدر للقراءة فقط.' } : { available: false, provider, message: 'لم يجتز AppContainer اختبار الملفات أو الشبكة أو البيئة أو قيود Node؛ التنفيذ متوقف.' };
    } finally { try { await network?.close(); } finally { await removeOwnedTemp(outside, tempBase); } }
  }
}
