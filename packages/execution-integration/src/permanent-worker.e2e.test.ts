import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermanentModelWorker, type PermanentModelWorkerStatus } from './experimental-worker-transport.js';

const python = process.env.MODEL_WORKER_TEST_PYTHON;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const workerPath = join(root, 'packages', 'execution-integration', 'model_worker', 'worker.py');
const modelPackage = join(root, 'packages', 'execution-model');
const prompts = [[1, 2, 3], [4, 5, 6]];
const maxNewTokens = 6;
const makeCheckpoint = `
from hashlib import sha256
import json
from pathlib import Path
import sys
import torch
sys.path.insert(0, sys.argv[1])
from execution_model.config import ModelConfig
from execution_model.generation import GenerationConfig, generate
from execution_model.model import ExecutionModel
from execution_model.sidecar import save_sidecar

torch.set_num_threads(1)
config = ModelConfig(vocab_size=256, hidden_size=16, intermediate_size=24, num_layers=2,
                     num_heads=2, max_context_length=32, seed=1729, init_std=0.25)
model = ExecutionModel(config).eval()
checkpoint = Path(sys.argv[2])
torch.save({'config': config.to_dict(), 'model_state': model.state_dict()}, checkpoint)
trunk_pin = sha256(checkpoint.read_bytes()).hexdigest()
heads = {'lm': {'kind': 'generate'}}
torch.manual_seed(42)
for kind, width in [('classify', 3), ('pointer', 1)]:
    directory = checkpoint.parent / kind
    manifest = save_sidecar(directory, torch.nn.Linear(config.hidden_size, width),
                            {'kind': kind, 'trunk_sha256': trunk_pin})
    heads[kind] = {'kind': kind, 'sidecar': {
        'path': directory.name, 'sha256': manifest['weights_sha256'],
        'manifestSha256': sha256((directory / 'sidecar.json').read_bytes()).hexdigest(),
    }}
generation = GenerationConfig(max_new_tokens=int(sys.argv[3]))
reference = [generate(model, prompt, generation).token_ids for prompt in json.loads(sys.argv[4])]
print(json.dumps({'heads': heads, 'reference': reference}))
`;

const environment: Record<string, string> = {};
if (process.platform === 'win32' && python) {
  const system = process.env.SystemRoot;
  if (system) environment.SystemRoot = system;
  environment.PATH = [dirname(resolve(python)), ...(system ? [join(system, 'System32'), system] : [])].join(delimiter);
}

function waitForReady(worker: PermanentModelWorker) {
  return vi.waitFor(() => {
    const status = worker.status;
    if (status.state !== 'ready') throw new Error(`Worker state is ${status.state}`);
    return status;
  }, { timeout: 12_000 });
}

