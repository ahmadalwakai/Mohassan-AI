import { createHash } from 'node:crypto';

export const EXPERIENCE_MEMORY_SCHEMA_VERSION = 'execution-integration-experience/v1' as const;

export interface ExperienceModelAttribution {
  readonly versionId: string;
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly checkpointId: string;
  readonly checkpointSha256: string;
}

export type VerifiedExperienceKind = 'verified_task_outcome' | 'verified_failure' | 'confirmed_recovery';
export type ExperienceFailureCategory = 'invalid_contract' | 'missing_context' | 'unsupported_capability'
  | 'invalid_model_output' | 'timeout' | 'cancellation' | 'stale_workspace' | 'permission_denial'
  | 'sandbox_failure' | 'verification_failure' | 'external_tool_uncertainty' | 'model_process_failure'
  | 'resource_exhaustion';

export interface ExperienceProvenance {
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly authorityId: string;
  readonly observedAt: string;
  readonly source: 'runtime_verifier' | 'independent_failure_verifier' | 'independent_recovery_verifier';
  readonly classification: 'synthetic' | 'public' | 'approved_non_customer';
  readonly evaluationOrigin: false;
  readonly authorizationReference: string;
}

/** Only this small metadata vocabulary may survive the privacy policy. No raw goals, outputs or file contents. */
export interface SafeExperienceContext {
  readonly taskFamily: string;
  readonly operationKinds: readonly string[];
  readonly projectLanguage: 'typescript' | 'javascript' | 'python' | 'other';
  readonly architectureDecisionSha256: readonly string[];
  readonly contextSha256: string;
}

export interface VerifiedExperienceEvidence {
  readonly schemaVersion: typeof EXPERIENCE_MEMORY_SCHEMA_VERSION;
  readonly kind: VerifiedExperienceKind;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspaceSnapshotId: string;
  readonly ownerScopeId: string;
  readonly subjectSha256: string;
  readonly model: ExperienceModelAttribution | null;
  readonly verifiedBy: string;
  readonly verdict: 'verified';
  readonly provenance: readonly ExperienceProvenance[];
  readonly context: SafeExperienceContext;
  readonly failureCategory: ExperienceFailureCategory | null;
  readonly recovery: {
    readonly strategyReference: string;
    readonly failedEvidenceId: string;
    readonly successfulEvidenceId: string;
    readonly independentlyConfirmed: true;
  } | null;
}

export interface ExperienceMemoryRequest {
  readonly ownerScopeId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspaceSnapshotId: string;
  readonly subjectSha256: string;
  readonly evidenceId: string;
  readonly correlationId: string;
}

/** Resolve from an independent evidence repository. Never parse model output into this interface. */
export interface IndependentExperienceEvidenceAdapter {
  resolve(request: ExperienceMemoryRequest, signal: AbortSignal): Promise<VerifiedExperienceEvidence | null>;
}

/**
 * Must check secret scanners, privacy/ownership authorization, corpus provenance and
 * evaluation exclusion. Hashes alone do not establish privacy or remove restrictions.
 * Null means denied. An unavailable policy is not implicit permission.
 */
export interface ExperiencePrivacyPolicy {
  readonly policyId: string;
  sanitizeAndApprove(
    request: ExperienceMemoryRequest,
    evidence: VerifiedExperienceEvidence,
    signal: AbortSignal,
  ): Promise<{ readonly context: SafeExperienceContext; readonly authorizationReference: string; readonly expiresAt: string } | null>;
}

export interface SafeExperienceRecord {
  readonly schemaVersion: typeof EXPERIENCE_MEMORY_SCHEMA_VERSION;
  readonly recordKey: string;
  readonly contentSha256: string;
  /** Full attempt payload hash, including current privacy approval and correlation. */
  readonly writeSha256: string;
  readonly correlationId: string;
  readonly ownerScopeId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspaceSnapshotId: string;
  readonly subjectSha256: string;
  readonly kind: VerifiedExperienceKind;
  readonly model: ExperienceModelAttribution | null;
  readonly context: SafeExperienceContext;
  readonly provenance: readonly ExperienceProvenance[];
  readonly failureCategory: ExperienceFailureCategory | null;
  readonly recovery: VerifiedExperienceEvidence['recovery'];
  readonly privacyPolicyId: string;
  readonly privacyAuthorizationReference: string;
  readonly privacyExpiresAt: string;
  readonly trainingUse: 'forbidden';
}

export interface ExperienceWriteAuthorizationRequest {
  readonly action: 'memory.write_verified_execution_experience';
  readonly ownerScopeId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly recordKey: string;
  readonly contentSha256: string;
  readonly writeSha256: string;
}

