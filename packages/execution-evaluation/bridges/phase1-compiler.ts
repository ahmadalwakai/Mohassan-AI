/** Source-only bridge. No transport, worker, model, file mutation or execution is started. */
import {
  DETERMINISTIC_EXECUTION_REGISTRY,
  DeterministicExecutionCompiler,
} from '../../cognitive/src/execution-model/compiler.ts';
import {
  ExecutionContextSchema,
  ExecutionTaskContractSchema,
  WorkspaceVersionReferenceSchema,
  type ExecutionResult,
  type ExecutionTaskContract,
} from '../../cognitive/src/execution-model/schemas.ts';
import {
  boundedJsonBytes,
  sameWorkspace,
  type ExecutionOutputTokenCounter,
} from '../../cognitive/src/execution-model/boundaries.ts';

export const PHASE1_EVALUATION_BRIDGE_VERSION = 'phase1-evaluation-compiler-bridge-v1';

export interface Phase1EvaluationBridgeOptions {
  /** Trusted supervisor counter over the complete serialized candidate envelope. */
  countOutputTokens: ExecutionOutputTokenCounter;
  /** Cancellation is owned by the evaluation supervisor. */
  signal?: AbortSignal;
}

/** JSON-compatible CandidateOutput from the Python evaluation package. */
export interface Phase1EvaluationCandidate {
  status: 'candidate' | 'unsupported' | 'missing_context' | 'unavailable' | 'error';
  content: null;
  output_language: string | null;
  mutations: { path: string; content: string; operation: 'write'; base_hash: string }[];
  operations: [];
  workspace_version: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;
type Preparation =
  | { ok: true; contract: ExecutionTaskContract; attemptsUsed: number; outputTokens: number }
  | { ok: false; result: Phase1EvaluationCandidate };

const publicTaskKeys = new Set([
  'schema_version', 'task_id', 'task_family', 'project_family', 'template_family',
  'input_specification', 'available_context', 'allowed_symbols', 'required_capabilities',
  'allowed_execution_budget', 'expected_output_language', 'safety_constraints', 'dataset_version', 'tier',
]);
const requestKeys = new Set(['task', 'budget', 'attempt', 'seed', 'prior_candidate']);
const privateKeys = new Set(['hidden_test_ref', 'expected_behavior', 'acceptance_criteria', 'expected_response']);
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const sameStrings = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

function response(status: Phase1EvaluationCandidate['status'], reason: string, metadata: Record<string, unknown> = {}): Phase1EvaluationCandidate {
  return { status, content: null, output_language: null, mutations: [], operations: [],
    workspace_version: null, reason, metadata: { bridge_version: PHASE1_EVALUATION_BRIDGE_VERSION, ...metadata } };
}

function includesPrivateKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(includesPrivateKeys);
  if (!object(value)) return false;
  return Object.entries(value).some(([key, child]) => privateKeys.has(key) || includesPrivateKeys(child));
}

function prepare(raw: unknown): Preparation {
  // Reuse Phase 1's bounded plain-data guard before traversal. This is a data
  // boundary, not a sandbox for hostile JS proxies; transports must decode JSON.
  if (boundedJsonBytes(raw) === null || !object(raw) || Object.keys(raw).some(key => !requestKeys.has(key))
      || !object(raw.task) || Object.keys(raw.task).some(key => !publicTaskKeys.has(key)) || includesPrivateKeys(raw)) {
    return { ok: false, result: response('error', 'INVALID_OR_PRIVATE_EVALUATION_REQUEST') };
  }
  const task = raw.task;
  if (task.schema_version !== 'execution-evaluation-task-v1' || typeof task.task_id !== 'string'
      || !object(task.input_specification) || !object(task.available_context) || !object(task.safety_constraints)
      || !strings(task.allowed_symbols) || !strings(task.required_capabilities)
      || !object(task.allowed_execution_budget) || !object(raw.budget)
      || !positive(raw.attempt) || typeof raw.seed !== 'number' || !Number.isSafeInteger(raw.seed) || raw.seed < 0) {
    return { ok: false, result: response('error', 'INVALID_PUBLIC_TASK_OR_BUDGET') };
  }
  if (task.task_family !== 'A') {
    return { ok: false, result: response('unsupported', 'NO_PHASE1_DETERMINISTIC_FAMILY_SUPPORT') };
  }
  const budget = raw.budget, original = task.allowed_execution_budget, allowedSymbols = task.allowed_symbols;
  if (!positive(budget.time_ms) || !positive(budget.output_tokens) || !positive(budget.max_attempts)
      || !positive(original.time_ms) || !positive(original.output_tokens) || !positive(original.max_attempts)
      || budget.time_ms > original.time_ms || budget.output_tokens > original.output_tokens
      || budget.max_attempts !== original.max_attempts || raw.attempt > budget.max_attempts
      || budget.external_calls !== 0 || budget.external_tokens !== 0
      || original.external_calls !== 0 || original.external_tokens !== 0) {
    return { ok: false, result: response('error', 'INVALID_OR_NONLOCAL_EXECUTION_BUDGET') };
  }
  if (original.time_ms > 120_000 || original.output_tokens > 16_384 || original.max_attempts > 3) {
    return { ok: false, result: response('unsupported', 'PUBLIC_BUDGET_EXCEEDS_PHASE1_LIMITS') };
  }
  const parsed = ExecutionTaskContractSchema.safeParse(task.input_specification.phase1_contract);
  if (!parsed.success) return { ok: false, result: response('error', 'PHASE1_PUBLIC_CONTRACT_INVALID') };
  const contract = parsed.data;
  const context = ExecutionContextSchema.safeParse(task.available_context.phase1_context);
  const workspace = WorkspaceVersionReferenceSchema.safeParse(task.available_context.phase1_workspace);
  if (!context.success || !workspace.success) {
    return { ok: false, result: response('missing_context', 'PHASE1_PUBLIC_CONTEXT_MAPPING_MISSING') };
  }
  if (contract.taskId !== task.task_id || contract.family !== 'structured_specification'
      || contract.output.language !== task.expected_output_language
      || JSON.stringify(contract.context) !== JSON.stringify(context.data)
      || !sameWorkspace(contract.workspace, workspace.data)
      || contract.budget.timeoutMs !== original.time_ms || contract.budget.outputTokens !== original.output_tokens
      || contract.budget.maxAttempts !== original.max_attempts
      || !sameStrings(contract.constraints.requiredCapabilities, task.required_capabilities)
      || contract.context.symbols.some(symbol => !allowedSymbols.includes(symbol.name))
      || !strings(task.safety_constraints.allowed_write_paths)
      || !strings(task.safety_constraints.allowed_tools)
      || !sameStrings(contract.constraints.allowedFiles, task.safety_constraints.allowed_write_paths)
      || !sameStrings(contract.constraints.requiredTools, task.safety_constraints.allowed_tools)) {
    return { ok: false, result: response('error', 'PHASE1_PUBLIC_CONDITIONS_MISMATCH') };
  }
  // Only the remaining supervisor budget is translated. The actual compiler still
  // owns contract validation, supported transformations and candidate generation.
  return { ok: true, contract: { ...contract, budget: {
    timeoutMs: budget.time_ms, outputTokens: budget.output_tokens, maxAttempts: budget.max_attempts,
  } }, attemptsUsed: raw.attempt - 1, outputTokens: budget.output_tokens };
}

