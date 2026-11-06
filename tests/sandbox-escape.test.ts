import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { WindowsAppContainerSandbox, type SandboxRunInput, type SandboxTestResult, type SandboxScriptInput, type SandboxScriptResult } from '../packages/sandbox/src/index.ts';
import { executableGateIds, verifyExecutableGates } from '../packages/sandbox/src/gates.ts';
import { collectSandboxOutputs, validateSandboxScript } from '../packages/sandbox/src/script.ts';
import { localSideChannelProbe } from '../packages/sandbox/src/side-channel-probe.ts';

const owned: { base: string; path: string }[] = [];
async function temp() { const base = await realpath(tmpdir()), path = await realpath(await mkdtemp(join(base, 'mohassan-sandbox-outputs-'))); owned.push({ base, path }); return path; }
afterEach(async () => { for (const { base, path } of owned.splice(0)) { const target = await realpath(path), inside = relative(base, target); if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('mohassan-sandbox-outputs-')) throw new Error('Unsafe fixture cleanup'); await rm(target, { recursive: true, force: true }); } });
const script = (content: string, overrides: Partial<SandboxScriptInput> = {}): SandboxScriptInput => ({ files: [{ path: 'trusted.mjs', content }], entry: 'trusted.mjs', inputJson: '{}', timeoutMs: 4000, ...overrides });
const trustedScript = (sandbox: WindowsAppContainerSandbox, input: SandboxScriptInput, lpac = false) => (sandbox as unknown as { executeScript(input: SandboxScriptInput, lpac: boolean): Promise<SandboxScriptResult> }).executeScript(input, lpac);

