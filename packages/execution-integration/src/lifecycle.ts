/** Phase 5 lifecycle boundary. No production setting, model file, or process is mutated here. */
export const LIFECYCLE_SCHEMA_VERSION = 'execution-integration-lifecycle/v1' as const;

export interface LifecycleModelIdentity {
  readonly modelId: string;
  readonly tokenizerId: string;
  readonly checkpointId: string;
  readonly modelSha256: string;
  readonly tokenizerSha256: string;
  readonly checkpointSha256: string;
}

export interface RegisteredModelVersion extends LifecycleModelIdentity {
  readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly versionId: string;
  readonly revision: number;
  readonly status: 'registered' | 'revoked';
  readonly capabilities: readonly string[];
  readonly provenanceReference: string;
  readonly initialization: 'random';
  readonly initializationAttestationReference: string;
}

export const PROMOTION_GATES = [
  'structural', 'behavioral', 'regression', 'permission_boundary', 'workspace_consistency',
  'expected_output', 'held_out', 'contamination', 'resource_limits',
] as const;
export type PromotionGate = (typeof PROMOTION_GATES)[number];

export interface IndependentModelEvaluation extends LifecycleModelIdentity {
  readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly evaluationId: string;
  readonly versionId: string;
  readonly revision: number;
  readonly authorityId: string;
  readonly status: 'valid' | 'revoked';
  readonly independentlyVerified: true;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly reportSha256: string;
  readonly eligibility: 'eligible' | 'ineligible' | 'insufficient_evidence';
  readonly gates: Readonly<Record<PromotionGate, {
    readonly status: 'passed' | 'failed' | 'unavailable';
    readonly evidenceReferences: readonly string[];
  }>>;
}

export interface ActiveModelReference extends LifecycleModelIdentity {
  readonly versionId: string;
  readonly registryRevision: number;
  readonly evaluationId: string;
  readonly evaluationRevision: number;
}

export interface ModelLifecycleState {
  readonly scopeId: string;
  readonly revision: number;
  readonly active: ActiveModelReference | null;
  readonly previous: ActiveModelReference | null;
  readonly rollbackTarget: ActiveModelReference | null;
}

export type LifecycleErrorCode = 'lifecycle_unavailable' | 'invalid_metadata' | 'model_unavailable'
  | 'evaluation_unavailable' | 'promotion_ineligible' | 'permission_unavailable' | 'permission_denied'
  | 'revision_conflict' | 'rollback_unavailable' | 'cancelled' | 'lifecycle_storage_failure';

export class ModelLifecycleError extends Error {
  constructor(readonly code: LifecycleErrorCode) {
    super(code);
    this.name = 'ModelLifecycleError';
  }
}

export interface PromotionEligibility {
  readonly status: 'eligible' | 'ineligible' | 'unavailable';
  readonly reasons: readonly string[];
  readonly reference: ActiveModelReference | null;
  readonly evaluationExpiresAt: string | null;
}

export interface ModelLifecycleAuditEvent {
  readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  readonly kind: 'model_promotion' | 'rollback';
  readonly correlationId: string;
  readonly scopeId: string;
  readonly approvalId: string;
  readonly from: ActiveModelReference | null;
  readonly to: ActiveModelReference;
  readonly revision: number;
  readonly timestamp: string;
}

export interface LifecycleApprovalRequest {
  readonly action: 'activate_execution_model' | 'rollback_execution_model';
  readonly scopeId: string;
  readonly approvalId: string;
  readonly correlationId: string;
  readonly expectedStateRevision: number;
  readonly expectedActive: ActiveModelReference | null;
  readonly target: ActiveModelReference;
}

export interface LifecycleApprovalReceipt {
  readonly approvalId: string;
  readonly authorityId: string;
  readonly action: LifecycleApprovalRequest['action'];
  readonly scopeId: string;
  readonly expectedStateRevision: number;
  readonly expectedActive: ActiveModelReference | null;
  readonly target: ActiveModelReference;
  readonly expiresAt: string;
  readonly explicitlyApproved: true;
}

/** Pinned validity constraints retained by storage and checked atomically at COMMIT. */
export interface LifecycleCommitConstraints {
  readonly scopeId: string;
  readonly expectedStateRevision: number;
  readonly target: ActiveModelReference;
  readonly evaluationExpiresAt: string;
  readonly approvalId: string;
  readonly approvalAuthorityId: string;
  readonly approvalExpiresAt: string;
}

