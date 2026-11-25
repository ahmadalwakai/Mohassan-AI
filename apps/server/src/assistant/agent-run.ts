import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ChatRunViewSchema, EvidenceRecordSchema, ExecutionPlanSchema, PermissionDecisionSchema, RunContextSchema, RunPathSchema, RunPhaseSchema,
  RunVerdictSchema, VerificationResultSchema, terminalRunPhases,
  type ChatRunView, type EvidenceKind, type EvidenceRecord, type ExecutionPlan, type PlanStep, type PlanStepState, type RunContext, type RunPath,
  type RunPhase, type RunRisk, type RunVerdict, type TerminalRunPhase, type VerificationMethod, type VerificationResult,
} from '@mohassan/contracts';
import type { TaskCompletionReview, TaskSupervisorState } from './task-supervisor.js';
import { thoughtLedgerFields } from './deliberation/run-ledger.js';

/**
 * The run ledger: the runtime's own record of one chat run (docs/architecture/agent-execution.md). It holds the run's
 * phase, its typed plan, the evidence the host observed, the permission decisions and the final verdict. Only host code
 * changes it, at the moments the runtime commits state (send, pause, approve, finish, cancel); model text, page text,
 * skill files, memory excerpts and client fields are never passed in as authority. Pure: no I/O, no clock of its own.
 */

export class RunLedgerError extends Error {
  constructor(readonly code: 'RUN_PHASE_TERMINAL' | 'RUN_PHASE_TRANSITION' | 'RUN_PLAN_INVALID' | 'RUN_STEP_UNKNOWN' | 'RUN_STEP_DEPENDENCY' | 'RUN_STEP_STATE',
    message: string, readonly details: string[] = []) { super(message); this.name = 'RunLedgerError'; }
}

const TERMINAL: ReadonlySet<RunPhase> = new Set(terminalRunPhases);
export const isTerminalPhase = (phase: RunPhase): phase is TerminalRunPhase => TERMINAL.has(phase);

/**
 * Allowed phase changes. Any working phase may end blocked or cancelled; `completed` and `partial` are reached only
 * through `verifying`; a terminal phase never changes again. Entering the current phase again is a no-op.
 */
const NEXT: Record<RunPhase, readonly RunPhase[]> = {
  received: ['understanding'],
  understanding: ['selecting', 'planning', 'answering', 'executing', 'awaiting_input', 'awaiting_approval', 'verifying'],
  selecting: ['planning', 'answering', 'executing', 'awaiting_input', 'awaiting_approval', 'verifying'],
  planning: ['executing', 'awaiting_input', 'awaiting_approval', 'verifying'],
  answering: ['verifying', 'awaiting_input', 'executing'],
  executing: ['selecting', 'planning', 'answering', 'repairing', 'awaiting_input', 'awaiting_approval', 'verifying'],
  repairing: ['executing', 'planning', 'selecting', 'awaiting_input', 'awaiting_approval', 'verifying'],
  awaiting_input: ['understanding', 'executing'],
  awaiting_approval: ['understanding', 'executing'],
  verifying: ['completed', 'partial', 'blocked', 'repairing', 'executing'],
  completed: [], partial: [], blocked: [], cancelled: [],
};
const ALWAYS_FROM_WORKING: readonly RunPhase[] = ['blocked', 'cancelled'];

export function canEnterPhase(from: RunPhase, to: RunPhase): boolean {
  if (from === to) return !isTerminalPhase(from);
  if (isTerminalPhase(from)) return false;
  return NEXT[from].includes(to) || ALWAYS_FROM_WORKING.includes(to);
}

/**
 * Capabilities a plan step may name, with the risk and check the runtime assigns to each. A plan naming anything else is
 * rejected before any step runs. `adapter_report` marks tools whose result the host cannot observe for itself.
 */
