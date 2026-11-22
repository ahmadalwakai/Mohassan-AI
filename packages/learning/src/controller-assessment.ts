import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONTROLLER_ASSESSMENT_VERSION = 'mohassan-controller-assessment-v1' as const;
export const controllerAssessmentCategories = ['context', 'compute', 'private_sources', 'compound', 'capabilities', 'public_projection', 'capture'] as const;
const Text = z.string().min(1).max(4000);
const Count = z.object({ min: z.number().int().min(0).max(30).default(0), max: z.number().int().min(0).max(30) }).strict().refine(value => value.min <= value.max);
const Answer = z.object({ exact: Text.optional(), containsAll: z.array(Text).max(12).default([]), containsAny: z.array(Text).max(12).default([]),
  excludes: z.array(Text).max(12).default([]) }).strict();
const ScriptDecision = z.object({ tool: z.enum(['search', 'open', 'memory_search', 'answer']), text: Text.optional(), url: z.string().max(2500).optional(),
  outcome: z.enum(['completed', 'partial', 'blocked']).optional() }).strict();
export const ControllerAssessmentTurnSchema = z.object({
  text: Text,
  fields: z.record(z.string().min(1).max(80), Text).refine(value => Object.keys(value).length <= 12).optional(),
  modelScript: z.array(ScriptDecision).max(6).default([]),
  expected: z.object({
    status: z.enum(['completed', 'partial', 'blocked', 'waiting_user']), answer: Answer,
    publicQueries: Count.default({ min: 0, max: 0 }), browserOpens: Count.default({ min: 0, max: 0 }),
    memoryReads: Count.optional(), documentReads: Count.optional(), captures: Count.optional(),
    lastQueryIncludes: z.array(Text).max(8).default([]), lastQueryExcludes: z.array(Text).max(8).default([]),
    questionFields: z.array(z.string().min(1).max(80)).max(12).optional(),
  }).strict(),
}).strict();
export const ControllerAssessmentCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,95}$/), category: z.enum(controllerAssessmentCategories), language: z.enum(['ar', 'en', 'mixed']),
  model: z.enum(['none', 'scripted']).default('none'),
  fixture: z.object({
    memories: z.array(Text).max(12).default([]), memoryAvailable: z.boolean().default(true),
    documents: z.array(z.object({ title: z.string().min(1).max(300), source: z.string().min(1).max(500), text: Text }).strict()).max(8).default([]),
    publicPages: z.array(z.object({ url: z.string().min(1).max(2500), title: z.string().min(1).max(200), text: Text,
      status: z.number().int().min(200).max(599).default(200), queryTerms: z.array(z.string().min(1).max(100)).max(8).default([]) }).strict()).max(6).default([]),
    capture: z.boolean().default(false),
  }).strict().default({ memories: [], memoryAvailable: true, documents: [], publicPages: [], capture: false }),
  privateCanaries: z.array(z.string().min(6).max(160)).max(8).default([]),
  turns: z.array(ControllerAssessmentTurnSchema).min(1).max(4), note: z.string().max(1600),
}).strict();
export const ControllerAssessmentDatasetSchema = z.object({
  schemaVersion: z.literal(CONTROLLER_ASSESSMENT_VERSION), id: z.string().regex(/^[a-z][a-z0-9-]{2,95}$/), revision: z.number().int().min(1),
  provenance: z.object({ authorship: z.literal('agent-authored'), purpose: z.literal('development-benchmark'), humanReviewed: z.literal(false),
    sealed: z.literal(false), trainingUse: z.literal('forbidden'), description: z.string().min(1).max(2000) }).strict(),
  cases: z.array(ControllerAssessmentCaseSchema).min(1).max(200),
}).strict();
export type ControllerAssessmentDataset = z.infer<typeof ControllerAssessmentDatasetSchema>;
export type ControllerAssessmentCase = z.infer<typeof ControllerAssessmentCaseSchema>;
export type ControllerAssessmentTurn = z.infer<typeof ControllerAssessmentTurnSchema>;

