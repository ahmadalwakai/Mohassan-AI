import { lstat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WindowsAppContainerSandbox } from '../packages/sandbox/src/index.js';

describe.skipIf(process.platform !== 'win32')('AppContainer control-plane boundary', () => {
  it('cannot open the protected host configuration or inherit service credentials', async () => {
    const protectedPath = 'C:/Mohassan AI/.env';
    // Metadata only: the host test never opens or reads configuration content.
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
    const result = await sandbox.run({
      files: [{ path: 'control-plane.test.mjs', content }],
      testFiles: ['control-plane.test.mjs'],
      timeoutMs: 4000,
    });
    expect(result).toMatchObject({ exitCode: 0, isolationVerified: true, isolation: 'appcontainer', network: 'denied' });
    expect(result.stdout).toContain('CONTROL_PLANE_OPEN_DENIED');
    expect(result.stderr).toBe('');
  }, 30_000);
});
