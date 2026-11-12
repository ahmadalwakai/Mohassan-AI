import type { BoundaryResult, LearnedExecutorAdapter, ModelReference, PhaseOneAdapter,
  Strategy, SupervisorEnvelope, ValidatedContract } from './contracts.js';
import { boundedJson, fail, freeze, IntegrationError, textId } from './safety.js';

export function unwrapBoundary<T>(result: BoundaryResult<T>): T {
  if (result.status === 'ok') return result.value;
  const codes = { missing_context: 'missing_context', unsupported: 'unsupported_capability',
    stale: 'stale_workspace', invalid: 'invalid_contract', escalate: 'reasoning_required' } as const;
  if (!(result.status in codes)) fail('invalid_contract');
  throw new IntegrationError(codes[result.status], 'none', result.evidenceRefs);
}
/** All strategy and deterministic task semantics remain in Phase 1. */
export class ExecutionStrategyCoordinator {
  constructor(private readonly phaseOne?: PhaseOneAdapter, private readonly learned?: LearnedExecutorAdapter) {}
  async validate(envelope: SupervisorEnvelope, signal: AbortSignal): Promise<ValidatedContract> {
    if (!this.phaseOne) fail('capability_unavailable');
    const contract = unwrapBoundary(await this.phaseOne.validate(envelope, signal));
    if (!textId(contract.reference) || !textId(contract.version)) fail('invalid_contract');
    return freeze(boundedJson(contract, envelope.budget.maxInputBytes) as unknown as ValidatedContract);
  }
  async select(contract: ValidatedContract, envelope: SupervisorEnvelope, signal: AbortSignal): Promise<{
    strategy: Strategy; model?: ModelReference;
  }> {
    if (!this.phaseOne) fail('capability_unavailable');
    const strategy = unwrapBoundary(await this.phaseOne.select(contract, envelope, signal));
    if (strategy === 'deterministic') return { strategy };
    if (strategy !== 'learned') fail('unsupported_capability');
    if (!this.learned) fail('capability_unavailable');
    const discovered = boundedJson(await this.learned.discover(envelope, signal), envelope.budget.maxInputBytes) as unknown as Awaited<ReturnType<LearnedExecutorAdapter['discover']>>;
    if (!discovered.model || ![discovered.model.modelId, discovered.model.tokenizerId, discovered.model.checkpointId].every(textId)
      || ![discovered.model.versionId, discovered.model.evaluationId].every(textId)
      || ![discovered.model.modelSha256, discovered.model.tokenizerSha256, discovered.model.checkpointSha256].every(value => /^[a-f0-9]{64}$/.test(value))
      || ![discovered.model.registryRevision, discovered.model.evaluationRevision].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Array.isArray(discovered.capabilities) || !discovered.capabilities.every(textId)) fail('invalid_model_output');
    if (unwrapBoundary(await this.phaseOne.supports(contract, discovered.capabilities, signal)) !== true) fail('unsupported_capability');
    await this.learned.assertEligible(discovered.model, envelope, signal);
    return { strategy, model: freeze(discovered.model) };
  }
  async generate(strategy: Strategy, contract: ValidatedContract, envelope: SupervisorEnvelope,
    signal: AbortSignal, model?: ModelReference): Promise<unknown> {
    boundedJson({ contract, envelope }, envelope.budget.maxInputBytes);
    if (strategy === 'deterministic') {
      if (!this.phaseOne) fail('capability_unavailable');
      return unwrapBoundary(await this.phaseOne.compile(contract, envelope, signal));
    }
    if (!this.learned || !model) fail('capability_unavailable');
    await this.learned.assertEligible(model, envelope, signal);
    return unwrapBoundary(await this.learned.generate({ envelope, contract, model }, signal));
  }
}
