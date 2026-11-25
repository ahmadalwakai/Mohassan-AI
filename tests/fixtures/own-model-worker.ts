import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { PermanentModelWorker } from '../../packages/execution-integration/src/permanent-worker.js';

export const ownModelTestPython = process.env.MODEL_WORKER_TEST_PYTHON;
const root = fileURLToPath(new URL('../../', import.meta.url));

const makeCheckpoint = `
from pathlib import Path
import sys
import torch
sys.path.insert(0, sys.argv[1])
from execution_model.config import ModelConfig
from execution_model.model import ExecutionModel
from execution_model.tokenizer import ByteBPETokenizer

torch.set_num_threads(1)
directory = Path(sys.argv[2])
tokenizer = ByteBPETokenizer()
tokenizer.save(directory / 'tokenizer.json')
# This random seed produces a printable token before EOS for the fixed evidence test prompt.
config = ModelConfig(vocab_size=tokenizer.vocab_size, hidden_size=16, intermediate_size=24,
                     num_layers=1, num_heads=2, max_context_length=512, seed=2740, init_std=0.25)
model = ExecutionModel(config).eval()
torch.save({'config': config.to_dict(), 'model_state': model.state_dict()}, directory / 'tiny.pt')
print(tokenizer.identity)
`;

export async function startOwnModelTestWorker() {
  if (!ownModelTestPython) throw new Error('Set MODEL_WORKER_TEST_PYTHON to run the permanent-worker fixture.');
  const executable = resolve(ownModelTestPython);
  const environment: Record<string, string> = {};
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot;
    if (system) environment.SystemRoot = system;
    environment.PATH = [dirname(executable), ...(system ? [join(system, 'System32'), system] : [])].join(delimiter);
  }
  const folder = await mkdtemp(join(tmpdir(), 'mohassan-own-model-'));
  let startedWorker: PermanentModelWorker | undefined;
  const stop = async () => {
    try { await startedWorker?.stop(); }
    finally { await rm(folder, { recursive: true, force: true }); }
  };
  try {
    const tokenizerId = execFileSync(executable, [
      '-I', '-B', '-c', makeCheckpoint, join(root, 'packages', 'execution-model'), folder,
    ], { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
    const hash = async (name: string) => createHash('sha256').update(await readFile(join(folder, name))).digest('hex');
    const sha256 = await hash('tiny.pt');
    const identity = { modelId: 'tiny-own-chat', tokenizerId: `sha256:${tokenizerId}`, checkpointId: `sha256:${sha256}` };
    const configPath = join(folder, 'worker.json');
    await writeFile(configPath, JSON.stringify({
      identity,
      model: {
        checkpoint: { path: 'tiny.pt', sha256 },
        tokenizer: { path: 'tokenizer.json', sha256: await hash('tokenizer.json') },
        heads: { lm: { kind: 'generate' }, options: { kind: 'score-options' } },
      },
      limits: { maxBatchWaitMs: 15, maxOutputTokens: 64 },
    }));
    const worker = new PermanentModelWorker({
      executable, cwd: root, environment, identity, startupTimeoutMs: 12_000,
      args: ['-I', '-B', join(root, 'packages', 'execution-integration', 'model_worker', 'worker.py'), configPath, String(process.pid)],
    });
    startedWorker = worker;
    worker.start();
    await vi.waitFor(() => {
      if (worker.status.state !== 'ready') throw Error(`Own model worker is ${worker.status.state}`);
    }, { timeout: 12_000 });
    return { worker, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
