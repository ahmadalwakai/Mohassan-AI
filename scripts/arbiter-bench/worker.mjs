import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [version, mode, laneText, out] = process.argv.slice(2);
let stage = 'loading';
process.on('uncaughtException', () => {
  process.stdout.write(`Worker stopped during ${stage}.\n`);
  process.exitCode = 1;
});
const lane = Number(laneText);
const root = process.cwd();
const tooling = resolve(root, `scripts/arbiter-bench-v${version}`);
const fixtures = resolve(root, 'tests/fixtures/agent-capability-bench');
const loadTooling = path => import(pathToFileURL(resolve(tooling, path)).href);
const { withCapabilityHarness } = await loadTooling('observe.ts');
const { scoreCapabilityCase } = await loadTooling('score.ts');
const capture = mode !== 'base';
const hooks = capture ? await import(pathToFileURL(resolve(root, 'apps/server/src/assistant/model-relations-arbiter.ts')).href) : undefined;
const filter = capture ? JSON.parse(execFileSync('python3', ['-B', fileURLToPath(new URL('filter.py', import.meta.url)), root, version], {
  encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
})) : undefined;

let cases;
if (version === '1') {
  const { loadCapabilityCorpus } = await loadTooling('corpus.ts');
  cases = (await loadCapabilityCorpus({ manifest: resolve(fixtures, 'manifest.json'), development: resolve(fixtures, 'development.json') })).development;
} else {
  const { loadDevelopmentCapabilityCorpus } = await loadTooling('v2/dev.ts');
  cases = (await loadDevelopmentCapabilityCorpus(resolve(fixtures, 'v2/dev'))).cases;
}

const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  lockfileSha256: createHash('sha256').update(readFileSync(resolve(root, 'package-lock.json'))).digest('hex'),
};
const result = { source, lane, version, mode, cases: [], rows: [], unsupported: [], protectedDecisions: [], latencyMs: [],
  filter: { human: 0, excluded: 0 } };
const lanes = version === '1' ? 1 : 8;
const split = `v${version}-development`;
const startedAt = new Date().toISOString();
console.error = () => { /* Controller diagnostics can contain fixture data. */ };

stage = 'observing';
await withCapabilityHarness(async observe => {
  for (const [index, item] of cases.entries()) {
    if (index % lanes !== lane) continue;
    const provenance = filter?.[item.id];
    if (capture && !provenance) throw new Error('Missing exclusion result for development case.');
    result.filter.human += Number(provenance?.author === 'human');
    result.filter.excluded += Number(provenance?.excluded === true);
    if (!hooks) {
      result.cases.push({ index, score: scoreCapabilityCase(item, await observe(item)) });
      continue;
    }
    const inspect = overrides => hooks.withArbiterReplay({ overrides }, async trace => ({
      score: scoreCapabilityCase(item, await observe(item)),
      decisions: trace.decisions,
    }));
    const baseline = await inspect([]);
    result.cases.push({ index, score: baseline.score });
    result.latencyMs.push(...baseline.decisions.map(decision => decision.elapsedMs));
    for (const decision of baseline.decisions) {
      const { turnId, occurrence = 1, type, precedence, claimants, language, length, conversationState, modelStates,
        selected, proposed, confidence, threshold, reason } = decision;
      if (claimants.length < 2) continue;
      const indexData = { split, caseId: item.id, turn: turnId - 1, occurrence, type };
      if (reason === 'protected') {
        result.protectedDecisions.push({ ...indexData, area: item.area, language: item.language, claimants, precedence });
        continue;
      }
      const outcomes = {};
      if (mode === 'replay') {
        for (const { component } of claimants) {
          const forced = await inspect([{ turnId, occurrence, type, component }]);
          if (!forced.decisions.some(entry => entry.turnId === turnId && (entry.occurrence ?? 1) === occurrence
              && entry.type === type && entry.selected === component && entry.reason === 'forced')) {
            result.unsupported.push({ ...indexData, component });
          } else {
            outcomes[component] = forced.score.passed;
          }
        }
      }
      result.rows.push({ ...indexData, area: item.area, language: item.language, ...provenance,
        input: { type, precedence, claimants, language, length, conversationState, modelStates },
        baselinePassed: baseline.score.passed, outcomes, observedSelected: selected, observedProposed: proposed,
        observedConfidence: confidence, observedThreshold: threshold, observedReason: reason });
    }
  }
});
stage = 'writing';
writeFileSync(resolve(out), JSON.stringify({ ...result, startedAt, finishedAt: new Date().toISOString() }) + '\n', {
  flag: 'wx', mode: 0o600,
});
