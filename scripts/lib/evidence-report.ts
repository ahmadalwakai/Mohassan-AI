import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Fresh directories and exclusive writes keep earlier acceptance evidence intact. */
export async function createEvidenceRun(repository: string, name: string, startedAt: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || !Number.isFinite(Date.parse(startedAt))) throw new Error('Invalid evidence run identity');
  const root = path.join(repository, 'artifacts', 'runs');
  await mkdir(root, { recursive: true });
  const prefix = name + '-' + new Date(startedAt).toISOString().replace(/[:.]/g, '-') + '-';
  const directory = await mkdtemp(path.join(root, prefix));
  const reportPath = path.join(directory, 'report.json');
  return {
    directory,
    reportPath,
    writeReport: async (report: unknown) => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }),
  };
}

export async function captureEvidenceSources(repository: string, files: readonly string[], snapshotDirectory?: string) {
  const entries: [string, string][] = [];
  for (const name of [...new Set(files)].sort()) {
    if (!name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid evidence source path');
    const bytes = await readFile(path.join(repository, name));
    entries.push([name, createHash('sha256').update(bytes).digest('hex')]);
    if (snapshotDirectory) {
      const target = path.join(snapshotDirectory, 'source', name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
  }
  return { files: Object.fromEntries(entries), hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
