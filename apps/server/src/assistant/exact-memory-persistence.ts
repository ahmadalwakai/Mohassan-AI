import { z } from 'zod';
import { MemoryExactWriteReceiptSchema, MemoryItemSchema, MemoryProvenanceSchema, type MemoryExactReconciliation,
  type MemoryExactReconcileInput, type MemoryExactWriteInput, type MemoryExactWriteReceipt } from '@mohassan/memory';

/** Internal host orchestration only. A purpose-specific factory/restore adapter must validate original request authority BEFORE calling this core. */
export interface ExactMemoryIntent {
  ownerId: string;
  evaluatedAt: number;
  operationKey: string;
  payload: { text: string; hash: string; bytes: number };
}
export const exactPersistenceReasons = ['ready', 'invalid_input', 'invalid_policy', 'invalid_state', 'invalid_clock', 'account_unavailable', 'exact_adapter_unavailable',
  'quota_exhausted', 'scrub_changed', 'write_uncertain', 'invalid_write_result', 'readback_unavailable', 'invalid_readback', 'missing', 'unavailable', 'verified'] as const;
export type ExactPersistenceReason = (typeof exactPersistenceReasons)[number];
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExactPersistencePolicySchema = z.object({ accountAllowed: z.boolean(), quota: z.object({ used: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(3) }).strict() }).strict();
export type ExactPersistencePolicy = z.infer<typeof ExactPersistencePolicySchema>;
export const ExactPersistenceVerificationSchema = z.object({ observedAt: z.iso.datetime(), itemId: z.uuid(), rootId: z.uuid(), itemVersion: z.number().int().positive(),
  evidenceId: z.uuid(), payloadHash: digest }).strict();
export type ExactPersistenceState<R extends ExactMemoryIntent> = { phase: 'prepared'; receipt: R }
  | { phase: 'write_attempted'; receipt: R; attemptedAt: number }
  | { phase: 'unknown'; receipt: R; attemptedAt: number; commitReceipt?: MemoryExactWriteReceipt; reason: ExactPersistenceReason }
  | { phase: 'verified'; receipt: R; attemptedAt: number; commitReceipt: MemoryExactWriteReceipt; verification: z.infer<typeof ExactPersistenceVerificationSchema> };
export type AttemptedExactPersistenceState<R extends ExactMemoryIntent> = Exclude<ExactPersistenceState<R>, { phase: 'prepared' }>;

const unavailableReasons = ['item_missing', 'item_inactive', 'item_expired', 'identity_mismatch', 'payload_mismatch', 'provenance_unavailable'] as const;
const StrictItemSchema = MemoryItemSchema.extend({ title: z.string().min(1).max(120), content: z.string().min(1).max(4000),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  provenance: z.array(MemoryProvenanceSchema.extend({ description: z.string().max(500), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable() }).strict()).length(1) }).strict();
const ReadbackSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(unavailableReasons), receipt: MemoryExactWriteReceiptSchema }).strict(),
  z.object({ status: z.literal('verified'), scope: z.literal('memory_persistence_only'), receipt: MemoryExactWriteReceiptSchema,
    item: StrictItemSchema, observedAt: z.iso.datetime() }).strict(),
]);
const WriteResultSchema = z.object({ created: z.boolean(), receipt: MemoryExactWriteReceiptSchema }).strict();
export const matchesExactMemoryCommit = (commit: MemoryExactWriteReceipt, receipt: ExactMemoryIntent): boolean => commit.ownerId === receipt.ownerId
  && commit.operationKey === receipt.operationKey && commit.payloadHash === receipt.payload.hash && commit.payloadBytes === receipt.payload.bytes
  && commit.layer === 'semantic' && commit.itemVersion === 1 && commit.itemId === commit.rootId;
export const validExactMemoryCommitTimes = (commit: MemoryExactWriteReceipt, earliest: number, latest: number) => {
  const created = Date.parse(commit.createdAt), expires = Date.parse(commit.expiresAt);
  return Number.isFinite(created) && Number.isFinite(expires) && created >= earliest && created <= latest && expires > created;
};

