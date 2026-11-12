import { INTEGRATION_VERSION, type ArgumentValidation, type Candidate, type CandidateAction,
  type DispatchRequest, type ExecutionContext, type ExecutionReceipt, type IndependentVerifierAdapter,
  type IsolatedExecutionAdapter, type IsolationPolicy, type Operation, type PermissionAdapter, type PermissionDecision,
  type SupervisorEnvelope, type Target, type ToolGatewayAdapter, type ValidatedCandidate,
  type VerificationResult, type WorkspaceAdapter, type WorkspaceLease } from './contracts.js';
import { boundedJson, exactKeys, fail, freeze, hash, IntegrationError, isRecord, positive, same, textId } from './safety.js';

export async function permissionCheck(adapter: PermissionAdapter | undefined, envelope: SupervisorEnvelope,
  operation: Operation, signal: AbortSignal, binding?: { argumentsHash: string; actionHash: string; candidateHash: string }): Promise<PermissionDecision> {
  signal.throwIfAborted();
  if (!adapter) return { status: 'unavailable' };
  const decision = await adapter.check({ envelope, operation, ...binding,
    sensitive: operation.kind !== 'read' || operation.requiresApproval }, signal);
  signal.throwIfAborted();
  if (!decision || !['granted', 'approval_required', 'denied', 'unavailable'].includes(decision.status)) return { status: 'denied' };
  if (decision.status === 'granted' && (!textId(decision.grantRef) || !Number.isFinite(decision.expiresAt)
    || decision.expiresAt <= Date.now())) return { status: 'denied' };
  if (decision.status === 'approval_required' && !textId(decision.requestRef)) return { status: 'denied' };
  return decision;
}
export async function assertWorkspace(adapter: WorkspaceAdapter | undefined, envelope: SupervisorEnvelope,
  signal: AbortSignal): Promise<void> {
  if (!adapter) fail('capability_unavailable');
  const result = await adapter.check(envelope.workspace, signal);
  signal.throwIfAborted();
  if (result.status === 'stale' || result.status === 'conflict') throw new IntegrationError('stale_workspace', 'none', result.evidenceRef ? [result.evidenceRef] : []);
  if (result.status !== 'current' || !textId(result.evidenceRef)) fail('capability_unavailable');
}
export async function acquireWorkspace(adapter: WorkspaceAdapter | undefined, envelope: SupervisorEnvelope,
  context: ExecutionContext): Promise<WorkspaceLease> {
  if (!adapter) fail('capability_unavailable');
  const lease = await adapter.acquire(envelope.workspace, context);
  if (context.signal.aborted) { if (lease) await lease.release(); context.signal.throwIfAborted(); }
  if (!lease || !textId(lease.id) || lease.workspaceId !== envelope.workspace.workspaceId
    || lease.snapshotId !== envelope.workspace.snapshotId) {
    if (lease) await lease.release();
    fail('stale_workspace');
  }
  return lease;
}
function targetsEqual(left: readonly Target[], right: readonly Target[]): boolean {
  const sorted = (targets: readonly Target[]) => [...targets].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));
  return same(sorted(left), sorted(right));
}
function validateArguments(result: ArgumentValidation, action: CandidateAction, operation: Operation): void {
  if (!result || result.status !== 'valid' || !textId(result.validationRef) || result.argumentsHash !== hash(action.arguments)
    || result.actionHash !== hash(action)
    || result.capability !== operation.capability || result.toolId !== operation.toolId || result.operationKind !== operation.kind
    || !Array.isArray(result.targets) || !targetsEqual(result.targets, operation.targets)) fail('invalid_model_output');
}
export async function validateCandidate(raw: unknown, envelope: SupervisorEnvelope, signal: AbortSignal,
  gateway?: ToolGatewayAdapter, isolated?: IsolatedExecutionAdapter): Promise<ValidatedCandidate> {
  const candidate = boundedJson(raw, envelope.budget.maxCandidateBytes);
  if (!isRecord(candidate) || !exactKeys(candidate, ['version', 'taskId', 'actions'])
    || candidate.version !== INTEGRATION_VERSION || candidate.taskId !== envelope.taskId
    || !Array.isArray(candidate.actions) || !candidate.actions.length
    || candidate.actions.length > envelope.budget.maxActions) fail('invalid_model_output');
  const actions: ValidatedCandidate['actions'][number][] = [];
  const usedOperations = new Set<string>();
  const mutationTargets = new Set<string>();
  for (const rawAction of candidate.actions) {
    signal.throwIfAborted();
    if (!isRecord(rawAction) || !exactKeys(rawAction, ['operationId', 'toolId', 'arguments'], ['artifactRef', 'artifactSha256'])
      || !textId(rawAction.operationId) || !textId(rawAction.toolId)
      || (Object.hasOwn(rawAction, 'artifactRef') && !textId(rawAction.artifactRef))
      || (Object.hasOwn(rawAction, 'artifactSha256') && (typeof rawAction.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(rawAction.artifactSha256)))) fail('invalid_model_output');
    const action = freeze(rawAction as unknown as CandidateAction);
    const operation = envelope.operations.find(item => item.id === action.operationId);
    if (!operation || operation.toolId !== action.toolId || usedOperations.has(operation.id)) fail('invalid_model_output');
    usedOperations.add(operation.id);
    for (const target of operation.targets) {
      if (target.kind === 'file' && !envelope.workspace.files.some(file => same(file, target))) fail('stale_workspace');
      if (operation.kind !== 'read') {
        const key = `${target.kind}:${target.key}`;
        if (mutationTargets.has(key)) fail('invalid_model_output');
        mutationTargets.add(key);
      }
    }
    const adapter = operation.kind === 'sandbox_code' ? isolated : gateway;
    if (!adapter) fail(operation.kind === 'sandbox_code' ? 'isolation_unavailable' : 'capability_unavailable');
    if (operation.kind === 'sandbox_code' && (!action.artifactRef || !action.artifactSha256)) fail('invalid_model_output');
    if (operation.kind !== 'sandbox_code' && (action.artifactRef || action.artifactSha256)) fail('invalid_model_output');
    const validation = await adapter.validate(action, operation, envelope, signal);
    validateArguments(validation, action, operation);
    actions.push({ action, operation, argumentsHash: hash(action.arguments), actionHash: hash(action), adapterValidationRef: validation.validationRef });
  }
  return freeze({ candidate: candidate as unknown as Candidate, hash: hash(candidate), actions });
}