export const RUN_CAPABILITIES = {
  'conversation.ask': { risk: 'none', verification: 'none' },
  'conversation.compose': { risk: 'none', verification: 'source_check' },
  'local.computation': { risk: 'none', verification: 'deterministic' },
  'local.answer': { risk: 'none', verification: 'deterministic' },
  'memory.read': { risk: 'read', verification: 'readback' },
  'memory.write': { risk: 'reversible_write', verification: 'readback' },
  'knowledge.read': { risk: 'read', verification: 'source_check' },
  'skill.read': { risk: 'read', verification: 'source_check' },
  'web.search': { risk: 'read', verification: 'source_check' },
  'web.read': { risk: 'read', verification: 'source_check' },
  'news.read': { risk: 'read', verification: 'observation' },
  'browser.open': { risk: 'read', verification: 'observation' },
  'browser.read': { risk: 'read', verification: 'observation' },
  'browser.scroll': { risk: 'read', verification: 'observation' },
  'browser.back': { risk: 'read', verification: 'observation' },
  'browser.click': { risk: 'reversible_write', verification: 'observation' },
  'browser.type': { risk: 'reversible_write', verification: 'observation' },
  'browser.submit': { risk: 'irreversible_write', verification: 'observation' },
  'document.create': { risk: 'reversible_write', verification: 'readback' },
  'document.edit': { risk: 'reversible_write', verification: 'readback' },
  'document.read': { risk: 'read', verification: 'readback' },
  'site.build': { risk: 'reversible_write', verification: 'adapter_report' },
  'desktop.read': { risk: 'read', verification: 'adapter_report' },
  'desktop.write': { risk: 'reversible_write', verification: 'adapter_report' },
  'desktop.delete': { risk: 'reversible_write', verification: 'adapter_report' },
  'desktop.run': { risk: 'irreversible_write', verification: 'adapter_report' },
  'computer.view': { risk: 'read', verification: 'observation' },
  'computer.input': { risk: 'irreversible_write', verification: 'adapter_report' },
  'runtime.task': { risk: 'irreversible_write', verification: 'owner_review' },
  'ads.campaign': { risk: 'irreversible_write', verification: 'readback' },
  'model.decision': { risk: 'none', verification: 'none' },
} as const satisfies Record<string, { risk: RunRisk; verification: VerificationMethod }>;
export type RunCapability = keyof typeof RUN_CAPABILITIES;
export const isRunCapability = (value: string): value is RunCapability => Object.hasOwn(RUN_CAPABILITIES, value);

const MAX_HISTORY = 48;
const MAX_EVIDENCE = 24;
const MAX_PERMISSIONS = 12;
const MAX_FAILURES = 16;
const MAX_STEP_ATTEMPTS = 20;
/** The same failure twice on one step is not retried a third time. */
export const REPEATED_FAILURE_LIMIT = 2;
/** Default number of corrections per run; CommandChatConfig.limits.repairsPerRun overrides it. */
export const DEFAULT_REPAIRS_PER_RUN = 1;

const isoSchema = z.iso.datetime();
export const PermissionRecordSchema = PermissionDecisionSchema.extend({
  actorId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(100),
  runId: z.string().min(1).max(100),
  capability: z.string().max(60),
  askedAt: isoSchema,
  expiresAt: isoSchema,
}).strict();
export type PermissionRecord = z.infer<typeof PermissionRecordSchema>;

export const RunLedgerSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(100),
  phase: RunPhaseSchema,
  history: z.array(z.object({ phase: RunPhaseSchema, at: isoSchema }).strict()).max(MAX_HISTORY),
  path: RunPathSchema.nullable(),
  context: RunContextSchema.nullable(),
  plan: ExecutionPlanSchema.nullable(),
  evidence: z.array(EvidenceRecordSchema).max(MAX_EVIDENCE),
  permissions: z.array(PermissionRecordSchema).max(MAX_PERMISSIONS),
  verification: VerificationResultSchema.nullable(),
  verdict: RunVerdictSchema.nullable(),
  repairs: z.object({ used: z.number().int().min(0).max(20), limit: z.number().int().min(0).max(20) }).strict(),
  failures: z.array(z.object({ stepId: z.string().max(40).nullable(), signature: z.string().min(1).max(160), count: z.number().int().min(1).max(100) }).strict()).max(MAX_FAILURES),
  steeredFrom: z.string().max(100).nullable(),
  /** Model calls of this run that returned a valid result, counted by the host when each one succeeded. */
  modelCalls: z.number().int().min(0).max(10_000),
  sequence: z.number().int().min(0).max(1_000_000),
  updatedAt: isoSchema,
  ...thoughtLedgerFields,
}).strict();
export type RunLedger = z.infer<typeof RunLedgerSchema>;

const iso = (at: number) => new Date(at).toISOString();
const touch = (ledger: RunLedger, at: number) => { ledger.sequence = Math.min(1_000_000, ledger.sequence + 1); ledger.updatedAt = iso(at); };
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function createRunLedger(input: { runId: string; at: number; path?: RunPath | null; context?: RunContext | null; steeredFrom?: string | null; repairLimit?: number }): RunLedger {
  return RunLedgerSchema.parse({
    version: 1, runId: input.runId, phase: 'received', history: [{ phase: 'received', at: iso(input.at) }],
    path: input.path ?? null, context: input.context ?? null, plan: null, evidence: [], permissions: [], verification: null, verdict: null,
    repairs: { used: 0, limit: Math.max(0, Math.min(20, input.repairLimit ?? DEFAULT_REPAIRS_PER_RUN)) }, failures: [],
    steeredFrom: input.steeredFrom ?? null, modelCalls: 0, sequence: 0, updatedAt: iso(input.at),
  });
}

