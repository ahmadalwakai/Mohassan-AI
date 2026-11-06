import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsAppContainerSandbox, type SandboxRunInput, type SandboxTestResult } from '../packages/sandbox/src/index.js';

describe.skipIf(process.platform !== 'win32')('AppContainer control-plane boundary', () => {
  it('cannot open the protected host configuration or inherit service credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-control-plane-'));
    const protectedPath = join(directory, 'synthetic-control-plane.txt');
    // The fixture has no real credentials. A failed boundary must never expose real configuration.
    await writeFile(protectedPath, 'synthetic-private-canary-only', { flag: 'wx' });
    try {
    const metadata = await lstat(protectedPath);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);

    const sandbox = new WindowsAppContainerSandbox();
    expect((await sandbox.available()).available).toBe(true);
    const content = `import test from 'node:test';import assert from 'node:assert/strict';import{openSync,closeSync}from 'node:fs';
test('host configuration is inaccessible',()=>{
  let deniedCode=null;
  try { const handle=openSync(${JSON.stringify(protectedPath)},'r');closeSync(handle); }
  catch(error){deniedCode=error.code;}
  assert.ok(['EACCES','EPERM'].includes(deniedCode),'The OS must deny opening control-plane configuration.');
  assert.equal(process.env.GROQ_API_KEY,undefined);
  assert.equal(process.env.DATABASE_URL,undefined);
  console.log('CONTROL_PLANE_OPEN_DENIED');
});`;
    // Repository-owned synthetic fixture only: omit the Node permission layer
    // so ERR_ACCESS_DENIED cannot stand in for the required native OS denial.
    // The overall availability assertion above still gates this acceptance test.
    const nativeFixture = sandbox as unknown as {execute(input: SandboxRunInput, probe: boolean, enforceNodePermissions: boolean): Promise<SandboxTestResult>};
    const result = await nativeFixture.execute({
      files: [{ path: 'control-plane.test.mjs', content }],
      testFiles: ['control-plane.test.mjs'],
      timeoutMs: 4000,
    }, false, false);
    expect(result).toMatchObject({ exitCode: 0, isolationVerified: true, isolation: 'appcontainer', network: 'denied' });
    expect(result.stdout).toContain('CONTROL_PLANE_OPEN_DENIED');
    expect(result.stderr).toBe('');
    } finally {
      const target = resolve(directory), base = resolve(tmpdir());
      if (!target.startsWith(base + sep) || !target.includes('mohassan-control-plane-')) throw new Error('Unsafe fixture cleanup target');
      await rm(target, { recursive: true, force: true });
    }
  }, 120_000);
});
