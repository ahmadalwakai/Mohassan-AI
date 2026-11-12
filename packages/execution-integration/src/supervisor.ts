import { INTEGRATION_VERSION, type Json, type SupervisorEnvelope } from './contracts.js';
import { boundedJson, fail, freeze, IntegrationError, isRecord, positive, textId } from './safety.js';

/** Validates this boundary's safety metadata; Phase 1 alone validates task semantics. */
export function snapshotSupervisor(raw: SupervisorEnvelope, taskId: string, correlationId: string): SupervisorEnvelope {
  let value: Json;
  try { value = boundedJson(raw, 4 * 1024 * 1024); }
  catch (error) {
    if (error instanceof IntegrationError && error.code === 'invalid_model_output') fail('invalid_contract');
    throw error;
  }
  if (!isRecord(value) || value.version !== INTEGRATION_VERSION || value.taskId !== taskId
    || value.correlationId !== correlationId || !textId(value.ownerId) || !textId(value.contextRevision)
    || typeof value.userGoal !== 'string' || !value.userGoal.trim() || !isRecord(value.approvedPlan)
    || !['id', 'revision', 'approvalRef'].every(key => textId((value.approvedPlan as Record<string, unknown>)[key]))
    || !Array.isArray(value.architecturalDecisions) || !value.architecturalDecisions.every(textId)
    || !Object.hasOwn(value, 'localTaskContract') || !Object.hasOwn(value, 'projectContext')
    || !Array.isArray(value.requiredPermissions) || !value.requiredPermissions.every(textId)
    || !isRecord(value.escalationPolicy) || !textId(value.escalationPolicy.policyId)
    || typeof value.escalationPolicy.allowLocalRepair !== 'boolean') fail('invalid_contract');
  const budget = value.budget;
  if (!isRecord(budget) || !['totalMs', 'generationMs', 'executionMs', 'verificationMs'].every(key => positive(budget[key], 86_400_000))
    || !positive(budget.maxCandidates, 8) || !positive(budget.maxActions, 32)
    || !positive(budget.maxInputBytes, 4 * 1024 * 1024) || !positive(budget.maxCandidateBytes, 4 * 1024 * 1024)
    || !positive(budget.maxOutputTokens, 131072) || !Number.isSafeInteger(budget.maxRecoveries)
    || (budget.maxRecoveries as number) < 0 || (budget.maxRecoveries as number) > 4) fail('invalid_contract');
  const workspace = value.workspace;
  if (!isRecord(workspace) || !textId(workspace.workspaceId) || !textId(workspace.snapshotId)
    || !Array.isArray(workspace.files) || !Array.isArray(workspace.sharedContracts)) fail('invalid_contract');
  const target = (item: unknown): boolean => isRecord(item) && ['file', 'resource'].includes(String(item.kind))
    && textId(item.key) && (item.version === null || textId(item.version));
  if (!workspace.files.every(target) || new Set(workspace.files.map(item => (item as Record<string, unknown>).key)).size !== workspace.files.length
    || !workspace.sharedContracts.every(item => isRecord(item) && textId(item.contractId) && textId(item.version)
      && Array.isArray(item.requiredConsumers) && item.requiredConsumers.length > 0 && item.requiredConsumers.every(textId))) fail('invalid_contract');
  const operationKinds = ['read', 'file_write', 'file_delete', 'database_mutation', 'browser_submit', 'external_mutation',
    'ads_publish', 'financial', 'remote_control', 'sandbox_code'];
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > (budget.maxActions as number)
    || !value.operations.every(item => isRecord(item) && textId(item.id) && textId(item.capability) && textId(item.toolId)
      && operationKinds.includes(String(item.kind)) && Array.isArray(item.targets) && item.targets.length > 0 && item.targets.every(target)
      && Array.isArray(item.requiredPermissions) && item.requiredPermissions.length > 0 && item.requiredPermissions.every(textId)
      && typeof item.requiresApproval === 'boolean')
    || new Set(value.operations.map(item => (item as Record<string, unknown>).id)).size !== value.operations.length) fail('invalid_contract');
  const kinds = ['structural', 'behavioral', 'regression', 'permission_boundary', 'workspace_consistency', 'expected_output'];
  if (!Array.isArray(value.verification) || !value.verification.length
    || !value.verification.every(item => isRecord(item) && textId(item.id) && kinds.includes(String(item.kind)) && textId(item.expectationRef))
    || new Set(value.verification.map(item => (item as Record<string, unknown>).id)).size !== value.verification.length
    || !['structural', 'permission_boundary', 'workspace_consistency', 'expected_output'].every(kind =>
      (value.verification as Record<string, unknown>[]).some(item => item.kind === kind))) fail('invalid_contract');
  return freeze(value as unknown as SupervisorEnvelope);
}
