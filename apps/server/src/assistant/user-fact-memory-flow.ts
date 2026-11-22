import { z } from 'zod';
import { MemoryExactWriteReceiptSchema, type MemoryExactReconciliation, type MemoryExactReconcileInput, type MemoryExactWriteInput } from '@mohassan/memory';
import { createUserFactMemoryReceipt, restoreUserFactMemoryReceipt, type UserFactMemoryBinding, type UserFactMemoryReceipt } from './user-fact-memory-receipt.js';
import { ExactPersistencePolicySchema, ExactPersistenceVerificationSchema, exactPersistenceReasons, matchesExactMemoryCommit, validExactMemoryCommitTimes,
  runExactMemoryPersistence, validateExactMemoryReadback, type ExactPersistencePolicy, type ExactPersistenceReason, type ExactPersistenceState } from './exact-memory-persistence.js';

const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const base = { version: z.literal(1), kind: z.literal('user_fact_memory_flow'), receipt: z.unknown() };
const StateSchema = z.discriminatedUnion('phase', [
  z.object({ ...base, phase: z.literal('prepared') }).strict(),
  z.object({ ...base, phase: z.literal('write_attempted'), attemptedAt: instant }).strict(),
  z.object({ ...base, phase: z.literal('unknown'), attemptedAt: instant, commitReceipt: MemoryExactWriteReceiptSchema.optional(), reason: z.enum(exactPersistenceReasons) }).strict(),
  z.object({ ...base, phase: z.literal('verified'), attemptedAt: instant, commitReceipt: MemoryExactWriteReceiptSchema, verification: ExactPersistenceVerificationSchema }).strict(),
]);
type WithReceipt<T> = T extends unknown ? Omit<T, 'receipt'> & { receipt: UserFactMemoryReceipt } : never;
export type UserFactMemoryFlowState = WithReceipt<z.infer<typeof StateSchema>>;
export type UserFactMemoryFlowReason = ExactPersistenceReason;
export type UserFactMemoryPolicy = ExactPersistencePolicy;
export interface UserFactMemoryFlowInput {
  request: unknown;
  binding: UserFactMemoryBinding;
  persisted?: unknown;
  policy: UserFactMemoryPolicy;
}
export interface UserFactMemoryFlowPorts {
  signal: AbortSignal;
  assertActive(): Promise<void>;
  isExecutionEnded(error: unknown): boolean;
  checkpoint(state: UserFactMemoryFlowState): Promise<void>;
  scrubExact(text: string): string;
  now(): number;
  /** Host adapter supplies the domain's SAME-TX current account/run/lease/intent fence. */
  writeExact?: (ownerId: string, input: MemoryExactWriteInput) => Promise<unknown>;
  reconcileExact?: (ownerId: string, input: MemoryExactReconcileInput) => Promise<unknown>;
}
export interface UserFactMemoryFlowResult {
  scope: 'current_user_assertion_persistence_only';
  status: 'verified' | 'partial' | 'rejected';
  persistence: 'verified' | 'not_attempted' | 'unknown' | 'missing' | 'unavailable';
  reason: UserFactMemoryFlowReason;
  receipt?: UserFactMemoryReceipt;
  state?: UserFactMemoryFlowState;
  readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>;
}

/** Restore only this purpose's literal receipt against the current DB request and independently pinned raw input hash. */
export function restoreUserFactMemoryFlowState(value: unknown, request: unknown, binding: UserFactMemoryBinding, now: number): UserFactMemoryFlowState | null {
  try {
    const parsed = StateSchema.safeParse(value);
    if (!parsed.success) return null;
    const receipt = restoreUserFactMemoryReceipt(parsed.data.receipt, request, binding);
    if (!receipt) return null;
    const state = { ...parsed.data, receipt };
    if (state.phase !== 'prepared') {
      if (state.attemptedAt < binding.evaluatedAt || state.attemptedAt > now) return null;
      if ('commitReceipt' in state && state.commitReceipt && (!matchesExactMemoryCommit(state.commitReceipt, receipt)
        || !validExactMemoryCommitTimes(state.commitReceipt, state.attemptedAt, now))) return null;
      if (state.phase === 'verified') {
        const check = state.verification, observed = Date.parse(check.observedAt), commit = state.commitReceipt;
        if (!Number.isFinite(observed) || observed < state.attemptedAt || observed > now || observed < binding.evaluatedAt
          || observed < Date.parse(commit.createdAt) || observed >= Date.parse(commit.expiresAt)
          || check.itemId !== commit.itemId || check.rootId !== commit.rootId || check.itemVersion !== commit.itemVersion
          || check.evidenceId !== commit.evidenceId || check.payloadHash !== receipt.payload.hash) return null;
      }
    }
    return state as UserFactMemoryFlowState;
  } catch { return null; }
}
export function validateUserFactMemoryReadback(value: unknown, receipt: UserFactMemoryReceipt,
  state: Exclude<UserFactMemoryFlowState, { phase: 'prepared' }>, started: number, finished: number) {
  return validateExactMemoryReadback(value, receipt, state, started, finished);
}

