import { z } from 'zod';
import { CapabilitySchema, SkillToolIdSchema, TaskStatusSchema } from '@mohassan/contracts';
import { ExecutionContractValidator } from './contract-validator.ts';
import { boundedJsonBytes, executionFailure, sameWorkspace, schemaIssues, type ExecutionOutputTokenCounter } from './boundaries.ts';
import {
  ExecutionIdSchema, ExecutionPathSchema, ExecutionResultSchema, ExecutionTargetPathSchema, WorkspaceVersionReferenceSchema,
  type ExecutionCandidate, type ExecutionFailure, type ExecutionResult, type ExecutionTaskContract,
  type MissingContextRequest, type UnsupportedExecutionResult, type WorkspaceVersionReference,
} from './schemas.ts';

type RejectedResult = ExecutionFailure | MissingContextRequest | UnsupportedExecutionResult;
export type ExecutionStructuralValidation =
  | { ok: true; result: ExecutionResult }
  | { ok: false; result: RejectedResult };

const PermissionBinding = { taskId: ExecutionIdSchema, workspace: WorkspaceVersionReferenceSchema };
/** These are supervisor observations of existing authority, never executor-supplied grants. */
export const ExecutionPermissionSnapshotSchema = z.discriminatedUnion('state', [
  z.object({ ...PermissionBinding, state: z.literal('required') }).strict(),
  z.object({ ...PermissionBinding, state: z.literal('denied') }).strict(),
  z.object({
    ...PermissionBinding, state: z.literal('granted'),
    scopes: z.array(z.string().min(1).max(100)).max(128),
    tools: z.array(SkillToolIdSchema).max(12), files: z.array(ExecutionTargetPathSchema).max(40),
    checkedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  }).strict(),
]);
export type ExecutionPermissionSnapshot = z.infer<typeof ExecutionPermissionSnapshotSchema>;

/** Re-read immediately before dispatch. This advisory snapshot is not a transferable approval. */
export const ExecutionEligibilitySnapshotSchema = z.object({
  taskId: ExecutionIdSchema, workspace: WorkspaceVersionReferenceSchema, status: TaskStatusSchema,
  cancellationRequested: z.boolean(),
  /** Completed generation attempts before the current candidate's generation began. */
  attemptsUsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  availableCapabilities: z.array(CapabilitySchema.strict()).max(256),
  availableTools: z.array(SkillToolIdSchema).max(12),
  permission: ExecutionPermissionSnapshotSchema,
}).strict();
export type ExecutionEligibilitySnapshot = z.infer<typeof ExecutionEligibilitySnapshotSchema>;

export type ExecutionEligibilityResult =
  | {
    ok: true; kind: 'eligible_for_supervisor_dispatch'; candidate: ExecutionCandidate;
    executionAllowed: false; semanticVerification: 'required';
  }
  | { ok: false; result: RejectedResult };

export interface ExecutionResultValidatorOptions {
  /** A trusted host clock, returning epoch milliseconds. */
  now?: () => number;
}

function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }

/** Validates proposals only. It never executes an operation, checks a database, or grants authority. */
export class ExecutionResultValidator {
  private readonly contracts = new ExecutionContractValidator();
  private readonly now: () => number;

  constructor(options: ExecutionResultValidatorOptions = {}) { this.now = options.now ?? Date.now; }

  validateStructure(raw: unknown, taskRaw: unknown, countOutputTokens: ExecutionOutputTokenCounter): ExecutionStructuralValidation {
    const contract = this.contracts.validate(taskRaw);
    if (!contract.ok) return contract;
    const task = contract.task;
    const invalid = (message: string): ExecutionStructuralValidation => ({
      ok: false, result: executionFailure(task.taskId, 'invalid_model_output', message),
    });

    // Account for the full untrusted envelope, not just its source content or claimed usage.
    if (boundedJsonBytes(raw, task.output.maxBytes) === null) return invalid('Execution result exceeds its JSON or byte boundary.');
    const parsed = ExecutionResultSchema.safeParse(raw);
    if (!parsed.success) return {
      ok: false,
      result: executionFailure(task.taskId, 'invalid_model_output', 'Execution result does not satisfy its schema.', schemaIssues(parsed.error.issues)),
    };
    let tokens: number;
    try { tokens = countOutputTokens(JSON.stringify(raw)); }
    catch { return invalid('The trusted output tokenizer could not measure the result.'); }
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > task.budget.outputTokens) {
      return invalid('Execution result exceeds its token boundary or has an invalid token measurement.');
    }

