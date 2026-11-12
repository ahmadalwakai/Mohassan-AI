/** Phase 5 boundary v1. These are local adapters, not claims about other packages' exports. */
export const INTEGRATION_VERSION = 'execution-integration.v1' as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type State = 'CREATED' | 'VALIDATING' | 'WAITING_FOR_CONTEXT' | 'WAITING_FOR_APPROVAL'
  | 'ROUTING' | 'GENERATING' | 'CANDIDATE_VALIDATION' | 'READY_FOR_EXECUTION' | 'EXECUTING'
  | 'VERIFYING' | 'REPAIR_REQUIRED' | 'ESCALATED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type FailureCode = 'invalid_contract' | 'missing_context' | 'unsupported_capability'
  | 'invalid_model_output' | 'timeout' | 'cancellation' | 'stale_workspace' | 'permission_denial'
  | 'permission_unavailable' | 'capability_unavailable' | 'sandbox_failure' | 'isolation_unavailable'
  | 'verification_failure' | 'verification_unavailable' | 'external_tool_uncertainty'
  | 'model_process_failure' | 'resource_exhaustion' | 'audit_unavailable' | 'state_conflict'
  | 'reasoning_required' | 'budget_exhausted';
export interface Failure { code: FailureCode; effect: 'none' | 'possible' | 'confirmed'; evidenceRefs: readonly string[] }
/** Full activation/evaluation pin, including digests, survives from routing through final verification. */
export type ModelReference = import('./lifecycle.js').ActiveModelReference;
/** Resource keys are canonical opaque identifiers from a trusted resolver, never model paths/globs. */
export interface Target { kind: 'file' | 'resource'; key: string; version: string | null }
export interface WorkspaceSnapshot {
  workspaceId: string; snapshotId: string; files: readonly Target[];
  sharedContracts: readonly { contractId: string; version: string; requiredConsumers: readonly string[] }[];
}
export type OperationKind = 'read' | 'file_write' | 'file_delete' | 'database_mutation'
  | 'browser_submit' | 'external_mutation' | 'ads_publish' | 'financial' | 'remote_control' | 'sandbox_code';
export interface Operation {
  id: string; capability: string; toolId: string; kind: OperationKind;
  targets: readonly Target[]; requiredPermissions: readonly string[]; requiresApproval: boolean;
}
export type EvidenceKind = 'structural' | 'behavioral' | 'regression' | 'permission_boundary'
  | 'workspace_consistency' | 'expected_output';
export interface VerificationRequirement { id: string; kind: EvidenceKind; expectationRef: string }
export interface Budget {
  totalMs: number; generationMs: number; executionMs: number; verificationMs: number;
  maxCandidates: number; maxActions: number; maxInputBytes: number; maxCandidateBytes: number;
  maxOutputTokens: number; maxRecoveries: number;
}
export interface SupervisorEnvelope {
  version: typeof INTEGRATION_VERSION; taskId: string; correlationId: string; ownerId: string;
  userGoal: string;
  approvedPlan: { id: string; revision: string; approvalRef: string };
  /** Opaque Phase 1 contract is validated and routed only by the Phase 1 boundary. */
  localTaskContract: Json;
  projectContext: Json; contextRevision: string; architecturalDecisions: readonly string[];
  operations: readonly Operation[]; requiredPermissions: readonly string[];
  verification: readonly VerificationRequirement[]; budget: Budget; workspace: WorkspaceSnapshot;
  escalationPolicy: { policyId: string; allowLocalRepair: boolean };
}
export interface EscalationRequest {
  taskId: string; reason: FailureCode; requires: 'context' | 'replan' | 'reasoning' | 'reconciliation' | 'adapter';
  evidenceRefs: readonly string[]; previousContextRevision: string;
}
export interface CognitiveSupervisorAdapter {
  /** Read an existing supervised decision. Must not start another planner/provider call. */
  read(taskId: string, signal: AbortSignal): Promise<SupervisorEnvelope>;
  /** Only authoritative newly acquired evidence may authorize another candidate. */
  repairEvidence?(request: EscalationRequest, signal: AbortSignal): Promise<null | {
    contextRevision: string; context: Json; evidenceRefs: readonly string[];
  }>;
}
export type BoundaryResult<T> = { status: 'ok'; value: T }
  | { status: 'missing_context'; evidenceRefs: readonly string[] }
  | { status: 'unsupported'; evidenceRefs: readonly string[] }
  | { status: 'stale'; evidenceRefs: readonly string[] }
  | { status: 'invalid'; evidenceRefs: readonly string[] }
  | { status: 'escalate'; evidenceRefs: readonly string[] };
