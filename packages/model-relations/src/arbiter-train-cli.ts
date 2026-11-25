import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assessArbiterPromotion, parseArbiterReplay, trainArbiter, type DevelopmentResult } from './arbiter-training.js';

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path: string, data: unknown) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    replay: { type: 'string' }, report: { type: 'string' }, artifact: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' },
  } });
  const [mode] = positionals;
  if (positionals.length === 1 && mode === 'train' && values.replay && values.report && !values.before && !values.after) {
    const { artifact, receipt } = trainArbiter(parseArbiterReplay(await readJson(values.replay)));
    if (artifact && values.artifact) await writeJson(values.artifact, artifact);
    await writeJson(values.report, { ...receipt, artifactWritten: Boolean(artifact && values.artifact) });
    return;
  }
  if (positionals.length === 1 && mode === 'gate' && values.before && values.after && values.report && !values.replay && !values.artifact) {
    const [before, after] = await Promise.all([readJson(values.before), readJson(values.after)]);
    if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('Expected arrays of full development case results.');
    const gate = assessArbiterPromotion(before as DevelopmentResult[], after as DevelopmentResult[]);
    await writeJson(values.report, gate);
    if (!gate.holdsAllGroups) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: train --replay FILE --report FILE [--artifact FILE] or gate --before FILE --after FILE --report FILE.');
}

void main().catch(error => {
  // JSON parser errors can quote input data, so keep all read/parse diagnostics generic.
  console.error(error instanceof SyntaxError ? 'Invalid input JSON.' : (error as Error).message);
  process.exitCode = 1;
});