/** Exact persistence only. The receipt is already purpose-validated host data, never a provider claim or proof of factual truth. */
export function validateExactMemoryReadback<R extends ExactMemoryIntent>(value: unknown, receipt: R, state: AttemptedExactPersistenceState<R>,
  started: number, finished: number): z.infer<typeof ReadbackSchema> | null {
  try {
    if (value && typeof value === 'object' && 'status' in value && value.status === 'verified'
      && (!('item' in value) || !value.item || typeof value.item !== 'object' || !('provenance' in value.item)
        || !Array.isArray(value.item.provenance) || value.item.provenance.length !== 1)) return null;
    const parsed = ReadbackSchema.safeParse(value);
    if (!parsed.success) return null;
    const result = parsed.data;
    if (result.status === 'missing') return result;
    const commit = result.receipt;
    if (!matchesExactMemoryCommit(commit, receipt) || !validExactMemoryCommitTimes(commit, state.attemptedAt, finished)
      || 'commitReceipt' in state && state.commitReceipt && JSON.stringify(state.commitReceipt) !== JSON.stringify(commit)) return null;
    if (result.status === 'unavailable') return result;
    const observed = Date.parse(result.observedAt), item = result.item, evidence = item.provenance[0]!;
    if (observed < started || observed > finished || observed < receipt.evaluatedAt || observed < Date.parse(commit.createdAt)
      || observed >= Date.parse(commit.expiresAt) || item.id !== commit.itemId || item.rootId !== commit.rootId || item.version !== commit.itemVersion
      || item.layer !== 'semantic' || item.title !== 'Saved result' || item.status !== 'active' || item.taskId !== null || item.confidenceKind !== 'user_asserted'
      || item.createdAt !== commit.createdAt || item.expiresAt !== commit.expiresAt || Date.parse(item.updatedAt) < Date.parse(item.createdAt)
      || Date.parse(item.updatedAt) > observed || item.content !== receipt.payload.text
      || Buffer.byteLength(item.content, 'utf8') !== receipt.payload.bytes || evidence.id !== commit.evidenceId || evidence.kind !== 'manual'
      || evidence.trust !== 'manual' || evidence.status !== 'active' || evidence.taskId !== null || evidence.eventId !== null
      || evidence.contentHash !== receipt.payload.hash || Date.parse(evidence.observedAt) < state.attemptedAt || Date.parse(evidence.observedAt) > observed
      || evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= observed) return null;
    return result;
  } catch { return null; }
}

export interface ExactPersistencePorts<R extends ExactMemoryIntent> {
  signal: AbortSignal;
  assertActive(): Promise<void>;
  isExecutionEnded(error: unknown): boolean;
  /** Adapter wraps the checkpoint in its original purpose-specific serialized contract before durable host persistence. */
  checkpoint(state: ExactPersistenceState<R>): Promise<void>;
  now(): number;
  writeExact?: (ownerId: string, input: MemoryExactWriteInput) => Promise<unknown>;
  reconcileExact: (ownerId: string, input: MemoryExactReconcileInput) => Promise<unknown>;
}
export interface ExactPersistenceResult<R extends ExactMemoryIntent> {
  persistence: 'verified' | 'unknown' | 'missing' | 'unavailable';
  reason: ExactPersistenceReason;
  state: ExactPersistenceState<R>;
  readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>;
}

/**
 * Bounded shared mechanism, not a public tool or authority factory. Purpose adapters
 * own strict request/binding/state restore, policy, exact scrubbing and capability
 * preflight. This core keeps attempted-before-I/O, at-most-one-write, same-key
 * read-only recovery and host lease/cancellation fences identical across purposes.
 */