/**
 * The authority MUST validate and consume a live, human/controller-issued approval in
 * this exact transaction. An HTTP approval check followed by a separate write does
 * not implement this interface. Consumption rolls back if the transaction rolls back.
 * Model-generated approvals and approval reuse are forbidden.
 */
export interface ModelActivationApprovalAdapter {
  readonly authorityId: string;
  authorizeAndConsume(
    transactionContext: unknown,
    request: LifecycleApprovalRequest,
    signal: AbortSignal,
  ): Promise<LifecycleApprovalReceipt | null>;
}

export interface ModelLifecycleTransaction {
  /** Storage-owned context for a compatible approval authority; never model data. */
  readonly approvalTransactionContext: unknown;
  readState(scopeId: string): Promise<ModelLifecycleState>;
  readVersion(scopeId: string, versionId: string): Promise<RegisteredModelVersion | null>;
  readEvaluation(scopeId: string, evaluationId: string): Promise<IndependentModelEvaluation | null>;
  /**
   * Validate both deadlines at CAS and register the constraints for a second atomic
   * check at COMMIT, including audit writes. Use the authoritative storage clock,
   * fence registry/evaluation/approval revocation, and roll back all changes if any
   * identity, revision, approval or deadline is invalid. No detached preflight check.
   */
  compareAndSetState(expectedRevision: number, next: ModelLifecycleState, constraints: LifecycleCommitConstraints): Promise<boolean>;
  appendAudit(event: ModelLifecycleAuditEvent): Promise<void>;
}

/**
 * Serializable transaction, including approval consumption, version/evaluation reads,
 * state CAS and audit append. Throwing or aborting rolls back every write. The adapter
 * must fence concurrent revocation, enforce the compareAndSetState validity constraints
 * against the authoritative storage clock, and recheck signal atomically at COMMIT.
 * No default persistence implementation or database schema is presumed.
 */
export interface ModelLifecycleStore {
  transaction<T>(scopeId: string, signal: AbortSignal, body: (tx: ModelLifecycleTransaction) => Promise<T>): Promise<T>;
}

export interface ModelLifecycleOptions {
  readonly store?: ModelLifecycleStore;
  readonly approvals?: ModelActivationApprovalAdapter;
  readonly trustedEvaluationAuthorities: readonly string[];
  readonly now?: () => Date;
}

export interface ModelActivationInput {
  readonly scopeId: string;
  readonly versionId: string;
  readonly evaluationId: string;
  readonly expectedStateRevision: number;
  readonly approvalId: string;
  readonly correlationId: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,199}$/;
const digest = /^[a-f0-9]{64}$/;
const sameIdentity = (a: LifecycleModelIdentity, b: LifecycleModelIdentity): boolean =>
  a.modelId === b.modelId && a.tokenizerId === b.tokenizerId && a.checkpointId === b.checkpointId &&
  a.modelSha256 === b.modelSha256 && a.tokenizerSha256 === b.tokenizerSha256 && a.checkpointSha256 === b.checkpointSha256;
const sameReference = (a: ActiveModelReference | null, b: ActiveModelReference | null): boolean =>
  a === null || b === null ? a === b : sameIdentity(a, b) && a.versionId === b.versionId &&
    a.registryRevision === b.registryRevision && a.evaluationId === b.evaluationId && a.evaluationRevision === b.evaluationRevision;
const revision = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);
const validIdentity = (value: LifecycleModelIdentity): boolean => !!value &&
  [value.modelId, value.tokenizerId, value.checkpointId].every(validId) &&
  [value.modelSha256, value.tokenizerSha256, value.checkpointSha256].every(v => typeof v === 'string' && digest.test(v));
const validReference = (value: ActiveModelReference | null): boolean => value === null ||
  (validIdentity(value) && validId(value.versionId) && validId(value.evaluationId) &&
    revision(value.registryRevision) && revision(value.evaluationRevision));

