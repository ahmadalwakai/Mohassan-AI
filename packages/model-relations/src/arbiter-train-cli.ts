import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assessArbiterPromotion, parseArbiterReplay, trainArbiter, type DevelopmentResult } from './arbiter-training.js';
import { assessMonitorArbiterPromotion, trainMonitorArbiter } from './monitor-arbiter-training.js';
import { monitorArtifactSha256, readMonitorArtifact } from './monitor-decision.js';

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path: string, data: unknown) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    replay: { type: 'string' }, report: { type: 'string' }, artifact: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, weights: { type: 'string' },
  } });
  const [mode] = positionals;
  if (positionals.length === 1 && mode === 'train' && values.replay && values.report && !values.before && !values.after && !values.weights) {
    const { artifact, receipt } = trainArbiter(parseArbiterReplay(await readJson(values.replay)));
    if (artifact && values.artifact) await writeJson(values.artifact, artifact);
    await writeJson(values.report, { ...receipt, artifactWritten: Boolean(artifact && values.artifact) });
    return;
  }
  if (positionals.length === 1 && mode === 'gate' && values.before && values.after && values.report && !values.replay && !values.artifact && !values.weights) {
    const [before, after] = await Promise.all([readJson(values.before), readJson(values.after)]);
    if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('Expected arrays of full development case results.');
    const gate = assessArbiterPromotion(before as DevelopmentResult[], after as DevelopmentResult[]);
    await writeJson(values.report, gate);
    if (!gate.holdsAllGroups) process.exitCode = 1;
    return;
  }
  if (positionals.length === 1 && mode === 'monitor-train' && values.replay && values.weights && values.report && !values.before && !values.after) {
    const [replay, weights] = await Promise.all([readFile(values.replay), readMonitorArtifact(values.weights)]);
    const { candidate, report } = trainMonitorArbiter({ replay, weights });
    const candidateSha256 = candidate && monitorArtifactSha256(Buffer.from(JSON.stringify(candidate)));
    await writeJson(values.report, { ...report, candidateSha256 });
    if (candidate && values.artifact) await writeJson(values.artifact, candidate);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (positionals.length === 1 && mode === 'monitor-gate' && values.replay && values.weights && values.before && values.after && values.report) {
    const [replay, weights, developmentBefore, developmentAfter] = await Promise.all([
      readFile(values.replay), readMonitorArtifact(values.weights), readFile(values.before), readFile(values.after),
    ]);
    const { artifact, report } = assessMonitorArbiterPromotion({ replay, weights, developmentBefore, developmentAfter });
    await writeJson(values.report, report);
    if (artifact && values.artifact) await writeJson(values.artifact, artifact);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: train --replay FILE --report FILE [--artifact FILE], gate --before FILE --after FILE --report FILE, monitor-train --replay FILE --weights FILE --report FILE [--artifact FILE], or monitor-gate --replay FILE --weights FILE --before FILE --after FILE --report FILE [--artifact FILE].');
}

void main().catch(error => {
  // JSON parser errors can quote input data, so keep all read/parse diagnostics generic.
  console.error(error instanceof SyntaxError ? 'Invalid input JSON.' : (error as Error).message);
  process.exitCode = 1;
});
