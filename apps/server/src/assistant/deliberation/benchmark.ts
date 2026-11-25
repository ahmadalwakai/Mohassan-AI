import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentBrowser } from '@mohassan/browser';
import { ThoughtRecordSchema } from '@mohassan/contracts';
import type { createCommandChatControl } from '../../command-chat.js';
import type { BrainState } from '../brain.js';
import { evaluateLocalConversation } from '../local-conversation.js';
import { requestActionText } from '../request-context.js';
import { requestScopeActionText } from '../request-scope.js';
import { decideRequestRoute } from '../routing-decision.js';
import { evaluateSelfQuestion, type SelfFacts } from '../self-knowledge.js';
import { effectiveBenchmarkPrediction, fitDecisionTemperature, measureDecisions, observeBenchmarkRun, sameDecision, type BenchmarkDecision, type BenchmarkPrediction, type BenchmarkRunObservation } from './benchmark-metrics.js';
import { inspectCascade } from './cascade.js';
import { conversationEvidence } from './conversation-evidence.js';
import { confidenceForMargin, deliberate } from './decision.js';
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
interface BenchmarkRuntimeResult {
  observed: NonNullable<ReturnType<typeof observeBenchmarkRun>>;
  proposal: BenchmarkPrediction;
  enforced: boolean;
}

const corpusFile = new URL('../../../../../tests/fixtures/deliberation/clinc150.json', import.meta.url);
const clock = new Date('2026-11-25T12:00:00Z');
const temperatures = [
  ...Array.from({ length: 40 }, (_, index) => (index + 1) / 4),
  ...Array.from({ length: 20 }, (_, index) => 12 + 2 * index),
];
const selfFacts: SelfFacts = {
  chatModel: false, web: true, browser: true, computation: true, memory: false, knowledge: false,
  documents: false, sites: false, skills: false, ads: false, imageReading: false, pc: false, planner: true, letters: true,
};

function verifiesDirectReply(request: string, reply: string | undefined): boolean {
  if (!reply) return false;
  const action = requestActionText(requestScopeActionText(request));
  return [evaluateLocalConversation(action), evaluateSelfQuestion(action, selfFacts)].some(answer => answer?.text.trim() === reply.trim());
}

function prepare(row: BenchmarkRow): DeliberationInput {
  const routing = decideRequestRoute({ text: row.text, fullAccess: true, now: clock, turnId: row.id,
    capabilities: { browser: true, search: true, planner: true } });
  const { predicates, legacy } = inspectCascade({ text: row.text, routing, now: clock, fullAccess: true });
  return { text: row.text, routing, predicates, legacy, ...conversationEvidence(row.text, row.id) };
}

function toBenchmarkDecision(outcome: DecisionOutcome): BenchmarkDecision {
  return outcome.action === 'act' ? { kind: 'act', route: outcome.route } : { kind: outcome.action };
}