export function supportsPhase1EvaluationRequest(raw: unknown): boolean {
  try {
    // Support is solely the actual compiler's registered operation predicate.
    // Context/budget/identity failures are classified by compile, not disguised as
    // an unsupported transformation merely because prerequisites are incomplete.
    if (boundedJsonBytes(raw) === null || !object(raw) || includesPrivateKeys(raw)
        || !object(raw.task) || raw.task.task_family !== 'A' || !object(raw.task.input_specification)) return false;
    const parsed = ExecutionTaskContractSchema.safeParse(raw.task.input_specification.phase1_contract);
    return parsed.success && new DeterministicExecutionCompiler().supports(parsed.data);
  } catch {
    return false;
  }
}

function translate(result: ExecutionResult): Phase1EvaluationCandidate {
  if (result.kind === 'unsupported') return response('unsupported', result.reason, { phase1_kind: result.kind });
  if (result.kind === 'missing_context') return response('missing_context', 'PHASE1_MISSING_CONTEXT', { phase1_kind: result.kind, missing: result.missing });
  if (result.kind === 'failure') return response('error', result.code, { phase1_kind: result.kind });
  if (result.output.category !== 'operation' || result.producer.strategy !== 'deterministic') {
    return response('error', 'UNEXPECTED_PHASE1_DETERMINISTIC_OUTPUT');
  }
  const replacement = result.output.replacement;
  // Envelope conversion only: copy the actual compiler result, never reconstruct
  // a replacement from raw inputs or execute a proposed write.
  return { status: 'candidate', content: null, output_language: result.output.language,
    mutations: [{ path: replacement.path, content: replacement.content, operation: 'write', base_hash: replacement.expectedHash }],
    operations: [], workspace_version: result.workspace.snapshotHash, reason: null,
    metadata: { bridge_version: PHASE1_EVALUATION_BRIDGE_VERSION, phase1_kind: result.kind,
      producer: result.producer, phase1_verification: result.verification, execution_allowed: result.executionAllowed } };
}

export function compilePhase1EvaluationRequest(raw: unknown, options: Phase1EvaluationBridgeOptions): Phase1EvaluationCandidate {
  const startedAt = performance.now();
  if (typeof options?.countOutputTokens !== 'function') return response('unavailable', 'TRUSTED_OUTPUT_TOKEN_COUNTER_REQUIRED');
  if (options.signal?.aborted) return response('error', 'cancelled');
  try {
    const prepared = prepare(raw);
    if (!prepared.ok) return prepared.result;
    const result = new DeterministicExecutionCompiler().compile(prepared.contract, {
      attemptsUsed: prepared.attemptsUsed, countOutputTokens: options.countOutputTokens, signal: options.signal,
    });
    const translated = translate(result);
    const tokens = options.countOutputTokens(JSON.stringify(translated));
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > prepared.outputTokens) {
      return response('error', 'TRANSLATED_RESULT_OUTPUT_BUDGET_EXCEEDED');
    }
    if (options.signal?.aborted) return response('error', 'cancelled');
    if (performance.now() - startedAt >= prepared.contract.budget.timeoutMs) return response('error', 'timeout');
    return translated;
  } catch {
    // Arbitrary diagnostics can contain task content. Emit a stable reason only.
    return response('error', 'PHASE1_BRIDGE_FAILURE');
  }
}

export const phase1EvaluationBridgeDescriptor = Object.freeze({
  adapter_id: PHASE1_EVALUATION_BRIDGE_VERSION,
  compiler_version: '1',
  supported_transformations: Object.freeze(DETERMINISTIC_EXECUTION_REGISTRY.map(entry => entry.operation)),
  transport_status: 'pending_explicit_python_binding',
  executes_candidates: false,
});
