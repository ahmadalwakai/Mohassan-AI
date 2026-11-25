import { readFile } from 'node:fs/promises';
import { MonitorDecisionFeaturesSchema } from '../../apps/server/src/monitors/decision/features.js';
import { ModelRelationsManager } from '../../packages/model-relations/src/manager.js';
import {
  isMonitorDecisionClaim, isRecord, loadMonitorDecisionHead, monitorArtifactSha256, monitorDecisionModelId, readMonitorArtifact,
} from '../../packages/model-relations/src/monitor-decision.js';
import { modelRegistry } from '../../packages/model-relations/src/registry.js';
import { ModelRuntime } from '../../packages/model-relations/src/runtime.js';

const [weightsPath, fixturePath, samplesArg = '10000'] = process.argv.slice(2);
const samples = Number(samplesArg);
if (!weightsPath || !fixturePath || !Number.isSafeInteger(samples) || samples < 1 || samples > 100_000) {
  throw new Error('Usage: node --import tsx scripts/monitor-decision/latency.ts WEIGHTS PIPELINE_CHECK_EXPORT [SAMPLES]');
}
const weights = await readMonitorArtifact(weightsPath);
const artifact: unknown = JSON.parse(weights.toString('utf8'));
const fixture = await readFile(fixturePath);
const manifest: unknown = JSON.parse(await readFile(`${fixturePath}.manifest.json`, 'utf8'));
if (!isRecord(artifact) || artifact.trainingSource !== 'pipeline-check' || !isRecord(manifest)
  || manifest.source !== 'pipeline-check' || manifest.sha256 !== monitorArtifactSha256(fixture)) {
  throw new Error('Expected a pipeline-check head and a checksum-matched pipeline-check export.');
}
const head = loadMonitorDecisionHead(artifact, { pipelineCheck: true });
const cases = fixture.toString('utf8').trim().split('\n').map(line => {
  const { language, frameFeatures, textFeatureIds, conversationState, length, reasonerDecision, reasonerScore } = JSON.parse(line);
  const baseline = { label: reasonerDecision, score: reasonerScore };
  if (!isMonitorDecisionClaim(baseline)) throw new Error('Invalid fixture baseline.');
  const features = MonitorDecisionFeaturesSchema.parse({ language, frameFeatures, textFeatureIds, conversationState, length });
  return { baseline, features };
});

const runtime = new ModelRuntime({
  registry: modelRegistry.filter(entry => entry.id === monitorDecisionModelId),
  // Inject the scorer only in this isolated benchmark. The normal adapter rejects fixture weights.
  resolve: async entry => ({ entry, state: 'shadow', artifacts: [] }),
  loadAdapter: () => ({ health: () => true, run: input => head.predict(input) }),
});
const manager = new ModelRelationsManager(runtime, { env: { MOHASSAN_MODEL_RELATIONS: 'shadow' } });
const warmup = 256;
const times: number[] = [];
const outcomes = { ok: 0, abstained: 0, timeout: 0 };
try {
  for (let index = 0; index < warmup + samples; index++) {
    const { baseline, features } = cases[index % cases.length]!;
    const { action, log } = await manager.reviewMonitorDecision(features, baseline, features);
    const outcome = log.modelOutcome;
    if (action !== baseline.label || (outcome !== 'ok' && outcome !== 'abstained' && outcome !== 'timeout')) {
      throw new Error(`Unexpected shadow outcome at sample ${index + 1} (${outcome ?? log.reason}).`);
    }
    if (index >= warmup) {
      times.push(log.elapsedMs);
      outcomes[outcome]++;
    }
  }
} finally {
  await runtime.close();
}
if (outcomes.timeout === samples) throw new Error('No shadow inference completed within the runtime budget.');
times.sort((left, right) => left - right);
const percentile = (fraction: number) => times[Math.ceil(samples * fraction) - 1];
console.log(JSON.stringify({
  provenance: 'pipeline-check', fixtureRows: cases.length, samples, warmup, outcomes,
  p50Ms: percentile(0.5), p95Ms: percentile(0.95), weightsSha256: monitorArtifactSha256(weights),
}));
