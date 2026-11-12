import type { Failure, SupervisorEnvelope } from './contracts.js';
import { fail, freeze, textId, within } from './safety.js';

export interface ReconciliationEvidence {
  taskId: string; workspaceId: string; operationId: string; idempotencyKey: string;
  authorityId: string; evidenceRef: string; observedAt: number;
  /** Must inspect the actual resource/provider receipt, never infer from transport errors. */
  effect: 'applied' | 'not_applied' | 'unknown';
}
export interface ReconciliationAdapter {
  readonly authorityId: string;
  inspect(input: { envelope: SupervisorEnvelope; operationId: string; idempotencyKey: string },
    signal: AbortSignal): Promise<ReconciliationEvidence>;
}
export type ReconciliationDecision =
  | { status: 'verification_only'; evidence: ReconciliationEvidence }
  | { status: 'supervisor_may_authorize_new_task'; evidence: ReconciliationEvidence }
  | { status: 'escalate'; reason: 'adapter_unavailable' | 'uncertain_effect' | 'invalid_evidence' | 'cancelled_task_no_retry' };

/** Read-only recovery. It cannot dispatch, reset the execution ledger, or approve a retry. */
export async function reconcileEffect(input: {
  envelope: SupervisorEnvelope; failure: Failure; operationId: string; idempotencyKey: string;
  dispatchedAt: number; observationMaxAgeMs: number;
}, signal: AbortSignal, adapter?: ReconciliationAdapter): Promise<ReconciliationDecision> {
  signal.throwIfAborted();
  if (!input.envelope.operations.some(operation => operation.id === input.operationId) || !textId(input.idempotencyKey)
    || !Number.isSafeInteger(input.dispatchedAt) || input.dispatchedAt <= 0
    || !Number.isSafeInteger(input.observationMaxAgeMs) || input.observationMaxAgeMs <= 0
    || input.observationMaxAgeMs > 300_000) fail('invalid_contract');
  if (!adapter) return { status: 'escalate', reason: 'adapter_unavailable' };
  const evidence = await within(Math.min(30_000, input.observationMaxAgeMs), signal, inspectionSignal => adapter.inspect(input, inspectionSignal));
  signal.throwIfAborted();
  if (!evidence || evidence.authorityId !== adapter.authorityId || !textId(evidence.authorityId)
    || evidence.taskId !== input.envelope.taskId || evidence.workspaceId !== input.envelope.workspace.workspaceId
    || evidence.operationId !== input.operationId || evidence.idempotencyKey !== input.idempotencyKey
    || !textId(evidence.evidenceRef) || !Number.isSafeInteger(evidence.observedAt) || evidence.observedAt <= 0
    || evidence.observedAt > Date.now() || evidence.observedAt < input.dispatchedAt
    || evidence.observedAt < Date.now() - input.observationMaxAgeMs) return { status: 'escalate', reason: 'invalid_evidence' };
  const snapshot = freeze({ taskId: evidence.taskId, workspaceId: evidence.workspaceId, operationId: evidence.operationId,
    idempotencyKey: evidence.idempotencyKey, authorityId: evidence.authorityId, evidenceRef: evidence.evidenceRef,
    observedAt: evidence.observedAt, effect: evidence.effect });
  if (snapshot.effect === 'applied') return { status: 'verification_only', evidence: snapshot };
  if (input.failure.code === 'cancellation') return { status: 'escalate', reason: 'cancelled_task_no_retry' };
  if (snapshot.effect === 'not_applied') return { status: 'supervisor_may_authorize_new_task', evidence: snapshot };
  return { status: 'escalate', reason: 'uncertain_effect' };
}
