import { randomUUID } from 'node:crypto';
import type {
  ExecutionModelAdapter, ExecutionModelCallOptions, ExecutionModelSubmissionOptions,
} from '../../cognitive/src/execution-model/adapter.ts';
import type {
  ExecutionModelCapabilities, ExecutionModelIdentity, ExecutionResult, ExecutionTaskContract,
} from '../../cognitive/src/execution-model/schemas.ts';
import { ModelTransportError, type ModelTransport, type TransportJson } from './transport.js';

/**
 * Bridges Phase 1's `ExecutionModelAdapter` to a Phase 5 `ModelTransport`.
 *
 * Phase 1 and Phase 5 were delivered with no code joining them. This maps:
 *   Phase 1 task contract  -> typed worker fields (never a free-form prompt)
 *   worker proposal text   -> Phase 1 `typescript_edit` candidate (verification: not_verified)
 * Supervisor-declared structured fields arrive in the documentation entry with id
 * `execution-spec`; failure evidence and the failed source come from the contract's
 * concrete evidence and file entries. The model never sees tools, paths or permissions.
 */
export const EXECUTION_SPEC_DOCUMENT_ID = 'execution-spec';
const CAPABILITY_BY_FAMILY = {
  typescript_implementation: 'typescript.implement.v1:null-safe-delta',
  local_code_repair: 'typescript.repair.v1:null-safe-delta',
} as const;

export interface Phase1AdapterOptions {
  transport: ModelTransport;
  model: ExecutionModelIdentity;
  responseLanguages: readonly string[];
  limits: ExecutionModelCapabilities['limits'];
}

function transportFailure(task: ExecutionTaskContract, error: unknown): ExecutionResult {
  const code = error instanceof ModelTransportError ? error.code : 'model_process_failure';
  const mapped = code === 'cancelled' ? 'cancelled' : code === 'timeout' ? 'timeout'
    : code === 'unsupported_capability' ? 'capability_unavailable' : code === 'invalid_model_output' ? 'invalid_model_output' : 'executor_failure';
  return { kind: 'failure', taskId: task.taskId, code: mapped, message: `Local execution model transport: ${code}.`,
    issues: [], retryable: false, executionAllowed: false };
}

export class TransportBackedExecutionModelAdapter implements ExecutionModelAdapter {
  private generationTokenLimit = 1;
  constructor(private readonly options: Phase1AdapterOptions) {}

  async discoverCapabilities(options: ExecutionModelCallOptions): Promise<ExecutionModelCapabilities> {
    const advertised = await this.options.transport.discover(options.signal);
    const tasks = (Object.entries(CAPABILITY_BY_FAMILY) as [keyof typeof CAPABILITY_BY_FAMILY, string][])
      .filter(([, capability]) => advertised.capabilities.includes(capability))
      .map(([family]) => family === 'typescript_implementation'
        ? { family, category: 'typescript' as const, operation: 'typescript.implement.v1', outputCategory: 'typescript_edit' as const,
            outputLanguage: 'typescript' as const, responseLanguages: [...this.options.responseLanguages] }
        : { family, category: 'code_repair' as const, operation: 'typescript.repair.v1', outputCategory: 'typescript_edit' as const,
            outputLanguage: 'typescript' as const, responseLanguages: [...this.options.responseLanguages] });
    // Two different limits: Phase 1 `maxOutputTokens` bounds the serialized candidate
    // envelope (measured by the host counter); the worker's advertised limit bounds
    // newly generated model tokens and is applied per submission below.
    this.generationTokenLimit = advertised.maxOutputTokens;
    return { model: { ...this.options.model }, tasks, limits: { ...this.options.limits }, cancellation: 'abort_signal' };
  }

  async generateCandidate(task: Readonly<ExecutionTaskContract>, options: ExecutionModelSubmissionOptions): Promise<ExecutionResult> {
    if (task.family === 'structured_specification') {
      return { kind: 'unsupported', taskId: task.taskId, operation: task.operation.name, reason: 'Structured operations are compiled deterministically.',
        disposition: task.policy.unsupportedTask, executionAllowed: false };
    }
    const unsupported = (reason: string): ExecutionResult => ({ kind: 'unsupported', taskId: task.taskId, operation: task.operation.name,
      reason, disposition: task.policy.unsupportedTask, executionAllowed: false });
    const spec = task.context.documentation.find(entry => entry.id === EXECUTION_SPEC_DOCUMENT_ID);
    if (!spec) return { kind: 'missing_context', taskId: task.taskId, disposition: task.policy.missingContext, executionAllowed: false,
      missing: [{ kind: 'documentation', reference: EXECUTION_SPEC_DOCUMENT_ID, reason: 'The supervisor must supply the structured execution specification.' }] };
    let declared: unknown;
    try { declared = JSON.parse(spec.excerpt); } catch { return unsupported('Execution specification is not JSON.'); }
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return unsupported('Execution specification is not an object.');
    const { function_name: functionName, increment, failure_category: failureCategory } = declared as Record<string, unknown>;
    const fields: Record<string, TransportJson> = { function_name: functionName as TransportJson, increment: increment as TransportJson };
    const target = task.input.targetPath;
    const file = task.context.files.find(entry => entry.path === target)!; // contract validator guarantees presence
    if (task.family === 'local_code_repair') {
      const evidence = task.input.evidenceIds.map(id => task.context.evidence.find(entry => entry.id === id)!.details);
      Object.assign(fields, { failed_candidate: file.content, failure_evidence: evidence.slice(0, 2), failure_category: failureCategory as TransportJson });
    }
    let response;
    try {
      response = await this.options.transport.submit({ requestId: randomUUID(), taskId: task.taskId, capability: CAPABILITY_BY_FAMILY[task.family],
        contract: { fields }, context: null, maxOutputTokens: Math.min(task.budget.outputTokens, this.generationTokenLimit) }, options.signal);
    } catch (error) { return transportFailure(task as ExecutionTaskContract, error); }
    if (response.status === 'unsupported') return unsupported('The local model does not support these fields.');
    if (response.status === 'missing_context') return { kind: 'missing_context', taskId: task.taskId, disposition: task.policy.missingContext,
      executionAllowed: false, missing: response.missingContextKeys.map(key => ({ kind: 'documentation' as const, reference: key, reason: 'Requested by the local model.' })) };
    const proposal = response.proposal as { text?: unknown } | null;
    if (!proposal || typeof proposal.text !== 'string') return { kind: 'failure', taskId: task.taskId, code: 'invalid_model_output',
      message: 'Local model proposal has no text.', issues: [], retryable: false, executionAllowed: false };
    return {
      kind: 'candidate', taskId: task.taskId, workspace: { ...task.workspace },
      producer: { strategy: 'learned', model: { ...this.options.model } },
      output: { category: 'typescript_edit', language: 'typescript', proposal: {
        summary: task.family === 'local_code_repair' ? 'Local model repair candidate.' : 'Local model implementation candidate.',
        edits: [{ path: target, expectedHash: file.hash, content: proposal.text }] } },
      verification: 'not_verified', executionAllowed: false,
    };
  }
}
