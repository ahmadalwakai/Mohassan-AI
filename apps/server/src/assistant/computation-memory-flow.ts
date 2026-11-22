import { z } from 'zod';
import { MemoryExactWriteReceiptSchema,
  type MemoryExactReconciliation, type MemoryExactReconcileInput, type MemoryExactWriteInput, type MemoryExactWriteReceipt } from '@mohassan/memory';
import { createComputationMemoryReceipt, restoreComputationMemoryReceipt,
  type ComputationMemoryBinding, type ComputationMemoryReceipt } from './computation-memory-receipt.js';
import { ExactPersistencePolicySchema, ExactPersistenceVerificationSchema, exactPersistenceReasons, matchesExactMemoryCommit as matchesPayload,
  validExactMemoryCommitTimes as validCommitTimes, validateExactMemoryReadback, runExactMemoryPersistence, type ExactPersistenceState } from './exact-memory-persistence.js';

const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const PolicySchema = ExactPersistencePolicySchema;
export type ComputationMemoryPolicy = z.infer<typeof PolicySchema>;
const reasons = exactPersistenceReasons;
export type ComputationMemoryFlowReason = (typeof reasons)[number];
const VerificationSchema = ExactPersistenceVerificationSchema;
const stateBase = { version: z.literal(1), kind: z.literal('calculation_memory_flow'), receipt: z.unknown() };
const FlowStateSchema = z.discriminatedUnion('phase', [
  z.object({ ...stateBase, phase: z.literal('prepared') }).strict(),
  z.object({ ...stateBase, phase: z.literal('write_attempted'), attemptedAt: instant }).strict(),
  z.object({ ...stateBase, phase: z.literal('unknown'), attemptedAt: instant, commitReceipt: MemoryExactWriteReceiptSchema.optional(), reason: z.enum(reasons) }).strict(),
  z.object({ ...stateBase, phase: z.literal('verified'), attemptedAt: instant, commitReceipt: MemoryExactWriteReceiptSchema, verification: VerificationSchema }).strict(),
]);
type ParsedFlowState = z.infer<typeof FlowStateSchema>;
type WithReceipt<T> = T extends unknown ? Omit<T, 'receipt'> & { receipt: ComputationMemoryReceipt } : never;
export type ComputationMemoryFlowState = WithReceipt<ParsedFlowState>;

export interface ComputationMemoryFlowPorts {
  signal: AbortSignal;
  /** Must check current owner/run/lease/account. A throw is never converted to success. */
  assertActive(): Promise<void>;
  /** Host closure recognises its private RunEnded/cancellation class. */
  isExecutionEnded(error: unknown): boolean;
  /** Durably persists under the same run fence; reserves quota only on first attempted transition. */
  checkpoint(state: ComputationMemoryFlowState): Promise<void>;
  scrubExact(text: string): string;
  now(): number;
  /** Host closure supplies the memory domain's SAME-TRANSACTION execution fence. */
  writeExact?: (ownerId: string, input: MemoryExactWriteInput) => Promise<unknown>;
  reconcileExact?: (ownerId: string, input: MemoryExactReconcileInput) => Promise<unknown>;
}
export interface ComputationMemoryFlowInput {
  request: unknown;
  binding: ComputationMemoryBinding;
  /** Only undefined denotes absence. null/legacy/malformed state is rejected without actions. */
  persisted?: unknown;
  policy: ComputationMemoryPolicy;
}
export interface ComputationMemoryFlowResult {
  scope: 'calculation_memory_persistence_only';
  status: 'verified' | 'partial' | 'rejected';
  persistence: 'verified' | 'not_attempted' | 'unknown' | 'missing' | 'unavailable';
  reason: ComputationMemoryFlowReason;
  /** Calculation display only; the host composes the whole-goal outcome. */
  answer?: string;
  receipt?: ComputationMemoryReceipt;
  state?: ComputationMemoryFlowState;
  readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>;
}

/** Validate persisted host state against the original DB-owned request, identity and time. No I/O or authority. */
export function restoreComputationMemoryFlowState(value: unknown, request: unknown, binding: ComputationMemoryBinding, now: number): ComputationMemoryFlowState | null {
  try {
    const parsed = FlowStateSchema.safeParse(value);
    if (!parsed.success) return null;
    const receipt = restoreComputationMemoryReceipt(parsed.data.receipt, request, binding);
    if (!receipt) return null;
    const state = { ...parsed.data, receipt };
    if (state.phase !== 'prepared') {
      if (state.attemptedAt < binding.evaluatedAt || state.attemptedAt > now) return null;
      if ('commitReceipt' in state && state.commitReceipt
        && (!matchesPayload(state.commitReceipt, receipt) || !validCommitTimes(state.commitReceipt, state.attemptedAt, now))) return null;
      if (state.phase === 'verified') {
        const check = state.verification, observed = Date.parse(check.observedAt), commit = state.commitReceipt;
        if (!Number.isFinite(observed) || observed < state.attemptedAt || observed > now || observed < binding.evaluatedAt
          || observed < Date.parse(commit.createdAt) || observed >= Date.parse(commit.expiresAt)
          || check.itemId !== commit.itemId || check.rootId !== commit.rootId || check.itemVersion !== commit.itemVersion
          || check.evidenceId !== commit.evidenceId || check.payloadHash !== receipt.payload.hash) return null;
      }
    }
    return state as ComputationMemoryFlowState;
  } catch { return null; }
}