/** Never spread stored adapter values into approvals, audit records or public results. */
function normalizeReference(value: ActiveModelReference): ActiveModelReference {
  if (!validReference(value)) throw new ModelLifecycleError('invalid_metadata');
  return Object.freeze({
    modelId: value.modelId, tokenizerId: value.tokenizerId, checkpointId: value.checkpointId,
    modelSha256: value.modelSha256, tokenizerSha256: value.tokenizerSha256, checkpointSha256: value.checkpointSha256,
    versionId: value.versionId, registryRevision: value.registryRevision,
    evaluationId: value.evaluationId, evaluationRevision: value.evaluationRevision,
  });
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelLifecycleError('cancelled');
}

/** Trusted registry/evaluation adapters provide evidence. This coordinator never evaluates a model itself. */
export class ModelLifecycleCoordinator {
  private readonly now: () => Date;
  private readonly authorities: ReadonlySet<string>;

  constructor(private readonly options: ModelLifecycleOptions) {
    this.now = options.now ?? (() => new Date());
    if (!options.trustedEvaluationAuthorities.length || !options.trustedEvaluationAuthorities.every(validId)) {
      throw new ModelLifecycleError('invalid_metadata');
    }
    this.authorities = new Set(options.trustedEvaluationAuthorities);
  }

  private deadlineCurrent(value: string | null): boolean {
    const current = this.now().getTime(), deadline = value === null ? NaN : Date.parse(value);
    return Number.isFinite(current) && Number.isFinite(deadline) && deadline > current;
  }

  private assertCommitDeadlines(constraints: LifecycleCommitConstraints): void {
    if (!this.deadlineCurrent(constraints.evaluationExpiresAt)) throw new ModelLifecycleError('promotion_ineligible');
    if (!this.deadlineCurrent(constraints.approvalExpiresAt)) throw new ModelLifecycleError('permission_denied');
  }

