import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [target, mode, output, split] = process.argv.slice(2);
if (!target || !['base', 'shadow', 'replay'].includes(mode) || !output
    || (split !== undefined && !['--v1', '--v2'].includes(split))) {
  throw new Error('Usage: node --import tsx scripts/arbiter-bench/run.mjs PREPARED_WORKTREE base|shadow|replay NEW_OUTPUT_DIRECTORY [--v1|--v2]');
}
const root = resolve(target);
const receipt = resolve(output);
mkdirSync(dirname(receipt), { recursive: true });
mkdirSync(receipt, { mode: 0o700 });
const home = resolve(receipt, 'home');
mkdirSync(home, { mode: 0o700 });
const worker = fileURLToPath(new URL('worker.mjs', import.meta.url));

// Do not inherit API keys, model overrides, provider settings or unrelated experiment flags.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TZ: 'UTC',
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
  ...(process.env.TEST_DRIVEN_CODING_PYTHON ? { TEST_DRIVEN_CODING_PYTHON: process.env.TEST_DRIVEN_CODING_PYTHON } : {}),
  MOHASSAN_SMALL_TALK_MANNERS: '1',
  MOHASSAN_CONVERSATION_REVIEW_APPLY: '1',
  MOHASSAN_CONVERSATION_SHADOW: 'decide',
  MOHASSAN_STRUCTURED_MEMORY: '1',
  MOHASSAN_EXTRACTIVE_WRITING: '1',
  MOHASSAN_PLAN_COMPILER: 'on',
  MOHASSAN_REASONING: '1',
  MOHASSAN_CLARIFY_CHOICES: '1',
  MOHASSAN_SCRATCH_CLASSIFIERS: '1',
  MOHASSAN_REFUSAL_POLICY: '1',
  TEST_DRIVEN_CODING_ENABLED: 'true',
  MOHASSAN_QUESTION_REWRITER: '1',
  MOHASSAN_ARITHMETIC_SEARCH: '1',
  MOHASSAN_MODEL_RELATIONS: mode === 'base' ? 'off' : 'shadow',
};

const allRows = [];
for (const [version, lanes, caseCount] of [[1, 1, 240], [2, 8, 2400]]) {
  if (split !== undefined && split !== `--v${version}`) continue;
  const data = [];
  for (let lane = 0; lane < lanes; lane += 1) {
    const path = resolve(receipt, `v${version}-lane-${lane}.json`);
    const args = ['--no-wasm-tier-up', '--no-wasm-dynamic-tiering', '--import', 'tsx',
      worker, String(version), mode, String(lane), path];
    const child = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (child.status !== 0) {
      const diagnostic = /^Worker stopped during (loading|observing|writing)\.$/m.exec(child.stdout ?? '')?.[0] ?? '';
      throw new Error(`Development v${version} lane ${lane} exited ${child.status ?? child.signal}. ${diagnostic}`);
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.mode !== mode || Number(record.version) !== version || record.lane !== lane
        || record.cases.some(({ index }, position) => index !== position * lanes + lane)
        || (data.length && JSON.stringify(record.source) !== JSON.stringify(data[0].source))) {
      throw new Error(`Development v${version} receipt identity or ordering mismatch.`);
    }
    data.push(record);
    console.log(`Development v${version} lane ${lane + 1}/${lanes} completed (${record.cases.length} cases).`);
  }
  const scores = data.flatMap(run => run.cases).sort((a, b) => a.index - b.index).map(entry => entry.score);
  if (scores.length !== caseCount || new Set(scores.map(score => score.id)).size !== caseCount) {
    throw new Error(`Development v${version} receipt count mismatch.`);
  }
  const { summarizeCapability } = await import(pathToFileURL(resolve(root, `scripts/arbiter-bench-v${version}/score.ts`)).href);
  const summary = summarizeCapability(scores);
  const rows = data.flatMap(run => run.rows);
  const unsupported = data.flatMap(run => run.unsupported);
  const protectedDecisions = data.flatMap(run => run.protectedDecisions);
  const latencyMs = data.flatMap(run => run.latencyMs).sort((a, b) => a - b);
  const filter = { human: 0, excluded: 0 };
  for (const run of data) {
    filter.human += run.filter.human;
    filter.excluded += run.filter.excluded;
  }
  writeFileSync(resolve(receipt, `v${version}-development.json`), JSON.stringify({
    source: data[0].source, mode, startedAt: data[0].startedAt, finishedAt: data.at(-1).finishedAt,
    scores, summary, rows, unsupported, protectedDecisions, filter, arbitrationTiming: { count: latencyMs.length,
      p50Ms: latencyMs[Math.ceil(latencyMs.length * 0.5) - 1] ?? null,
      p95Ms: latencyMs[Math.ceil(latencyMs.length * 0.95) - 1] ?? null },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Development v${version} scored ${summary.overall.passed}/${caseCount} with ${rows.length} contested decisions.`);
  allRows.push(...rows.filter(({ input, outcomes }) => Object.keys(outcomes).length === input.claimants.length));
}
if (mode === 'replay') {
  const exclusionManifestSha256 = createHash('sha256').update(readFileSync(
    resolve(root, 'tests/fixtures/agent-capability-bench/v2/exclusion/manifest.json'))).digest('hex');
  const rows = allRows.map(({ split, caseId, turn, occurrence, area, language, family, author, excluded, input, baselinePassed, outcomes }) =>
    ({ split, caseId, turn, occurrence, area, language, family, author, excluded, input, baselinePassed, outcomes }));
  writeFileSync(resolve(receipt, 'replay-dataset.json'), JSON.stringify({ schemaVersion: 1, exclusionManifestSha256, rows }) + '\n',
    { flag: 'wx', mode: 0o600 });
}
