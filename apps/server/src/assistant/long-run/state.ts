import { z } from 'zod';
import { SiteBriefSchema } from '@mohassan/contracts';
import { createRunLedger, enterPhase, planStep, RunLedgerSchema, setPlan } from '../agent-run.js';
import type { ReplyConstraints } from '../reply-directive.js';
import { ReplyConstraintsSchema } from '../reply-preferences.js';

export const LONG_RUN_WORKER = 'response-policy-long-run-v1';
export const LONG_RUN_LIMITS = {
  wallMs: 3 * 60 * 60_000,
  steps: 12,
  resourceUnits: 18,
  attemptMs: 30_000,
  attemptsPerStep: 3,
  leaseMs: 40_000,
  pollMs: 2_000,
} as const;
export const LONG_RUN_ACTIVE = ['running', 'waiting_approval', 'waiting_input'] as const;

const url = z.url({ protocol: /^https?$/ }).max(2048);
const step = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), query: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('read_source'), index: z.number().int().min(0).max(3) }),
  z.object({ kind: z.literal('monitor'), url, delayMs: z.number().int().min(0).max(LONG_RUN_LIMITS.wallMs) }),
  z.object({ kind: z.literal('prepare_site'), brief: SiteBriefSchema }),
  z.object({ kind: z.literal('build_site'), approval: z.boolean() }),
]);
const background = z.object({ replyLength: z.enum(['short', 'medium', 'long']) }).strict();
export type LongRunStep = z.infer<typeof step>;
export type LongRunLanguage = 'ar' | 'en';
export type LongRunPlan = { language: LongRunLanguage; steps: LongRunStep[]; background?: z.infer<typeof background> };

const observation = z.object({ url, title: z.string().max(240), quote: z.string().max(700), hash: z.string().length(64) });
const checkpoint = z.object({
  version: z.literal(1),
  background: background.optional(),
  language: z.enum(['ar', 'en']),
  replyConstraints: ReplyConstraintsSchema.optional(),
  steps: z.array(step).min(1).max(LONG_RUN_LIMITS.steps),
  next: z.number().int().min(0).max(LONG_RUN_LIMITS.steps),
  resources: z.number().int().min(0).max(LONG_RUN_LIMITS.resourceUnits),
  deadline: z.number().int().positive(),
  dueAt: z.number().int().nonnegative(),
  inFlight: z.object({ token: z.uuid(), expiresAt: z.number().int().positive() }).nullable(),
  candidates: z.array(url).max(4),
  observations: z.array(observation).max(LONG_RUN_LIMITS.steps),
  site: z.object({ id: z.uuid(), text: z.string().max(4000), partial: z.boolean() }).nullable(),
  inputId: z.uuid().nullable(),
}).strict();

export const LongRunStateSchema = z.object({ longRun: checkpoint, agentRun: RunLedgerSchema, siteId: z.uuid().optional() }).strict();
export type LongRunState = z.infer<typeof LongRunStateSchema>;
export type LongRunCheckpoint = LongRunState['longRun'];
export type LongRunObservation = z.infer<typeof observation>;
export const stepId = (index: number) => `long-${index + 1}`;
export const say = (language: LongRunLanguage, ar: string, en: string) => language === 'ar' ? ar : en;

function label(operation: LongRunStep, language: LongRunLanguage) {
  switch (operation.kind) {
    case 'search': return say(language, 'البحث عن مصادر عامة', 'Find public sources');
    case 'read_source': return say(language, 'قراءة مصدر عام', 'Read a public source');
    case 'monitor': return say(language, 'فحص الصفحة العامة', 'Check the public page');
    case 'prepare_site': return say(language, 'مراجعة تفاصيل الموقع', 'Validate the site brief');
    case 'build_site': return say(language, 'إنشاء مسودة الموقع', 'Build the draft site');
  }
}
function acceptance(operation: LongRunStep, language: LongRunLanguage) {
  switch (operation.kind) {
    case 'search': return say(language, 'استُرجعت قائمة نتائج عامة.', 'Retrieved a list of public results.');
    case 'read_source': case 'monitor': return say(language, 'قُرئ نص المصدر وحُفظت بصمته.', 'Read and fingerprinted the source text.');
    case 'prepare_site': return say(language, 'استوفت تفاصيل الموقع متطلبات المخطط.', 'The brief passed schema validation.');
    case 'build_site': return say(language, 'أعادت خدمة المواقع معرّف المسودة ونتائج فحوصها.', 'The site service returned the draft ID and check results.');
  }
}
const capability = { search: 'web.search', read_source: 'web.read', monitor: 'web.read', prepare_site: 'local.computation', build_site: 'site.build' } as const;

export function initialLongRunState(id: string, plan: LongRunPlan, at: number, replyConstraints?: ReplyConstraints): LongRunState {
  const language = replyConstraints?.lang ?? plan.language;
  const ledger = createRunLedger({ runId: id, at, path: 'action' });
  enterPhase(ledger, 'understanding', at);
  enterPhase(ledger, 'planning', at);
  const operations = plan.steps.map((operation, index) => planStep({
    id: stepId(index),
    capability: capability[operation.kind],
    outcome: label(operation, language),
    acceptance: [acceptance(operation, language)],
    input: null,
    ...(operation.kind === 'build_site' && operation.approval ? { authorization: 'required' } : {}),
    required: operation.kind !== 'read_source',
    // Candidate reads are independent. The host runs the frozen plan in order.
    dependsOn: operation.kind === 'read_source' || operation.kind === 'build_site' ? [stepId(0)] : [],
  }));
  setPlan(ledger, { version: 1, steps: operations }, at);
  enterPhase(ledger, 'executing', at);
  return LongRunStateSchema.parse({
    agentRun: ledger,
    longRun: { version: 1, ...(plan.background ? { background: plan.background } : {}), language, replyConstraints, steps: plan.steps, next: 0, resources: 0, deadline: at + LONG_RUN_LIMITS.wallMs,
      dueAt: at, inFlight: null, candidates: [], observations: [], site: null, inputId: null },
  });
}

export function restoreLongRunState(value: unknown, runId: string): LongRunState | null {
  const parsed = LongRunStateSchema.safeParse(value);
  return parsed.success && parsed.data.agentRun.runId === runId ? parsed.data : null;
}