/** Trusted receipt/state and host call brackets only; never pass provider fields as those inputs. */
export function validateComputationMemoryReadback(value: unknown, receipt: ComputationMemoryReceipt, state: Exclude<ComputationMemoryFlowState, { phase: 'prepared' }>,
  started: number, finished: number) {
  return validateExactMemoryReadback(value, receipt, state, started, finished);
}

/**
 * At most one exact-write call. Every restored attempted/unknown/verified phase
 * reconciles read-only; missing/inactive evidence never becomes a create retry.
 * A verified result means only this owner-scoped persistence check, not overall
 * task completion or authority to dispatch any other action.
 */
export async function runComputationMemoryFlow(input: ComputationMemoryFlowInput, ports: ComputationMemoryFlowPorts): Promise<ComputationMemoryFlowResult> {
  const result = (status: ComputationMemoryFlowResult['status'], persistence: ComputationMemoryFlowResult['persistence'], reason: ComputationMemoryFlowReason,
    state?: ComputationMemoryFlowState, readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>): ComputationMemoryFlowResult => ({
    scope: 'calculation_memory_persistence_only', status, persistence, reason,
    ...(state ? { state: structuredClone(state), receipt: structuredClone(state.receipt), answer: state.receipt.answer } : {}),
    ...(readback ? { readback: structuredClone(readback) } : {}),
  });
  const uncertain = input.persisted !== undefined ? 'unknown' as const : 'not_attempted' as const;
  const policy = PolicySchema.safeParse(input.policy);
  if (!policy.success) return result('rejected', uncertain, 'invalid_policy');
  ports.signal.throwIfAborted();
  if (!policy.data.accountAllowed) return result('partial', uncertain, 'account_unavailable');
  const now = ports.now();
  if (!instant.safeParse(now).success || now < input.binding.evaluatedAt) return result('rejected', uncertain, 'invalid_clock');
  const receipt = createComputationMemoryReceipt(input.request, input.binding);
  if (!receipt) return result('rejected', uncertain, 'invalid_input');
  let state: ComputationMemoryFlowState;
  if (input.persisted !== undefined) {
    const restored = restoreComputationMemoryFlowState(input.persisted, input.request, input.binding, now);
    if (!restored) return result('rejected', 'unknown', 'invalid_state');
    state = restored;
  } else state = { version: 1, kind: 'calculation_memory_flow', phase: 'prepared', receipt };
  if (ports.scrubExact(input.request as string) !== input.request || ports.scrubExact(receipt.payload.text) !== receipt.payload.text
    || ports.scrubExact(receipt.answer) !== receipt.answer) return result('partial', state.phase === 'prepared' ? 'not_attempted' : 'unknown', 'scrub_changed', state);
  if (typeof ports.reconcileExact !== 'function' || state.phase === 'prepared' && typeof ports.writeExact !== 'function')
    return result('partial', state.phase === 'prepared' ? 'not_attempted' : 'unknown', 'exact_adapter_unavailable', state);
  if (state.phase === 'prepared' && policy.data.quota.used >= policy.data.quota.limit) return result('partial', 'not_attempted', 'quota_exhausted', state);

  const wrap = (next: ExactPersistenceState<ComputationMemoryReceipt>): ComputationMemoryFlowState => ({ version: 1, kind: 'calculation_memory_flow', ...next });
  const outcome = await runExactMemoryPersistence({ state, invalidClockMessage: 'COMPUTATION_MEMORY_INVALID_HOST_CLOCK' }, {
    signal: ports.signal, assertActive: () => ports.assertActive(), isExecutionEnded: error => ports.isExecutionEnded(error), now: () => ports.now(),
    checkpoint: next => ports.checkpoint(wrap(next)),
    writeExact: ports.writeExact && ((owner, payload) => ports.writeExact!(owner, payload)),
    reconcileExact: (owner, expected) => ports.reconcileExact!(owner, expected),
  });
  return result(outcome.persistence === 'verified' ? 'verified' : 'partial', outcome.persistence, outcome.reason, wrap(outcome.state), outcome.readback);
}
