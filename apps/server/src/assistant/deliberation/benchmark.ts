import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentBrowser } from '@mohassan/browser';
import type { createCommandChatControl } from '../../command-chat.js';
import { decideRequestRoute } from '../routing-decision.js';
import { fitDecisionTemperature, measureDecisions, sameDecision, type BenchmarkDecision, type BenchmarkPrediction } from './benchmark-metrics.js';
import { inspectCascade } from './cascade.js';
import { conversationEvidence } from './conversation-evidence.js';
import { confidenceForMargin, COST_POLICY_TEMPERATURE, DELIBERATION_TEMPERATURE, deliberate } from './decision.js';
import type { DecisionOutcome, DeliberationInput } from './types.js';

interface BenchmarkRow {
  id: string;
  text: string;
  intent: string;
  expected: BenchmarkDecision;
}

interface BenchmarkCorpus {
  source: string;
  purpose: string;
  development: BenchmarkRow[];
  benchmark: BenchmarkRow[];
}
interface BenchmarkComparison extends Pick<BenchmarkRow, 'id' | 'intent' | 'expected'> {
  today: BenchmarkPrediction;
  deliberation: BenchmarkPrediction;
}

const corpusFile = new URL('../../../../../tests/fixtures/deliberation/clinc150.json', import.meta.url);
const clock = new Date('2026-11-25T12:00:00Z');
const temperatures = [
  ...Array.from({ length: 40 }, (_, index) => (index + 1) / 4),
  ...Array.from({ length: 20 }, (_, index) => 12 + 2 * index),
];

function prepare(row: BenchmarkRow): DeliberationInput {
  const routing = decideRequestRoute({ text: row.text, fullAccess: true, now: clock, turnId: row.id,
    capabilities: { browser: true, search: true, planner: true } });
  const { predicates, legacy } = inspectCascade({ text: row.text, routing, now: clock, fullAccess: true });
  return { text: row.text, routing, predicates, legacy, ...conversationEvidence(row.text, row.id) };
}

function toBenchmarkDecision(outcome: DecisionOutcome): BenchmarkDecision {
  return outcome.action === 'act' ? { kind: 'act', route: outcome.route } : { kind: outcome.action };
}

async function observeProductionPaths(rows: readonly BenchmarkRow[]): Promise<BenchmarkComparison[]> {
  const [{ createDatabase, migrate }, { createCommandChatControl }] = await Promise.all([
    import('@mohassan/database'), import('../../command-chat.js'),
  ]);
  const database = await createDatabase();
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      async act() { throw new Error('The decision benchmark does not dispatch browser actions.'); },
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false, deliberationEnabled: false,
      searchProvider: { name: 'benchmark-no-network', async search() { return []; } },
      async fetch() { throw new Error('The decision benchmark does not fetch network resources.'); },
    });
    const owner = 'isolated-deliberation-benchmark';
    const observed = [];
    for (const row of rows) {
      const { id } = await control.create(owner, { goal: row.text });
      await control.settled(id);
      const conversation = await control.detail(owner, id);
      const trace = conversation.run?.deliberation;
      if (!trace?.legacy || !trace.legacyObserved) throw new Error(`Missing observed first-match decision for ${row.id}.`);
      observed.push({
        id: row.id, intent: row.intent, expected: row.expected,
        today: { decision: toBenchmarkDecision(trace.legacy), confidence: 1 },
        deliberation: { decision: toBenchmarkDecision(trace.chosen), confidence: trace.confidence },
      });
    }
    return observed;
  } finally {
    await control?.shutdown();
    await database.close();
  }
}

async function printBenchmark(mode?: '--fit-temperature' | '--development') {
  const sourceFile = readFileSync(corpusFile);
  const corpus = JSON.parse(sourceFile.toString('utf8')) as BenchmarkCorpus;
  const sha256 = createHash('sha256').update(sourceFile).digest('hex');
  console.log(`${corpus.source}. ${corpus.purpose} SHA-256 ${sha256}`);
  if (mode === '--fit-temperature') {
    const development = corpus.development.map(row => ({ expected: row.expected, input: prepare(row) }));
    const routeObservations = development.flatMap(({ expected, input }) => {
      const { routeCandidate, routeMargin } = deliberate(input);
      return routeCandidate ? [{ margin: routeMargin, correct: expected.kind === 'act' && expected.route === routeCandidate }] : [];
    });
    const route = fitDecisionTemperature(routeObservations, confidenceForMargin, temperatures);
    const decisionObservations = development.map(({ expected, input }) => {
      const { margin, outcome } = deliberate({ ...input, policyTemperature: route.temperature });
      return { margin, correct: sameDecision(expected, toBenchmarkDecision(outcome)) };
    });
    const decision = fitDecisionTemperature(decisionObservations, confidenceForMargin, temperatures);
    console.log(`Development-only calibration (${development.length} rows, ${routeObservations.length} with an eligible route)`);
    console.log(JSON.stringify({ route, decision }));
    return;
  }
  const rows = await observeProductionPaths(mode === '--development' ? corpus.development : corpus.benchmark);
  const baseline = measureDecisions(rows.map(row => ({ expected: row.expected, ...row.today })));
  const current = measureDecisions(rows.map(row => ({ expected: row.expected, ...row.deliberation })));
  const corrections = rows.filter(row => !sameDecision(row.expected, row.today.decision) && sameDecision(row.expected, row.deliberation.decision));
  const regressions = rows.filter(row => sameDecision(row.expected, row.today.decision) && !sameDecision(row.expected, row.deliberation.decision));
  const disagreements = rows.filter(row => !sameDecision(row.today.decision, row.deliberation.decision));
  const percent = (value: number) => `${(100 * value).toFixed(2)}%`;
  const display = (metrics: typeof baseline) => ({
    Decisions: metrics.count,
    Accuracy: percent(metrics.accuracy),
    'Wrong action': percent(metrics.wrongActionRate),
    'Unnecessary question': percent(metrics.unnecessaryQuestionRate),
    ECE: percent(metrics.expectedCalibrationError),
  });
  console.log(`${mode === '--development' ? 'Development' : 'Benchmark'} split, route temperature ${COST_POLICY_TEMPERATURE}, decision temperature ${DELIBERATION_TEMPERATURE}. First-match confidence is fixed at 1 for ECE.`);
  console.table({ 'First match': display(baseline), Deliberation: display(current) });
  console.log(`${disagreements.length} disagreements, ${corrections.length} corrected first-match misses, ${regressions.length} regressions.`);
  const correctedWrongActions = corrections.filter(row => row.today.decision.kind === 'act');
  console.log(`${correctedWrongActions.length} corrected wrong actions. Example case IDs: ${correctedWrongActions.slice(0, 8).map(row => row.id).join(', ') || 'none'}.`);
  if (mode === '--development') {
    const intents = [...new Set(rows.map(row => row.intent))].sort();
    console.table(Object.fromEntries(intents.map(intent => {
      const group = rows.filter(row => row.intent === intent);
      return [intent, {
        decisions: group.length,
        firstMatchCorrect: group.filter(row => sameDecision(row.expected, row.today.decision)).length,
        deliberationCorrect: group.filter(row => sameDecision(row.expected, row.deliberation.decision)).length,
      }];
    })));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const [mode] = args;
  if (args.length > 1 || mode !== undefined && mode !== '--fit-temperature' && mode !== '--development') {
    throw new Error('Usage: node --import tsx apps/server/src/assistant/deliberation/benchmark.ts [--fit-temperature | --development]');
  }
  await printBenchmark(mode);
}
