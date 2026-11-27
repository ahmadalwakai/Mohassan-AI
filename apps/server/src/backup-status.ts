import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BackupStatusResponse } from '@mohassan/contracts';
import { z } from 'zod';

const statusDirectory = '/var/lib/mohassan-backup-status';
const drillReportName = /^restore-drill-\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z\.json$/;
const timestamp = z.iso.datetime({ offset: true });
const backupStatus = z.object({
  snapshotAt: timestamp,
  finishedAt: timestamp,
  sizeBytes: z.int().positive().optional().catch(undefined),
});
const drillStatus = z.object({ finishedAt: timestamp, verdict: z.enum(['passed', 'failed']) });
const copyStatus = z.object({ downloadedAt: timestamp });

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readStatus(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readLatestDrill(directory: string): Promise<unknown> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (missing(error)) return [];
    throw error;
  });
  const latest = entries.filter(entry => entry.isFile() && drillReportName.test(entry.name))
    .map(entry => entry.name).sort().at(-1);
  return latest ? readStatus(join(directory, latest)) : null;
}

export function registerBackupStatusRoute(
  app: FastifyInstance,
  owner: (request: FastifyRequest) => Promise<unknown>,
  directory = statusDirectory,
) {
  app.get('/api/ops/backup-status', async (request): Promise<BackupStatusResponse> => {
    await owner(request);
    const [backupData, drillData, copyData] = await Promise.all([
      readStatus(join(directory, 'backup.json')),
      readLatestDrill(directory),
      readStatus(join(directory, 'off-server-copy.json')),
    ]);
    const backup = backupStatus.safeParse(backupData).data;
    const drill = drillStatus.safeParse(drillData).data;
    const copy = copyStatus.safeParse(copyData).data;
    const now = Date.now();
    const ageHours = (time: string) => Math.max(0, (now - Date.parse(time)) / 3_600_000);
    return {
      newestDump: backup ? { ...backup, ageHours: ageHours(backup.snapshotAt) } : null,
      lastDrill: drill ? { ...drill, ageHours: ageHours(drill.finishedAt) } : null,
      offServerCopy: copy ?? null,
    };
  });
}
