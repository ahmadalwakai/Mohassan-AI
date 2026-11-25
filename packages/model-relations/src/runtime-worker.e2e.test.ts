import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getModelEntry, type ModelArtifact } from './registry.js';
import { createModelRuntime } from './runtime.js';

const python = process.env.MODEL_WORKER_TEST_PYTHON;
const checkpointFixture = `
import hashlib
import json
from pathlib import Path
import sys
import torch
sys.path.insert(0, sys.argv[1])
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.sidecar import save_sidecar
from execution_model.tokenizer import ByteBPETokenizer

torch.set_num_threads(1)
folder = Path(sys.argv[2])
tokenizer = ByteBPETokenizer()
tokenizer.save(folder / 'tokenizer.json')
config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=24,
                     num_layers=2, num_heads=2, max_context_length=32, seed=541)
model = ExecutionModel(config).eval()
checkpoint = folder / 'trunk.pt'
torch.save({'config': config.to_dict(), 'model_state': model.state_dict()}, checkpoint)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
trunk = {'path': str(checkpoint), 'sha256': digest(checkpoint)}
codec = {'path': str(folder / 'tokenizer.json'), 'sha256': digest(folder / 'tokenizer.json')}
identity = {'modelId': 'tiny-local-e2e', 'tokenizerId': 'sha256:' + tokenizer.identity,
            'checkpointId': 'sha256:' + trunk['sha256']}
common = {'checkpoint': trunk, 'device': 'cpu', 'eosTokenId': tokenizer.eos_token_id}
(folder / 'chat.json').write_text(json.dumps({'identity': identity, 'model': {**common, 'tokenizer': codec}}))
projection = torch.nn.Linear(config.hidden_size, 2)
with torch.no_grad():
    projection.weight.zero_()
    projection.bias.copy_(torch.tensor([0.0, 5.0]))
sidecar = folder / 'sidecar'
projection_manifest = save_sidecar(sidecar, projection, {'kind': 'classify', 'trunk_sha256': trunk['sha256']})
worker_config = folder / 'worker.json'
worker_config.write_text(json.dumps({'identity': identity, 'model': {**common, 'heads': {'follow-up': {
    'kind': 'classify', 'sidecar': {'path': 'sidecar', 'sha256': projection_manifest['weights_sha256'],
                                  'manifestSha256': digest(sidecar / 'sidecar.json')}}}}}))
(folder / 'manifest.json').write_text(json.dumps({
    'schema_version': 1, 'trunk': {'checkpoint': trunk, 'tokenizer': codec},
    'worker': {'path': str(worker_config), 'sha256': digest(worker_config)},
    'inference': {'head': 'follow-up', 'operation': 'classify', 'labels': ['new', 'follow_up'],
                  'eos_token_id': tokenizer.eos_token_id, 'max_tokens': 32,
                  'calibration': {'temperature': 1.0, 'minConfidence': 0.5, 'minMargin': 0.01}}}))
`;

describe.skipIf(!python)('model relations runtime through the permanent CPU worker', () => {
  it('runs a lazy trunk and a calibrated text head, then rejects a different trunk pin', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'model-relations-cpu-'));
    const artifact = (role: string, relative: string): ModelArtifact => ({ role, path: join(folder, relative), sha256: null });
    try {
      const modelPackage = fileURLToPath(new URL('../../execution-model', import.meta.url));
      execFileSync(resolve(python!), ['-I', '-B', '-c', checkpointFixture, modelPackage, folder], { timeout: 45_000 });
      const originalTrunk = getModelEntry('chat-v5')!;
      const originalHead = getModelEntry('head-follow-up')!;
      const registry = [{ ...originalTrunk,
        resources: { ...originalTrunk.resources, memoryMb: 4_096, latencyMs: 8_000 },
        artifacts: [artifact('worker-config', 'chat.json'), artifact('checkpoint', 'trunk.pt'), artifact('tokenizer', 'tokenizer.json')],
      }, { ...originalHead,
        resources: { ...originalHead.resources, memoryMb: 4_096, latencyMs: 8_000 },
        artifacts: [artifact('worker-config', 'worker.json'), artifact('head-manifest', 'sidecar/sidecar.json'),
          artifact('weights', 'sidecar/weights.pt'), artifact('training-manifest', 'manifest.json')],
      }];
      const options = { env: { ...process.env, EXECUTOR_PYTHON: resolve(python!) }, registry };
      const runtime = createModelRuntime(options);
      try {
        const result = await runtime.run('chat-v5', { inputIds: [65], maxNewTokens: 2 });
        expect(result).toMatchObject({ ok: true, output: { tokenIds: expect.any(Array), stopReason: expect.any(String) } });
        expect(await runtime.run('head-follow-up', { text: 'When?', history: ['We met yesterday.'] }))
          .toMatchObject({ ok: true, output: { label: 'follow_up', classIndex: 1, abstained: false } });
      } finally {
        await runtime.close();
      }
      const checkpoint = join(folder, 'trunk.pt');
      const originalBytes = await readFile(checkpoint);
      await writeFile(checkpoint, Buffer.concat([originalBytes, Buffer.from('different trunk bytes')]));
      const mismatched = createModelRuntime(options);
      try {
        expect(await mismatched.health('head-follow-up')).toMatchObject({ ok: false, reason: 'incompatible' });
      } finally {
        await mismatched.close();
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 120_000);
});
