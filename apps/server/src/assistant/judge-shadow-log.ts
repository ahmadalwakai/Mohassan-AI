import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const ARCHIVES_TO_KEEP = 14;
// Divide a 256 MiB log allocation among the active log, retained archives and one gzip staging file.
// A legacy file or a single oversized record stays whole, and gzip framing adds a small overhead.
const MAX_LOG_BYTES = (256 * 1024 ** 2) / (ARCHIVES_TO_KEEP + 2);

async function regularFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('Judge log must be a regular file');
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

// The caller serializes appends and owns this log path. Move the active file then gzip it into a staging
// file, publishing the gzip before deleting the original. A later write resumes interrupted compression.
// https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrenameoldpath-newpath (retrieved 2026-11-25)
export function createJudgeLogWriter(logFile: string, maxLogBytes = MAX_LOG_BYTES) {
  const directory = dirname(logFile);
  const archivePrefix = `${basename(logFile)}.`;
  let activeDay: string | undefined;
  let directoryReady = false;
  let maintenancePending = true;

  async function archiveIds() {
    const files = await readdir(directory, { withFileTypes: true });
    const ids = new Set<string>();
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith(archivePrefix)) continue;
      const entry = file.name.slice(archivePrefix.length);
      if (/^\d{13}(?:\.gz)?$/u.test(entry)) ids.add(entry.slice(0, 13));
    }
    return [...ids].sort().reverse();
  }

  async function maintainArchives(ids: string[]) {
    // Prune older archives first even if compressing a newer one fails.
    for (const id of ids.slice(ARCHIVES_TO_KEEP)) {
      const path = `${logFile}.${id}`;
      for (const suffix of ['', '.gz', '.tmp']) await rm(`${path}${suffix}`, { force: true });
    }
    for (const id of ids.slice(0, ARCHIVES_TO_KEEP)) {
      const path = `${logFile}.${id}`;
      if (!(await regularFile(path))) continue;
      const temp = `${path}.tmp`;
      await rm(temp, { force: true });
      try {
        await pipeline(createReadStream(path), createGzip(), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        await rename(temp, `${path}.gz`);
        await rm(path);
      } finally {
        await rm(temp, { force: true });
      }
    }
  }

  return async function append(line: string, utcDay: string) {
    if (!directoryReady) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      directoryReady = true;
    }
    const active = await regularFile(logFile);
    const day = activeDay ?? active?.mtime.toISOString().slice(0, 10);
    let ids: string[] | undefined;
    if (active?.size && (day !== utcDay || active.size + Buffer.byteLength(line) > maxLogBytes)) {
      ids = await archiveIds();
      const stamp = Math.max(Date.now(), Number(ids[0] ?? 0) + 1).toString().padStart(13, '0');
      await rename(logFile, `${logFile}.${stamp}`);
      ids.unshift(stamp);
      maintenancePending = true;
    }

    await appendFile(logFile, line, { encoding: 'utf8', mode: 0o600 });
    activeDay = utcDay;
    if (maintenancePending) {
      await maintainArchives(ids ?? await archiveIds());
      maintenancePending = false;
    }
  };
}