export type Strategy = 'deterministic' | 'learned';
export interface ValidatedContract { version: string; reference: string; contract: Json }
export interface PhaseOneAdapter {
  validate(envelope: SupervisorEnvelope, signal: AbortSignal): Promise<BoundaryResult<ValidatedContract>>;
  select(contract: ValidatedContract, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<BoundaryResult<Strategy>>;
  supports(contract: ValidatedContract, capabilities: readonly string[], signal: AbortSignal): Promise<BoundaryResult<true>>;
  compile(contract: ValidatedContract, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<BoundaryResult<unknown>>;
}
export interface CandidateAction {
  operationId: string; toolId: string; arguments: Json;
  /** Host must resolve immutable artifact bytes and check this digest at validation AND launch. */
  artifactRef?: string; artifactSha256?: string;
}
export interface Candidate { version: typeof INTEGRATION_VERSION; taskId: string; actions: readonly CandidateAction[] }
export interface ValidatedAction {
  action: CandidateAction; operation: Operation; argumentsHash: string; actionHash: string; adapterValidationRef: string;
}
export interface ValidatedCandidate { candidate: Candidate; hash: string; actions: readonly ValidatedAction[] }
export interface ExecutionContext {
  taskId: string; ownerId: string; correlationId: string; fence: string; signal: AbortSignal;
  /** Adapters MUST recheck immediately at their effect boundary, including after internal awaits. */
  assertActive(): Promise<void>;
}
export type PermissionDecision = { status: 'granted'; grantRef: string; expiresAt: number }
  | { status: 'approval_required'; requestRef: string }
  | { status: 'denied' | 'unavailable' };
export interface PermissionAdapter {
  /** Existing authority must verify plan approval, owner, task, workspace, operation,
   * exact targets/permissions, argumentsHash (when present), expiry and revocation.
   * Sensitive grants require the existing independent approval, never model assertions. */
  check(input: { envelope: SupervisorEnvelope; operation: Operation; argumentsHash?: string;
    actionHash?: string; candidateHash?: string; sensitive: boolean },
    signal: AbortSignal): Promise<PermissionDecision>;
}
export interface WorkspaceAdapter {
  /** Includes canonicalization/symlinks, file creation (null version), snapshot and all shared consumers. */
  check(expected: WorkspaceSnapshot, signal: AbortSignal): Promise<{
    status: 'current' | 'stale' | 'conflict' | 'unavailable'; evidenceRef?: string;
  }>;
  /** Must be an enforceable cross-process mutation fence, not an in-memory advisory flag.
   * Gateway writes must perform compare-and-swap of preimages inside this lease. */
  /** Abort must fence pending acquisition. A late resolution MUST release its own lease;
   * cancelling this promise may not leave a resource lock or permit a later mutation. */
  acquire(expected: WorkspaceSnapshot, context: ExecutionContext): Promise<WorkspaceLease>;
}
export interface WorkspaceLease {
  id: string; workspaceId: string; snapshotId: string;
  assertHeld(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export interface ArgumentValidation {
  status: 'valid' | 'invalid'; validationRef: string; argumentsHash: string; actionHash: string;
  targets: readonly Target[]; capability: string; toolId: string; operationKind: OperationKind;
}
export interface ExecutionReceipt {
  taskId: string; operationId: string; candidateHash: string; idempotencyKey: string;
  adapterId: string; evidenceRef: string; effect: 'none' | 'confirmed' | 'unknown';
  status: 'succeeded' | 'failed' | 'uncertain'; outputRef: string; artifactRefs: readonly string[];
}
export interface DispatchRequest {
  envelope: SupervisorEnvelope; candidateHash: string; action: ValidatedAction;
  idempotencyKey: string; workspaceLeaseId: string; timeoutMs: number;
}
export interface ToolGatewayAdapter {
  readonly adapterId: string;
  validate(action: CandidateAction, operation: Operation, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<ArgumentValidation>;
  /** Translate ONLY to the existing gateway's authority-bound dispatch. No raw executor fallback. */
  execute(request: DispatchRequest, context: ExecutionContext): Promise<ExecutionReceipt>;
}
export interface IsolationPolicy {
  sandboxId: string; network: 'denied'; readOnlyRoots: readonly string[]; writableRoots: readonly string[];
  memoryBytes: number; cpuMs: number; diskBytes: number; processLimit: number; outputBytes: number; timeoutMs: number;
}
export interface IsolationAttestation {
  sandboxId: string; policyHash: string; evidenceRef: string; expiresAt: number;
  processTreeTermination: boolean; filesystemEnforced: boolean; networkEnforced: boolean;
  memoryEnforced: boolean; cpuEnforced: boolean; diskEnforced: boolean; outputEnforced: boolean;
  processCountEnforced: boolean;
}
export interface IsolatedExecutionAdapter {
  readonly adapterId: string;
  /** Policy comes from trusted host configuration, never from a generated candidate. */
  policy(envelope: SupervisorEnvelope, operation: Operation): IsolationPolicy;
  attest(policy: IsolationPolicy, signal: AbortSignal): Promise<IsolationAttestation>;
  validate(action: CandidateAction, operation: Operation, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<ArgumentValidation>;
  /** Revalidate attestation at launch; run code only in the attested sandbox. */
  execute(request: DispatchRequest, policy: IsolationPolicy, attestation: IsolationAttestation,
    context: ExecutionContext): Promise<ExecutionReceipt>;
}
export interface VerificationEvidence {
  id: string; taskId: string; candidateHash: string; requirementId: string; kind: EvidenceKind;
  source: 'independent'; verifierId: string; status: 'passed' | 'failed' | 'inconclusive';
  receiptRefs: readonly string[];
}
export interface VerificationResult {
  status: 'verified' | 'rejected' | 'inconclusive' | 'unavailable'; verifierId: string;
  evidence: readonly VerificationEvidence[];
  consumerEvidence: readonly { contractId: string; version: string; consumerId: string; evidenceRef: string }[];
}
export interface IndependentVerifierAdapter {
  readonly verifierId: string;
  /** Reads real state/receipts. Candidate assertions never count as evidence. */
  verify(input: { envelope: SupervisorEnvelope; candidate: ValidatedCandidate; receipts: readonly ExecutionReceipt[] },
    context: ExecutionContext): Promise<VerificationResult>;
}
export interface LearnedExecutorAdapter {
  /** Must resolve an explicitly activated Phase 3/4-backed version, never a raw caller/model choice. */
  discover(envelope: SupervisorEnvelope, signal: AbortSignal): Promise<{ model: ModelReference; capabilities: readonly string[] }>;
  /** Re-read activation, exact identity, evaluation and task scope; fail on revocation or changed version. */
  assertEligible(model: ModelReference, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<void>;
  generate(input: { envelope: SupervisorEnvelope; contract: ValidatedContract; model: ModelReference },
    signal: AbortSignal): Promise<BoundaryResult<unknown>>;
}
/** Sensitive reviewable proposal retained only for an exact-candidate approval resume.
 * Production state stores must encrypt/scope this context and use appropriate retention. */
export interface PreparedExecution {
  envelope: SupervisorEnvelope; candidate: Candidate; strategy: Strategy; model?: ModelReference;
}
export interface TaskRecord {
  taskId: string; correlationId: string; state: State; revision: number; createdAt: number; deadlineAt: number;
  generationCount: number; recoveryCount: number; executionStarted: boolean;
  contextRevision?: string; contextHash?: string; repairEvidenceRefs?: readonly string[];
  candidateHash?: string; model?: ModelReference;
  failure?: Failure; escalation?: EscalationRequest; verification?: VerificationResult;
  preparation?: PreparedExecution;
  executionManifest?: {
    candidateHash: string; workspaceId: string; snapshotId: string; startedAt: number;
    operations: readonly { operationId: string; idempotencyKey: string; actionHash: string }[];
  };
}
export interface TaskClaim { taskId: string; fence: string }
export interface StateStore {
  /** All methods atomic, durable in a production adapter; compareAndSet enforces transitions.
   * Cancellation and state CAS are serialized. EXECUTING and COMPLETED commits must
   * atomically reject a requested cancellation, even if a caller checked earlier. */
  create(record: TaskRecord): Promise<boolean>;
  read(taskId: string): Promise<TaskRecord | null>;
  claim(taskId: string): Promise<TaskClaim | null>;
  assertClaim(claim: TaskClaim): Promise<void>;
  /** Separate durable cancellation flag; must not race/overwrite state revisions. */
  requestCancellation(taskId: string): Promise<void>;
  isCancellationRequested(taskId: string): Promise<boolean>;
  compareAndSet(claim: TaskClaim, expectedRevision: number, next: TaskRecord): Promise<boolean>;
  /** Persisted BEFORE effect; never reissue this task's batch, even after crash/timeout/cancellation.
   * Atomic with the EXECUTING state and candidate binding. */
  beginExecution(claim: TaskClaim, expectedRevision: number, next: TaskRecord): Promise<boolean>;
  release(claim: TaskClaim): Promise<void>;
}
export type AuditKind = 'task_creation' | 'contract_validation' | 'routing_decision' | 'model_selection'
  | 'candidate_generation' | 'approval_request' | 'permission_decision' | 'sandbox_execution'
  | 'verification_result' | 'failure_classification' | 'recovery' | 'escalation' | 'cancellation'
  | 'completion' | 'model_promotion' | 'rollback' | 'state_transition';
/** References in logs are hashes; no goal, arguments, paths, outputs, stderr or secret-bearing errors. */
export interface AuditEvent {
  version: typeof INTEGRATION_VERSION; id: string; at: number; correlationHash: string; taskHash: string;
  kind: AuditKind; state: State; code?: FailureCode; referenceHashes: readonly string[];
}
export interface AuditSink { append(event: AuditEvent, signal: AbortSignal): Promise<void> }