/** Opaque storage-compatible transaction/lease held by the trusted permission authority until the callback returns. */
export interface ExperienceWriteLease {
  readonly request: ExperienceWriteAuthorizationRequest;
  readonly authorityId: string;
  readonly authorizationReference: string;
  readonly expiresAt: string;
  readonly transactionContext: unknown;
}

export interface ExperienceMemoryPermissionAdapter {
  readonly authorityId: string;
  /** Deny by throwing or return null; do not invoke callback unless all task/resource grants remain current. */
  withWriteAuthorization<T>(
    request: ExperienceWriteAuthorizationRequest,
    signal: AbortSignal,
    write: (lease: ExperienceWriteLease) => Promise<T>,
  ): Promise<T | null>;
}

export interface SafeExperienceStore {
  /**
   * Atomically insert once using recordKey and stable semantic contentSha256. A duplicate
   * with a different semantic digest is a conflict. A fresh privacy approval/correlation
   * changes writeSha256 only; matching semantic duplicates return already_stored without
   * overwriting the original record. Every attempt, including duplicates, must validate
   * its full writeSha256 against the live lease and fence revocation/expiry/cancellation;
   * the lease must bind the same permission/storage transaction, not a stale boolean.
   * The privacy authorization must also remain valid through privacyExpiresAt at commit.
   */
  appendVerified(
    record: SafeExperienceRecord,
    lease: ExperienceWriteLease,
    signal: AbortSignal,
  ): Promise<{ readonly status: 'stored' | 'already_stored'; readonly recordKey: string; readonly contentSha256: string }>;
}

export type ExperienceMemoryErrorCode = 'memory_unavailable' | 'permission_unavailable' | 'permission_denied'
  | 'unverified_evidence' | 'invalid_metadata' | 'privacy_denied' | 'memory_conflict' | 'memory_storage_failure' | 'cancelled';

export class ExperienceMemoryError extends Error {
  constructor(readonly code: ExperienceMemoryErrorCode) {
    super(code);
    this.name = 'ExperienceMemoryError';
  }
}

export interface ExperienceMemoryOptions {
  readonly evidence?: IndependentExperienceEvidenceAdapter;
  readonly privacy?: ExperiencePrivacyPolicy;
  readonly permissions?: ExperienceMemoryPermissionAdapter;
  readonly store?: SafeExperienceStore;
  readonly trustedVerifierIds: readonly string[];
  readonly now?: () => Date;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
const failureCategories = new Set<ExperienceFailureCategory>([
  'invalid_contract', 'missing_context', 'unsupported_capability', 'invalid_model_output', 'timeout', 'cancellation',
  'stale_workspace', 'permission_denial', 'sandbox_failure', 'verification_failure', 'external_tool_uncertainty',
  'model_process_failure', 'resource_exhaustion',
]);

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ExperienceMemoryError('cancelled');
}

function safeContext(context: SafeExperienceContext): SafeExperienceContext {
  if (!context || !isId(context.taskFamily) || !isHash(context.contextSha256) ||
      !['typescript', 'javascript', 'python', 'other'].includes(context.projectLanguage) ||
      !Array.isArray(context.operationKinds) || context.operationKinds.length > 64 || !context.operationKinds.every(isId) ||
      !Array.isArray(context.architectureDecisionSha256) || context.architectureDecisionSha256.length > 64 ||
      !context.architectureDecisionSha256.every(isHash)) throw new ExperienceMemoryError('invalid_metadata');
  return {
    taskFamily: context.taskFamily, operationKinds: [...context.operationKinds], projectLanguage: context.projectLanguage,
    architectureDecisionSha256: [...context.architectureDecisionSha256], contextSha256: context.contextSha256,
  };
}

function modelAttribution(model: ExperienceModelAttribution | null): ExperienceModelAttribution | null {
  if (model === null) return null;
  if (!model || ![model.versionId, model.modelId, model.tokenizerId, model.checkpointId].every(isId) || !isHash(model.checkpointSha256)) {
    throw new ExperienceMemoryError('invalid_metadata');
  }
  return {
    versionId: model.versionId, modelId: model.modelId, tokenizerId: model.tokenizerId,
    checkpointId: model.checkpointId, checkpointSha256: model.checkpointSha256,
  };
}

/** Writes a minimal, independently evidenced record. There is deliberately no train, updateWeights, or raw-memory API. */
export class ExperienceMemoryCoordinator {
  private readonly now: () => Date;
  private readonly verifiers: ReadonlySet<string>;

  constructor(private readonly options: ExperienceMemoryOptions) {
    this.now = options.now ?? (() => new Date());
    if (!options.trustedVerifierIds.length || !options.trustedVerifierIds.every(isId)) throw new ExperienceMemoryError('invalid_metadata');
    this.verifiers = new Set(options.trustedVerifierIds);
  }