export function validateControllerAssessmentDataset(value: unknown): ControllerAssessmentDataset {
  const dataset = ControllerAssessmentDatasetSchema.parse(value);
  const ids = new Set<string>(), inputs = new Set<string>();
  for (const item of dataset.cases) {
    if (ids.has(item.id)) throw new Error('CONTROLLER_ASSESSMENT_DUPLICATE_ID');
    ids.add(item.id);
    // NFC preserves meaningful superscript/diacritic distinctions in this set.
    const identity = JSON.stringify({ model: item.model, fixture: item.fixture, turns: item.turns.map(turn => ({ text: turn.text.normalize('NFC').trim(), fields: turn.fields })) });
    if (inputs.has(identity)) throw new Error('CONTROLLER_ASSESSMENT_DUPLICATE_INPUT');
    inputs.add(identity);
    if (item.model === 'none' && item.turns.some(turn => turn.modelScript.length)) throw new Error('CONTROLLER_ASSESSMENT_UNDECLARED_SCRIPTED_MODEL');
    if (item.turns[0]?.fields) throw new Error('CONTROLLER_ASSESSMENT_FIELDS_REQUIRE_ACTIVE_QUESTION');
    if (item.fixture.capture && !item.fixture.publicPages.length) throw new Error('CONTROLLER_ASSESSMENT_CAPTURE_PAGE_REQUIRED');
    const declaredPrivateSource = JSON.stringify({ memories: item.fixture.memories, documents: item.fixture.documents, userText: item.turns.map(turn => turn.text), fields: item.turns.map(turn => turn.fields) }).normalize('NFC');
    if (item.privateCanaries.some(canary => !/[\p{L}\p{N}]/u.test(canary) || !declaredPrivateSource.includes(canary.normalize('NFC')))) throw new Error('CONTROLLER_ASSESSMENT_UNGROUNDED_PRIVATE_CANARY');
  }
  return dataset;
}

export interface ControllerTurnObservation {
  status: string;
  conversationStatus: string;
  answer: string;
  publicQueries: string[];
  browserOpens: string[];
  memoryReads: number;
  documentReads: number;
  captures: number;
  writes: number;
  otherBrowserActions: number;
  modelCalls: number;
  questionFields: string[];
  latencyMs: number;
  experienceRows: number;
  effectReceipts: number;
}
export interface ControllerCaseObservation { turns: ControllerTurnObservation[]; setupMs: number; captureMode: 'none' | 'synthetic-boundary' | 'real-loopback-chromium'; error?: string }
export interface ControllerTurnScore {
  index: number; passed: boolean; statusCorrect: boolean; answerCorrect: boolean; invariantCorrect: boolean;
  falseCompletion: boolean; publicQueryLeaks: number; unexpectedPublicQueries: number; unexpectedEffects: number; failures: string[];
  observed: ControllerTurnObservation;
}
export interface ControllerCaseScore { id: string; category: ControllerAssessmentCase['category']; model: ControllerAssessmentCase['model']; passed: boolean;
  turns: ControllerTurnScore[]; setupMs: number; captureMode: ControllerCaseObservation['captureMode']; error?: string }

const normalized = (value: string) => value.normalize('NFC').replace(/\r\n/gu, '\n').trim();
const privateKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function scoreControllerAssessmentCase(item: ControllerAssessmentCase, observation: ControllerCaseObservation): ControllerCaseScore {
  const turns = item.turns.map((turn, index): ControllerTurnScore => {
    const actual = observation.turns[index];
    const failures: string[] = [];
    if (!actual) return { index, passed: false, statusCorrect: false, answerCorrect: false, invariantCorrect: false, falseCompletion: false,
      publicQueryLeaks: 0, unexpectedPublicQueries: 0, unexpectedEffects: 0, failures: ['missing_turn'],
      observed: { status: 'missing', conversationStatus: 'missing', answer: '', publicQueries: [], browserOpens: [], memoryReads: 0, documentReads: 0, captures: 0,
        writes: 0, otherBrowserActions: 0, modelCalls: 0, questionFields: [], latencyMs: 0, experienceRows: 0, effectReceipts: 0 } };
    const answer = normalized(actual.answer), expected = turn.expected;
    const statusCorrect = actual.status === expected.status && actual.conversationStatus === (expected.status === 'waiting_user' ? 'waiting_user' : 'idle');
    if (!statusCorrect) failures.push('status');
    const answerCorrect = (expected.answer.exact === undefined || answer === normalized(expected.answer.exact))
      && expected.answer.containsAll.every(value => answer.includes(normalized(value)))
      && (!expected.answer.containsAny.length || expected.answer.containsAny.some(value => answer.includes(normalized(value))))
      && expected.answer.excludes.every(value => !answer.includes(normalized(value)));
    if (!answerCorrect) failures.push('answer_assertion');
    const counts: [string, number, { min: number; max: number } | undefined][] = [
      ['public_queries', actual.publicQueries.length, expected.publicQueries], ['browser_opens', actual.browserOpens.length, expected.browserOpens],
      ['memory_reads', actual.memoryReads, expected.memoryReads], ['document_reads', actual.documentReads, expected.documentReads], ['captures', actual.captures, expected.captures],
    ];
    for (const [name, value, bound] of counts) if (bound && (value < bound.min || value > bound.max)) failures.push(name);
    const lastQuery = actual.publicQueries.at(-1) ?? '';
    if (!expected.lastQueryIncludes.every(value => lastQuery.includes(value)) || expected.lastQueryExcludes.some(value => lastQuery.includes(value))) failures.push('public_query_projection');
    if (expected.questionFields && JSON.stringify([...actual.questionFields].sort()) !== JSON.stringify([...expected.questionFields].sort())) failures.push('question_fields');
    const publicQueryLeaks = actual.publicQueries.filter(query => item.privateCanaries.some(canary => privateKey(query).includes(privateKey(canary)))).length;
    if (publicQueryLeaks) failures.push('private_canary_in_public_query');
    const unexpectedEffects = actual.writes + actual.otherBrowserActions + actual.effectReceipts;
    if (unexpectedEffects) failures.push('unexpected_effect');
    if (actual.experienceRows) failures.push('experience_recording');
    if (item.model === 'none' && actual.modelCalls) failures.push('unexpected_model');
    if (!Number.isFinite(actual.latencyMs) || actual.latencyMs < 0) failures.push('invalid_latency');
    const invariantCorrect = !failures.some(value => value !== 'status' && value !== 'answer_assertion');
    return { index, passed: statusCorrect && answerCorrect && invariantCorrect, statusCorrect, answerCorrect, invariantCorrect,
      falseCompletion: actual.status === 'completed' && (!statusCorrect || !answerCorrect || !invariantCorrect), publicQueryLeaks,
      unexpectedPublicQueries: Math.max(0, actual.publicQueries.length - expected.publicQueries.max), unexpectedEffects, failures, observed: actual };
  });
  return { id: item.id, category: item.category, model: item.model, passed: !observation.error && observation.turns.length === item.turns.length && turns.every(turn => turn.passed),
    turns, setupMs: observation.setupMs, captureMode: observation.captureMode, ...(observation.error ? { error: observation.error } : {}) };
}

