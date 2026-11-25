import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { CodeKnowledge, createCodeKnowledgeShadow, formatAnswer, readCorpus } from '../../packages/code-knowledge/src/index.js';

type ContentMatch = 'literal' | 'number';
interface BenchmarkTurn {
  text: string;
  fields?: Readonly<Record<string, string>>;
  approve?: boolean;
  expect: {
    requiredContent: readonly { match: ContentMatch; anyOf: readonly string[] }[];
    forbiddenContent: readonly string[];
  };
}

interface BenchmarkCase {
  id: string;
  area: string;
  language: string;
  turns: readonly BenchmarkTurn[];
}

interface BenchmarkObservation {
  setupMs: number;
  turns: readonly { answer: string }[];
}

interface BenchmarkScore {
  passed: boolean;
  failures: readonly { turn: number; stage: string; check: string }[];
}

interface BenchmarkScorer {
  includesLiteral: (answer: string, expected: string) => boolean;
  includesNumber: (answer: string, expected: string) => boolean;
  scoreCapabilityCase: (item: BenchmarkCase, observation: BenchmarkObservation) => BenchmarkScore;
}

type Shadow = Pick<ReturnType<typeof createCodeKnowledgeShadow>, 'observe'>;
type AnswerOutcome = 'correct' | 'wrong' | 'abstained';

function checkContent(turn: BenchmarkTurn, evidence: string, scorer: BenchmarkScorer): string[] {
  const failures: string[] = [];
  for (const [index, assertion] of turn.expect.requiredContent.entries()) {
    const includes = assertion.match === 'number' ? scorer.includesNumber : scorer.includesLiteral;
    if (!assertion.anyOf.some(value => includes(evidence, value))) failures.push(`required-content-${index + 1}`);
  }
  for (const [index, value] of turn.expect.forbiddenContent.entries()) {
    if (scorer.includesLiteral(evidence, value)) failures.push(`forbidden-content-${index + 1}`);
  }
  return failures;
}

function checkShadowTurn(item: BenchmarkCase, turn: BenchmarkTurn, shadow: Shadow, scorer: BenchmarkScorer) {
  const answer = turn.text.trim() && turn.approve === undefined && !turn.fields
    ? shadow.observe(turn.text, { caseId: item.id })
    : undefined;
  if (answer?.status !== 'answered') {
    return { outcome: 'abstained' as const, reply: '', failures: [], answer };
  }
  const evidence = answer.excerpts.flatMap(excerpt => [...excerpt.sentences, ...excerpt.code.map(block => block.text)]).join('\n');
  const failures = checkContent(turn, evidence, scorer);
  const locale = item.language === 'ar' ? 'ar' : 'en';
  return { outcome: failures.length ? 'wrong' as const : 'correct' as const,
    reply: formatAnswer(answer, locale), failures, answer };
}

function countByOutcome(cases: readonly { outcome: AnswerOutcome; baseline: BenchmarkScore; replay: BenchmarkScore }[]) {
  return {
    cases: cases.length,
    baselinePassed: cases.filter(item => item.baseline.passed).length,
    replayPassed: cases.filter(item => item.replay.passed).length,
    correct: cases.filter(item => item.outcome === 'correct').length,
    wrong: cases.filter(item => item.outcome === 'wrong').length,
    abstained: cases.filter(item => item.outcome === 'abstained').length,
  };
}