/** Counts one model call that returned a valid result. */
export function countModelCall(ledger: RunLedger, at: number) {
  ledger.modelCalls = Math.min(10_000, ledger.modelCalls + 1);
  touch(ledger, at);
}

/**
 * A stored ledger is reused only for the same run; anything malformed or foreign is dropped, never repaired by guessing.
 * The validated object itself is returned (the schema has no defaults or transforms), so every hook of one run changes
 * the same ledger the run state holds, rather than a copy.
 */
export function restoreRunLedger(value: unknown, runId: string): RunLedger | null {
  const parsed = RunLedgerSchema.safeParse(value);
  return parsed.success && parsed.data.runId === runId ? value as RunLedger : null;
}

export function enterPhase(ledger: RunLedger, phase: RunPhase, at: number): RunLedger {
  if (ledger.phase === phase && !isTerminalPhase(phase)) return ledger;
  if (isTerminalPhase(ledger.phase)) throw new RunLedgerError('RUN_PHASE_TERMINAL', `The run already ended as ${ledger.phase}.`);
  if (!canEnterPhase(ledger.phase, phase)) throw new RunLedgerError('RUN_PHASE_TRANSITION', `A run cannot move from ${ledger.phase} to ${phase}.`);
  ledger.phase = phase;
  ledger.history.push({ phase, at: iso(at) });
  // The first entry (received) stays; the oldest of the rest give way.
  if (ledger.history.length > MAX_HISTORY) ledger.history.splice(1, ledger.history.length - MAX_HISTORY);
  touch(ledger, at);
  return ledger;
}

/** Moves to the phase when the move is allowed, and reports whether it did. For hooks that must never stop a run. */
export function tryEnterPhase(ledger: RunLedger | undefined | null, phase: RunPhase, at: number): boolean {
  if (!ledger || !canEnterPhase(ledger.phase, phase)) return false;
  enterPhase(ledger, phase, at);
  return true;
}

export type PlanStepInput = Omit<PlanStep, 'state' | 'attempts' | 'risk' | 'verification' | 'authorization' | 'required' | 'dependsOn'>
  & Partial<Pick<PlanStep, 'state' | 'attempts' | 'risk' | 'verification' | 'authorization' | 'required' | 'dependsOn'>>;

/** A step with the risk and check its capability defines, unless the caller states stricter ones. */
export function planStep(input: PlanStepInput): PlanStep {
  const capability = isRunCapability(input.capability) ? RUN_CAPABILITIES[input.capability] : null;
  const risk = input.risk ?? capability?.risk ?? 'read';
  return {
    id: input.id, outcome: clip(input.outcome, 200), dependsOn: input.dependsOn ?? [], capability: input.capability,
    input: input.input === null ? null : clip(input.input, 300), acceptance: input.acceptance.map(item => clip(item, 200)).slice(0, 4),
    verification: input.verification ?? capability?.verification ?? 'none', required: input.required ?? true, risk,
    authorization: input.authorization ?? (risk === 'irreversible_write' ? 'required' : 'not_needed'),
    state: input.state ?? 'pending', attempts: input.attempts ?? 0,
  };
}

/**
 * Schema, unique ids, known dependencies, no cycle, registered capabilities, and authorization on every irreversible step.
 * Returns every problem found, so a rejected plan says why.
 */
export function validatePlan(value: unknown): { ok: true; plan: ExecutionPlan } | { ok: false; errors: string[] } {
  const parsed = ExecutionPlanSchema.safeParse(value);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(issue => `schema: ${issue.path.join('.')} ${issue.message}`).slice(0, 8) };
  const plan = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) errors.push(`duplicate step id ${step.id}`);
    ids.add(step.id);
    if (!isRunCapability(step.capability)) errors.push(`unregistered capability ${step.capability} in ${step.id}`);
    if (step.risk === 'irreversible_write' && step.authorization === 'not_needed') errors.push(`irreversible step ${step.id} has no authorization requirement`);
  }
  for (const step of plan.steps) for (const dependency of step.dependsOn) {
    if (dependency === step.id) errors.push(`step ${step.id} depends on itself`);
    else if (!ids.has(dependency)) errors.push(`step ${step.id} depends on unknown step ${dependency}`);
  }
  // Kahn's algorithm: a step whose dependencies never all finish is in a cycle.
  const incoming = new Map(plan.steps.map(step => [step.id, new Set(step.dependsOn.filter(dependency => ids.has(dependency) && dependency !== step.id))]));
  const ready = [...incoming].filter(([, needs]) => !needs.size).map(([id]) => id);
  let ordered = 0;
  while (ready.length) {
    const done = ready.pop()!;
    ordered++;
    for (const [id, needs] of incoming) if (needs.delete(done) && !needs.size) ready.push(id);
  }
  if (ordered < incoming.size) errors.push('the plan has a dependency cycle');
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