export async function dispatch(request: DispatchRequest, context: ExecutionContext,
  gateway?: ToolGatewayAdapter, isolated?: IsolatedExecutionAdapter): Promise<ExecutionReceipt> {
  await context.assertActive();
  let receipt: ExecutionReceipt;
  let adapterId: string;
  if (request.action.operation.kind === 'sandbox_code') {
    if (!isolated) fail('isolation_unavailable');
    adapterId = isolated.adapterId;
    const policy = freeze(boundedJson(isolated.policy(request.envelope, request.action.operation), 1024 * 1024) as unknown as IsolationPolicy);
    if (!textId(policy.sandboxId) || policy.network !== 'denied'
      || !Array.isArray(policy.readOnlyRoots) || !Array.isArray(policy.writableRoots)
      || !policy.readOnlyRoots.every(textId) || !policy.writableRoots.every(textId)
      || !positive(policy.memoryBytes, Number.MAX_SAFE_INTEGER) || !positive(policy.diskBytes, Number.MAX_SAFE_INTEGER)
      || !positive(policy.cpuMs, request.timeoutMs) || !positive(policy.timeoutMs, request.timeoutMs)
      || !positive(policy.outputBytes, 16 * 1024 * 1024) || !positive(policy.processLimit, 64)) fail('isolation_unavailable');
    const proof = freeze(await isolated.attest(policy, context.signal));
    if (proof.sandboxId !== policy.sandboxId || proof.policyHash !== hash(policy) || !textId(proof.evidenceRef)
      || !Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now()
      || !proof.processTreeTermination || !proof.filesystemEnforced || !proof.networkEnforced || !proof.memoryEnforced
      || !proof.cpuEnforced || !proof.diskEnforced || !proof.outputEnforced || !proof.processCountEnforced) fail('isolation_unavailable');
    await context.assertActive();
    receipt = await isolated.execute(request, policy, proof, context);
  } else {
    if (!gateway) fail('capability_unavailable');
    adapterId = gateway.adapterId;
    receipt = await gateway.execute(request, context);
  }
  context.signal.throwIfAborted();
  if (!receipt || receipt.taskId !== request.envelope.taskId || receipt.operationId !== request.action.operation.id
    || receipt.candidateHash !== request.candidateHash || receipt.idempotencyKey !== request.idempotencyKey
    || receipt.adapterId !== adapterId || !textId(receipt.evidenceRef) || !textId(receipt.outputRef)
    || !Array.isArray(receipt.artifactRefs) || !receipt.artifactRefs.every(textId)
    || !['none', 'confirmed', 'unknown'].includes(receipt.effect)) throw new IntegrationError('external_tool_uncertainty', 'possible');
  if (receipt.status !== 'succeeded' || receipt.effect === 'unknown') {
    throw new IntegrationError(request.action.operation.kind === 'sandbox_code' ? 'sandbox_failure' : 'external_tool_uncertainty',
      receipt.effect === 'confirmed' ? 'confirmed' : 'possible', [receipt.evidenceRef]);
  }
  return freeze(structuredClone(receipt));
}

