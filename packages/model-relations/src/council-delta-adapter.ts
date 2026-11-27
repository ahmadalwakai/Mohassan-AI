import { join } from 'node:path';
import { requiredArtifact } from './adapters.js';
import type { ResolvedModel } from './registry.js';
import { ModelRuntimeError, type ModelAdapter, type ModelAdapterContext } from './runtime.js';
import { fileHash, loadWorkerAdapter } from './worker-adapter.js';

export async function loadCouncilDeltaAdapter(model: ResolvedModel, context: ModelAdapterContext): Promise<ModelAdapter> {
  const arm = /^(?:reading|ads)-v4-(head|lora|last2)$/u.exec(model.entry.id)?.[1];
  if (!arm) throw new ModelRuntimeError('unsupported', 'No v4 delta architecture is registered for this model');
  const base = context.dependencies.find(dependency => dependency.entry.id === 'chat-v4');
  if (!base) throw new ModelRuntimeError('absent', 'The registered v4 trunk is absent');
  const weights = requiredArtifact(model, 'weights');
  if (!weights.sha256) throw new ModelRuntimeError('incompatible', 'The v4 delta could not be verified');

  const artifacts = await Promise.all(['checkpoint', 'tokenizer', 'tokenizer-report'].map(async role => {
    const artifact = requiredArtifact(base, role);
    return { ...artifact, sha256: artifact.sha256 ?? await fileHash(artifact.path) };
  }));
  // The runtime reserved this member's Python slot. The worker loads its registered trunk and this exact delta.
  return loadWorkerAdapter({ ...model, artifacts }, context, {
    script: join(context.root, 'packages', 'model-relations', 'src', 'council_delta_worker.py'),
    modelFields: { delta: { arm, path: weights.path, sha256: weights.sha256 } },
  });
}
