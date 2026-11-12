import { z } from 'zod';
import { ExecutionContractValidator } from './contract-validator.ts';
import { executionFailure, unsupportedExecution, type ExecutionOutputTokenCounter } from './boundaries.ts';
import { ExecutionResultValidator } from './result-validator.ts';
import { FileReplacementSchema, type ExecutionCandidate, type ExecutionResult, type ExecutionTaskContract } from './schemas.ts';

export const DETERMINISTIC_EXECUTION_REGISTRY = Object.freeze([
  Object.freeze({ operation: 'structured.replace-file.v1', family: 'structured_specification',
    category: 'structured', outputCategory: 'operation', inputSchema: FileReplacementSchema }),
] as const);

export interface DeterministicCompilationOptions {
  /** Number of candidate-generation attempts already consumed, before this invocation. */
  attemptsUsed: number;
  countOutputTokens: ExecutionOutputTokenCounter;
  signal?: AbortSignal;
}

/** Pure compilation: validates and wraps the supplied replacement, without reading or applying it. */
export class DeterministicExecutionCompiler {
  readonly registry = DETERMINISTIC_EXECUTION_REGISTRY;

  supports(task: ExecutionTaskContract): boolean {
    return this.registry.some(entry => entry.operation === task.operation.name && entry.family === task.family
      && entry.category === task.operation.category && entry.outputCategory === task.output.category
      && entry.inputSchema.safeParse(task.input).success);
  }

  compile(raw: unknown, options: DeterministicCompilationOptions): ExecutionResult {
    const startedAt = performance.now();
    const validation = new ExecutionContractValidator().validate(raw);
    if (!validation.ok) return validation.result;
    const task = validation.task;
    if (options.signal?.aborted) return executionFailure(task.taskId, 'cancelled', 'Candidate generation was cancelled.');
    if (!z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).safeParse(options.attemptsUsed).success) return executionFailure(task.taskId, 'invalid_contract', 'Attempt accounting must be supplied by the supervisor.');
    if (options.attemptsUsed >= task.budget.maxAttempts) return executionFailure(task.taskId, 'budget_exhausted', 'The supervisor must reassess the task before another generation attempt.');
    if (task.constraints.architecture.status !== 'fixed') return executionFailure(task.taskId, 'escalation_required', 'Architectural decisions must be resolved by the cognitive supervisor.');
    if (task.policy.strategy === 'learned_only') return unsupportedExecution(task, 'Execution policy excludes deterministic compilation.');
    if (!this.supports(task) || task.family !== 'structured_specification') return unsupportedExecution(task, 'No deterministic transformation is registered for this task.');
    const replacement = FileReplacementSchema.parse(task.input);
    const candidate: ExecutionCandidate = {
      kind: 'candidate', taskId: task.taskId, workspace: task.workspace,
      producer: { strategy: 'deterministic', compilerVersion: '1' },
      output: { category: 'operation', language: 'typescript', operation: 'replace_file', replacement },
      verification: 'not_verified', executionAllowed: false,
    };
    const checked = new ExecutionResultValidator().validateStructure(candidate, task, options.countOutputTokens);
    if (options.signal?.aborted) return executionFailure(task.taskId, 'cancelled', 'Candidate generation was cancelled.');
    if (performance.now() - startedAt >= task.budget.timeoutMs) return executionFailure(task.taskId, 'timeout', 'Deterministic compilation exceeded its deadline.');
    return checked.result;
  }
}
