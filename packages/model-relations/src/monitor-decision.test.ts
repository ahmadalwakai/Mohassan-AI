import { describe, expect, it, vi } from 'vitest';
import { ArbiterBrain } from './arbiter.js';
import { ModelRelationsManager } from './manager.js';
import { assessMonitorArbiterPromotion } from './monitor-arbiter-training.js';
import {
  loadMonitorDecisionHead, makeMonitorArbiterInput, monitorArtifactSha256, monitorDecisionLabels, monitorDecisionModelId,
  MonitorDecisionPromotion, monitorDecisionType, monitorHeadComponent, monitorReasonerComponent,
} from './monitor-decision.js';

const context = { language: 'ar', length: 123, conversationState: 'pending' } as const;
const features = { frameFeatures: { historyTurns: 3 }, textFeatureIds: [0] };
const baseline = { label: 'offer', score: 0.9 } as const;

function pipelineHead() {
  const dimensions = 2;
  const packed = Buffer.alloc(monitorDecisionLabels.length * dimensions * 2);
  packed.writeInt16LE(1, 0);
  packed.writeInt16LE(2, 2);
  return { schemaVersion: 1, featureSchemaVersion: 1, trainingSource: 'pipeline-check', labels: monitorDecisionLabels,
    dimensions, weights: packed.toString('base64'), weightScale: 0.5, bias: monitorDecisionLabels.map(() => 0),
    temperature: 1, threshold: 0.5, textFeatureDimensions: 1, frameFeatureKeys: ['historyTurns'] };
}

const hypotheticalArbiter = { schemaVersion: 1, decisions: { [monitorDecisionType]: {
  components: [monitorReasonerComponent, monitorHeadComponent],
  coefficients: { [`candidate:${monitorHeadComponent}`]: 8 }, threshold: 0.9,
} } };

describe('monitor context decision head', () => {
  it('scores numeric frame features and hashed text buckets locally using the packed layout', () => {
    const artifact = pipelineHead();
    expect(() => loadMonitorDecisionHead(artifact)).toThrow(/provenance/u);
    const head = loadMonitorDecisionHead(artifact, { pipelineCheck: true });
    const expectedLogit = (1 + 2 * 3) * 0.5;
    const prediction = head.predict(features);
    expect(prediction.label).toBe('none');
    expect(prediction.score).toBeCloseTo(1 / (1 + (monitorDecisionLabels.length - 1) * Math.exp(-expectedLogit)), 14);
    expect(() => head.predict({ ...features, textFeatureIds: [0, 0] })).toThrow(/features/u);
    expect(() => head.predict({ ...features, frameFeatures: { ...features.frameFeatures, unknown: 1 } })).toThrow(/features/u);
    expect(loadMonitorDecisionHead({ ...artifact, threshold: 1 + Number.EPSILON }, { pipelineCheck: true }).predict(features).label).toBeNull();
  });

  it('compares the reasoner and local head in shadow using feature-only input', async () => {
    const head = loadMonitorDecisionHead(pipelineHead(), { pipelineCheck: true });
    const runtime = { run: vi.fn(async (_id: string, input: unknown) => ({ ok: true as const, output: head.predict(input), elapsedMs: 0 })) };
    const manager = new ModelRelationsManager(runtime, { env: {}, arbiter: new ArbiterBrain(hypotheticalArbiter) });
    const result = await manager.reviewMonitorDecision(context, baseline, features);
    expect(result.action).toBe('offer');
    expect(result.log).toMatchObject({ type: monitorDecisionType, selected: monitorReasonerComponent, proposed: monitorHeadComponent,
      modelOutcome: 'ok', reason: 'shadow', claimants: [{ label: 'offer' }, { label: 'none' }] });
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith(monitorDecisionModelId, features);
    expect(JSON.stringify(result.log)).not.toMatch(/historyTurns|textFeatureIds|frameFeatures/u);
  });

  it('cannot force a monitor decision or apply it with the flag and a designation alone', async () => {
    const manager = new ModelRelationsManager({ run: async () => ({ ok: false, elapsedMs: 0, reason: 'absent' }) }, {
      env: { MOHASSAN_ARBITER_MONITOR_CONTEXT: '1' }, promotedDecisionTypes: [monitorDecisionType],
      arbiter: new ArbiterBrain(hypotheticalArbiter),
    });
    const input = makeMonitorArbiterInput(context, baseline, { label: 'none', score: 0.99 });
    expect(manager.arbitrate(input, { forced: monitorHeadComponent })).toMatchObject({ selected: monitorReasonerComponent, reason: 'shadow' });
    expect((await manager.reviewMonitorDecision(context, baseline, features)).log.modelOutcome).toBe('absent');
    expect(MonitorDecisionPromotion.fromArtifact({ schemaVersion: 1, trainingSource: 'pipeline-check', arbiter: hypotheticalArbiter },
      'a'.repeat(64))).toBeUndefined();
  });

  it('rejects a pipeline-check artifact before either promotion gate', () => {
    const weights = Buffer.from(JSON.stringify(pipelineHead()));
    const replay = Buffer.from(JSON.stringify({ schemaVersion: 1, trainingSource: 'pipeline-check', weightsSha256: monitorArtifactSha256(weights) }));
    expect(() => assessMonitorArbiterPromotion({ weights, replay, developmentBefore: Buffer.from('[]'), developmentAfter: Buffer.from('[]') }))
      .toThrow(/provenance/u);
  });
});