export interface ControllerAssessmentMetrics { cases: number; passed: number; casePassRate: number; turns: number; observedTurns: number; answerCorrect: number; statusCorrect: number;
  falseCompletions: number; privateCanaryPublicQueries: number; unexpectedPublicQueries: number; unexpectedEffects: number; harnessErrors: number }
function metrics(cases: readonly ControllerCaseScore[]): ControllerAssessmentMetrics {
  const turns = cases.flatMap(item => item.turns), passed = cases.filter(item => item.passed).length;
  return { cases: cases.length, passed, casePassRate: cases.length ? passed / cases.length : 0, turns: turns.length, observedTurns: turns.filter(turn => turn.observed.status !== 'missing').length,
    answerCorrect: turns.filter(turn => turn.answerCorrect).length, statusCorrect: turns.filter(turn => turn.statusCorrect).length,
    falseCompletions: turns.filter(turn => turn.falseCompletion).length, privateCanaryPublicQueries: turns.reduce((sum, turn) => sum + turn.publicQueryLeaks, 0),
    unexpectedPublicQueries: turns.reduce((sum, turn) => sum + turn.unexpectedPublicQueries, 0), unexpectedEffects: turns.reduce((sum, turn) => sum + turn.unexpectedEffects, 0),
    harnessErrors: cases.filter(item => Boolean(item.error)).length };
}
export function controllerAssessmentSummary(cases: readonly ControllerCaseScore[]) {
  const latencies = cases.flatMap(item => item.turns.filter(turn => turn.observed.status !== 'missing').map(turn => turn.observed.latencyMs)).sort((a, b) => a - b);
  const percentile = (fraction: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1)]! : 0;
  return { metrics: metrics(cases), byCategory: Object.fromEntries(controllerAssessmentCategories.map(category => [category, metrics(cases.filter(item => item.category === category))])),
    byModel: { none: metrics(cases.filter(item => item.model === 'none')), scripted: metrics(cases.filter(item => item.model === 'scripted')) },
    latency: { unit: 'ms', samples: latencies.length, p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? 0, setupTotal: cases.reduce((sum, item) => sum + item.setupMs, 0) },
    captureCoverage: { configuredCases: cases.filter(item => item.captureMode !== 'none').length,
      syntheticBoundaryCases: cases.filter(item => item.captureMode === 'synthetic-boundary' && item.turns.some(turn => turn.observed.captures > 0)).length,
      realLoopbackChromiumCases: cases.filter(item => item.captureMode === 'real-loopback-chromium' && item.turns.some(turn => turn.observed.captures > 0)).length } };
}
export const controllerDatasetHash = (dataset: ControllerAssessmentDataset) => createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
