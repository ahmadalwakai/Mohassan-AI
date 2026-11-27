import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCouncilDeltaAdapter } from './council-delta-adapter.js';
import { getModelEntry, type ResolvedArtifact, type ResolvedModel } from './registry.js';
import type { ModelAdapterContext } from './runtime.js';
import { fileHash, loadWorkerAdapter } from './worker-adapter.js';

vi.mock('./worker-adapter.js', () => ({ fileHash: vi.fn(), loadWorkerAdapter: vi.fn() }));

const root = resolve('checkout');
const artifact = (role: string, sha256: string | null = role): ResolvedArtifact => ({
  role, path: resolve('model-store', role), present: true, required: true, sha256,
});
const trunk: ResolvedModel = {
  entry: getModelEntry('chat-v4')!, state: 'experimental',
  artifacts: [artifact('checkpoint'), artifact('tokenizer', null), artifact('tokenizer-report', null)],
};
const context: ModelAdapterContext = {
  root, env: {}, dependencies: [trunk], signal: new AbortController().signal,
  memoryBudgetMiB: trunk.entry.resources.memoryMb, startupMs: 1_000, assertGpuFree: async () => {},
};
const delta = (id: string) => ({ entry: getModelEntry(id)!, state: 'experimental' as const, artifacts: [artifact('weights')] });

describe('council v4 delta adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fileHash).mockImplementation(async path => `hash:${path}`);
    vi.mocked(loadWorkerAdapter).mockResolvedValue({ health: () => true, run: () => ({ text: 'answer' }) });
  });

  it.each(['reading-v4-head', 'reading-v4-lora', 'reading-v4-last2', 'ads-v4-head', 'ads-v4-lora', 'ads-v4-last2'])
    ('passes %s with its pinned delta and registered trunk to the contained worker', async id => {
      const model = delta(id);
      const adapter = await loadCouncilDeltaAdapter(model, context);
      expect(loadWorkerAdapter).toHaveBeenCalledWith({ ...model, artifacts: trunk.artifacts.map(item => ({
        ...item, sha256: item.sha256 ?? `hash:${item.path}`,
      })) }, context, {
        script: resolve(root, 'packages/model-relations/src/council_delta_worker.py'),
        modelFields: { delta: { arm: id.split('-').at(-1), path: model.artifacts[0].path, sha256: 'weights' } },
      });
      expect(adapter.run({ prompt: 'Question', maxNewTokens: 1 }, context.signal, 1_000)).toEqual({ text: 'answer' });
    });

  it('reports a missing trunk and refuses an unverified delta before the worker starts', async () => {
    const model = delta('reading-v4-head');
    await expect(loadCouncilDeltaAdapter(model, { ...context, dependencies: [] })).rejects.toMatchObject({ reason: 'absent' });
    await expect(loadCouncilDeltaAdapter({ ...model, artifacts: [artifact('weights', null)] }, context))
      .rejects.toMatchObject({ reason: 'incompatible' });
    expect(loadWorkerAdapter).not.toHaveBeenCalled();
  });
});