describe('executable skill readiness remains fail-closed', () => {
  it('requires all eight gates, including LPAC, with no default approvals', () => {
    const report = verifyExecutableGates();
    expect(report.enabled).toBe(false);
    expect(report.baselineVerified).toBe(false);
    expect(report.gates.map(gate => gate.id)).toEqual([...executableGateIds]);
    expect(report.gates.every(gate => gate.required && gate.status === 'blocked' && gate.evidence.length === 0)).toBe(true);
    expect(report.gates.find(gate => gate.id === 'G5')).toMatchObject({ required: true, status: 'blocked' });
  });

  it('never treats native host/UI/Node proofs as disk, LPAC, script, outputs, UDP or pipe proofs', () => {
    const report = verifyExecutableGates({ baselineVerified: true, fixedUnpackagedHostVerified: true, nativeUiRestrictionsVerified: true, nodeRestrictionsVerified: true });
    expect(report.enabled).toBe(false);
    expect(report.gates.filter(gate => gate.status === 'verified').map(gate => gate.id)).toEqual(['G1', 'G3', 'G4']);
    expect(report.gates.filter(gate => gate.status === 'blocked').map(gate => gate.id)).toEqual(['G2', 'G5', 'G6', 'G7', 'G8']);
    expect(report.gates.find(gate => gate.id === 'G2')?.reason).toContain('not a hard quota');
  });

  it('returns a cold diagnostic snapshot without starting a process and refuses scripts even with all other evidence', async () => {
    const sandbox = new WindowsAppContainerSandbox(), execute = vi.spyOn(sandbox as any, 'executeScript');
    expect(await sandbox.executableReadiness()).toMatchObject({ enabled: false, baselineVerified: false }); expect(sandbox.probeEvidence).toBeUndefined();
    const report = verifyExecutableGates({ baselineVerified: true, fixedUnpackagedHostVerified: true, nativeUiRestrictionsVerified: true, nodeRestrictionsVerified: true, lowPrivilegeTokenVerified: true, publicResourceIsolationVerified: true, fixedScriptVerified: true, outputCollectionVerified: true, sideChannelsVerified: true });
    expect(report.enabled).toBe(false); expect(report.gates.filter(gate => gate.status === 'blocked').map(gate => gate.id)).toEqual(['G2']);
    await expect(sandbox.runScript(script("throw new Error('must never execute')"))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' }); expect(execute).not.toHaveBeenCalled();
  });
});

describe('fixed script inputs and bounded output collection', () => {
  it('rejects caller arguments, environment, unknown entries, collisions and oversized inputs before execution', () => {
    expect(() => validateSandboxScript(script('', { files: [{ path: 'entry.ts', content: '' }], entry: 'entry.ts' }))).toThrow();
    for (const bad of [{ ...script(''), args: ['--eval=1'] }, { ...script(''), env: { PATH: 'x' } }, script('', { entry: '../escape.mjs' }), script('', { entry: 'other.mjs' }), script('', { inputJson: '[]' }), script('', { inputJson: JSON.stringify({ text: 'ع'.repeat(40000) }) }), script('', { files: [{ path: 'a.mjs', content: '' }, { path: 'A.mjs', content: '' }] }), script('', { files: [{ path: '.mohassan-input.json', content: '{}' }] })]) expect(() => validateSandboxScript(bad as SandboxScriptInput)).toThrow();
    for (const name of ['COM¹.mjs', 'com².js', 'COM³.cjs', 'LPT¹.mjs', 'LPT².js', 'lpt³.cjs']) expect(() => validateSandboxScript(script('', { files: [{ path: name, content: '' }], entry: name }))).toThrow();
    for (const inputJson of ['{"constructor":1}', '{"number":1e999}', JSON.stringify({ values: Array.from({ length: 4100 }, () => 1) }), '{"a":'.repeat(18) + '1' + '}'.repeat(18)]) expect(() => validateSandboxScript(script('', { inputJson }))).toThrow();
  });
  it('collects exact Arabic bytes, sorted paths and a deterministic manifest', async () => {
    const root = await temp(); await mkdir(join(root, 'reports')); await writeFile(join(root, 'reports', 'عربي.txt'), 'نتيجة موثقة'); await writeFile(join(root, 'a.txt'), 'a');
    const result = await collectSandboxOutputs(root); expect(result.outputs.map(file => file.path)).toEqual(['a.txt', 'reports/عربي.txt']); expect(result.outputs[1]).toMatchObject({ content: 'نتيجة موثقة', bytes: Buffer.byteLength('نتيجة موثقة') }); expect(result.outputs[1]?.sha256).toMatch(/^[a-f0-9]{64}$/); expect(await collectSandboxOutputs(root)).toEqual(result);
  });
  it('preserves a UTF-8 BOM so text, byte length and SHA-256 describe identical bytes', async () => {
    const root = await temp(), bytes = Buffer.from('\uFEFFنص موثوق', 'utf8'); await writeFile(join(root, 'bom.txt'), bytes);
    const result = (await collectSandboxOutputs(root)).outputs[0]!; expect(Buffer.from(result.content, 'utf8')).toEqual(bytes); expect(result.bytes).toBe(bytes.length); expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it.each(['size', 'files', 'depth', 'binary', 'encoding', 'secret', 'wire'] as const)('rejects %s output without truncating it', async kind => {
    const root = await temp();
    if (kind === 'files') for (let i = 0; i < 33; i++) await writeFile(join(root, `${i}.txt`), 'x');
    else if (kind === 'depth') await mkdir(join(root, ...Array.from({ length: 9 }, () => 'nested')), { recursive: true });
    else await writeFile(join(root, kind === 'secret' ? '.env.synthetic' : 'out.txt'), kind === 'binary' ? Buffer.from([0]) : kind === 'encoding' ? Buffer.from([255]) : kind === 'wire' ? '\t'.repeat(600000) : 'ع'.repeat(10));
    await expect(collectSandboxOutputs(root, kind === 'size' ? 8 : undefined)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
  });
  it('rejects hard links and directory links, including a linked root', async () => {
    const root = await temp(), outside = await temp(); await writeFile(join(outside, 'source.txt'), 'Synthetic external fixture'); await link(join(outside, 'source.txt'), join(root, 'hard.txt'));
    await expect(collectSandboxOutputs(root)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' }); await rm(join(root, 'hard.txt'));
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); await expect(collectSandboxOutputs(root)).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' }); await expect(collectSandboxOutputs(join(root, 'linked'))).rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_REJECTED' });
  });
});

describe.skipIf(process.platform !== 'win32')('trusted native hardening fixtures', () => {
  // This private test seam is used only for repository-owned fixtures while M0's
  // TCP baseline may be unavailable. Public run() never bypasses availability.
  const trustedFixture = (sandbox: WindowsAppContainerSandbox, input: SandboxRunInput) =>
    (sandbox as unknown as { execute(input: SandboxRunInput): Promise<SandboxTestResult> }).execute(input);

  it('queries the full UI restriction mask from Windows before running a fixed test', async () => {
    const sandbox = new WindowsAppContainerSandbox();
    const result = await trustedFixture(sandbox, {
      files: [{ path: 'ui.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';test('trusted arithmetic',()=>assert.equal(2+3,5));" }],
      testFiles: ['ui.test.mjs'], timeoutMs: 4000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, isolationVerified: true, nativeControls: { uiRestrictionMask: 255, uiRestrictionsVerified: true } });
  });

  it('blocks child processes, workers and native addons before loading or spawning them', async () => {
    const sandbox = new WindowsAppContainerSandbox();
    const result = await trustedFixture(sandbox, {
      files: [{ path: 'node.test.mjs', content: `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {spawn} from 'node:child_process';import {Worker} from 'node:worker_threads';
test('permission boundary',()=>{
 assert.ok(process.permission);
 assert.equal(fs.readFileSync(import.meta.filename,'utf8').length>0,true);
 assert.throws(()=>fs.writeFileSync(import.meta.filename,'changed'),{code:'ERR_ACCESS_DENIED'});
 assert.throws(()=>fs.readFileSync(process.env.SystemRoot+'/mohassan-uncreated-sentinel'),{code:'ERR_ACCESS_DENIED'});
 fs.writeFileSync(process.env.TEMP+'/allowed.txt','ok');
 assert.throws(()=>spawn(process.execPath,['-e','process.exit(0)']),{code:'ERR_ACCESS_DENIED'});
 assert.throws(()=>new Worker('process.exit(0)',{eval:true}),{code:'ERR_ACCESS_DENIED'});
 assert.throws(()=>process.dlopen({exports:{}},process.env.TEMP+'/not-an-addon.node'),{code:'ERR_DLOPEN_DISABLED'});
 console.log('TRUSTED_NODE_CONTROLS_PROVEN');
});` }],
      testFiles: ['node.test.mjs'], timeoutMs: 4000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, isolationVerified: true });
    expect(result.stdout).toContain('TRUSTED_NODE_CONTROLS_PROVEN');
  });
  it('independently denies one fixed child process at the native Job boundary without Node permissions', async () => {
    const sandbox = new WindowsAppContainerSandbox();
    const input: SandboxRunInput = { files: [{ path: 'job.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';import{spawn}from 'node:child_process';test('native child blocked',async()=>{assert.equal(process.permission,undefined);const blocked=await new Promise(resolve=>{try{const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});child.once('error',()=>resolve(true));child.once('exit',code=>resolve(code!==0));}catch(error){resolve(['UNKNOWN','EAGAIN','EPERM','EACCES'].includes(error.code));}});assert.equal(blocked,true);});" }], testFiles: ['job.test.mjs'], timeoutMs: 4000 };
    const result = await (sandbox as unknown as { execute(input: SandboxRunInput, probe: boolean, permissions: boolean): Promise<SandboxTestResult> }).execute(input, false, false);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, isolationVerified: true });
  });

  it('reports actual native evidence independently and keeps executables disabled', async () => {
    const sandbox = new WindowsAppContainerSandbox();
    const availability = await sandbox.available();
    const report = await sandbox.executableReadiness();
    expect(report.enabled).toBe(false);
    expect(report.baselineVerified).toBe(availability.available);
    expect(report.gates.filter(gate => gate.status === 'verified').map(gate => gate.id)).toEqual(expect.arrayContaining(['G1', 'G3', 'G4', 'G6', 'G7']));
    expect(report.gates.find(gate => gate.id === 'G2')?.status).toBe('blocked'); expect(report.gates.find(gate => gate.id === 'G5')?.required).toBe(true);
    expect(sandbox.nodeRestrictionEvidence).toMatchObject({ exitCode: 0, timedOut: false });
    await expect(sandbox.runScript(script(''))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(sandbox.publicResourceProbeEvidence?.ordinary).toMatchObject({ exitCode: 0, timedOut: false });
    console.info('M7_NATIVE_DIAGNOSTIC', JSON.stringify({ baseline: availability.available, gates: report.gates.map(({ id, status }) => ({ id, status })), lpac: sandbox.lpacProbeEvidence?.nativeControls, lpacError: sandbox.lpacProbeError, publicControl: sandbox.publicResourceProbeEvidence?.ordinary.stdout, publicError: sandbox.publicResourceProbeError, channels: sandbox.sideChannelProbeEvidence?.stdout, channelControls: sandbox.sideChannelControlEvidence, channelError: sandbox.sideChannelProbeError }));
    if (!availability.available) {
      await expect(sandbox.run({ files: [{ path: 'blocked.test.mjs', content: "throw new Error('must not start')" }], testFiles: ['blocked.test.mjs'] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    }
  }, 60_000);

  it('executes only a fixed trusted entry with copied JSON, bounded output and queried requested memory', async () => {
    const result = await trustedScript(new WindowsAppContainerSandbox(), script("import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(process.env.MOHASSAN_INPUT_PATH,'utf8'));fs.writeFileSync(process.env.MOHASSAN_OUTPUT_DIR+'/result.txt',input.text);", { inputJson: JSON.stringify({ text: 'مخرج موثوق' }), memoryMb: 256, outputMaxBytes: 64 }));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, nativeControls: { memoryLimitBytes: 256 * 1024 * 1024 } }); expect(result.outputs).toEqual([expect.objectContaining({ path: 'result.txt', content: 'مخرج موثوق' })]);
  });

  it.each(['stdout', 'stderr', 'file'] as const)('rejects %s overflow from a bounded trusted fixture', async stream => {
    const content = stream === 'file' ? "import fs from 'node:fs';fs.writeFileSync(process.env.MOHASSAN_OUTPUT_DIR+'/large.txt','x'.repeat(2048));" : `process.${stream}.write('x'.repeat(70000));`;
    await expect(trustedScript(new WindowsAppContainerSandbox(), script(content, { outputMaxBytes: 1024 }))).rejects.toThrow();
  });

  it('terminates a fixed looping fixture at the requested native timeout and returns no artifacts', async () => {
    const result = await trustedScript(new WindowsAppContainerSandbox(), script('while(true){}', { timeoutMs: 200 })); expect(result).toMatchObject({ timedOut: true, exitCode: 124, outputs: [] });
  });

  it('cancels a running trusted fixture and confirms its PID is no longer alive', async () => {
    const controller = new AbortController(), pending = trustedScript(new WindowsAppContainerSandbox(), script("console.log('TRUSTED_PID='+process.pid);while(true){}", { timeoutMs: 10000, signal: controller.signal }));
    const timer = setTimeout(() => controller.abort(), 6000);
    try { const result = await pending; expect(result.exitCode).toBe(130); expect(result.outputs).toEqual([]); const pid = Number(result.stdout.match(/TRUSTED_PID=(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).toThrow(); }
    finally { clearTimeout(timer); }
  }, 20000);
});

describe.skipIf(process.platform !== 'win32')('local UDP and named-pipe positive controls', () => {
  it('proves both host controls and refuses a receiver hit from an isolated-attempt surrogate', async () => {
    const first = await localSideChannelProbe(); try { expect(await first.verifyDenial()).toMatchObject({ hostControlsBefore: true, hostControlsAfter: true, isolatedMessages: 0 }); } finally { await first.close(); }
    const second = await localSideChannelProbe(), socket = createSocket('udp4');
    try { await new Promise<void>((resolve, reject) => socket.send('controlled unexpected packet', second.udp[0]!.port, second.udp[0]!.host, error => error ? reject(error) : resolve())); await new Promise(resolve => setTimeout(resolve, 20)); await expect(second.verifyDenial()).rejects.toThrow(); }
    finally { socket.close(); await second.close(); }
  });
});
