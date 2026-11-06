import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The largest volume accepted as a per-run quota. The native helper reads the real capacity from Windows. */
export const quotaVolumeMaxBytes = 256 * 1024 * 1024;
const runPrefix = 'mohassan-sandbox-';
const slotName = /^slot-\d{1,2}$/;

export interface QuotaLease { directory: string; release(): Promise<void> }
export class SandboxQuotaUnavailableError extends Error { readonly code = 'SANDBOX_QUOTA_UNAVAILABLE'; }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Slots are fixed-size volumes mounted as folders under one root by `scripts/isolation-admin-setup.ps1`.
 * This class only leases a slot. Proof that a slot is a separate bounded volume belongs to the native helper,
 * which refuses an ordinary folder before any process exists.
 */
export class QuotaSlots {
  constructor(private readonly root: string) {}
  async slots(): Promise<string[]> {
    const names = (await readdir(this.root).catch(() => [] as string[])).filter(name => slotName.test(name)).sort();
    const folders = await Promise.all(names.map(async name => (await stat(join(this.root, name)).catch(() => null))?.isDirectory() ? name : null));
    return folders.filter((name): name is string => name !== null);
  }
  private async lock(slot: string): Promise<(() => Promise<void>) | null> {
    const path = join(this.root, `${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx');
        await handle.writeFile(String(process.pid)); await handle.close();
        return () => rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await readFile(path, 'utf8').catch(() => ''));
        // A missing pid can be a lock still being written, so only a dead owner is reclaimed.
        if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return null;
        await rm(path, { force: true });
      }
    }
    return null;
  }
  async acquire(): Promise<QuotaLease> {
    const slots = await this.slots();
    if (!slots.length) throw new SandboxQuotaUnavailableError('لا توجد وحدات حصة قرص مركبة.');
    for (const slot of slots) {
      const unlock = await this.lock(slot);
      if (!unlock) continue;
      const base = join(this.root, slot);
      try {
        // The lock is exclusive, so anything left here belongs to a dead run.
        for (const name of await readdir(base)) if (name.startsWith(runPrefix)) await rm(join(base, name), { recursive: true, force: true });
        const directory = await mkdtemp(join(base, runPrefix));
        return { directory, release: async () => {
          try {
            if (dirname(directory) !== base || !basename(directory).startsWith(runPrefix)) throw new Error('Invalid quota cleanup target.');
            await rm(directory, { recursive: true, force: true });
          } finally { await unlock(); }
        } };
      } catch (error) { await unlock(); throw error; }
    }
    throw new SandboxQuotaUnavailableError('كل وحدات حصة القرص مشغولة؛ لم يبدأ أي تشغيل.');
  }
}