export async function replayCodingCases(
  cases: readonly BenchmarkCase[],
  observe: (item: BenchmarkCase) => Promise<BenchmarkObservation>,
  scorer: BenchmarkScorer,
  shadow: Shadow,
) {
  const scored = [];
  for (const item of cases) {
    if (item.area !== 'coding') continue;
    const observation = await observe(item);
    const turns = item.turns.map(turn => checkShadowTurn(item, turn, shadow, scorer));
    const baseline = scorer.scoreCapabilityCase(item, observation);
    const replay = scorer.scoreCapabilityCase(item, {
      ...observation,
      turns: observation.turns.map((turn, index) => ({ ...turn, answer: turns[index]?.reply ?? '' })),
    });
    const outcome: AnswerOutcome = turns.every(turn => turn.outcome === 'correct') ? 'correct'
      : turns.every(turn => turn.outcome === 'abstained') ? 'abstained' : 'wrong';
    scored.push({ id: item.id, language: item.language, outcome,
      baseline: { passed: baseline.passed, failures: baseline.failures },
      replay: { passed: replay.passed, failures: replay.failures },
      turns: turns.map(({ outcome, failures, answer }) => ({ outcome, failures, intent: answer?.intent })) });
  }
  return { summary: countByOutcome(scored), cases: scored };
}

interface CorpusLoader {
  loadCapabilityCorpus(paths: { manifest: string; development: string; sealed?: string }): Promise<{
    manifest: unknown;
    development: BenchmarkCase[];
    sealed?: BenchmarkCase[];
  }>;
}

interface BenchmarkHarness {
  withCapabilityHarness<T>(use: (observe: (item: BenchmarkCase) => Promise<BenchmarkObservation>) => Promise<T>): Promise<T>;
}

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

async function verifyScratchMerge() {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD', 'MERGE_HEAD', 'refs/remotes/origin/feat/agent-capability-bench'], { cwd: root });
    const [head, mergeHead, benchmarkRef] = stdout.trim().split('\n');
    if (head && mergeHead && mergeHead === benchmarkRef) return { head, mergeHead };
  } catch {
    // A missing MERGE_HEAD is expected outside the scratch merge.
  }
  throw new Error('Run from an uncommitted scratch merge with origin/feat/agent-capability-bench.');
}

async function main() {
  const { values } = parseArgs({ options: {
    corpus: { type: 'string' }, output: { type: 'string' }, sealed: { type: 'boolean', default: false },
  } });
  if (!values.corpus || !values.output) throw new Error('Usage: tsx scripts/code-knowledge/capability.ts --corpus PATH --output PATH [--sealed]');
  const revision = await verifyScratchMerge();
  // This branch does not carry the benchmark. Load its verified corpus, controller, and scorer from the scratch merge.
  const benchmark = (module: string) => import(new URL(`../agent-capability-bench/${module}.ts`, import.meta.url).href);
  const [loader, harness, scorer, corpus]: [CorpusLoader, BenchmarkHarness, BenchmarkScorer, Awaited<ReturnType<typeof readCorpus>>] =
    await Promise.all([benchmark('corpus'), benchmark('observe'), benchmark('score'), readCorpus(values.corpus)]);
  const fixtureDir = resolve(root, 'tests/fixtures/agent-capability-bench');
  const fixtures = await loader.loadCapabilityCorpus({ manifest: resolve(fixtureDir, 'manifest.json'),
    development: resolve(fixtureDir, 'development.json'),
    ...(values.sealed ? { sealed: resolve(fixtureDir, 'holdout/sealed.json') } : {}) });
  let shadowEvents = 0;
  const shadow = createCodeKnowledgeShadow(new CodeKnowledge(corpus), () => { shadowEvents++; });
  const partitions = [{ name: 'development', cases: fixtures.development },
    ...(fixtures.sealed ? [{ name: 'sealed', cases: fixtures.sealed }] : [])];
  const splits = await harness.withCapabilityHarness(async observe => {
    const results = [];
    for (const { name, cases } of partitions) results.push({ name, ...await replayCodingCases(cases, observe, scorer, shadow) });
    return results;
  });
  const summary = countByOutcome(splits.flatMap(split => split.cases));
  const report = { schemaVersion: 1, revision, runtime: process.version, manifest: fixtures.manifest,
    sources: corpus.sources, shadowEvents, summary, splits };
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ summary, splits: splits.map(({ name, summary }) => ({ name, ...summary })), shadowEvents }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not complete capability shadow replay.');
    process.exitCode = 1;
  }
}