  private async transaction<T>(scopeId: string, signal: AbortSignal, body: (tx: ModelLifecycleTransaction) => Promise<T>): Promise<T> {
    if (!validId(scopeId)) throw new ModelLifecycleError('invalid_metadata');
    checkSignal(signal);
    if (!this.options.store) throw new ModelLifecycleError('lifecycle_unavailable');
    try {
      return await this.options.store.transaction(scopeId, signal, async tx => {
        checkSignal(signal);
        const result = await body(tx);
        checkSignal(signal);
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw new ModelLifecycleError('cancelled');
      if (error instanceof ModelLifecycleError) throw error;
      throw new ModelLifecycleError('lifecycle_storage_failure');
    }
  }

  private async eligible(tx: ModelLifecycleTransaction, scopeId: string, versionId: string, evaluationId: string): Promise<PromotionEligibility> {
    if (![versionId, evaluationId].every(validId)) throw new ModelLifecycleError('invalid_metadata');
    const version = await tx.readVersion(scopeId, versionId);
    if (!version) return { status: 'unavailable', reasons: ['model_unavailable'], reference: null, evaluationExpiresAt: null };
    if (!validIdentity(version) || version.schemaVersion !== LIFECYCLE_SCHEMA_VERSION || version.scopeId !== scopeId ||
        version.versionId !== versionId || !revision(version.revision) || !validId(version.provenanceReference) ||
        !validId(version.initializationAttestationReference) || version.initialization !== 'random' ||
        !Array.isArray(version.capabilities) || !version.capabilities.length || !version.capabilities.every(validId)) {
      return { status: 'ineligible', reasons: ['invalid_registry_metadata'], reference: null, evaluationExpiresAt: null };
    }
    if (version.status !== 'registered') return { status: 'ineligible', reasons: ['version_revoked'], reference: null, evaluationExpiresAt: null };
    const evaluation = await tx.readEvaluation(scopeId, evaluationId);
    if (!evaluation) return { status: 'unavailable', reasons: ['evaluation_unavailable'], reference: null, evaluationExpiresAt: null };
    if (!validIdentity(evaluation) || evaluation.schemaVersion !== LIFECYCLE_SCHEMA_VERSION || evaluation.scopeId !== scopeId ||
        evaluation.versionId !== versionId || evaluation.evaluationId !== evaluationId || !revision(evaluation.revision) ||
        !sameIdentity(version, evaluation) || !digest.test(evaluation.reportSha256) ||
        !this.authorities.has(evaluation.authorityId) || evaluation.authorityId === version.modelId ||
        evaluation.independentlyVerified !== true || evaluation.status !== 'valid') {
      return { status: 'ineligible', reasons: ['invalid_independent_evaluation'], reference: null, evaluationExpiresAt: null };
    }
    const current = this.now().getTime();
    const evaluatedAt = Date.parse(evaluation.evaluatedAt), expiresAt = Date.parse(evaluation.expiresAt);
    if (!Number.isFinite(current) || !Number.isFinite(evaluatedAt) || !Number.isFinite(expiresAt) || evaluatedAt > current || expiresAt <= current) {
      return { status: 'ineligible', reasons: ['evaluation_expired_or_invalid_time'], reference: null, evaluationExpiresAt: null };
    }
    const reasons: string[] = [];
    if (evaluation.eligibility !== 'eligible') reasons.push('independent_promotion_gate_not_passed');
    for (const gate of PROMOTION_GATES) {
      const result = evaluation.gates?.[gate];
      if (!result || result.status !== 'passed' || !Array.isArray(result.evidenceReferences) ||
          !result.evidenceReferences.length || !result.evidenceReferences.every(validId)) reasons.push(`gate_${gate}`);
    }
    if (reasons.length) return { status: 'ineligible', reasons, reference: null, evaluationExpiresAt: null };
    return { status: 'eligible', reasons: [], evaluationExpiresAt: new Date(expiresAt).toISOString(), reference: Object.freeze({
      versionId, registryRevision: version.revision, evaluationId, evaluationRevision: evaluation.revision,
      modelId: version.modelId, tokenizerId: version.tokenizerId, checkpointId: version.checkpointId,
      modelSha256: version.modelSha256, tokenizerSha256: version.tokenizerSha256, checkpointSha256: version.checkpointSha256,
    }) };
  }

  private async state(tx: ModelLifecycleTransaction, scopeId: string): Promise<ModelLifecycleState> {
    const state = await tx.readState(scopeId);
    if (!state || state.scopeId !== scopeId || !revision(state.revision) ||
        !validReference(state.active) || !validReference(state.previous) || !validReference(state.rollbackTarget)) {
      throw new ModelLifecycleError('invalid_metadata');
    }
    return Object.freeze({
      scopeId: state.scopeId, revision: state.revision,
      active: state.active === null ? null : normalizeReference(state.active),
      previous: state.previous === null ? null : normalizeReference(state.previous),
      rollbackTarget: state.rollbackTarget === null ? null : normalizeReference(state.rollbackTarget),
    });
  }

  async assessEligibility(scopeId: string, versionId: string, evaluationId: string, signal: AbortSignal): Promise<PromotionEligibility> {
    const result = await this.transaction(scopeId, signal, tx => this.eligible(tx, scopeId, versionId, evaluationId));
    checkSignal(signal);
    if (result.status === 'eligible' && !this.deadlineCurrent(result.evaluationExpiresAt)) {
      return { status: 'ineligible', reasons: ['evaluation_expired_or_invalid_time'], reference: null, evaluationExpiresAt: null };
    }
    return result;
  }

  /** Revalidates current registered identity and live independent evidence on every selection. */
  async selectActive(scopeId: string, signal: AbortSignal): Promise<ActiveModelReference> {
    const selected = await this.transaction(scopeId, signal, async tx => {
      const state = await this.state(tx, scopeId);
      if (!state.active) throw new ModelLifecycleError('model_unavailable');
      const eligibility = await this.eligible(tx, scopeId, state.active.versionId, state.active.evaluationId);
      if (eligibility.status !== 'eligible' || !eligibility.reference || !sameReference(state.active, eligibility.reference)) {
        throw new ModelLifecycleError('promotion_ineligible');
      }
      return { reference: normalizeReference(eligibility.reference), evaluationExpiresAt: eligibility.evaluationExpiresAt };
    });
    checkSignal(signal);
    if (!this.deadlineCurrent(selected.evaluationExpiresAt)) throw new ModelLifecycleError('promotion_ineligible');
    return selected.reference;
  }

  activate(input: ModelActivationInput, signal: AbortSignal): Promise<ModelLifecycleState> {
    return this.change('activate_execution_model', { ...input }, signal);
  }

  /** Explicit target must match the stored rollback target; rollback uses the same eligibility and approval gates. */
  rollback(input: ModelActivationInput, signal: AbortSignal): Promise<ModelLifecycleState> {
    return this.change('rollback_execution_model', { ...input }, signal);
  }

  private change(action: LifecycleApprovalRequest['action'], input: ModelActivationInput, signal: AbortSignal): Promise<ModelLifecycleState> {
    return this.transaction(input.scopeId, signal, async tx => {
      if (![input.approvalId, input.correlationId].every(validId) || !revision(input.expectedStateRevision)) {
        throw new ModelLifecycleError('invalid_metadata');
      }
      if (!this.options.approvals || !validId(this.options.approvals.authorityId)) throw new ModelLifecycleError('permission_unavailable');
      const state = await this.state(tx, input.scopeId);
      if (state.revision !== input.expectedStateRevision) throw new ModelLifecycleError('revision_conflict');
      const eligibility = await this.eligible(tx, input.scopeId, input.versionId, input.evaluationId);
      if (eligibility.status === 'unavailable') throw new ModelLifecycleError('evaluation_unavailable');
      if (eligibility.status !== 'eligible' || !eligibility.reference) throw new ModelLifecycleError('promotion_ineligible');
      const target = eligibility.reference;
      if (sameReference(state.active, target)) throw new ModelLifecycleError('revision_conflict');
      if (action === 'rollback_execution_model' && !sameReference(state.rollbackTarget, target)) throw new ModelLifecycleError('rollback_unavailable');
      const request: LifecycleApprovalRequest = Object.freeze({
        action, scopeId: input.scopeId, approvalId: input.approvalId, correlationId: input.correlationId,
        expectedStateRevision: state.revision, expectedActive: state.active, target,
      });
      checkSignal(signal);
      const receipt = await this.options.approvals.authorizeAndConsume(tx.approvalTransactionContext, request, signal);
      checkSignal(signal);
      if (!receipt || receipt.explicitlyApproved !== true || receipt.approvalId !== input.approvalId ||
          receipt.authorityId !== this.options.approvals.authorityId || receipt.authorityId === target.modelId ||
          receipt.action !== action || receipt.scopeId !== input.scopeId || receipt.expectedStateRevision !== state.revision ||
          !sameReference(receipt.expectedActive, state.active) || !sameReference(receipt.target, target) ||
          !this.deadlineCurrent(receipt.expiresAt)) {
        throw new ModelLifecycleError('permission_denied');
      }
      // Approval resolution can wait arbitrarily long: renew the evidence read after it.
      const approvalExpiresAt = new Date(Date.parse(receipt.expiresAt)).toISOString();
      const refreshed = await this.eligible(tx, input.scopeId, input.versionId, input.evaluationId);
      checkSignal(signal);
      if (refreshed.status !== 'eligible' || !refreshed.reference || !refreshed.evaluationExpiresAt ||
          !sameReference(refreshed.reference, target) || refreshed.evaluationExpiresAt !== eligibility.evaluationExpiresAt) {
        throw new ModelLifecycleError('promotion_ineligible');
      }
      const constraints: LifecycleCommitConstraints = Object.freeze({
        scopeId: input.scopeId, expectedStateRevision: state.revision, target,
        evaluationExpiresAt: refreshed.evaluationExpiresAt, approvalId: input.approvalId,
        approvalAuthorityId: this.options.approvals.authorityId, approvalExpiresAt,
      });
      const next: ModelLifecycleState = Object.freeze({
        scopeId: input.scopeId, revision: state.revision + 1, active: target,
        previous: state.active, rollbackTarget: state.active,
      });
      this.assertCommitDeadlines(constraints);
      if (!revision(next.revision) || !await tx.compareAndSetState(state.revision, next, constraints)) throw new ModelLifecycleError('revision_conflict');
      this.assertCommitDeadlines(constraints);
      await tx.appendAudit({
        schemaVersion: LIFECYCLE_SCHEMA_VERSION, kind: action === 'activate_execution_model' ? 'model_promotion' : 'rollback',
        correlationId: input.correlationId, scopeId: input.scopeId, approvalId: input.approvalId,
        from: state.active, to: target, revision: next.revision, timestamp: this.now().toISOString(),
      });
      this.assertCommitDeadlines(constraints);
      return next;
    });
  }
}
