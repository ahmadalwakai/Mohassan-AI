import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuotaSlots, SandboxQuotaUnavailableError, WindowsAppContainerSandbox } from './index.ts';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mohassan-quota-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const exists = (path: string) => stat(path).then(() => true, () => false);

describe('quota slot leases', () => {
  it('reports no slots for an empty root and refuses to lease', async () => {
    await expect(new QuotaSlots(root).acquire()).rejects.toBeInstanceOf(SandboxQuotaUnavailableError);
    await expect(new QuotaSlots(join(root, 'missing')).acquire()).rejects.toBeInstanceOf(SandboxQuotaUnavailableError);
  });

  it('ignores anything that is not a numbered slot folder', async () => {
    await mkdir(join(root, 'slot-0')); await mkdir(join(root, 'other')); await writeFile(join(root, 'slot-1'), 'a file');
    expect(await new QuotaSlots(root).slots()).toEqual(['slot-0']);
  });

  it('gives each slot to one run, reports busy, and frees it on release', async () => {
    await mkdir(join(root, 'slot-0'));
    const slots = new QuotaSlots(root), lease = await slots.acquire();
    await expect(slots.acquire()).rejects.toMatchObject({ code: 'SANDBOX_QUOTA_UNAVAILABLE' });
    await writeFile(join(lease.directory, 'scratch.txt'), 'run data');
    await lease.release();
    expect(await readdir(join(root, 'slot-0'))).toEqual([]);
    expect(await exists(join(root, 'slot-0.lock'))).toBe(false);
    await (await slots.acquire()).release();
  });

  it('never lets two concurrent acquires share a slot', async () => {
    await mkdir(join(root, 'slot-0')); await mkdir(join(root, 'slot-1'));
    const results = await Promise.allSettled([1, 2, 3].map(() => new QuotaSlots(root).acquire()));
    const won = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(won).toHaveLength(2);
    expect(new Set(won.map(lease => lease.directory.split(/[\\/]/).at(-2))).size).toBe(2);
    await Promise.all(won.map(lease => lease.release()));
  });

  it('reclaims a slot from a dead owner and clears what that run left behind', async () => {
    await mkdir(join(root, 'slot-0'));
    const stale = join(root, 'slot-0', 'mohassan-sandbox-stale'); await mkdir(stale); await writeFile(join(stale, 'left.txt'), 'old');
    await writeFile(join(root, 'slot-0.lock'), '2147483646');
    const lease = await new QuotaSlots(root).acquire();
    expect(await exists(stale)).toBe(false);
    await lease.release();
  });

  it('does not reclaim a slot held by a live process', async () => {
    await mkdir(join(root, 'slot-0'));
    await writeFile(join(root, 'slot-0.lock'), String(process.pid));
    await expect(new QuotaSlots(root).acquire()).rejects.toMatchObject({ code: 'SANDBOX_QUOTA_UNAVAILABLE' });
  });
});

describe.skipIf(process.platform !== 'win32')('the native helper proves the quota volume', () => {
  it('refuses an ordinary folder before any process exists and keeps G2 closed', async () => {
    await mkdir(join(root, 'slot-0'));
    const sandbox = new WindowsAppContainerSandbox({ quotaRoot: root });
    await (sandbox as unknown as { probeDiskQuota(): Promise<void> }).probeDiskQuota();
    expect(sandbox.quotaProbeError).toContain('not a separate bounded volume');
    expect(sandbox.quotaProbeEvidence).toBeUndefined();
    expect((await sandbox.executableReadiness()).gates.find(gate => gate.id === 'G2')?.status).toBe('blocked');
    expect(await readdir(join(root, 'slot-0'))).toEqual([]);
  }, 30_000);

  it('keeps G2 closed with a clear reason when no quota root is configured', async () => {
    const sandbox = new WindowsAppContainerSandbox({ quotaRoot: '' });
    await (sandbox as unknown as { probeDiskQuota(): Promise<void> }).probeDiskQuota();
    expect(sandbox.quotaProbeError).toBeTruthy();
    expect((await sandbox.executableReadiness()).gates.find(gate => gate.id === 'G2')?.status).toBe('blocked');
  }, 30_000);
});
