import { z } from 'zod';
import { CapabilitySchema, SkillToolIdSchema } from '@mohassan/contracts';
import { boundedJsonBytes, executionFailure, schemaIssues, unsupportedExecution, type ExecutionOutputTokenCounter } from './boundaries.ts';
import { DeterministicExecutionCompiler } from './compiler.ts';
import { ExecutionContractValidator } from './contract-validator.ts';
import {
  ExecutionModelCapabilitiesSchema, type ExecutionCandidate, type ExecutionFailure, type ExecutionModelIdentity,
  type ExecutionTaskContract, type MissingContextRequest, type UnsupportedExecutionResult,
} from './schemas.ts';

export const ExecutionRoutingContextSchema = z.object({
  availableCapabilities: z.array(CapabilitySchema.strict()).max(64),
  availableTools: z.array(SkillToolIdSchema).max(12),
  /** Consumed generation attempts BEFORE this invocation; never an automatic retry instruction. */
  attemptsUsed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  learned: ExecutionModelCapabilitiesSchema.optional(),
}).strict();
export type ExecutionRoutingContext = z.infer<typeof ExecutionRoutingContextSchema>;
export type ExecutionRoutingDecision =
  | { kind: 'selected'; strategy: 'deterministic'; task: ExecutionTaskContract; candidate: ExecutionCandidate; executionAllowed: false }
  | { kind: 'selected'; strategy: 'learned'; task: ExecutionTaskContract; model: ExecutionModelIdentity; executionAllowed: false }
  | { kind: 'unsupported'; strategy: 'unsupported'; result: UnsupportedExecutionResult }
  | ExecutionFailure | MissingContextRequest;

/** Pure selection over supervisor-supplied facts; no discovery, provider fallback, permissions, or dispatch. */
export class ExecutionStrategyRouter {
  private readonly compiler = new DeterministicExecutionCompiler();

  route(rawTask: unknown, rawContext: unknown, countOutputTokens: ExecutionOutputTokenCounter): ExecutionRoutingDecision {
    const validation = new ExecutionContractValidator().validate(rawTask);
    if (!validation.ok) return validation.result.kind === 'unsupported'
      ? { kind: 'unsupported', strategy: 'unsupported', result: validation.result } : validation.result;
    const task = validation.task;
    const unsupported = (reason: string): ExecutionRoutingDecision => ({ kind: 'unsupported', strategy: 'unsupported', result: unsupportedExecution(task, reason) });
    if (task.constraints.architecture.status !== 'fixed') return executionFailure(task.taskId, 'escalation_required', 'The cognitive supervisor must resolve architectural decisions before execution routing.');
    if (boundedJsonBytes(rawContext, 131_072) === null) return executionFailure(task.taskId, 'invalid_contract', 'Routing context must be bounded supervisor-supplied JSON.');
    const parsed = ExecutionRoutingContextSchema.safeParse(rawContext);
    if (!parsed.success) return executionFailure(task.taskId, 'invalid_contract', 'Routing context is invalid.', schemaIssues(parsed.error.issues));
    const context = parsed.data;
    if (new Set(context.availableCapabilities.map(value => value.id)).size !== context.availableCapabilities.length
      || new Set(context.availableTools).size !== context.availableTools.length) return executionFailure(task.taskId, 'invalid_contract', 'Capability and tool registries must not contain duplicate identities.');
    if (context.attemptsUsed >= task.budget.maxAttempts) return executionFailure(task.taskId, 'budget_exhausted', 'Generation budget is exhausted; supervisor reassessment is required.');
    if (task.constraints.requiredCapabilities.some(id => !context.availableCapabilities.some(capability => capability.id === id && capability.status === 'active'))
      || task.constraints.requiredTools.some(id => !context.availableTools.includes(id))) return executionFailure(task.taskId, 'capability_unavailable', 'Required existing capabilities or Tool Gateway adapters are unavailable.');
    if (task.policy.strategy !== 'learned_only' && this.compiler.supports(task)) {
      const compiled = this.compiler.compile(task, { attemptsUsed: context.attemptsUsed, countOutputTokens });
      // An applicable compiler failure is surfaced, never hidden by a learned/provider fallback.
      if (compiled.kind !== 'candidate') return compiled.kind === 'unsupported'
        ? { kind: 'unsupported', strategy: 'unsupported', result: compiled } : compiled;
      return { kind: 'selected', strategy: 'deterministic', task, candidate: compiled, executionAllowed: false };
    }
    if (task.policy.strategy === 'deterministic_only') return unsupported('The deterministic-only policy has no matching registered transformation.');
    const advertised = context.learned;
    if (!advertised) return unsupported('No local learned executor has advertised capabilities.');
    const supported = advertised.tasks.some(entry => entry.family === task.family && entry.category === task.operation.category
      && entry.operation === task.operation.name && entry.outputCategory === task.output.category
      && entry.outputLanguage === task.output.language && entry.responseLanguages.includes(task.output.responseLanguage));
    if (!supported) return unsupported('The local learned executor does not advertise this exact task and output contract.');
    const inputBytes = boundedJsonBytes(task);
    if (inputBytes === null || inputBytes > advertised.limits.maxInputBytes || task.budget.outputTokens > advertised.limits.maxOutputTokens
      || task.budget.timeoutMs > advertised.limits.maxTimeoutMs) return executionFailure(task.taskId, 'budget_exhausted', 'Requested execution limits exceed the advertised local executor limits.');
    return { kind: 'selected', strategy: 'learned', task, model: advertised.model, executionAllowed: false };
  }
}
