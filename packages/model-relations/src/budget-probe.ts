import { text } from 'node:stream/consumers';
import { loadModelAdapter } from './adapters.js';
import { budgetProbeTimeoutMs, type BudgetReceipt, type MeasuredModelBudget } from './budget-receipt.js';
import type { MeasurableModelAdapter, WorkerMemoryPeaks } from './budget-worker-memory.js';
import { modelRoots, unmeasuredModelRegistry } from './registry.js';
import { createModelRuntime } from './runtime.js';

type FailedMeasurement = Extract<BudgetReceipt['models'][number], { status: 'failed' }>;
export type ProbeSample =
  | { ok: true; artifacts: MeasuredModelBudget['artifacts']; coldMs: number; warmMs: number; nodePeakRssKiB: number; worker?: WorkerMemoryPeaks }
  | { ok: false; reason: string; phase: FailedMeasurement['phase'] };

async function sample(modelId: string, input: unknown): Promise<ProbeSample> {
  const root = process.cwd();
  let adapter: MeasurableModelAdapter | undefined;
  let artifacts: MeasuredModelBudget['artifacts'] = [];
  const registry = unmeasuredModelRegistry.map(entry => ({
    ...entry,
    resources: { ...entry.resources, startupMs: budgetProbeTimeoutMs, latencyMs: budgetProbeTimeoutMs },
  }));
  const runtime = createModelRuntime({
    root, artifactRoots: modelRoots(root), registry,
    loadAdapter: async (model, context) => {
      artifacts = model.artifacts.flatMap(artifact => artifact.present && artifact.sha256
        ? [{ role: artifact.role, sha256: artifact.sha256 }] : []);
      adapter = await loadModelAdapter(model, context);
      return adapter;
    },
  });
  try {
    const cold = await runtime.health(modelId);
    if (!cold.ok) return { ok: false, phase: 'cold-start', reason: cold.reason };
    const first = await runtime.run(modelId, input);
    if (!first.ok) return { ok: false, phase: 'first-call', reason: first.reason };
    const warm = await runtime.run(modelId, input);
    if (!warm.ok) return { ok: false, phase: 'warm-call', reason: warm.reason };
    // Node includes all worker threads. A permanent Python worker is a distinct process.
    const nodePeakRssKiB = process.resourceUsage().maxRSS;
    try {
      const worker = await adapter?.workerMemoryPeaks?.();
      return { ok: true, artifacts, coldMs: cold.elapsedMs, warmMs: warm.elapsedMs, nodePeakRssKiB, ...(worker ? { worker } : {}) };
    } catch {
      return { ok: false, phase: 'memory', reason: 'worker-memory-unavailable' };
    }
  } finally {
    await runtime.close();
  }
}

const modelId = process.argv[2];
if (!modelId) throw new Error('Missing model ID.');
const result = await sample(modelId, JSON.parse(await text(process.stdin)));
process.stdout.write(JSON.stringify(result) + '\n');
