import { randomUUID } from 'node:crypto';
import type { BoundaryResult, LearnedExecutorAdapter, ModelReference, SupervisorEnvelope, ValidatedContract } from './contracts.js';
import { ModelLifecycleCoordinator, ModelLifecycleError, type ActiveModelReference } from './lifecycle.js';
import { LOCAL_MODEL_PROTOCOL, ModelTransportError, type ModelCapabilities, type ModelIdentity, type ModelTransport, type TransportJson } from './transport.js';
import { boundedJson, fail, freeze, IntegrationError, same } from './safety.js';

/** Necessary mapping for Phase 1 semantics and Phase 2 token/byte payloads. No guessed task grammar. */
export interface StructuredModelCodec {
  authorizeTaskScope(envelope: SupervisorEnvelope, scopeId: string, signal: AbortSignal): Promise<boolean>;
  encode(envelope: SupervisorEnvelope, contract: ValidatedContract, signal: AbortSignal): Promise<{
    capability: string; contract: TransportJson; context: TransportJson;
  }>;
  decode(proposal: TransportJson, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<unknown>;
}
export interface ApprovedModelTransportFactory {
  /** Resolve local checkpoint/tokenizer bytes and verify all SHA-256 values BEFORE any launch.
   * Returned transport must remain pinned to this exact reference for its lifetime. */
  forApprovedModel(reference: ActiveModelReference, signal: AbortSignal): Promise<ModelTransport>;
}
export interface LifecycleBoundModelOptions {
  scopeId: string; lifecycle: ModelLifecycleCoordinator; transports: ApprovedModelTransportFactory; codec: StructuredModelCodec;
}
function identity(value: ModelReference): ModelIdentity {
  return { modelId: value.modelId, tokenizerId: value.tokenizerId, checkpointId: value.checkpointId };
}
function normalize(error: unknown): never {
  if (error instanceof IntegrationError) throw error;
  if (error instanceof ModelTransportError) {
    const code = error.code;
    if (code === 'cancelled') throw new IntegrationError('cancellation');
    if (code === 'timeout' || code === 'resource_exhaustion' || code === 'isolation_unavailable'
      || code === 'unsupported_capability' || code === 'invalid_model_output' || code === 'model_process_failure') throw new IntegrationError(code);
    if (code === 'process_cleanup_failed') throw new IntegrationError('model_process_failure', 'possible');
    throw new IntegrationError('invalid_model_output');
  }
  if (error instanceof ModelLifecycleError) throw new IntegrationError(error.code === 'cancelled' ? 'cancellation'
    : error.code === 'permission_unavailable' ? 'permission_unavailable' : 'capability_unavailable');
  throw new IntegrationError('model_process_failure');
}
/** Selects ONLY an explicitly active, currently eligible lifecycle version; never activates one. */
export class LifecycleBoundModelAdapter implements LearnedExecutorAdapter {
  private current?: { reference: ActiveModelReference; transport: ModelTransport; capabilities: ModelCapabilities };
  constructor(private readonly options: LifecycleBoundModelOptions) {}
  async assertEligible(model: ModelReference, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<void> {
    try {
      const selected = this.current;
      if (!selected || !same(model, selected.reference)) fail('capability_unavailable');
      if (!await this.options.codec.authorizeTaskScope(envelope, this.options.scopeId, signal)) fail('permission_denial');
      if (!same(await this.options.lifecycle.selectActive(this.options.scopeId, signal), selected.reference)) fail('capability_unavailable');
      signal.throwIfAborted();
    } catch (error) { normalize(error); }
  }
  async discover(envelope: SupervisorEnvelope, signal: AbortSignal): Promise<{ model: ModelReference; capabilities: readonly string[] }> {
    try {
      if (!await this.options.codec.authorizeTaskScope(envelope, this.options.scopeId, signal)) fail('permission_denial');
      const reference = freeze(structuredClone(await this.options.lifecycle.selectActive(this.options.scopeId, signal)));
      const transport = await this.options.transports.forApprovedModel(reference, signal);
      const capabilities = freeze(boundedJson(await transport.discover(signal), 1024 * 1024) as unknown as ModelCapabilities);
      signal.throwIfAborted();
      if (capabilities.protocol !== LOCAL_MODEL_PROTOCOL || !same(capabilities.identity, identity(reference))) fail('invalid_model_output');
      this.current = { reference, transport, capabilities };
      return { model: reference, capabilities: capabilities.capabilities };
    } catch (error) { normalize(error); }
  }
  async generate(input: { envelope: SupervisorEnvelope; contract: ValidatedContract; model: ModelReference },
    signal: AbortSignal): Promise<BoundaryResult<unknown>> {
    try {
      const selected = this.current;
      if (!selected || !same(input.model, selected.reference)) fail('capability_unavailable');
      if (!await this.options.codec.authorizeTaskScope(input.envelope, this.options.scopeId, signal)) fail('permission_denial');
      const active = await this.options.lifecycle.selectActive(this.options.scopeId, signal);
      if (!same(active, selected.reference)) fail('capability_unavailable');
      const encoded = await this.options.codec.encode(input.envelope, input.contract, signal);
      if (!selected.capabilities.capabilities.includes(encoded.capability)) return { status: 'unsupported', evidenceRefs: [] };
      const safe = boundedJson(encoded, Math.min(input.envelope.budget.maxInputBytes, selected.capabilities.maxInputBytes)) as unknown as typeof encoded;
      const requestId = randomUUID();
      const response = await selected.transport.submit({ ...safe, requestId, taskId: input.envelope.taskId,
        maxOutputTokens: Math.min(input.envelope.budget.maxOutputTokens, selected.capabilities.maxOutputTokens) }, signal);
      signal.throwIfAborted();
      if (response.requestId !== requestId || response.taskId !== input.envelope.taskId
        || !same(response.identity, identity(selected.reference))) fail('invalid_model_output');
      // Revocation/rollback during generation invalidates even a well-formed response.
      if (!same(await this.options.lifecycle.selectActive(this.options.scopeId, signal), selected.reference)) fail('capability_unavailable');
      if (response.status === 'missing_context') return { status: 'missing_context', evidenceRefs: [] };
      if (response.status === 'unsupported') return { status: 'unsupported', evidenceRefs: [] };
      if (response.status !== 'candidate') fail('invalid_model_output');
      const decoded = await this.options.codec.decode(response.proposal, input.envelope, signal);
      return { status: 'ok', value: boundedJson(decoded, input.envelope.budget.maxCandidateBytes) };
    } catch (error) { normalize(error); }
  }
}