async function observeProductionPaths(rows: readonly BenchmarkRow[], enabled: boolean, fullWorktree?: string): Promise<BenchmarkRuntimeResult[]> {
  const fromWorktree = (path: string) => pathToFileURL(resolve(fullWorktree ?? '', path)).href;
  const [{ createDatabase, migrate }, { createCommandChatControl }] = await Promise.all([
    fullWorktree ? import(fromWorktree('packages/database/src/index.ts')) as Promise<typeof import('@mohassan/database')> : import('@mohassan/database'),
    fullWorktree ? import(fromWorktree('apps/server/src/command-chat.ts')) as Promise<typeof import('../../command-chat.js')> : import('../../command-chat.js'),
  ]);
  const database = await createDatabase();
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(database.db);
    if (enabled && !fullWorktree) {
      const { configureDeliberation } = await import('./settings.js');
      await configureDeliberation(database.db, { enabled: true });
    }
    const calls: BenchmarkRunObservation['calls'][number][] = [];
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      async act() {
        calls.push('browser_command');
        throw new Error('The decision benchmark does not execute browser actions.');
      },
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
      ...(fullWorktree ? { deliberationEnabled: enabled } : {}),
      searchProvider: { name: 'benchmark-no-network', async search() { calls.push('web_search'); return []; } },
      async fetch() { throw new Error('The decision benchmark does not fetch network resources.'); },
    });
    const owner = 'isolated-deliberation-benchmark';
    const observed = [];
    for (const row of rows) {
      calls.length = 0;
      const { id } = await control.create(owner, { goal: row.text });
      await control.settled(id);
      const conversation = await control.detail(owner, id);
      const stored = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
      const state = stored.state as BrainState;
      const trace = ThoughtRecordSchema.safeParse(state.agentRun?.deliberation);
      if (!trace.success) throw new Error(`Missing deliberation record for ${row.id} with flag ${enabled ? 'on' : 'off'}.`);
      const reply = conversation.messages.findLast(message => message.role === 'assistant')?.text;
      const observedRun = observeBenchmarkRun({ waitingForQuestion: conversation.status === 'waiting_user' && conversation.question !== null,
        calls, trail: state.trail.map(entry => entry.action), ledgerPath: state.agentRun?.path ?? null, status: stored.status,
        verifiedDirectReply: stored.status === 'completed' && verifiesDirectReply(row.text, reply) });
      if (!observedRun) throw new Error(`Cannot classify runtime outcome for ${row.id} with flag ${enabled ? 'on' : 'off'} (${stored.status}).`);
      observed.push({
        observed: observedRun, enforced: trace.data.enforced === true,
        proposal: { decision: toBenchmarkDecision(trace.data.chosen), confidence: trace.data.confidence },
      });
    }
    return observed;
  } finally {
    await control?.shutdown();
    await database.close();
  }
}

async function printBenchmark(mode?: '--fit-temperature' | '--development', fullWorktree?: string) {
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
  const corpusRows = mode === '--development' ? corpus.development : corpus.benchmark;
  const [flagOff, flagOn] = await Promise.all([observeProductionPaths(corpusRows, false, fullWorktree), observeProductionPaths(corpusRows, true, fullWorktree)]);
  const rows = corpusRows.map((row, index) => {
    const off = flagOff[index], on = flagOn[index];
    return { ...row, today: { decision: off.observed.decision, confidence: 1 }, shadow: off.proposal,
      deliberation: effectiveBenchmarkPrediction(on.observed.decision, on.proposal, on.enforced) };
  });
  const baseline = measureDecisions(rows.map(row => ({ expected: row.expected, ...row.today })));
  const shadow = measureDecisions(rows.map(row => ({ expected: row.expected, ...row.shadow })));
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
  console.log(`${mode === '--development' ? 'Development' : 'Benchmark'} split, ${fullWorktree ? 'full-version worktree' : 'phase one'}. ECE uses confidence 1 for decisions without a policy confidence.`);
  console.table({ 'Flag off, observed': display(baseline), 'Flag on, observed': display(current), 'Shadow proposal': display(shadow) });
  const countEnforced = flagOn.filter(row => row.enforced).length;
  const countObservedProposal = flagOn.filter(row => row.enforced && sameDecision(row.observed.decision, row.proposal.decision)).length;
  const notObservedActs = flagOn.filter(row => row.proposal.decision.kind === 'act' && !sameDecision(row.observed.decision, row.proposal.decision));
  console.log(`${countEnforced} flag-on consultations intervened. ${countObservedProposal} produced an observed decision matching the proposal.`);
  console.log(`${notObservedActs.length} proposed acts did not produce the matching observed route.`);
  const sources = [...new Set([...flagOff, ...flagOn].map(row => row.observed.source))].sort();
  console.table(Object.fromEntries(sources.map(source => [source, {
    flagOff: flagOff.filter(row => row.observed.source === source).length,
    flagOn: flagOn.filter(row => row.observed.source === source).length,
  }])));
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
  const [mode, worktree] = args;
  if (mode === '--full-worktree' && args.length === 2 && worktree) {
    await printBenchmark(undefined, worktree);
  } else if (args.length <= 1 && (mode === undefined || mode === '--fit-temperature' || mode === '--development')) {
    await printBenchmark(mode);
  } else {
    throw new Error('Usage: node --import tsx apps/server/src/assistant/deliberation/benchmark.ts [--fit-temperature | --development | --full-worktree PATH]');
  }
}