/** Sets the run's plan. A plan is replaced only while none of its steps has started; an invalid plan is refused whole. */
export function setPlan(ledger: RunLedger, plan: ExecutionPlan, at: number): RunLedger {
  const checked = validatePlan(plan);
  if (!checked.ok) throw new RunLedgerError('RUN_PLAN_INVALID', 'The plan was rejected before any step ran.', checked.errors);
  if (ledger.plan?.steps.some(step => step.state !== 'pending')) throw new RunLedgerError('RUN_STEP_STATE', 'A started plan is extended, not replaced.');
  ledger.plan = structuredClone(checked.plan);
  touch(ledger, at);
  return ledger;
}

/** Adds one step to the plan (a plan made step by step, such as a model's or a desktop command's). False when the plan is full. */
export function appendStep(ledger: RunLedger, step: PlanStep, at: number): boolean {
  const steps = [...(ledger.plan?.steps ?? []), step];
  if (steps.length > 16) return false;
  const checked = validatePlan({ version: 1, steps });
  if (!checked.ok) throw new RunLedgerError('RUN_PLAN_INVALID', 'The step was rejected.', checked.errors);
  ledger.plan = structuredClone(checked.plan);
  touch(ledger, at);
  return true;
}

function stepOf(ledger: RunLedger, id: string): PlanStep {
  const step = ledger.plan?.steps.find(item => item.id === id);
  if (!step) throw new RunLedgerError('RUN_STEP_UNKNOWN', `No plan step ${id}.`);
  return step;
}

const RESTARTABLE: ReadonlySet<PlanStepState> = new Set(['pending', 'failed', 'awaiting_approval']);
/** Starts a step whose required dependencies are verified. Unknown effects require reconciliation, never an automatic retry. */
export function startStep(ledger: RunLedger, id: string, at: number): PlanStep {
  const step = stepOf(ledger, id);
  if (step.state === 'running') return step;
  if (!RESTARTABLE.has(step.state)) throw new RunLedgerError('RUN_STEP_STATE', `Step ${id} is ${step.state}; it cannot start.`);
  const waiting = step.dependsOn.filter(dependency => {
    const prior = stepOf(ledger, dependency);
    return prior.state !== 'verified' && !(prior.state === 'skipped' && !prior.required);
  });
  if (waiting.length) throw new RunLedgerError('RUN_STEP_DEPENDENCY', `Step ${id} waits for ${waiting.join(', ')}.`, waiting);
  if (step.attempts >= MAX_STEP_ATTEMPTS) throw new RunLedgerError('RUN_STEP_STATE', `Step ${id} reached its attempt limit.`);
  step.state = 'running';
  step.attempts++;
  // A run that starts a tool step is on the action path, whatever the first routing guess was.
  if (step.capability !== 'conversation.ask') ledger.path = 'action';
  touch(ledger, at);
  return step;
}

const SETTLED_FROM: Record<PlanStepState, readonly PlanStepState[]> = {
  pending: [], running: [],
  awaiting_approval: ['pending', 'running'],
  verified: ['running', 'awaiting_approval'],
  failed: ['running', 'awaiting_approval', 'pending'],
  unknown: ['running', 'awaiting_approval'],
  skipped: ['pending'],
  invalidated: ['pending', 'running', 'awaiting_approval'],
};
export function settleStep(ledger: RunLedger, id: string, state: Exclude<PlanStepState, 'pending' | 'running'>, at: number): PlanStep {
  const step = stepOf(ledger, id);
  if (step.state === state) return step;
  if (!SETTLED_FROM[state].includes(step.state)) throw new RunLedgerError('RUN_STEP_STATE', `Step ${id} cannot go from ${step.state} to ${state}.`);
  step.state = state;
  touch(ledger, at);
  return step;
}

export function setStepAuthorization(ledger: RunLedger, id: string, authorization: PlanStep['authorization'], at: number) {
  const step = stepOf(ledger, id);
  if (step.authorization === authorization) return;
  step.authorization = authorization;
  touch(ledger, at);
}

