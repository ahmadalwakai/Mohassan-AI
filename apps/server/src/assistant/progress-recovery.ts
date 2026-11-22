import { z } from 'zod';
import { restoreTaskSupervisor, type TaskSupervisorState } from './task-supervisor.js';
import { BrowserRecoverySchema, reserveBrowserRecovery } from './browser-recovery.js';

/**
 * Host-owned loop budgets. This helper never authorizes a tool or certifies a
 * goal. Call it with counters and receipts read by the controller, never with a
 * provider's JSON. Retry changes a budget checkpoint, not the evidence ledger,
 * action signatures, approvals, or effect receipts.
 */
const MAX_LIFETIME_DECISIONS = 60;
const MAX_RETRIES = 2;
const MAX_STATE_BYTES = 8192;
const identity = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(2_147_483_647);
const PolicySchema = z.object({
  windowDecisions: z.number().int().min(1).max(40),
  lifetimeDecisions: z.number().int().min(1).max(MAX_LIFETIME_DECISIONS),
  maxRetries: z.number().int().min(0).max(MAX_RETRIES),
  warnAfter: z.number().int().min(1).max(10),
  pauseAfter: z.number().int().min(2).max(20),
  failureLimit: z.number().int().min(1).max(20),
}).strict().refine(value => value.windowDecisions <= value.lifetimeDecisions && value.warnAfter < value.pauseAfter);
export type ProgressRecoveryPolicy = z.infer<typeof PolicySchema>;
const defaults: ProgressRecoveryPolicy = {
  windowDecisions: 40, lifetimeDecisions: 60, maxRetries: 2, warnAfter: 3, pauseAfter: 5, failureLimit: 6,
};
const CheckpointSchema = z.object({ totalSteps: counter, supervisionSequence: counter }).strict();
const PauseSchema = CheckpointSchema.extend({ questionId: identity, failures: counter, unchanged: counter }).strict();
const StateSchema = z.object({
  version: z.literal(1), runId: identity, contractHash: hash, policy: PolicySchema,
  checkpoint: CheckpointSchema,
  retries: z.number().int().min(0).max(MAX_RETRIES),
  consumedQuestions: z.array(identity).max(MAX_RETRIES),
  pendingPause: PauseSchema.optional(),
  browser: BrowserRecoverySchema.optional(),
  automaticCheckpoint: CheckpointSchema.extend({ failures: counter, unchanged: counter }).strict().optional(),
}).strict();
export type ProgressRecoveryState = z.infer<typeof StateSchema>;
export interface ProgressRecoveryIdentity { runId: string; contractHash: string }
export interface ProgressRecoveryContext extends ProgressRecoveryIdentity {
  /** Lifetime model/decision count. Never zero this on a retry. */
  totalSteps: number;
  /** Existing consecutive failure/no-effect counters; clear only after accepted retry. */
  failures: number;
  unchanged: number;
  /** The controller's ledger; omit for legacy runs without one. */
  supervision?: TaskSupervisorState;
  /** Read from controller/receipt state. Unknown read content is not an unknown effect. */
  effectStatus: 'clear' | 'pending' | 'unknown';
}
export type ProgressRecoveryAction = 'continue' | 'change_strategy' | 'pause_for_retry' | 'stop_and_report' | 'reconcile';
export type ProgressRecoveryReason = 'within_budget' | 'stagnation' | 'failures' | 'window_limit' | 'lifetime_limit'
  | 'retry_limit' | 'ledger_capacity' | 'effect_pending' | 'effect_unknown' | 'awaiting_retry' | 'invalid_state';
export interface ProgressRecoveryReview {
  action: ProgressRecoveryAction;
  reason: ProgressRecoveryReason;
  /** These are routing recommendations, never authority to replay an effect. */
  mayReplayEffects: false;
  windowSteps: number;
  stagnantSteps: number;
  remainingDecisions: number;
  remainingRetries: number;
}

export function createProgressRecovery(input: ProgressRecoveryIdentity & { policy?: Partial<ProgressRecoveryPolicy> }): ProgressRecoveryState {
  const state = StateSchema.parse({ version: 1, runId: input.runId, contractHash: input.contractHash,
    policy: { ...defaults, ...input.policy }, checkpoint: { totalSteps: 0, supervisionSequence: 0 }, retries: 0, consumedQuestions: [] });
  return state;
}

const ContextSchema = z.object({
  runId: identity, contractHash: hash, totalSteps: counter, failures: counter, unchanged: counter,
  effectStatus: z.enum(['clear', 'pending', 'unknown']),
});