    const result = parsed.data;
    if (result.taskId !== task.taskId) return invalid('Execution result must identify its exact task.');
    if (result.kind === 'missing_context') {
      if (result.disposition !== task.policy.missingContext) return invalid('Missing-context disposition differs from supervisor policy.');
      const keys = result.missing.map(item => `${item.kind}:${item.reference}`);
      if (!unique(keys)) return invalid('Missing-context entries must be unique.');
      for (const item of result.missing) {
        const reference = item.kind === 'file' ? ExecutionPathSchema : ExecutionIdSchema;
        if (!reference.safeParse(item.reference).success) return invalid('Missing-context reference is invalid.');
      }
      // A request is an untrusted claim: newly discovered and already supplied references may be requested.
      return { ok: true, result };
    }
    if (result.kind === 'unsupported') {
      if (result.operation !== task.operation.name || result.disposition !== task.policy.unsupportedTask) {
        return invalid('Unsupported result differs from the requested operation or supervisor policy.');
      }
      return { ok: true, result };
    }
    if (result.kind === 'failure') return { ok: true, result };

    if (!sameWorkspace(result.workspace, task.workspace)) return {
      ok: false, result: executionFailure(task.taskId, 'stale_workspace', 'Candidate is bound to a different workspace version.'),
    };
    if (result.output.category !== task.output.category || result.output.language !== task.output.language) {
      return invalid('Candidate output category or language differs from its task contract.');
    }
    if (task.policy.strategy === 'deterministic_only' && result.producer.strategy !== 'deterministic'
      || task.policy.strategy === 'learned_only' && result.producer.strategy !== 'learned') {
      return invalid('Candidate producer strategy is disallowed by supervisor policy.');
    }
    if (result.producer.strategy === 'deterministic' && task.family !== 'structured_specification') {
      return invalid('The deterministic compiler does not implement this task family.');
    }
    if (!task.constraints.allowedOperations.includes('replace_file')) return invalid('File replacement is not permitted by this task.');
    const replacement = result.output.category === 'operation' ? result.output.replacement : result.output.proposal.edits[0]!;
    const targetPath = task.family === 'structured_specification' ? task.input.path : task.input.targetPath;
    if (replacement.path !== targetPath || !task.constraints.allowedFiles.includes(replacement.path)) {
      return invalid('Candidate target is outside the exact allowed file scope.');
    }
    const source = task.context.files.find(file => file.path === replacement.path);
    if (!source || replacement.expectedHash !== source.hash) return {
      ok: false, result: executionFailure(task.taskId, 'stale_workspace', 'Candidate expected hash differs from its supplied source version.'),
    };
    if (task.family === 'structured_specification' && (replacement.path !== task.input.path
      || replacement.expectedHash !== task.input.expectedHash || replacement.content !== task.input.content)) {
      return invalid('A structured operation must preserve the exact supplied replacement specification.');
    }
    return { ok: true, result };
  }

  checkEligibility(
    rawCandidate: unknown, rawTask: unknown, rawSnapshot: unknown, countOutputTokens: ExecutionOutputTokenCounter,
  ): ExecutionEligibilityResult {
    const contract = this.contracts.validate(rawTask);
    if (!contract.ok) return contract;
    const task = contract.task;
    const structural = this.validateStructure(rawCandidate, task, countOutputTokens);
    if (!structural.ok) return structural;
    if (structural.result.kind !== 'candidate') return {
      ok: false,
      result: structural.result,
    };
    const candidate = structural.result;
    if (boundedJsonBytes(rawSnapshot) === null) return {
      ok: false, result: executionFailure(task.taskId, 'invalid_task_state', 'Supervisor eligibility snapshot is not bounded JSON.'),
    };
    const parsed = ExecutionEligibilitySnapshotSchema.safeParse(rawSnapshot);
    if (!parsed.success) return {
      ok: false,
      result: executionFailure(task.taskId, 'invalid_task_state', 'Supervisor eligibility snapshot is invalid.', schemaIssues(parsed.error.issues)),
    };
    const snapshot = parsed.data;
    if (snapshot.taskId !== task.taskId) return {
      ok: false, result: executionFailure(task.taskId, 'invalid_task_state', 'Supervisor snapshot belongs to another task.'),
    };
    if (!sameWorkspace(snapshot.workspace, task.workspace)) return {
      ok: false, result: executionFailure(task.taskId, 'stale_workspace', 'Current workspace differs from the contract and candidate.'),
    };
    if (snapshot.cancellationRequested || snapshot.status === 'cancelled') return {
      ok: false, result: executionFailure(task.taskId, 'cancelled', 'Supervisor reports cancellation of the task.'),
    };
    if (snapshot.status !== 'running') return {
      ok: false, result: executionFailure(task.taskId, 'invalid_task_state', 'Only a currently running task can be considered for dispatch.'),
    };
    if (snapshot.attemptsUsed >= task.budget.maxAttempts) return {
      ok: false, result: executionFailure(task.taskId, 'budget_exhausted', 'The generation attempt did not begin within the permitted attempt budget.'),
    };
    if (task.constraints.architecture.status !== 'fixed') return {
      ok: false, result: executionFailure(task.taskId, 'escalation_required', 'The cognitive supervisor must resolve architectural decisions.'),
    };
    if (!unique(snapshot.availableCapabilities.map(capability => capability.id)) || !unique(snapshot.availableTools)) return {
      ok: false, result: executionFailure(task.taskId, 'capability_unavailable', 'Supervisor capability inventory contains ambiguous duplicate entries.'),
    };
    const capabilities = new Map(snapshot.availableCapabilities.map(capability => [capability.id, capability]));
    const requiredScopes = new Set(task.constraints.requiredScopes);
    for (const id of task.constraints.requiredCapabilities) {
      const capability = capabilities.get(id);
      if (!capability || capability.status !== 'active') return {
        ok: false, result: executionFailure(task.taskId, 'capability_unavailable', 'A required capability is unavailable or inactive.'),
      };
      // Required scopes from the actual registry cannot be removed by underdeclaring the task.
      for (const scope of capability.requiredScopes) requiredScopes.add(scope);
    }
    if (task.constraints.requiredTools.some(tool => !snapshot.availableTools.includes(tool))) return {
      ok: false, result: executionFailure(task.taskId, 'capability_unavailable', 'A required Tool Gateway adapter is unavailable.'),
    };
    const permission = snapshot.permission;
    if (permission.taskId !== task.taskId || !sameWorkspace(permission.workspace, task.workspace)) return {
      ok: false, result: executionFailure(task.taskId, 'permission_required', 'Permission observation is not bound to this exact task and workspace.'),
    };
    if (permission.state !== 'granted') return {
      ok: false, result: executionFailure(task.taskId, 'permission_required', 'The existing supervisor and Tool Gateway have not granted the required permission.'),
    };
    let now: number;
    try { now = this.now(); }
    catch { return { ok: false, result: executionFailure(task.taskId, 'permission_required', 'Current permission validity cannot be established.') }; }
    const checkedAt = Date.parse(permission.checkedAt), expiresAt = Date.parse(permission.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(checkedAt) || !Number.isFinite(expiresAt)
      || checkedAt > now || expiresAt <= now || expiresAt <= checkedAt
      || !unique(permission.scopes) || !unique(permission.tools) || !unique(permission.files)
      || [...requiredScopes].some(scope => !permission.scopes.includes(scope))
      || task.constraints.requiredTools.some(tool => !permission.tools.includes(tool))
      || task.constraints.allowedFiles.some(path => !permission.files.includes(path))) return {
      ok: false, result: executionFailure(task.taskId, 'permission_required', 'Current scoped permission does not cover all task and registry requirements.'),
    };
    return { ok: true, kind: 'eligible_for_supervisor_dispatch', candidate, executionAllowed: false, semanticVerification: 'required' };
  }
}

/** Opaque references to independently persisted evidence, supplied by the host verifier. */
export interface ExecutionVerificationEvidenceReference {
  reference: string;
  criterionId: ExecutionTaskContract['acceptanceCriteria'][number]['id'];
  description: string;
}

export interface ExecutionSemanticVerificationResult {
  taskId: string;
  workspace: WorkspaceVersionReference;
  outcome: 'passed' | 'failed' | 'inconclusive';
  evidence: readonly ExecutionVerificationEvidenceReference[];
  unmetCriterionIds: readonly string[];
}

/** Implement only in trusted supervisor integration using existing independent verification.
 * No adapter/model result can implement or substitute this authority, and passing it does not dispatch tools.
 */
export interface ExecutionSemanticVerifier {
  verify(input: {
    candidate: ExecutionCandidate;
    task: ExecutionTaskContract;
    signal: AbortSignal;
    assertActive(): Promise<void>;
  }): Promise<ExecutionSemanticVerificationResult>;
}
