import type { Budget, Failure, State } from './contracts.js';
import { IntegrationError } from './safety.js';

export type RecoveryDecision = 'cancel' | 'wait_context' | 'repair_candidate' | 'reconcile' | 'replan' | 'escalate' | 'fail';
export function classifyFailure(error: unknown, executionStarted: boolean, signal?: AbortSignal): Failure {
  const known = signal?.aborted ? signal.reason instanceof IntegrationError ? signal.reason : new IntegrationError('cancellation')
    : error instanceof IntegrationError ? error : new IntegrationError(executionStarted ? 'external_tool_uncertainty' : 'capability_unavailable');
  return { code: known.code, effect: executionStarted && known.effect === 'none' ? 'possible' : known.effect,
    evidenceRefs: [...known.evidenceRefs] };
}
export function decideRecovery(input: {
  failure: Failure; state: State; executionStarted: boolean; cancelled: boolean;
  generationCount: number; recoveryCount: number; budget: Budget; allowLocalRepair: boolean;
}): RecoveryDecision {
  if (input.cancelled || input.failure.code === 'cancellation') return 'cancel';
  // A lost response never authorizes replay, including when a tool claims it failed.
  if (input.executionStarted || input.failure.effect !== 'none') return 'reconcile';
  if (input.failure.code === 'missing_context') return 'wait_context';
  if (input.failure.code === 'stale_workspace') return 'replan';
  if (input.failure.code === 'invalid_model_output' && input.allowLocalRepair
    && ['GENERATING', 'CANDIDATE_VALIDATION'].includes(input.state)
    && input.generationCount < input.budget.maxCandidates && input.recoveryCount < input.budget.maxRecoveries) return 'repair_candidate';
  if (['reasoning_required', 'unsupported_capability', 'verification_unavailable', 'permission_unavailable',
    'capability_unavailable', 'isolation_unavailable'].includes(input.failure.code)) return 'escalate';
  return 'fail';
}