function checked(value: unknown, context: ProgressRecoveryContext): { state: ProgressRecoveryState; ledger?: TaskSupervisorState } | null {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STATE_BYTES) return null;
    const state = StateSchema.parse(value);
    const current = ContextSchema.parse(context);
    if (state.runId !== current.runId || state.contractHash !== current.contractHash
      || state.retries !== state.consumedQuestions.length || state.retries > state.policy.maxRetries
      || new Set(state.consumedQuestions).size !== state.consumedQuestions.length
      || state.retries === 0 && (state.checkpoint.totalSteps !== 0 || state.checkpoint.supervisionSequence !== 0)) return null;
    let ledger: TaskSupervisorState | undefined;
    if (context.supervision) {
      if (context.supervision.contract.hash !== state.contractHash) return null;
      // Progress does not assess evidence freshness. Replay validates the ledger
      // integrity with a fixed maximum timestamp, keeping this helper clock-free.
      ledger = restoreTaskSupervisor(context.supervision, context.supervision.contract, { now: 8_640_000_000_000_000 }) ?? undefined;
      if (!ledger) return null;
    }
    const sequence = ledger?.lastSequence ?? 0;
    if (state.checkpoint.totalSteps > current.totalSteps || state.checkpoint.supervisionSequence > sequence) return null;
    if (state.automaticCheckpoint && (!state.browser?.history.some(entry => entry.strategy === 'observe_and_replan'
      && entry.step === state.automaticCheckpoint!.totalSteps && entry.sequence === state.automaticCheckpoint!.supervisionSequence)
      || state.automaticCheckpoint.totalSteps > current.totalSteps || state.automaticCheckpoint.supervisionSequence > sequence)) return null;
    if (state.browser?.history.some(entry => entry.step > current.totalSteps || entry.sequence > sequence)) return null;
    if (state.pendingPause && (state.consumedQuestions.includes(state.pendingPause.questionId)
      || state.pendingPause.totalSteps !== current.totalSteps || state.pendingPause.supervisionSequence !== sequence
      || state.pendingPause.failures !== current.failures || state.pendingPause.unchanged !== current.unchanged)) return null;
    return { state, ledger };
  } catch { return null; }
}

/** Restore only alongside the current host run, objective and monotonic counters. */
export function restoreProgressRecovery(value: unknown, context: ProgressRecoveryContext): ProgressRecoveryState | null {
  return checked(value, context)?.state ?? null;
}

export function reviewProgressRecovery(value: ProgressRecoveryState, context: ProgressRecoveryContext): ProgressRecoveryReview {
  const valid = checked(value, context);
  const result = (action: ProgressRecoveryAction, reason: ProgressRecoveryReason, windowSteps = 0, stagnantSteps = 0): ProgressRecoveryReview => ({
    action, reason, mayReplayEffects: false, windowSteps, stagnantSteps,
    remainingDecisions: valid ? Math.max(0, valid.state.policy.lifetimeDecisions - context.totalSteps) : 0,
    remainingRetries: valid ? Math.max(0, valid.state.policy.maxRetries - valid.state.retries) : 0,
  });
  // Effect fences win even if an old recovery snapshot is invalid. They do not
  // become ordinary retry questions, and retry never clears them.
  if (context.effectStatus === 'pending') return result('reconcile', 'effect_pending');
  if (context.effectStatus === 'unknown') return result('reconcile', 'effect_unknown');
  if (!valid) return result('stop_and_report', 'invalid_state');
  if (valid.state.browser?.uncertain) return result('reconcile', 'effect_unknown');
  const { state, ledger } = valid;
  const windowSteps = context.totalSteps - state.checkpoint.totalSteps;
  const automaticCheckpoint = state.automaticCheckpoint && state.automaticCheckpoint.totalSteps >= state.checkpoint.totalSteps ? state.automaticCheckpoint : undefined;
  const progressCheckpoint = automaticCheckpoint ?? state.checkpoint;
  let stagnantSteps = 0;
  for (const record of (ledger?.steps ?? []).toReversed()) {
    if (record.sequence <= progressCheckpoint.supervisionSequence || record.progressed) break;
    stagnantSteps++;
  }
  // Legacy counters also include suppressed duplicate decisions, which are not
  // dispatched and therefore have no new ledger receipt. Never trust changed:true.
  const sinceAutomatic = automaticCheckpoint ? Math.max(0, context.totalSteps - automaticCheckpoint.totalSteps) : Infinity;
  stagnantSteps = Math.max(stagnantSteps, Math.min(context.unchanged, sinceAutomatic));
  if (context.totalSteps >= state.policy.lifetimeDecisions) return result('stop_and_report', 'lifetime_limit', windowSteps, stagnantSteps);
  if (ledger && ledger.steps.length >= 64) return result('stop_and_report', 'ledger_capacity', windowSteps, stagnantSteps);
  if (state.pendingPause) return result('pause_for_retry', 'awaiting_retry', windowSteps, stagnantSteps);
  const reason: ProgressRecoveryReason | null = Math.min(context.failures, sinceAutomatic) >= state.policy.failureLimit ? 'failures'
    : stagnantSteps >= state.policy.pauseAfter ? 'stagnation'
      : windowSteps >= state.policy.windowDecisions ? 'window_limit' : null;
  if (reason) return result(state.retries >= state.policy.maxRetries ? 'stop_and_report' : 'pause_for_retry',
    state.retries >= state.policy.maxRetries ? 'retry_limit' : reason, windowSteps, stagnantSteps);
  return stagnantSteps >= state.policy.warnAfter ? result('change_strategy', 'stagnation', windowSteps, stagnantSteps)
    : result('continue', 'within_budget', windowSteps, stagnantSteps);
}

