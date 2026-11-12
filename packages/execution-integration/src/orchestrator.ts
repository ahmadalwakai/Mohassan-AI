import type { AuditSink, CognitiveSupervisorAdapter, EscalationRequest, ExecutionContext, ExecutionReceipt,
  Failure, IndependentVerifierAdapter, IsolatedExecutionAdapter, LearnedExecutorAdapter, Operation,
  PermissionAdapter, PhaseOneAdapter, PreparedExecution, State, StateStore, SupervisorEnvelope, TaskRecord,
  ToolGatewayAdapter, ValidatedAction, ValidatedCandidate, WorkspaceAdapter, WorkspaceLease } from './contracts.js';
import { ExecutionAudit } from './audit.js';
import { acquireWorkspace, assertWorkspace, dispatch, permissionCheck, validateCandidate, verifyIndependently } from './coordination.js';
import { classifyFailure, decideRecovery } from './recovery.js';
import { abortable, fail, hash, IntegrationError, positive, same, textId, within } from './safety.js';
import { assertTransition, terminal, TRANSITIONS } from './state.js';
import { ExecutionStrategyCoordinator } from './strategy.js';
import { snapshotSupervisor } from './supervisor.js';

export interface OrchestratorAdapters {
  state: StateStore; audit: AuditSink; supervisor: CognitiveSupervisorAdapter;
  phaseOne?: PhaseOneAdapter; learned?: LearnedExecutorAdapter; permission?: PermissionAdapter;
  workspace?: WorkspaceAdapter; gateway?: ToolGatewayAdapter; isolated?: IsolatedExecutionAdapter;
  verifier?: IndependentVerifierAdapter;
}
/** Inert unless explicitly instantiated. No application entrypoints or provider configuration are changed. */
export class ExecutionOrchestrator {
  private readonly active = new Map<string, AbortController>();
  private readonly audit: ExecutionAudit;
  private readonly strategies: ExecutionStrategyCoordinator;
  constructor(private readonly adapters: OrchestratorAdapters) {
    this.audit = new ExecutionAudit(adapters.audit);
    this.strategies = new ExecutionStrategyCoordinator(adapters.phaseOne, adapters.learned);
  }
  async create(taskId: string, correlationId: string, totalMs: number): Promise<TaskRecord> {
    if (!textId(taskId) || !textId(correlationId) || !positive(totalMs, 86_400_000)) fail('invalid_contract');
    const now = Date.now();
    const record: TaskRecord = { taskId, correlationId, state: 'CREATED', revision: 0, createdAt: now,
      deadlineAt: now + totalMs, generationCount: 0, recoveryCount: 0, executionStarted: false };
    if (!await this.adapters.state.create(record)) fail('state_conflict');
    await this.audit.emit(record, 'task_creation');
    return record;
  }
  async cancel(taskId: string): Promise<TaskRecord | null> {
    const record = await this.adapters.state.read(taskId);
    if (!record || terminal(record.state)) return record;
    await this.adapters.state.requestCancellation(taskId);
    const active = this.active.get(taskId);
    if (active) { active.abort(new IntegrationError('cancellation')); return this.adapters.state.read(taskId); }
    // Another process can own the claim; its boundary checks/poll will consume the durable flag.
    const claim = await this.adapters.state.claim(taskId);
    if (!claim) return this.adapters.state.read(taskId);
    try {
      const latest = await this.adapters.state.read(taskId);
      if (!latest || terminal(latest.state)) return latest;
      const next: TaskRecord = { ...latest, state: 'CANCELLED', revision: latest.revision + 1,
        failure: { code: 'cancellation', effect: latest.executionStarted ? 'possible' : 'none', evidenceRefs: [] } };
      assertTransition(latest, next);
      if (!await this.adapters.state.compareAndSet(claim, latest.revision, next)) fail('state_conflict');
      await this.audit.emit(next, 'cancellation');
      return next;
    } finally { await this.adapters.state.release(claim); }
  }
  async run(taskId: string, callerSignal?: AbortSignal): Promise<TaskRecord> {
    const claim = await this.adapters.state.claim(taskId);
    if (!claim) fail('state_conflict');
    let existing: TaskRecord | null;
    try { existing = await this.adapters.state.read(taskId); }
    catch (error) { await this.adapters.state.release(claim); throw error; }
    if (!existing) { await this.adapters.state.release(claim); fail('state_conflict'); }
    let record: TaskRecord = existing;
    if (terminal(record.state)) { await this.adapters.state.release(claim); return record; }
    const controller = new AbortController();
    this.active.set(taskId, controller);
    const cancel = () => controller.abort(new IntegrationError('cancellation'));
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    let timeout = setTimeout(() => controller.abort(new IntegrationError('budget_exhausted')), Math.max(1, record.deadlineAt - Date.now()));
    let watch: Promise<void> | undefined;
    const poll = setInterval(() => {
      if (watch || controller.signal.aborted) return;
      watch = (async () => {
        await this.adapters.state.assertClaim(claim);
        if (await this.adapters.state.isCancellationRequested(taskId)) cancel();
      })().catch(() => controller.abort(new IntegrationError('state_conflict'))).finally(() => { watch = undefined; });
    }, 250);
    let envelope: SupervisorEnvelope | undefined;
    let lease: WorkspaceLease | undefined;
    let acceptingWorkspaceLease = true;
    let validated: ValidatedCandidate | undefined;
    let preparation: PreparedExecution | undefined = record.preparation;
    const resumingContext = record.state === 'WAITING_FOR_CONTEXT';
    const repairEvidenceRefs = new Set(record.repairEvidenceRefs ?? []);
    const receipts: ExecutionReceipt[] = [];
    const signal = controller.signal;
    const remaining = () => Math.max(0, record!.deadlineAt - Date.now());
    const check = async () => {
      signal.throwIfAborted();
      await this.adapters.state.assertClaim(claim);
      if (await this.adapters.state.isCancellationRequested(taskId)) { cancel(); signal.throwIfAborted(); }
      if (remaining() <= 0) fail('budget_exhausted');
    };
    const move = async (state: State, patch: Partial<TaskRecord> = {}, beginning = false) => {
      if (state === 'EXECUTING' || state === 'COMPLETED') await check();
      const next: TaskRecord = { ...record!, ...patch, taskId, correlationId: record!.correlationId,
        state, revision: record!.revision + 1 };
      assertTransition(record!, next);
      const updated = beginning
        ? await this.adapters.state.beginExecution(claim, record!.revision, next)
        : await this.adapters.state.compareAndSet(claim, record!.revision, next);
      if (!updated) {
        if (await this.adapters.state.isCancellationRequested(taskId)) fail('cancellation');
        fail('state_conflict');
      }
      record = next;
      await this.audit.emit(next, 'state_transition');
    };
    const request = (failure: Failure, requires: EscalationRequest['requires']): EscalationRequest => ({
      taskId, reason: failure.code, requires, evidenceRefs: failure.evidenceRefs,
      previousContextRevision: envelope?.contextRevision ?? record!.contextRevision ?? 'unavailable',
    });
    const escalate = async (failure: Failure, requires: EscalationRequest['requires']) => {
      await move('ESCALATED', { failure, escalation: request(failure, requires) });
      await this.audit.emit(record!, 'escalation', failure.evidenceRefs, failure.code);
    };
    const permission = async (operation: Operation, action?: ValidatedAction, canWait = false): Promise<boolean> => {
      await check();
      const result = await permissionCheck(this.adapters.permission, envelope!, operation, signal,
        action ? { argumentsHash: action.argumentsHash, actionHash: action.actionHash, candidateHash: validated!.hash } : undefined);
      await this.audit.emit(record!, 'permission_decision', [operation.id, result.status]);
      if (result.status === 'granted') return true;
      if (result.status === 'approval_required' && canWait) {
        await move('WAITING_FOR_APPROVAL', preparation ? { preparation } : {});
        await this.audit.emit(record!, 'approval_request', [result.requestRef]);
        return false;
      }
      fail(result.status === 'unavailable' ? 'permission_unavailable' : 'permission_denial');
    };
    const context = (stepSignal: AbortSignal): ExecutionContext => ({
      taskId, ownerId: envelope!.ownerId, correlationId: record!.correlationId, fence: claim.fence, signal: stepSignal,
      assertActive: async () => {
        stepSignal.throwIfAborted(); await check();
        if (lease) await lease.assertHeld(stepSignal);
        if (record.model) {
          if (!this.adapters.learned) fail('capability_unavailable');
          await this.adapters.learned.assertEligible(record.model, envelope!, stepSignal);
        }
        if (validated) for (const item of validated.actions) await permission(item.operation, item);
        stepSignal.throwIfAborted();
      },
    });
    try {
      await check();
      if (!['CREATED', 'WAITING_FOR_CONTEXT', 'WAITING_FOR_APPROVAL'].includes(record.state)) {
        // An interrupted execution or verification is a reconciliation task, never an execution replay.
        if (TRANSITIONS[record.state].includes('ESCALATED')) {
          await escalate({ code: 'external_tool_uncertainty', effect: record.executionStarted ? 'possible' : 'none', evidenceRefs: [] },
            record.executionStarted ? 'reconciliation' : 'replan');
          return record;
        }
        fail('state_conflict');
      }
      await move('VALIDATING');
      envelope = snapshotSupervisor(await within(Math.min(30_000, remaining()), signal,
        stepSignal => this.adapters.supervisor.read(taskId, stepSignal)), taskId, record.correlationId);
      if (resumingContext && record.generationCount > 0
        && (record.contextRevision === envelope.contextRevision || record.contextHash === hash(envelope.projectContext))) {
        const failure: Failure = { code: 'missing_context', effect: 'none', evidenceRefs: [] };
        await move('WAITING_FOR_CONTEXT', { failure, escalation: request(failure, 'context') }); return record;
      }
      const deadline = Math.min(record.deadlineAt, record.createdAt + envelope.budget.totalMs);
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(new IntegrationError('budget_exhausted')), Math.max(1, deadline - Date.now()));
      if (deadline <= Date.now()) fail('budget_exhausted');
      let contract = await abortable(() => this.strategies.validate(envelope!, signal), signal);
      await this.audit.emit(record, 'contract_validation', [contract.reference]);
      await abortable(() => assertWorkspace(this.adapters.workspace, envelope!, signal), signal);
      if (preparation && !same(envelope, preparation.envelope)) {
        await escalate({ code: 'reasoning_required', effect: 'none', evidenceRefs: [] }, 'replan'); return record;
      }
      // Recheck live task/plan grants even for a retained proposal before any model discovery.
      for (const operation of envelope.operations) {
        if (!await abortable(() => permission(operation, undefined, true), signal)) return record;
      }
      await move('ROUTING', { contextRevision: envelope.contextRevision, contextHash: hash(envelope.projectContext), deadlineAt: deadline });
      const selected = await abortable(() => this.strategies.select(contract, envelope!, signal), signal);
      await this.audit.emit(record, 'routing_decision', [selected.strategy]);
      if (selected.model) await this.audit.emit(record, 'model_selection', [selected.model.modelId, selected.model.tokenizerId, selected.model.checkpointId]);
      if (preparation) {
        if (preparation.strategy !== selected.strategy || !same(preparation.model ?? null, selected.model ?? null)) {
          await escalate({ code: 'reasoning_required', effect: 'none', evidenceRefs: [] }, 'replan'); return record;
        }
        await move('CANDIDATE_VALIDATION');
        validated = await abortable(() => validateCandidate(preparation!.candidate, envelope!, signal, this.adapters.gateway, this.adapters.isolated), signal);
      }
      while (!validated) {
        await check();
        if (record.generationCount >= envelope.budget.maxCandidates) fail('budget_exhausted');
        await move('GENERATING', { generationCount: record.generationCount + 1,
          contextRevision: envelope.contextRevision, contextHash: hash(envelope.projectContext), repairEvidenceRefs: [...repairEvidenceRefs],
          ...(selected.model ? { model: selected.model } : {}) });
        try {
          const candidate = await within(Math.min(envelope.budget.generationMs, remaining()), signal,
            stepSignal => this.strategies.generate(selected.strategy, contract, envelope!, stepSignal, selected.model));
          await this.audit.emit(record, 'candidate_generation');
          await move('CANDIDATE_VALIDATION');
          validated = await abortable(() => validateCandidate(candidate, envelope!, signal, this.adapters.gateway, this.adapters.isolated), signal);
        } catch (error) {
          const failure = classifyFailure(error, record.executionStarted, signal);
          const recovery = decideRecovery({ failure, state: record.state, executionStarted: record.executionStarted,
            cancelled: signal.aborted, generationCount: record.generationCount, recoveryCount: record.recoveryCount,
            budget: envelope.budget, allowLocalRepair: envelope.escalationPolicy.allowLocalRepair });
          if (recovery !== 'repair_candidate') throw error;
          await this.audit.emit(record, 'failure_classification', failure.evidenceRefs, failure.code);
          await move('REPAIR_REQUIRED', { failure, recoveryCount: record.recoveryCount + 1 });
          if (!this.adapters.supervisor.repairEvidence) { await escalate(failure, 'reasoning'); return record; }
          const evidence = await abortable(() => this.adapters.supervisor.repairEvidence!(request(failure, 'context'), signal), signal);
          if (!evidence || !textId(evidence.contextRevision) || evidence.contextRevision === envelope.contextRevision
            || !Array.isArray(evidence.evidenceRefs) || !evidence.evidenceRefs.length || !evidence.evidenceRefs.every(textId)
            || evidence.evidenceRefs.every(ref => failure.evidenceRefs.includes(ref) || repairEvidenceRefs.has(ref))) {
            await escalate(failure, 'reasoning'); return record;
          }
          // Only context/evidence changes here. Plan, allowed operations and architecture remain immutable.
          const repaired = snapshotSupervisor({ ...envelope, projectContext: evidence.context, contextRevision: evidence.contextRevision }, taskId, record.correlationId);
          if (same(repaired.projectContext, envelope.projectContext)) { await escalate(failure, 'reasoning'); return record; }
          envelope = repaired;
          evidence.evidenceRefs.forEach(ref => repairEvidenceRefs.add(ref));
          contract = await abortable(() => this.strategies.validate(envelope!, signal), signal);
          const rerouted = await abortable(() => this.strategies.select(contract, envelope!, signal), signal);
          if (!same(rerouted, selected)) { await escalate(failure, 'replan'); return record; }
          await abortable(() => assertWorkspace(this.adapters.workspace, envelope!, signal), signal);
          await this.audit.emit(record, 'recovery', evidence.evidenceRefs);
        }
      }
      await check();
      if (!this.adapters.verifier || !textId(this.adapters.verifier.verifierId)
        || [this.adapters.gateway?.adapterId, this.adapters.isolated?.adapterId, selected.model?.modelId].includes(this.adapters.verifier.verifierId)) fail('verification_unavailable');
      preparation = { envelope, candidate: validated.candidate, strategy: selected.strategy,
        ...(selected.model ? { model: selected.model } : {}) };
      for (const item of validated.actions) if (!await abortable(() => permission(item.operation, item, true), signal)) return record;
      await move('READY_FOR_EXECUTION', { candidateHash: validated.hash, contextRevision: envelope.contextRevision,
        preparation: undefined, model: selected.model });
      // Establish the mutation fence and recheck the original snapshot immediately before claiming the batch.
      await abortable(async () => {
        const acquired = await acquireWorkspace(this.adapters.workspace, envelope!, context(signal));
        if (!acceptingWorkspaceLease || signal.aborted) { await acquired.release(); fail('cancellation'); }
        // Take ownership before promise settlement so cancellation cannot lose the lease.
        lease = acquired;
      }, signal);
      await abortable(() => assertWorkspace(this.adapters.workspace, envelope!, signal), signal);
      await abortable(() => context(signal).assertActive(), signal);
      await move('EXECUTING', { executionStarted: true, executionManifest: {
        candidateHash: validated.hash, workspaceId: envelope.workspace.workspaceId, snapshotId: envelope.workspace.snapshotId,
        startedAt: Date.now(), operations: validated.actions.map(item => ({ operationId: item.operation.id,
          idempotencyKey: hash({ taskId, candidate: validated!.hash, operation: item.operation.id }), actionHash: item.actionHash })),
      } }, true);
      const executionDeadline = Math.min(record.deadlineAt, Date.now() + envelope.budget.executionMs);
      await within(Math.max(1, executionDeadline - Date.now()), signal, async executionSignal => {
        for (const item of validated!.actions) {
          await context(executionSignal).assertActive();
          const idempotencyKey = hash({ taskId, candidate: validated!.hash, operation: item.operation.id });
          if (item.operation.kind === 'sandbox_code') await this.audit.emit(record!, 'sandbox_execution', [item.operation.id]);
          const receipt = await dispatch({ envelope: envelope!, candidateHash: validated!.hash, action: item, idempotencyKey,
            workspaceLeaseId: lease!.id, timeoutMs: Math.max(1, executionDeadline - Date.now()) },
          context(executionSignal), this.adapters.gateway, this.adapters.isolated);
          receipts.push(receipt);
        }
      });
      await check();
      await move('VERIFYING');
      const verification = await within(Math.min(envelope.budget.verificationMs, remaining()), signal, stepSignal =>
        verifyIndependently(this.adapters.verifier, envelope!, validated!, receipts, context(stepSignal),
          [this.adapters.gateway?.adapterId, this.adapters.isolated?.adapterId, selected.model?.modelId].filter((id): id is string => Boolean(id))));
      await this.audit.emit(record, 'verification_result', [verification.status, ...verification.evidence.map(item => item.id)]);
      if (verification.status !== 'verified') {
        await move('REPAIR_REQUIRED', { verification, failure: {
          code: verification.status === 'unavailable' ? 'verification_unavailable' : 'verification_failure',
          effect: 'possible', evidenceRefs: verification.evidence.map(item => item.id),
        } });
        await escalate(record.failure!, 'reconciliation'); return record;
      }
      await abortable(() => context(signal).assertActive(), signal);
      await move('COMPLETED', { verification, failure: undefined, escalation: undefined });
      await this.audit.emit(record, 'completion', verification.evidence.map(item => item.id));
      return record;
    } catch (error) {
      if (terminal(record.state)) throw error;
      const failure = classifyFailure(error, record.executionStarted, signal);
      // Stop effects before attempting failure persistence or external diagnostics.
      if (!signal.aborted) controller.abort(new IntegrationError(failure.code, failure.effect, failure.evidenceRefs));
      const next: State = failure.code === 'cancellation' ? 'CANCELLED'
        : record.executionStarted ? 'ESCALATED'
          : failure.code === 'missing_context' && TRANSITIONS[record.state].includes('WAITING_FOR_CONTEXT') ? 'WAITING_FOR_CONTEXT'
            : ['stale_workspace', 'unsupported_capability', 'reasoning_required', 'permission_unavailable',
              'capability_unavailable', 'isolation_unavailable', 'verification_unavailable'].includes(failure.code) && TRANSITIONS[record.state].includes('ESCALATED') ? 'ESCALATED' : 'FAILED';
      const requires: EscalationRequest['requires'] = record.executionStarted ? 'reconciliation'
        : failure.code === 'stale_workspace' ? 'replan' : failure.code === 'missing_context' ? 'context'
          : failure.code.endsWith('unavailable') ? 'adapter' : 'reasoning';
      // Persist failure even when the audit sink itself is unavailable; never substitute success.
      const nextRecord: TaskRecord = { ...record, state: next, revision: record.revision + 1, failure,
        ...(['ESCALATED', 'WAITING_FOR_CONTEXT'].includes(next) ? { escalation: request(failure, requires) } : {}) };
      assertTransition(record, nextRecord);
      if (!await this.adapters.state.compareAndSet(claim, record.revision, nextRecord)) fail('state_conflict');
      record = nextRecord;
      await this.audit.emit(record, 'failure_classification', failure.evidenceRefs, failure.code);
      if (next === 'CANCELLED') await this.audit.emit(record, 'cancellation', failure.evidenceRefs);
      if (next === 'ESCALATED') await this.audit.emit(record, 'escalation', failure.evidenceRefs, failure.code);
      return record;
    } finally {
      acceptingWorkspaceLease = false;
      controller.abort(new IntegrationError('cancellation'));
      clearTimeout(timeout); clearInterval(poll); callerSignal?.removeEventListener('abort', cancel);
      this.active.delete(taskId);
      // release must fence future effects, and must not free a workspace while a child still runs.
      // Adapters own teardown acknowledgement; an uncertain release is surfaced to the caller.
      try { await lease?.release(); }
      finally { await this.adapters.state.release(claim); }
    }
  }
}