/** Records host-observed evidence once (same kind, reference and label); the oldest give way past the bound. */
export function addEvidence(ledger: RunLedger, input: { stepId?: string | null; kind: EvidenceKind; label: string; reference?: string | null; observedAt?: number; independent?: boolean }, at: number, scope?: 'step'): EvidenceRecord | null {
  const label = clip(input.label.replace(/\s+/gu, ' ').trim(), 200);
  if (!label) return null;
  const reference = input.reference ? clip(input.reference, 500) : null;
  const existing = ledger.evidence.find(item => item.kind === input.kind && item.reference === reference && item.label === label && (scope !== 'step' || item.stepId === (input.stepId ?? null)));
  if (existing) return existing;
  // Only the host's own deterministic checks and observations can be independent; a tool's report, a user's
  // statement and model text never are, whatever the caller says.
  const independent = Boolean(input.independent) && ['observation', 'computation', 'readback', 'source'].includes(input.kind);
  const record = EvidenceRecordSchema.parse({
    id: createHash('sha256').update(`${ledger.runId}\n${input.kind}\n${reference ?? ''}\n${label}${scope === 'step' ? `\n${input.stepId ?? ''}` : ''}`).digest('hex').slice(0, 16),
    stepId: input.stepId ?? null, kind: input.kind, label, reference, observedAt: iso(input.observedAt ?? at), independent,
  });
  ledger.evidence.push(record);
  if (ledger.evidence.length > MAX_EVIDENCE) ledger.evidence.splice(0, ledger.evidence.length - MAX_EVIDENCE);
  touch(ledger, at);
  return record;
}

/**
 * Asks to correct a failed step once more. Refused when the run used its corrections or when the same failure already
 * happened twice on this step: a third identical attempt would only repeat it. On approval the run enters `repairing`.
 */
export function beginRepair(ledger: RunLedger, input: { stepId: string | null; signature: string }, at: number): { allowed: true } | { allowed: false; reason: 'repair_limit' | 'repeated_failure' } {
  const signature = clip(input.signature, 160);
  const seen = ledger.failures.find(item => item.stepId === input.stepId && item.signature === signature);
  if (seen) seen.count++;
  else {
    ledger.failures.push({ stepId: input.stepId, signature, count: 1 });
    if (ledger.failures.length > MAX_FAILURES) ledger.failures.shift();
  }
  touch(ledger, at);
  if ((seen?.count ?? 1) >= REPEATED_FAILURE_LIMIT) return { allowed: false, reason: 'repeated_failure' };
  if (ledger.repairs.used >= ledger.repairs.limit) return { allowed: false, reason: 'repair_limit' };
  ledger.repairs.used++;
  tryEnterPhase(ledger, 'repairing', at);
  return { allowed: true };
}

const CRITERION_STATUS = { verified: 'verified', failed: 'failed', unverified: 'unverified', expired: 'expired', missing: 'missing' } as const;

/**
 * The run's verdict, decided once when it finishes. `hostStatus` is what the path that answered concluded; the verdict
 * can lower it, never raise it: `completed` needs every required plan step verified and no enforced criterion unmet.
 * A completed step that only has its tool's report counts as done but is labelled so in the verification list.
 */