/** Called only for a live, permitted browser task after the host checks effects. */
export function resumeBrowserProgressAutomatically(value: ProgressRecoveryState, context: ProgressRecoveryContext): ProgressRecoveryState | null {
  const valid = checked(value, context);
  if (!valid || context.effectStatus !== 'clear' || valid.state.pendingPause) return null;
  const review = reviewProgressRecovery(value, context);
  if (review.action !== 'pause_for_retry' || !['stagnation', 'failures'].includes(review.reason)) return null;
  const browser = reserveBrowserRecovery(valid.state.browser, { reason: review.reason, action: 'progress', strategy: 'observe_and_replan',
    step: context.totalSteps, sequence: valid.ledger?.lastSequence ?? 0 });
  return browser ? { ...valid.state, browser, automaticCheckpoint: { totalSteps: context.totalSteps,
    supervisionSequence: valid.ledger?.lastSequence ?? 0, failures: context.failures, unchanged: context.unchanged } } : null;
}

export interface ProgressPauseResult {
  armed: boolean;
  reason: 'armed' | 'already_armed' | 'not_paused' | 'question_conflict' | 'invalid_state';
  state: ProgressRecoveryState;
}

/** Call in the same host transaction that publishes this exact progress card. */
export function armProgressPause(value: ProgressRecoveryState, questionId: string, context: ProgressRecoveryContext): ProgressPauseResult {
  const valid = checked(value, context);
  const reject = (reason: ProgressPauseResult['reason']): ProgressPauseResult => ({ armed: false, reason, state: value });
  if (!valid || !identity.safeParse(questionId).success || questionId.trim() !== questionId) return reject('invalid_state');
  const { state, ledger } = valid;
  if (state.consumedQuestions.includes(questionId)) return reject('question_conflict');
  if (state.pendingPause) return state.pendingPause.questionId === questionId
    ? { armed: true, reason: 'already_armed', state } : reject('question_conflict');
  if (reviewProgressRecovery(state, context).action !== 'pause_for_retry') return reject('not_paused');
  return { armed: true, reason: 'armed', state: { ...state, pendingPause: {
    questionId, totalSteps: context.totalSteps, supervisionSequence: ledger?.lastSequence ?? 0,
    failures: context.failures, unchanged: context.unchanged,
  } } };
}

export interface ProgressRetryResult {
  resumed: boolean;
  reason: 'resumed' | 'not_retry' | 'question_mismatch' | 'effect_unresolved' | 'budget_exhausted' | 'invalid_state';
  state: ProgressRecoveryState;
  resetCounters?: { failures: 0; unchanged: 0 };
}

/**
 * Only an explicit retry option on the active host progress question may consume
 * a retry. A plain reply, clarification, login or approval is not this operation.
 * The enclosing conversation transaction must validate owner/question/lease too.
 */
export function resumeProgressAfterRetry(value: ProgressRecoveryState, choice: { questionId: string; optionId: string }, context: ProgressRecoveryContext): ProgressRetryResult {
  const reject = (reason: ProgressRetryResult['reason']): ProgressRetryResult => ({ resumed: false, reason, state: value });
  if (choice.optionId !== 'retry') return reject('not_retry');
  if (context.effectStatus !== 'clear' || value.browser?.uncertain) return reject('effect_unresolved');
  const valid = checked(value, context);
  if (!valid) return reject('invalid_state');
  const { state, ledger } = valid;
  if (!state.pendingPause || state.pendingPause.questionId !== choice.questionId || state.consumedQuestions.includes(choice.questionId)) return reject('question_mismatch');
  if (state.retries >= state.policy.maxRetries || context.totalSteps >= state.policy.lifetimeDecisions
    || ledger && ledger.steps.length >= 64) return reject('budget_exhausted');
  const { pendingPause: _pending, ...rest } = state;
  return { resumed: true, reason: 'resumed', state: { ...rest,
    checkpoint: { totalSteps: context.totalSteps, supervisionSequence: ledger?.lastSequence ?? 0 },
    retries: state.retries + 1, consumedQuestions: [...state.consumedQuestions, choice.questionId],
  }, resetCounters: { failures: 0, unchanged: 0 } };
}