  private deadlineCurrent(value: string): boolean {
    const current = this.now().getTime(), deadline = Date.parse(value);
    return Number.isFinite(current) && Number.isFinite(deadline) && deadline > current;
  }

  async record(input: ExperienceMemoryRequest, signal: AbortSignal): Promise<'stored' | 'already_stored'> {
    const request: ExperienceMemoryRequest = Object.freeze({
      ownerScopeId: input.ownerScopeId, taskId: input.taskId, workspaceId: input.workspaceId,
      workspaceSnapshotId: input.workspaceSnapshotId, subjectSha256: input.subjectSha256,
      evidenceId: input.evidenceId, correlationId: input.correlationId,
    });
    cancelled(signal);
    if (![request.ownerScopeId, request.taskId, request.workspaceId, request.workspaceSnapshotId, request.evidenceId, request.correlationId].every(isId) ||
        !isHash(request.subjectSha256)) throw new ExperienceMemoryError('invalid_metadata');
    if (!this.options.evidence || !this.options.privacy || !this.options.store) throw new ExperienceMemoryError('memory_unavailable');
    if (!this.options.permissions) throw new ExperienceMemoryError('permission_unavailable');
    const { evidence: resolver, privacy, store, permissions } = this.options;
    if (!isId(privacy.policyId) || !isId(permissions.authorityId)) throw new ExperienceMemoryError('invalid_metadata');
    try {
      const evidence = await resolver.resolve(request, signal);
      cancelled(signal);
      if (!evidence || evidence.schemaVersion !== EXPERIENCE_MEMORY_SCHEMA_VERSION || evidence.verdict !== 'verified' ||
          !this.verifiers.has(evidence.verifiedBy) || evidence.verifiedBy === evidence.model?.modelId ||
          evidence.taskId !== request.taskId || evidence.ownerScopeId !== request.ownerScopeId ||
          evidence.workspaceId !== request.workspaceId || evidence.workspaceSnapshotId !== request.workspaceSnapshotId ||
          evidence.subjectSha256 !== request.subjectSha256 ||
          !['verified_task_outcome', 'verified_failure', 'confirmed_recovery'].includes(evidence.kind) ||
          !Array.isArray(evidence.provenance) || evidence.provenance.length < 1 || evidence.provenance.length > 64) {
        throw new ExperienceMemoryError('unverified_evidence');
      }
      const now = this.now().getTime();
      if (!Number.isFinite(now)) throw new ExperienceMemoryError('invalid_metadata');
      const provenance = evidence.provenance.map(item => {
        if (!item || !isId(item.evidenceId) || !isHash(item.evidenceSha256) || !this.verifiers.has(item.authorityId) ||
            item.authorityId === evidence.model?.modelId || !isId(item.authorizationReference) || item.evaluationOrigin !== false ||
            !['synthetic', 'public', 'approved_non_customer'].includes(item.classification) ||
            !['runtime_verifier', 'independent_failure_verifier', 'independent_recovery_verifier'].includes(item.source) ||
            !Number.isFinite(Date.parse(item.observedAt)) || Date.parse(item.observedAt) > now) {
          throw new ExperienceMemoryError('unverified_evidence');
        }
        return {
          evidenceId: item.evidenceId, evidenceSha256: item.evidenceSha256, authorityId: item.authorityId,
          observedAt: item.observedAt, source: item.source, classification: item.classification,
          evaluationOrigin: false as const, authorizationReference: item.authorizationReference,
        };
      });
      if (!provenance.some(item => item.evidenceId === request.evidenceId)) throw new ExperienceMemoryError('unverified_evidence');
      if (!provenance.some(item => item.authorityId === evidence.verifiedBy)) throw new ExperienceMemoryError('unverified_evidence');
      if (new Set(provenance.map(item => item.evidenceId)).size !== provenance.length) throw new ExperienceMemoryError('unverified_evidence');
      const model = modelAttribution(evidence.model);
      const originalContext = safeContext(evidence.context);
      const kind = evidence.kind, failureCategory = evidence.failureCategory;
      let recovery: VerifiedExperienceEvidence['recovery'] = null;
      if (evidence.kind === 'verified_task_outcome') {
        if (evidence.failureCategory !== null || evidence.recovery !== null) throw new ExperienceMemoryError('unverified_evidence');
      } else if (!failureCategories.has(evidence.failureCategory as ExperienceFailureCategory)) {
        throw new ExperienceMemoryError('unverified_evidence');
      }
      if (evidence.kind === 'confirmed_recovery') {
        const value = evidence.recovery;
        if (!value || value.independentlyConfirmed !== true ||
            ![value.strategyReference, value.failedEvidenceId, value.successfulEvidenceId].every(isId) ||
            value.failedEvidenceId === value.successfulEvidenceId ||
            !provenance.some(item => item.evidenceId === value.failedEvidenceId && item.source === 'independent_failure_verifier') ||
            !provenance.some(item => item.evidenceId === value.successfulEvidenceId && item.source === 'independent_recovery_verifier')) {
          throw new ExperienceMemoryError('unverified_evidence');
        }
        recovery = {
          strategyReference: value.strategyReference, failedEvidenceId: value.failedEvidenceId,
          successfulEvidenceId: value.successfulEvidenceId, independentlyConfirmed: true,
        };
        const before = provenance.find(item => item.evidenceId === value.failedEvidenceId)!;
        const after = provenance.find(item => item.evidenceId === value.successfulEvidenceId)!;
        if (Date.parse(before.observedAt) > Date.parse(after.observedAt)) throw new ExperienceMemoryError('unverified_evidence');
      } else if (evidence.recovery !== null) throw new ExperienceMemoryError('unverified_evidence');
      const reviewedEvidence = freezeMetadata<VerifiedExperienceEvidence>({
        schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION, kind, taskId: request.taskId, workspaceId: request.workspaceId,
        workspaceSnapshotId: request.workspaceSnapshotId, ownerScopeId: request.ownerScopeId, subjectSha256: request.subjectSha256,
        model, verifiedBy: evidence.verifiedBy, verdict: 'verified', provenance,
        context: originalContext, failureCategory, recovery,
      });
      const approved = await privacy.sanitizeAndApprove(request, reviewedEvidence, signal);
      cancelled(signal);
      if (!approved || !isId(approved.authorizationReference) || !this.deadlineCurrent(approved.expiresAt)) {
        throw new ExperienceMemoryError('privacy_denied');
      }
      const context = safeContext(approved.context);
      const recordKey = hash([request.ownerScopeId, request.taskId, request.workspaceId, request.evidenceId, kind]);
      // Whitelist every output field: unknown adapter properties and all raw text are dropped.
      const content = {
        schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION, ownerScopeId: request.ownerScopeId, taskId: request.taskId,
        workspaceId: request.workspaceId, workspaceSnapshotId: request.workspaceSnapshotId, subjectSha256: request.subjectSha256,
        kind, model, context, provenance, failureCategory, recovery,
        trainingUse: 'forbidden' as const,
      };
      // Semantics remain stable when a retry obtains fresh privacy authorization.
      // The separate write hash binds that authorization to this exact attempt.
      const writePayload = {
        ...content, recordKey, contentSha256: hash(content), correlationId: request.correlationId,
        privacyPolicyId: privacy.policyId, privacyAuthorizationReference: approved.authorizationReference,
        privacyExpiresAt: new Date(Date.parse(approved.expiresAt)).toISOString(),
      };
      const record = freezeMetadata<SafeExperienceRecord>({ ...writePayload, writeSha256: hash(writePayload) });
      const authorization: ExperienceWriteAuthorizationRequest = Object.freeze({
        action: 'memory.write_verified_execution_experience', ownerScopeId: request.ownerScopeId,
        taskId: request.taskId, workspaceId: request.workspaceId, recordKey,
        contentSha256: record.contentSha256, writeSha256: record.writeSha256,
      });
      let invoked = false;
      const result = await permissions.withWriteAuthorization(authorization, signal, async lease => {
        cancelled(signal);
        if (invoked) throw new ExperienceMemoryError('memory_conflict');
        invoked = true;
        if (!lease || lease.authorityId !== permissions.authorityId || lease.authorityId === model?.modelId ||
            !isId(lease.authorizationReference) || lease.request?.action !== authorization.action ||
            lease.request.ownerScopeId !== authorization.ownerScopeId || lease.request.taskId !== authorization.taskId ||
            lease.request.workspaceId !== authorization.workspaceId || lease.request.recordKey !== recordKey ||
            lease.request.contentSha256 !== record.contentSha256 || lease.request.writeSha256 !== record.writeSha256 ||
            !this.deadlineCurrent(lease.expiresAt) || !this.deadlineCurrent(record.privacyExpiresAt)) {
          throw new ExperienceMemoryError('permission_denied');
        }
        const stored = await store.appendVerified(record, lease, signal);
        if (!stored || !['stored', 'already_stored'].includes(stored.status) || stored.recordKey !== recordKey ||
            stored.contentSha256 !== record.contentSha256) throw new ExperienceMemoryError('memory_conflict');
        return stored.status;
      });
      if (!invoked || result === null || !['stored', 'already_stored'].includes(result)) throw new ExperienceMemoryError('permission_denied');
      return result;
    } catch (error) {
      if (signal.aborted) throw new ExperienceMemoryError('cancelled');
      if (error instanceof ExperienceMemoryError) throw error;
      throw new ExperienceMemoryError('memory_storage_failure');
    }
  }
}
