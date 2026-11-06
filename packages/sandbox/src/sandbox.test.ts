import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotHash, WindowsAppContainerSandbox, type SandboxFile, type SandboxRunInput, type SandboxTestResult } from './index.js';

describe('sandbox input boundary', () => {
  it.each(['../outside.mjs', '.git/config', '.env', 'src/.env.local', 'C:/outside.mjs', 'src\\outside.mjs', '.ENV.LOCAL', 'src/NUL.mjs', 'src/trailing.'])('rejects disallowed path %s before creating any process', async (path) => {
    const sandbox = new WindowsAppContainerSandbox();
    await expect(sandbox.run({ files: [{ path, content: 'test' }], testFiles: [path] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(sandbox.probeEvidence).toBeUndefined();
  });
  it('hashes a canonical immutable snapshot independent of input ordering', () => {
    const files = [{ path: 'b.mjs', content: 'b' }, { path: 'a.mjs', content: 'a' }];
    expect(snapshotHash(files)).toBe(snapshotHash([...files].reverse()));
    expect(snapshotHash(files)).not.toBe(snapshotHash([{ path: 'b.mjs', content: 'changed' }, files[1]]));
  });
});

describe.skipIf(process.platform !== 'win32')('real Windows AppContainer + Job boundary', () => {
  const sandbox = new WindowsAppContainerSandbox();
  beforeAll(async () => { expect((await sandbox.available()).available).toBe(true); }, 120_000);

  it('proves network, immutable source, outside file denial and a clean environment using controlled sentinels', () => {
    expect(sandbox.probeEvidence).toMatchObject({ isolation: 'appcontainer', isolationVerified: true, network: 'denied', exitCode: 0 });
    expect(sandbox.probeEvidence?.stdout).toContain('MOHASSAN_BOUNDARY_PROVEN');
    expect(sandbox.probeEvidence?.stdout).toMatch(/BOUNDARY_NETWORK=127\.0\.0\.1:(?:EACCES|EPERM|ETIMEDOUT)/);
    expect(sandbox.probeEvidence?.stdout).not.toContain('unproven_timeout');
    // Every probed interface needs an OS verdict, not only loopback.
    const verdicts = sandbox.probeEvidence?.stdout.match(/^BOUNDARY_NETWORK=.+$/gm) ?? [];
    expect(verdicts).toHaveLength(sandbox.networkProbeEvidence?.length ?? 0);
    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) expect(verdict).toMatch(/:(?:EACCES|EPERM|ETIMEDOUT)\s*$/);
    expect(sandbox.networkProbeEvidence?.length).toBeGreaterThan(0);
    expect(sandbox.networkProbeEvidence?.every(entry => entry.controlBefore && entry.controlAfter && entry.isolatedConnections === 0)).toBe(true);
  });

  it('runs syntax and frozen builtin tests only inside the OS boundary', async () => {
    const files: SandboxFile[] = [
      { path: 'math.mjs', content: 'export const add=(a,b)=>a+b;' },
      { path: 'math.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';import{add}from './math.mjs';test('sum',()=>assert.equal(add(2,3),5));" },
    ];
    const result = await sandbox.run({ files, testFiles: ['math.test.mjs'], syntaxFiles: ['math.mjs'], timeoutMs: 5000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, isolationVerified: true, snapshotHash: snapshotHash(files) });
    expect(result.stdout).toContain('pass 1');
  });

  it('enforces the single-process Job limit in a repository-owned fixture without Node permissions', async () => {
    const files = [{ path: 'process.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';import{spawn}from 'node:child_process';test('child blocked',async()=>{const blocked=await new Promise(resolve=>{try{const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});child.once('error',()=>resolve(true));child.once('exit',code=>resolve(code!==0));}catch(error){resolve(['UNKNOWN','EAGAIN','EPERM','EACCES'].includes(error.code));}});assert.equal(blocked,true);});" }];
    const result = await (sandbox as unknown as { execute(input: SandboxRunInput, probe: boolean, enforceNodePermissions: boolean): Promise<SandboxTestResult> }).execute({ files, testFiles: ['process.test.mjs'], timeoutMs: 4000 }, false, false);
    expect(result).toMatchObject({ exitCode: 0, isolationVerified: true });
  });

  it('terminates an infinite test at the Job wall deadline', async () => {
    const files = [{ path: 'timeout.test.mjs', content: "import test from 'node:test';test('loop',()=>{while(true){}});" }];
    const result = await sandbox.run({ files, testFiles: ['timeout.test.mjs'], timeoutMs: 200 });
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, isolationVerified: true });
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('does not run tests after an unimported source file fails syntax verification', async () => {
    const files = [
      { path: 'broken.mjs', content: 'export const broken = ;' },
      { path: 'unrelated.test.mjs', content: "import test from 'node:test';test('unrelated',()=>console.log('SHOULD_NOT_RUN'));" },
    ];
    const result = await sandbox.run({ files, syntaxFiles: ['broken.mjs'], testFiles: ['unrelated.test.mjs'], timeoutMs: 4000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('SyntaxError');
    expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
  });

  it('cancels the Job and leaves no isolated Node process running', async () => {
    const files = [{ path: 'cancel.test.mjs', content: "import test from 'node:test';test('loop',()=>{console.log('ISOLATED_PID='+process.pid);while(true){}});" }];
    const controller = new AbortController();
    const pending = sandbox.run({ files, testFiles: ['cancel.test.mjs'], signal: controller.signal, timeoutMs: 10_000 });
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const result = await pending;
      expect(result).toMatchObject({ exitCode: 130, timedOut: false, isolationVerified: true });
      const pid = Number(result.stdout.match(/ISOLATED_PID=(\d+)/)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { clearTimeout(timer); }
  });
  it('keeps non-ASCII test output intact across the host boundary', async () => {
    const result = await sandbox.run({ files: [{ path: 'text.test.mjs', content: "import test from 'node:test';test('نص',()=>{console.log('نتيجة عربية');});" }], testFiles: ['text.test.mjs'], timeoutMs: 8000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('نتيجة عربية');
  });
  const pwshPath = spawnSync('pwsh.exe', ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const packagedPwsh = pwshPath?.includes('\\WindowsApps\\') ? pwshPath : undefined;
  it.skipIf(!packagedPwsh)('refuses a packaged PowerShell host instead of running in its child AppContainer', async () => {
    const refused = new WindowsAppContainerSandbox({ powerShellPath: packagedPwsh });
    // This message comes after the host started, so the refusal is the runner's own package check.
    await expect((refused as unknown as { execute(input: unknown): Promise<unknown> }).execute({ files: [{ path: 'a.test.mjs', content: "import test from 'node:test';test('x',()=>{});" }], testFiles: ['a.test.mjs'], timeoutMs: 4000 })).rejects.toThrow('فشل إثبات عزل العملية');
    expect((await refused.available()).available).toBe(false);
  }, 30_000);
  it('stays unavailable when the trusted host cannot start', async () => {
    const missing = new WindowsAppContainerSandbox({ powerShellPath: 'C:\Windows\System32\WindowsPowerShell\v1.0\missing.exe' });
    await expect(missing.run({ files: [{ path: 'a.test.mjs', content: "import test from 'node:test';test('x',()=>{});" }], testFiles: ['a.test.mjs'] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});