/** Stores only the literal statement as manual/user_asserted data. Verified means exact persistence, never factual truth or calculation correctness. */
export async function runUserFactMemoryFlow(input: UserFactMemoryFlowInput, ports: UserFactMemoryFlowPorts): Promise<UserFactMemoryFlowResult> {
  const result = (status: UserFactMemoryFlowResult['status'], persistence: UserFactMemoryFlowResult['persistence'], reason: UserFactMemoryFlowReason,
    state?: UserFactMemoryFlowState, readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>): UserFactMemoryFlowResult => ({
    scope: 'current_user_assertion_persistence_only', status, persistence, reason,
    ...(state ? { state: structuredClone(state), receipt: structuredClone(state.receipt) } : {}), ...(readback ? { readback: structuredClone(readback) } : {}),
  });
  const uncertain = input.persisted !== undefined ? 'unknown' as const : 'not_attempted' as const;
  const policy = ExactPersistencePolicySchema.safeParse(input.policy);
  if (!policy.success) return result('rejected', uncertain, 'invalid_policy');
  ports.signal.throwIfAborted();
  if (!policy.data.accountAllowed) return result('partial', uncertain, 'account_unavailable');
  const now = ports.now();
  if (!instant.safeParse(now).success || now < input.binding?.evaluatedAt) return result('rejected', uncertain, 'invalid_clock');
  const receipt = createUserFactMemoryReceipt(input.request, input.binding);
  if (!receipt) return result('rejected', uncertain, 'invalid_input');
  let state: UserFactMemoryFlowState;
  if (input.persisted !== undefined) {
    const restored = restoreUserFactMemoryFlowState(input.persisted, input.request, input.binding, now);
    if (!restored) return result('rejected', 'unknown', 'invalid_state');
    state = restored;
  } else state = { version: 1, kind: 'user_fact_memory_flow', phase: 'prepared', receipt };
  if (ports.scrubExact(input.request as string) !== input.request || ports.scrubExact(receipt.payload.text) !== receipt.payload.text)
    return result('partial', state.phase === 'prepared' ? 'not_attempted' : 'unknown', 'scrub_changed', state);
  if (typeof ports.reconcileExact !== 'function' || state.phase === 'prepared' && typeof ports.writeExact !== 'function')
    return result('partial', state.phase === 'prepared' ? 'not_attempted' : 'unknown', 'exact_adapter_unavailable', state);
  if (state.phase === 'prepared' && policy.data.quota.used >= policy.data.quota.limit) return result('partial', 'not_attempted', 'quota_exhausted', state);
  const wrap = (next: ExactPersistenceState<UserFactMemoryReceipt>): UserFactMemoryFlowState => ({ version: 1, kind: 'user_fact_memory_flow', ...next });
  const outcome = await runExactMemoryPersistence({ state, invalidClockMessage: 'USER_FACT_MEMORY_INVALID_HOST_CLOCK' }, {
    signal: ports.signal, assertActive: () => ports.assertActive(), isExecutionEnded: error => ports.isExecutionEnded(error), now: () => ports.now(),
    checkpoint: next => ports.checkpoint(wrap(next)),
    writeExact: ports.writeExact && ((owner, payload) => ports.writeExact!(owner, payload)),
    reconcileExact: (owner, expected) => ports.reconcileExact!(owner, expected),
  });
  return result(outcome.persistence === 'verified' ? 'verified' : 'partial', outcome.persistence, outcome.reason, wrap(outcome.state), outcome.readback);
}