describe.skipIf(!python)('permanent model worker with a random dense checkpoint', () => {
  let folder: string;
  let checkpoint: string;
  let config: string;
  let sha256: string;
  let reference: number[][];

  const identity = () => ({ modelId: 'random-dense-fixture', tokenizerId: 'fixture-token-ids', checkpointId: `sha256:${sha256}` });

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mohassan-worker-e2e-'));
    checkpoint = join(folder, 'tiny.pt');
    config = join(folder, 'worker.json');
    const output = execFileSync(resolve(python!), [
      '-I', '-B', '-c', makeCheckpoint, modelPackage, checkpoint, String(maxNewTokens), JSON.stringify(prompts),
    ], { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
    const fixture = JSON.parse(output) as { heads: Record<string, unknown>; reference: number[][] };
    reference = fixture.reference;
    sha256 = createHash('sha256').update(await readFile(checkpoint)).digest('hex');
    await writeFile(config, JSON.stringify({
      identity: identity(),
      model: { checkpoint: { path: checkpoint, sha256 }, heads: fixture.heads },
      limits: { maxBatchSize: 2, maxBatchWaitMs: 10, maxOutputTokens: maxNewTokens },
    }));
  });

  afterAll(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  function startWorker(onState?: (status: PermanentModelWorkerStatus) => void) {
    const worker = new PermanentModelWorker({
      executable: resolve(python!),
      args: ['-I', '-B', workerPath, config, String(process.pid)],
      cwd: root,
      environment,
      identity: identity(),
      startupTimeoutMs: 10_000,
      restartMinMs: 100,
      restartMaxMs: 200,
      onState,
    });
    worker.start();
    return worker;
  }

  async function generate(worker: PermanentModelWorker, inputIds: number[]) {
    const events: { index: number; token: number }[] = [];
    const result = await worker.request({
      operation: 'generate',
      head: 'lm',
      input: { inputIds, maxNewTokens },
      onToken: token => { events.push(token); },
    });
    const tokens = events.map(({ token }) => token);
    expect(events.map(({ index }) => index)).toEqual(Array.from({ length: tokens.length }, (_, index) => index));
    expect(result).toEqual({ tokenIds: tokens, stopReason: 'length' });
    return tokens;
  }

  it('serves all heads from a resident checkpoint and streams matching single and concurrent results', async () => {
    const worker = startWorker();
    try {
      const ready = await waitForReady(worker);
      expect(ready.startupMs).toBeGreaterThan(0);
      expect(ready.ready).toMatchObject({
        identity: identity(), device: 'cpu', heads: { lm: 'generate', classify: 'classify', pointer: 'pointer' },
      });
      const single = await generate(worker, prompts[0]);
      const batched = await Promise.all(prompts.map(prompt => generate(worker, prompt)));
      expect(batched[0]).toEqual(single);
      expect(batched).toEqual(reference);

      const moved = join(folder, 'resident.pt');
      await rename(checkpoint, moved);
      try {
        expect(await generate(worker, prompts[1])).toEqual(reference[1]);
        const inputIds = prompts[0];
        const input = { inputIds, candidatePositions: [2, 0] };
        const [classified, scored, selected] = await Promise.all([
          worker.request({ operation: 'classify', head: 'classify', input: { inputIds } }),
          worker.request({ operation: 'score', head: 'pointer', input }),
          worker.request({ operation: 'select', head: 'pointer', input }),
        ]);
        const logits = classified.logits as number[];
        const scores = scored.scores as number[];
        expect(logits).toHaveLength(3);
        expect(classified.classIndex).toBe(logits.indexOf(Math.max(...logits)));
        expect(scores).toHaveLength(2);
        const selectedIndex = scores.indexOf(Math.max(...scores));
        expect(selected).toEqual({ scores, selectedIndex, selectedPosition: input.candidatePositions[selectedIndex] });
        expect(worker.status).toMatchObject({ state: 'ready', pid: ready.pid });
      } finally {
        await rename(moved, checkpoint);
      }
    } finally {
      await worker.stop();
    }
    expect(worker.status.state).toBe('stopped');
  });

  it('observes a genuine worker crash and serves again after a fresh load', async () => {
    const states: PermanentModelWorkerStatus[] = [];
    const worker = startWorker(status => { states.push(status); });
    try {
      const first = await waitForReady(worker);
      process.kill(first.pid, 'SIGKILL');
      await vi.waitFor(() => {
        expect(states.some(status => status.state === 'degraded')).toBe(true);
        expect(worker.status.state).toBe('ready');
        expect(worker.status).not.toMatchObject({ pid: first.pid });
      }, { timeout: 12_000 });
      expect(await generate(worker, prompts[0])).toEqual(reference[0]);
    } finally {
      await worker.stop();
    }
  });

  it('refuses startup when the checkpoint bytes differ from the SHA-256 pin', async () => {
    const original = await readFile(checkpoint);
    await writeFile(checkpoint, Buffer.concat([original, Buffer.from([0])]));
    const states: PermanentModelWorkerStatus[] = [];
    const worker = startWorker(status => { states.push(status); });
    try {
      await vi.waitFor(() => expect(states).toContainEqual(expect.objectContaining({
        state: 'degraded', code: 'checkpoint_pin_mismatch',
      })), { timeout: 12_000 });
      expect(states.some(status => status.state === 'ready')).toBe(false);
      await expect(worker.request({ operation: 'generate', head: 'lm', input: { inputIds: prompts[0], maxNewTokens } })).rejects.toMatchObject({
        code: 'model_process_failure',
      });
    } finally {
      try {
        await worker.stop();
      } finally {
        await writeFile(checkpoint, original);
      }
    }
  });
  it.skipIf(process.platform !== 'linux')('loads the worker at API startup before receiving any HTTP request', async () => {
    const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        MOHASSAN_ISOLATED_TEST: 'true',
        MOHASSAN_LOCAL_LAB: '1',
        RUN_WORKER: 'false',
        SERVER_PORT: '0',
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        INTERNAL_API_SECRET: randomBytes(32).toString('hex'),
        DATA_DIR: join(folder, 'postgres'),
        CODING_DATA_DIR: join(folder, 'coding'),
        DOCUMENTS_DIR: join(folder, 'documents'),
        BROWSER_PROFILE_DIR: join(folder, 'browser'),
        STUDIO_AI_DATA_DIR: join(folder, 'studio-ai'),
        MOHASSAN_MODEL_WORKER: '1',
        MOHASSAN_MODEL_WORKER_CONFIG: config,
        EXECUTOR_PYTHON: resolve(python!),
      },
    });
    let failure = false;
    let exitCode: number | null | undefined;
    let apiReady = false;
    let workerStartupMs: number | undefined;
    server.once('error', () => { failure = true; });
    server.once('close', code => { exitCode = code; });
    const lines = createInterface({ input: server.stdout });
    lines.on('line', line => {
      if (line.startsWith('Mohassan API ready on port ')) apiReady = true;
      if (line.startsWith('{"level":"info","event":"model_worker_ready",')) {
        workerStartupMs = (JSON.parse(line) as { startupMs: number }).startupMs;
      }
    });
    try {
      await vi.waitFor(() => {
        expect(failure).toBe(false);
        expect(exitCode).toBeUndefined();
        expect(apiReady).toBe(true);
        expect(workerStartupMs).toBeGreaterThan(0);
      }, { timeout: 20_000 });
    } finally {
      if (exitCode === undefined) server.kill('SIGTERM');
      try {
        await vi.waitFor(() => expect(exitCode).toBeDefined(), { timeout: 5_000 });
      } finally {
        if (exitCode === undefined) server.kill('SIGKILL');
        lines.close();
      }
    }
    expect(exitCode).toBe(0);
  });
});