export function decideVerdict(ledger: RunLedger, input: { hostStatus: 'completed' | 'partial' | 'blocked'; review?: TaskCompletionReview | null;
  /**
   * Whether the supervisor's criteria gate completion for this run (an enforced contract, or a memory publication). Advisory
   * criteria are shown as guidance only: they never count as required, so a missing advisory observation is not reported
   * as a failed requirement of an answer the path itself verified.
   */
  enforced?: boolean;
  criterionLabels?: Record<string, string>; at: number }): { status: 'completed' | 'partial' | 'blocked'; verdict: RunVerdict; verification: VerificationResult } {
  const steps = ledger.plan?.steps ?? [];
  const required = steps.filter(step => step.required);
  const failedStep = required.find(step => ['failed', 'invalidated'].includes(step.state));
  const openStep = required.find(step => ['pending', 'running', 'awaiting_approval', 'unknown', 'skipped'].includes(step.state));
  const reviewBlocks = Boolean(input.review?.shouldBlockCompletion);
  let status = input.hostStatus;
  // The reason names what the runtime recorded: a refusal by the owner is never reported as a missing capability.
  const refused = required.some(step => step.authorization === 'refused');
  let reason = input.hostStatus === 'completed' ? (steps.length ? 'criteria_met' : 'answered')
    : refused ? 'owner_refused' : failedStep ? 'step_failed' : input.hostStatus === 'partial' ? 'partial_result' : 'not_possible';
  if (status === 'completed' && failedStep) { status = 'partial'; reason = failedStep.authorization === 'refused' ? 'owner_refused' : 'step_failed'; }
  else if (status === 'completed' && openStep) { status = 'partial'; reason = openStep.state === 'unknown' ? 'step_unverified' : 'steps_outstanding'; }
  else if (status === 'completed' && reviewBlocks) { status = 'partial'; reason = 'criteria_unmet'; }
  const allCriteria: VerificationResult['criteria'] = [
    ...steps.map(step => ({ id: `step:${step.id}`, label: step.outcome, required: step.required,
      status: step.state === 'verified' ? 'verified' as const : step.state === 'failed' || step.state === 'invalidated' ? 'failed' as const
        : step.state === 'unknown' ? 'unverified' as const : 'missing' as const })),
    ...(input.review?.criteria ?? []).map(item => ({ id: item.id, label: clip(input.criterionLabels?.[item.id] ?? item.id, 200), required: item.required && Boolean(input.enforced), status: CRITERION_STATUS[item.status] })),
  ];
  // The view is bounded, but every requirement contributes to the aggregate check.
  // When the view fills, keep unmet required criteria visible before guidance.
  const priority = (item: VerificationResult['criteria'][number]) => item.required ? item.status === 'verified' ? 1 : 0 : 2;
  const criteria = (allCriteria.length > 24 ? [...allCriteria].sort((left, right) => priority(left) - priority(right)) : allCriteria).slice(0, 24);
  const counted = allCriteria.filter(item => item.required);
  const verificationStatus: VerificationResult['status'] = !counted.length ? 'not_applicable'
    : counted.every(item => item.status === 'verified') ? 'verified' : counted.some(item => item.status === 'failed') ? 'failed'
      : counted.some(item => item.status === 'verified') ? 'partial' : 'unverified';
  const verification: VerificationResult = { status: verificationStatus, criteria, checkedAt: iso(input.at) };
  const verdict: RunVerdict = { status, reason, decidedAt: iso(input.at) };
  ledger.verification = VerificationResultSchema.parse(verification);
  ledger.verdict = RunVerdictSchema.parse(verdict);
  // A run resumed after a card or an approval comes back through understanding; every working phase reaches verifying.
  if (!canEnterPhase(ledger.phase, 'verifying')) tryEnterPhase(ledger, 'understanding', input.at);
  tryEnterPhase(ledger, 'verifying', input.at);
  enterPhase(ledger, status, input.at);
  return { status, verdict, verification };
}

/**
 * At the end of a run, the path's own final check settles the steps the runtime saw start but not end: on success they
 * are verified by it; otherwise a running step failed and a step that never started was skipped. A step whose effect is
 * `unknown` stays unknown: no final status turns an unknown external effect into a verified one.
 */
export function settleOpenSteps(ledger: RunLedger, hostStatus: 'completed' | 'partial' | 'blocked', at: number) {
  let changed = false;
  for (const step of ledger.plan?.steps ?? []) {
    const next: PlanStepState | null = step.state === 'running' ? hostStatus === 'completed' ? 'verified' : 'failed'
      : step.state === 'pending' && hostStatus !== 'completed' ? 'skipped' : null;
    if (next) { step.state = next; changed = true; }
  }
  if (changed) touch(ledger, at);
}

/**
 * Ends the run as cancelled: stopped by the owner, or replaced by a correction (`superseded`). Steps not yet done and
 * every permission not yet used are invalidated, so nothing queued for the old objective can run afterwards.
 */
export function cancelLedger(ledger: RunLedger, reason: 'owner_cancelled' | 'superseded', at: number): RunLedger {
  if (isTerminalPhase(ledger.phase)) return ledger;
  for (const step of ledger.plan?.steps ?? []) if (['pending', 'running', 'awaiting_approval'].includes(step.state)) step.state = 'invalidated';
  for (const permission of ledger.permissions) if (permission.decision === 'asked' || permission.decision === 'granted') {
    permission.decision = 'invalidated'; permission.reason = reason; permission.decidedAt = iso(at);
  }
  ledger.verdict = { status: 'cancelled', reason, decidedAt: iso(at) };
  enterPhase(ledger, 'cancelled', at);
  return ledger;
}

/** «توقف» / "stop" alone ends the task; any other message sent while a task works or waits corrects it. */
const STOP = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،\s]+)?(?:stop|cancel|abort|halt|never ?mind|forget it|توقف|توقّف|أوقف|اوقف|قف|الغ|ألغ|إلغ|الغي|ألغي|إلغاء|الغاء|لا تكمل|كفى|خلاص|بطّل|بطل)(?:\s+(?:it|this|that|now|please|here|ذلك|هذا|العمل|المهمة|الآن|الان|هنا|من فضلك))*[.!؟?\s]*$/iu;
export function classifySteering(text: string): 'stop' | 'steer' {
  return STOP.test(text.normalize('NFKC').replace(/[ً-ٰٟـ]/gu, '').trim()) ? 'stop' : 'steer';
}

