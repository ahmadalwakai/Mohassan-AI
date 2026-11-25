import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lpacRegistryReadCapability, snapshotHash, WindowsAppContainerSandbox, type SandboxFile, type SandboxRunInput, type SandboxTestResult } from './index.js';

type PowerShellIdentity = { kind: 'packaged' | 'unpackaged'; path: string; packageFullName: string | null; initialStatus: number }
  | { kind: 'unavailable' | 'error'; detail: string };

/** Directory names do not establish process identity: https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getcurrentpackagefullname */
function discoverPowerShellIdentity(): PowerShellIdentity {
  if (process.platform !== 'win32') return { kind: 'unavailable', detail: 'Optional PowerShell discovery requires Windows.' };
  const resolved = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'],
    { encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024 });
  if (resolved.error && 'code' in resolved.error && resolved.error.code === 'ENOENT') return { kind: 'unavailable', detail: 'Optional pwsh.exe is not installed.' };
  const executable = resolved.stdout?.trim();
  if (resolved.error || resolved.status !== 0 || !executable || /[\r\n\u0000]/u.test(executable)) {
    return { kind: 'error', detail: `PowerShell path discovery failed: ${resolved.error?.message ?? `exit=${resolved.status}; ${resolved.stderr?.trim().slice(0, 500)}`}` };
  }
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -WarningAction Stop -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class MohassanSandboxHostIdentityProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetCurrentPackageFullName(ref uint length, StringBuilder fullName);
}
'@
[uint32]$length = 0
$initialStatus = [MohassanSandboxHostIdentityProbe]::GetCurrentPackageFullName([ref]$length, $null)
$status = $initialStatus
$packageFullName = $null
if ($initialStatus -eq 122) {
  if ($length -lt 1 -or $length -gt 32768) { throw 'Invalid package identity buffer size.' }
  $buffer = [System.Text.StringBuilder]::new([int]$length)
  $status = [MohassanSandboxHostIdentityProbe]::GetCurrentPackageFullName([ref]$length, $buffer)
  $packageFullName = $buffer.ToString()
}
@{ path=(Get-Process -Id $PID).Path; initialStatus=$initialStatus; status=$status; packageFullName=$packageFullName } | ConvertTo-Json -Compress
`;
  // An AppExecutionAlias may activate a different package context. Query through
  // the exact resolved image and sanitized environment used by sandbox.execute.
  const probe = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024,
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: tmpdir(), TMP: tmpdir(), PATH: 'C:\\Windows\\System32' } });
  if (probe.error || probe.status !== 0) return { kind: 'error', detail: `PowerShell package identity probe failed: ${probe.error?.message ?? `exit=${probe.status}; ${probe.stderr?.trim().slice(0, 500)}`}` };
  try {
    const identity = JSON.parse(probe.stdout.trim());
    if (!identity || typeof identity.path !== 'string' || !identity.path.trim()) throw new Error('Missing executable identity.');
    // APPMODEL_ERROR_NO_PACKAGE=15700 is the native runner's exact prerequisite.
    if (identity.initialStatus === 15700 && identity.status === 15700 && identity.packageFullName === null) {
      return { kind: 'unpackaged', path: identity.path, packageFullName: null, initialStatus: 15700 };
    }
    // A zero-buffer query reports ERROR_INSUFFICIENT_BUFFER=122 for a packaged
    // process, followed by ERROR_SUCCESS=0 and a nonempty full package name.
    if (identity.initialStatus === 122 && identity.status === 0 && typeof identity.packageFullName === 'string' && identity.packageFullName.trim()) {
      return { kind: 'packaged', path: identity.path, packageFullName: identity.packageFullName, initialStatus: 122 };
    }
    return { kind: 'error', detail: `Unexpected native package identity result: ${probe.stdout.trim().slice(0, 500)}` };
  } catch (error) { return { kind: 'error', detail: `Invalid package identity evidence: ${error instanceof Error ? error.message : String(error)}` }; }
}

describe('sandbox input boundary', () => {
  it.each(['../outside.mjs', '.git/config', '.env', 'src/.env.local', 'C:/outside.mjs', 'src\\outside.mjs', '.ENV.LOCAL', 'src/NUL.mjs', 'src/trailing.'])('rejects disallowed path %s before creating any process', async (path) => {
    const sandbox = new WindowsAppContainerSandbox();
    await expect(sandbox.run({ files: [{ path, content: 'test' }], testFiles: [path] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(sandbox.probeEvidence).toBeUndefined();
  });
  it('pins one identical registryRead capability in the native runner and the result check', () => {
    const runner = readFileSync(new URL('../native/Runner.cs', import.meta.url), 'utf8');
    const pinned = [...runner.matchAll(/RegistryReadCapability="(S-1-15-3-[0-9-]+)"/g)].map(match => match[1]);
    expect(pinned).toEqual([lpacRegistryReadCapability]);
    // The well-known registryRead capability SID; any other capability is rejected.
    expect(lpacRegistryReadCapability).toBe('S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681');
    expect(runner).toContain('lowPrivilege?result.capabilityCount==1&&capabilityEnabled&&result.capabilitySid==RegistryReadCapability:result.capabilityCount==0');
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

  it('runs the pinned TypeScript check and validates TSX syntax and JSON before the frozen Node tests', async () => {
    const files: SandboxFile[] = [
      { path: 'tsconfig.json', content: '{"compilerOptions":{"types":[],"strict":true,"composite":true},"files":["src/math.ts"]}' },
      { path: 'src/math.ts', content: 'export const value: number = 3;' },
      { path: 'src/view.tsx', content: 'throw new Error("TSX must not execute");\nexport const view = <span />;' },
      { path: 'data.json', content: '{"value":3}' },
      { path: 'math.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './src/math.ts';test('number',()=>assert.equal(value,3));" },
    ];
    const run = { files, testFiles: ['math.test.mjs'], syntaxFiles: ['src/view.tsx'], jsonFiles: ['data.json'], typecheck: { project: 'tsconfig.json' }, timeoutMs: 10_000 };
    const passed = await sandbox.run(run);
    expect(passed).toMatchObject({ exitCode: 0, isolationVerified: true, snapshotHash: snapshotHash(files) });
    expect(passed.stdout).toContain('pass 1');
    const brokenTypes = files.map(file => file.path === 'src/math.ts' ? { ...file, content: 'export const value: number = "wrong";' } : file);
    const rejectedTypes = await sandbox.run({ ...run, files: brokenTypes });
    expect(rejectedTypes.exitCode).not.toBe(0);
    expect(rejectedTypes.stdout).toContain('TS2322');
    const brokenJson = files.map(file => file.path === 'data.json' ? { ...file, content: '{"value":}' } : file);
    const rejectedJson = await sandbox.run({ ...run, files: brokenJson });
    expect(rejectedJson.exitCode).not.toBe(0);
    expect(rejectedJson.stderr).toContain('SyntaxError');
    const brokenTsx = files.map(file => file.path === 'src/view.tsx' ? { ...file, content: 'export const view = <span;' } : file);
    const rejectedTsx = await sandbox.run({ ...run, files: brokenTsx });
    expect(rejectedTsx.exitCode).not.toBe(0);
    expect(rejectedTsx.stderr).toContain('TS1003');
  }, 60_000);

  it('runs ESLint --fix on private copies and limits layout fixes to requested formatting', async () => {
    const files: SandboxFile[] = [
      { path: 'eslint.config.mjs', content: 'export default [{rules:{"prefer-const":"error","semi":["error","always"]}}];' },
      { path: 'src/math.mjs', content: 'let value = 3\nexport { value }\n' },
    ];
    const lint = { files, configPath: 'eslint.config.mjs', fixFiles: ['src/math.mjs'], formatting: false };
    const repaired = await sandbox.lintFix(lint);
    expect(repaired).toMatchObject({
      exitCode: 1, isolationVerified: true, snapshotHash: snapshotHash(files),
      fixes: [{ path: 'src/math.mjs', content: 'const value = 3\nexport { value }\n' }],
    });
    const formatted = await sandbox.lintFix({ ...lint, formatting: true });
    expect(formatted).toMatchObject({
      exitCode: 0, isolationVerified: true, snapshotHash: snapshotHash(files),
      fixes: [{ path: 'src/math.mjs', content: 'const value = 3;\nexport { value };\n' }],
    });
  }, 60_000);

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
  const powerShellIdentity = discoverPowerShellIdentity();
  it.skipIf(powerShellIdentity.kind === 'unavailable')('discovers optional PowerShell package identity using the native API', () => {
    expect(powerShellIdentity.kind, 'detail' in powerShellIdentity ? powerShellIdentity.detail : undefined).not.toBe('error');
    if (powerShellIdentity.kind === 'packaged') {
      expect(powerShellIdentity.initialStatus).toBe(122);
      expect(powerShellIdentity.packageFullName).toBeTruthy();
    } else if (powerShellIdentity.kind === 'unpackaged') {
      expect(powerShellIdentity.initialStatus).toBe(15700);
      expect(powerShellIdentity.packageFullName).toBeNull();
    }
  });
  const packagedPwsh = powerShellIdentity.kind === 'packaged' ? powerShellIdentity.path : undefined;
  it.skipIf(!packagedPwsh)('refuses a packaged PowerShell host instead of running in its child AppContainer', async () => {
    const refused = new WindowsAppContainerSandbox({ powerShellPath: packagedPwsh });
    // This message comes after the host started, so the refusal is the runner's own package check.
    await expect((refused as unknown as { execute(input: unknown): Promise<unknown> }).execute({ files: [{ path: 'a.test.mjs', content: "import test from 'node:test';test('x',()=>{});" }], testFiles: ['a.test.mjs'], timeoutMs: 4000 })).rejects.toThrow('فشل إثبات عزل العملية');
    expect((refused as unknown as { lastNativeError?: string }).lastNativeError).toBe('Sandbox host must be unpackaged.');
    expect((await refused.available()).available).toBe(false);
  }, 30_000);
  const unpackagedWindowsAppsPwsh = powerShellIdentity.kind === 'unpackaged' && /\\WindowsApps\\/iu.test(powerShellIdentity.path) ? powerShellIdentity.path : undefined;
  it.skipIf(!unpackagedWindowsAppsPwsh)('runs an unpackaged WindowsApps PowerShell host only with verified isolation', async () => {
    const accepted = new WindowsAppContainerSandbox({ powerShellPath: unpackagedWindowsAppsPwsh });
    expect((await accepted.available()).available).toBe(true);
    expect(accepted.probeEvidence).toMatchObject({ isolation: 'appcontainer', isolationVerified: true, network: 'denied', exitCode: 0 });
    expect(accepted.probeEvidence?.stdout).toContain('MOHASSAN_BOUNDARY_PROVEN');
    const verdicts = accepted.probeEvidence?.stdout.match(/^BOUNDARY_NETWORK=.+$/gm) ?? [];
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts).toHaveLength(accepted.networkProbeEvidence?.length ?? 0);
    for (const verdict of verdicts) expect(verdict).toMatch(/:(?:EACCES|EPERM|ETIMEDOUT)\s*$/);
    expect(accepted.networkProbeEvidence?.every(entry => entry.controlBefore && entry.controlAfter && entry.isolatedConnections === 0)).toBe(true);
    const files = [{ path: 'unpackaged-host.test.mjs', content: "import test from 'node:test';import assert from 'node:assert/strict';test('isolated host',()=>assert.equal(2+3,5));" }];
    const result = await accepted.run({ files, testFiles: ['unpackaged-host.test.mjs'], timeoutMs: 5000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, isolation: 'appcontainer', isolationVerified: true, network: 'denied',
      snapshotHash: snapshotHash(files), nativeControls: { lowPrivilege: false, memoryLimitBytes: 512 * 1024 * 1024,
        quotaVolumeBytes: 0, uiRestrictionMask: 255, uiRestrictionsVerified: true } });
    expect(result.stdout).toContain('pass 1');
  }, 120_000);
  it('stays unavailable when the trusted host cannot start', async () => {
    const missing = new WindowsAppContainerSandbox({ powerShellPath: 'C:\Windows\System32\WindowsPowerShell\v1.0\missing.exe' });
    await expect(missing.run({ files: [{ path: 'a.test.mjs', content: "import test from 'node:test';test('x',()=>{});" }], testFiles: ['a.test.mjs'] })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});