export async function verifyIndependently(adapter: IndependentVerifierAdapter | undefined,
  envelope: SupervisorEnvelope, candidate: ValidatedCandidate, receipts: readonly ExecutionReceipt[],
  context: ExecutionContext, excludedVerifierIds: readonly string[] = []): Promise<VerificationResult> {
  if (!adapter || !textId(adapter.verifierId) || excludedVerifierIds.includes(adapter.verifierId)) {
    return { status: 'unavailable', verifierId: adapter?.verifierId ?? 'unavailable', evidence: [], consumerEvidence: [] };
  }
  await context.assertActive();
  const result = await adapter.verify({ envelope, candidate, receipts }, context);
  context.signal.throwIfAborted();
  const unavailable: VerificationResult = { status: 'unavailable', verifierId: adapter.verifierId, evidence: [], consumerEvidence: [] };
  if (!result || result.verifierId !== adapter.verifierId || !['verified', 'rejected', 'inconclusive', 'unavailable'].includes(result.status)
    || !Array.isArray(result.evidence) || !Array.isArray(result.consumerEvidence)) return unavailable;
  const receiptRefs = new Set(receipts.map(receipt => receipt.evidenceRef));
  const evidenceIds = new Set<string>();
  for (const evidence of result.evidence) {
    const requirement = envelope.verification.find(item => item.id === evidence.requirementId);
    if (!requirement || !textId(evidence.id) || evidenceIds.has(evidence.id) || evidence.taskId !== envelope.taskId
      || evidence.candidateHash !== candidate.hash || evidence.source !== 'independent' || evidence.verifierId !== adapter.verifierId
      || evidence.kind !== requirement.kind || !['passed', 'failed', 'inconclusive'].includes(evidence.status)
      || !Array.isArray(evidence.receiptRefs) || !evidence.receiptRefs.length
      || !evidence.receiptRefs.every((ref: unknown) => typeof ref === 'string' && receiptRefs.has(ref))) return unavailable;
    evidenceIds.add(evidence.id);
  }
  for (const consumer of result.consumerEvidence) {
    if (!envelope.workspace.sharedContracts.some(contract => contract.contractId === consumer.contractId
      && contract.version === consumer.version && contract.requiredConsumers.includes(consumer.consumerId))
      || !result.evidence.some(evidence => evidence.id === consumer.evidenceRef && evidence.kind === 'workspace_consistency'
        && evidence.status === 'passed')) return unavailable;
  }
  if (result.status === 'verified') {
    const complete = envelope.verification.every(requirement => result.evidence.some(evidence => evidence.requirementId === requirement.id && evidence.status === 'passed'))
      && result.evidence.every(evidence => evidence.status === 'passed')
      && receipts.every(receipt => result.evidence.some(evidence => evidence.receiptRefs.includes(receipt.evidenceRef)))
      && envelope.workspace.sharedContracts.every(contract => contract.requiredConsumers.every(consumer => result.consumerEvidence.some(item =>
        item.contractId === contract.contractId && item.version === contract.version && item.consumerId === consumer)));
    if (!complete) return { ...result, status: 'inconclusive' };
  }
  return freeze(structuredClone(result));
}
