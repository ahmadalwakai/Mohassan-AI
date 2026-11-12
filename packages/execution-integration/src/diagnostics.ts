import { INTEGRATION_VERSION, type TaskRecord } from './contracts.js';
import type { OrchestratorAdapters } from './orchestrator.js';
import { hash } from './safety.js';

export type IntegrationStatus = 'IMPLEMENTED' | 'ADAPTER_REQUIRED' | 'INTEGRATION_PENDING' | 'VERIFICATION_PENDING';
export interface IntegrationDiagnostic { component: string; status: IntegrationStatus; code: string }
/** Presence is reported separately from compatibility/security verification. No probes launch code. */
export function integrationDiagnostics(adapters: Partial<OrchestratorAdapters>): readonly IntegrationDiagnostic[] {
  const entries: IntegrationDiagnostic[] = [
    { component: 'orchestration', status: 'IMPLEMENTED', code: INTEGRATION_VERSION },
    { component: 'runtime_execution_verification', status: 'VERIFICATION_PENDING', code: 'no_checks_executed_in_phase_5' },
    { component: 'cross_phase_schemas', status: 'INTEGRATION_PENDING', code: 'translation_and_behavior_not_verified' },
    { component: 'production_activation', status: 'INTEGRATION_PENDING', code: 'no_production_entrypoint_changed' },
  ];
  const required = ['state', 'audit', 'supervisor', 'phaseOne', 'permission', 'workspace', 'gateway', 'verifier'] as const;
  for (const key of required) entries.push({ component: key, status: adapters[key] ? 'VERIFICATION_PENDING' : 'ADAPTER_REQUIRED',
    code: adapters[key] ? 'adapter_present_not_verified' : 'adapter_missing_fail_closed' });
  for (const key of ['learned', 'isolated'] as const) entries.push({ component: key,
    status: adapters[key] ? 'VERIFICATION_PENDING' : 'ADAPTER_REQUIRED',
    code: adapters[key] ? 'adapter_present_not_verified' : 'required_for_requested_strategy_or_operation' });
  return entries;
}
/** Caller still must enforce owner/task read authorization before exposing this view. */
export function taskDiagnostic(record: TaskRecord) {
  return {
    taskHash: hash(record.taskId), correlationHash: hash(record.correlationId), state: record.state,
    revision: record.revision, generationCount: record.generationCount, recoveryCount: record.recoveryCount,
    executionStarted: record.executionStarted, deadlineAt: record.deadlineAt,
    failureCode: record.failure?.code ?? null, effect: record.failure?.effect ?? 'none',
    verification: record.verification?.status ?? null,
    escalation: record.escalation?.requires ?? null,
    modelHash: record.model ? hash(record.model) : null,
  } as const;
}
