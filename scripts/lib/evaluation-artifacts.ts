import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export interface EvaluationSourceSnapshot { name: string; bytes: Buffer }

/** Selected source evidence, not a runnable checkout. A run never reuses an output directory. */
export async function createEvaluationArtifactRun(root: string, sources: readonly EvaluationSourceSnapshot[]) {
  if (!sources.length || new Set(sources.map(source => source.name)).size !== sources.length || sources.some(source =>
    isAbsolute(source.name) || !/^[a-zA-Z0-9_./-]+$/.test(source.name) || source.name.split('/').some(part => !part || part === '..' || part === '.'))) {
    throw new Error('EVAL_ARTIFACT_SOURCE_INVALID');
  }
  await mkdir(root, { recursive: true });
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(root, `${startedAt.replace(/[:.]/g, '-')}-`));
  const files: Record<string, string> = {};
  for (const source of sources) {
    const destination = join(directory, 'sources', source.name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source.bytes, { flag: 'wx' });
    files[source.name] = createHash('sha256').update(source.bytes).digest('hex');
  }
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({
    version: 1, startedAt, scope: 'selected-source-snapshot', runnableCheckout: false,
    sourceHash: createHash('sha256').update(Object.values(files).join('\n')).digest('hex'), files,
  }, null, 2) + '\n', { flag: 'wx' });
  return {
    directory,
    async writeReport(report: unknown) {
      const destination = join(directory, 'report.json');
      await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      return destination;
    },
  };
}