export async function runExactMemoryPersistence<R extends ExactMemoryIntent>(input: { state: ExactPersistenceState<R>; invalidClockMessage: string },
  ports: ExactPersistencePorts<R>): Promise<ExactPersistenceResult<R>> {
  let state = input.state;
  const receipt = state.receipt;
  const result = (persistence: ExactPersistenceResult<R>['persistence'], reason: ExactPersistenceReason,
    readback?: Extract<MemoryExactReconciliation, { status: 'verified' }>): ExactPersistenceResult<R> => ({ persistence, reason, state: structuredClone(state),
      ...(readback ? { readback: structuredClone(readback) } : {}) });
  const active = async () => { ports.signal.throwIfAborted(); await ports.assertActive(); ports.signal.throwIfAborted(); };
  const propagate = (error: unknown) => { ports.signal.throwIfAborted(); if (ports.isExecutionEnded(error)) throw error; };
  const checkpoint = async (next: ExactPersistenceState<R>) => {
    await active(); await ports.checkpoint(structuredClone(next)); await active(); state = next;
  };
  const time = () => { const value = ports.now(); if (!instant.safeParse(value).success) throw new Error(input.invalidClockMessage); return value; };
  await active();
  if (state.phase === 'prepared') {
    const attemptedAt = time();
    if (attemptedAt < receipt.evaluatedAt) throw new Error(input.invalidClockMessage);
    await checkpoint({ phase: 'write_attempted', receipt, attemptedAt });
    let commitReceipt: MemoryExactWriteReceipt | undefined, reason: ExactPersistenceReason = 'write_uncertain';
    let written: unknown, returned = false;
    try { written = await ports.writeExact!(receipt.ownerId, { operationKey: receipt.operationKey, payload: receipt.payload.text, payloadHash: receipt.payload.hash }); returned = true; }
    catch (error) { propagate(error); }
    await active();
    const writeFinished = time();
    try { if (returned) {
      const parsed = WriteResultSchema.safeParse(written);
      if (parsed.success && matchesExactMemoryCommit(parsed.data.receipt, receipt) && validExactMemoryCommitTimes(parsed.data.receipt, attemptedAt, writeFinished)) commitReceipt = parsed.data.receipt;
      else reason = 'invalid_write_result';
    } } catch { reason = 'invalid_write_result'; }
    await checkpoint({ phase: 'unknown', receipt, attemptedAt, reason, ...(commitReceipt ? { commitReceipt } : {}) });
  }
  const attempted = state as AttemptedExactPersistenceState<R>;
  await active();
  const readStarted = time();
  let returned: unknown;
  try { returned = await ports.reconcileExact(receipt.ownerId, { operationKey: receipt.operationKey, payloadHash: receipt.payload.hash }); }
  catch (error) {
    propagate(error); await active();
    await checkpoint({ phase: 'unknown', receipt, attemptedAt: attempted.attemptedAt,
      ...('commitReceipt' in attempted && attempted.commitReceipt ? { commitReceipt: attempted.commitReceipt } : {}), reason: 'readback_unavailable' });
    return result('unknown', 'readback_unavailable');
  }
  await active();
  const checked = validateExactMemoryReadback(returned, receipt, attempted, readStarted, time());
  if (checked?.status === 'verified') {
    await checkpoint({ phase: 'verified', receipt, attemptedAt: attempted.attemptedAt, commitReceipt: checked.receipt,
      verification: { observedAt: checked.observedAt, itemId: checked.item.id, rootId: checked.item.rootId, itemVersion: checked.item.version,
        evidenceId: checked.receipt.evidenceId, payloadHash: receipt.payload.hash } });
    return result('verified', 'verified', checked);
  }
  const reason: ExactPersistenceReason = !checked ? 'invalid_readback' : checked.status === 'missing' ? 'missing' : 'unavailable';
  const commitReceipt = checked?.status === 'unavailable' ? checked.receipt : 'commitReceipt' in attempted ? attempted.commitReceipt : undefined;
  await checkpoint({ phase: 'unknown', receipt, attemptedAt: attempted.attemptedAt, reason, ...(commitReceipt ? { commitReceipt } : {}) });
  return result(reason === 'missing' ? 'missing' : reason === 'unavailable' ? 'unavailable' : 'unknown', reason);
}
