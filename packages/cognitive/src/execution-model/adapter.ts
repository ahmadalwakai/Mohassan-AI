import { boundedJsonBytes, executionFailure, schemaIssues, type ExecutionOutputTokenCounter } from './boundaries.ts';
import { ExecutionContractValidator } from './contract-validator.ts';
import { ExecutionResultValidator } from './result-validator.ts';
import { ExecutionStrategyRouter, ExecutionRoutingContextSchema } from './router.ts';
import {
  ExecutionModelCapabilitiesSchema, type ExecutionModelCapabilities, type ExecutionModelIdentity,
  type ExecutionResult, type ExecutionTaskContract,
} from './schemas.ts';

export interface ExecutionModelCallOptions {
  signal: AbortSignal;
  /** Remaining wall-clock allowance, including transport and generation. */
  timeoutMs: number;
  deadlineAt: number;
}
export interface ExecutionModelSubmissionOptions extends ExecutionModelCallOptions {
  /** Supervisor-reserved, one-based generation ordinal. No adapter-level retry loop is permitted. */
  attempt: number;
}

/**
 * Implemented by a future local, randomly initialized model runtime.
 * No tools, workspace handles, approval objects, provider fallback or verifier are supplied.
 * Identity/provenance is a deployment attestation, not something this interface can prove.
 * Implementations must propagate abort/deadline to their underlying local transport/worker,
 * perform at most one generation, and classify failures using ExecutionResult.
 */
export interface ExecutionModelAdapter {
  discoverCapabilities(options: ExecutionModelCallOptions): Promise<ExecutionModelCapabilities>;
  generateCandidate(task: Readonly<ExecutionTaskContract>, options: ExecutionModelSubmissionOptions): Promise<ExecutionResult>;
}

export interface ExecutionModelInvocationOptions {
  signal?: AbortSignal;
  countOutputTokens: ExecutionOutputTokenCounter;
}

function sameModel(left: ExecutionModelIdentity, right: ExecutionModelIdentity): boolean {
  return left.id === right.id && left.version === right.version && left.artifactHash === right.artifactHash
    && left.initialization === right.initialization && left.locality === right.locality;
}

const ABORTED = Symbol('execution-model-aborted');

/**
 * One bounded candidate-generation invocation. A selected deterministic route returns its
 * already-validated candidate without touching the adapter. Nothing here dispatches tools.
 * The host must reserve attempts atomically and recheck live authority before applying output.
 */
export async function submitExecutionModelTask(
  adapter: ExecutionModelAdapter,
  rawTask: unknown,
  rawRoutingContext: unknown,
  options: ExecutionModelInvocationOptions,
): Promise<ExecutionResult> {
  const startedAt = performance.now();
  const validation = new ExecutionContractValidator().validate(rawTask);
  if (!validation.ok) return validation.result;
  const task = validation.task;
  if (options.signal?.aborted) return executionFailure(task.taskId, 'cancelled', 'Candidate generation was cancelled.');
  const route = new ExecutionStrategyRouter().route(task, rawRoutingContext, options.countOutputTokens);
  if (options.signal?.aborted) return executionFailure(task.taskId, 'cancelled', 'Candidate generation was cancelled.');
  if (performance.now() - startedAt >= task.budget.timeoutMs) return executionFailure(task.taskId, 'timeout', 'Execution deadline expired during routing.');
  if (route.kind === 'unsupported') return route.result;
  if (route.kind !== 'selected') return route;
  if (route.strategy === 'deterministic') return route.candidate;
  // The router validated the exact same bounded input; parse again for an independent copy.
  const routingContext = ExecutionRoutingContextSchema.parse(rawRoutingContext);
  const controller = new AbortController();
  let timedOut = false;
  const remaining = () => Math.max(0, task.budget.timeoutMs - (performance.now() - startedAt));
  if (remaining() <= 0) return executionFailure(task.taskId, 'timeout', 'Execution deadline expired during routing.');
  const deadlineAt = Date.now() + remaining();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remaining());
  let removeAbortListener = () => {};
  const aborted = new Promise<typeof ABORTED>(resolve => {
    const onAbort = () => resolve(ABORTED);
    if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
  });
  const stopped = () => executionFailure(task.taskId, options.signal?.aborted ? 'cancelled' : 'timeout',
    options.signal?.aborted ? 'Candidate generation was cancelled.' : 'Local execution model exceeded its deadline.');
  const callOptions = (): ExecutionModelCallOptions => ({ signal: controller.signal, timeoutMs: Math.max(1, Math.floor(remaining())), deadlineAt });
  async function boundedCall<T>(call: () => Promise<T>): Promise<T | typeof ABORTED> {
    if (controller.signal.aborted || remaining() <= 0) return ABORTED;
    // Promise.race attaches a rejection handler even when an uncooperative adapter settles late.
    const operation: Promise<T | typeof ABORTED> = Promise.resolve().then(async (): Promise<T | typeof ABORTED> => {
      if (controller.signal.aborted || remaining() <= 0) return ABORTED;
      return await call();
    });
    return Promise.race([operation, aborted]);
  }
  try {
    const rawCapabilities = await boundedCall(() => adapter.discoverCapabilities(callOptions()));
    if (rawCapabilities === ABORTED || controller.signal.aborted || remaining() <= 0) return stopped();
    if (boundedJsonBytes(rawCapabilities, 65_536) === null) return executionFailure(task.taskId, 'executor_failure', 'Local model capability discovery returned invalid data.');
    const capabilities = ExecutionModelCapabilitiesSchema.safeParse(rawCapabilities);
    if (!capabilities.success) return executionFailure(task.taskId, 'executor_failure', 'Local model capability discovery violated its schema.', schemaIssues(capabilities.error.issues));
    if (!sameModel(route.model, capabilities.data.model)) return executionFailure(task.taskId, 'executor_failure', 'Local model identity changed after strategy selection.');
    const refreshed = new ExecutionStrategyRouter().route(task, { ...routingContext, learned: capabilities.data }, options.countOutputTokens);
    if (refreshed.kind === 'unsupported') return refreshed.result;
    if (refreshed.kind !== 'selected') return refreshed;
    if (refreshed.strategy !== 'learned') return executionFailure(task.taskId, 'executor_failure', 'Learned strategy selection changed during discovery.');
    // An in-process adapter may mutate its argument. Never give it the validator's authoritative copy.
    const rawResult = await boundedCall(() => adapter.generateCandidate(structuredClone(task), {
      ...callOptions(), attempt: routingContext.attemptsUsed + 1,
    }));
    if (rawResult === ABORTED || controller.signal.aborted || remaining() <= 0) return stopped();
    const checked = new ExecutionResultValidator().validateStructure(rawResult, task, options.countOutputTokens);
    if (controller.signal.aborted || remaining() <= 0) return stopped();
    if (!checked.ok) return checked.result;
    if (checked.result.kind === 'candidate' && (checked.result.producer.strategy !== 'learned'
      || !sameModel(checked.result.producer.model, route.model))) return executionFailure(task.taskId, 'invalid_model_output', 'Candidate producer does not match the selected local model artifact.');
    return checked.result;
  } catch {
    return controller.signal.aborted || timedOut || remaining() <= 0 ? stopped()
      : executionFailure(task.taskId, 'executor_failure', 'Local execution adapter failed; the supervisor must diagnose the failure.');
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    options.signal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}