/** Maps a run row's status (the authority) to the phase and verdict a client sees. */
function phaseOfStatus(status: string): { phase: RunPhase; reason?: string } | null {
  switch (status) {
    case 'running': return null;
    case 'waiting_user': case 'waiting_input': return { phase: 'awaiting_input' };
    case 'waiting_approval': return { phase: 'awaiting_approval' };
    case 'completed': return { phase: 'completed' };
    case 'partial': return { phase: 'partial' };
    case 'blocked': return { phase: 'blocked' };
    case 'cancelled': return { phase: 'cancelled', reason: 'owner_cancelled' };
    case 'failed': return { phase: 'blocked', reason: 'error' };
    case 'interrupted': return { phase: 'blocked', reason: 'interrupted' };
    default: return { phase: 'blocked', reason: 'unknown_status' };
  }
}

/**
 * The run as a client sees it. The run row's status is the authority: a terminal row always shows its own verdict, even
 * when the ledger missed the last write (a crash, an interrupted worker, a run recorded before ledgers existed).
 */
export function projectRunView(input: { runId: string; status: string; ledger: unknown; createdAt: Date | string; updatedAt: Date | string;
  /** Model calls counted from the receipts table; used only for runs recorded before the ledger counted them. */
  modelCalls?: number }): ChatRunView | null {
  const ledger = restoreRunLedger(input.ledger, input.runId);
  const mapped = phaseOfStatus(input.status);
  const modelCalls = ledger ? ledger.modelCalls : input.modelCalls ?? 0;
  const updatedAt = new Date(input.updatedAt).toISOString();
  const phase: RunPhase = mapped ? mapped.phase : ledger && !isTerminalPhase(ledger.phase) ? ledger.phase : 'understanding';
  const verdict = mapped && isTerminalPhase(mapped.phase)
    ? ledger?.verdict?.status === mapped.phase ? ledger.verdict : { status: mapped.phase, reason: mapped.reason ?? 'recorded', decidedAt: ledger?.verdict?.decidedAt ?? updatedAt }
    : null;
  const view = {
    id: input.runId, phase, path: ledger?.path ?? null,
    engine: { kind: modelCalls > 0 ? 'model' : 'rules', modelCalls: Math.max(0, Math.min(10_000, Math.trunc(modelCalls))) },
    context: ledger?.context ?? null, plan: ledger?.plan ?? null, evidence: ledger?.evidence ?? [],
    permissions: (ledger?.permissions ?? []).map(({ actorId: _actor, conversationId: _conversation, runId: _run, capability: _capability, askedAt: _asked, expiresAt: _expires, ...shown }) => shown),
    verification: ledger?.verification ?? null, verdict, repairs: ledger?.repairs ?? { used: 0, limit: 0 },
    steeredFrom: ledger?.steeredFrom && z.uuid().safeParse(ledger.steeredFrom).success ? ledger.steeredFrom : null,
    sequence: ledger?.sequence ?? 0, updatedAt: ledger && Date.parse(ledger.updatedAt) > Date.parse(updatedAt) ? ledger.updatedAt : updatedAt,
  };
  const parsed = ChatRunViewSchema.safeParse(view);
  if (parsed.success) return parsed.data;
  // A view that does not validate is never sent half-built: only what the row itself proves.
  const minimal = ChatRunViewSchema.safeParse({ ...view, context: null, plan: null, evidence: [], permissions: [], verification: null, steeredFrom: null });
  return minimal.success ? minimal.data : null;
}

/** Words for the supervisor's own sources, outcomes and criteria, in the request's language (the owner reads them). */
const SOURCE_WORDS: Record<string, [string, string]> = {
  computation: ['فحص الحساب المحلي', 'Local calculation check'], 'memory-read': ['قراءة الذاكرة', 'Memory read'],
  'knowledge-verifier': ['فحص المستندات المحفوظة', 'Saved documents check'], 'browser-verifier': ['فحص المتصفح', 'Browser check'],
  'computer-observation': ['قراءة النافذة', 'Window read'], 'authoritative-readback': ['قراءة راجعة من المصدر', 'Authoritative read-back'],
  'tool-receipt': ['إيصال الأداة', 'Tool receipt'],
};
const OUTCOME_WORDS: Record<string, [string, string]> = { confirmed: ['مؤكَّد', 'confirmed'], contradicted: ['مخالف', 'contradicted'], unknown: ['غير محسوم', 'undecided'] };
const CRITERION_WORDS: Record<string, [string, string]> = {
  'computed-answer': ['الجواب يحمل ناتج الحساب المحلي نفسه', 'The answer carries the local calculation\'s own result'],
  'computed-memory-save': ['الناتج محفوظ في الذاكرة ومقروء بعد الحفظ', 'The result is saved and reads back from memory'],
  'factual-answer': ['جواب مدعوم بمصدر قُرئ ويغطي السؤال', 'An answer supported by a source that was read'],
  'memory-answer': ['الجواب منقول من الذاكرة نفسها', 'The answer is taken from memory itself'],
  'memory-status-answer': ['حالة الحفظ مقروءة من الذاكرة', 'The save status is read from memory'],
  'user-note-status-answer': ['حالة الملاحظة مقروءة من الذاكرة', 'The note status is read from memory'],
  'user-fact-memory-save': ['الملاحظة محفوظة ومقروءة بعد الحفظ', 'The note is saved and reads back'],
  navigation: ['المتصفح وصل إلى الصفحة المطلوبة', 'The browser reached the requested page'],
  screenshot: ['صورة الصفحة المطلوبة', 'A screenshot of the requested page'],
  effect: ['الأثر المطلوب ظاهر في المصدر', 'The requested effect shows at its source'],
  'computer-title': ['عنوان النافذة مقروء', 'The window title was read'], 'computer-observation': ['النافذة مقروءة', 'The window was read'],
  'computer-text-subset': ['النص المطلوب ظاهر في النافذة', 'The requested text shows in the window'],
};
const arabicRun = (ledger: RunLedger) => /\p{Script=Arabic}/u.test(ledger.context?.objective ?? '');
/** The label of a supervisor criterion in the request's language; an unknown criterion keeps the supervisor's own wording. */
export function criterionLabel(ledger: RunLedger, id: string, fallback: string): string {
  const words = CRITERION_WORDS[id];
  return words ? words[arabicRun(ledger) ? 0 : 1] : fallback;
}

/**
 * Host-recorded evidence of a finished or paused run, read from state the runtime itself wrote: the task supervisor's
 * observations, the page an answer was read from, and the local calculation. Nothing here comes from model text.
 */
export function collectStateEvidence(ledger: RunLedger, state: {
  supervision?: TaskSupervisorState; handsFound?: { url: string; title: string; readAt?: string } | null;
  computed?: { line: string } | null;
}, at: number) {
  const lang = arabicRun(ledger) ? 0 : 1;
  const said = (source: string, outcome: string) => `${SOURCE_WORDS[source]?.[lang] ?? source}: ${OUTCOME_WORDS[outcome]?.[lang] ?? outcome}`;
  for (const step of state.supervision?.steps ?? []) for (const observation of step.observations) {
    const observedAt = observation.observedAt;
    if (observation.kind === 'navigation') addEvidence(ledger, { kind: 'observation', label: `HTTP ${observation.httpStatus}`, reference: observation.target, observedAt, independent: observation.httpStatus >= 200 && observation.httpStatus < 300 }, at);
    else if (observation.kind === 'answer_evidence') addEvidence(ledger, {
      kind: observation.source === 'computation' ? 'computation' : observation.source === 'memory-read' ? 'readback' : observation.source === 'knowledge-verifier' ? 'source' : 'observation',
      label: said(observation.source, observation.outcome), reference: observation.reference, observedAt, independent: observation.independentlyVerified && observation.outcome === 'confirmed' }, at);
    else if (observation.kind === 'effect') addEvidence(ledger, { kind: observation.source === 'tool-receipt' ? 'adapter_report' : 'readback',
      label: said(observation.source, observation.outcome), reference: observation.actionRef, observedAt, independent: observation.independentlyVerified && observation.source !== 'tool-receipt' && observation.outcome === 'confirmed' }, at);
    else addEvidence(ledger, { kind: 'observation', label: `${observation.artifactType}`, reference: observation.reference, observedAt, independent: true }, at);
  }
  if (state.handsFound?.url) addEvidence(ledger, { kind: 'source', label: state.handsFound.title || state.handsFound.url, reference: state.handsFound.url,
    observedAt: state.handsFound.readAt && Number.isFinite(Date.parse(state.handsFound.readAt)) ? Date.parse(state.handsFound.readAt) : at, independent: true }, at);
  if (state.computed?.line) addEvidence(ledger, { kind: 'computation', label: state.computed.line, independent: true }, at);
}
