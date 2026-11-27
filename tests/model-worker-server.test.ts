import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServerOwnModelReply } from '../apps/server/src/assistant/own-model-reply.js';
import { getServerModelWorker, getServerOwnModelGates, installServerModelWorkerShutdown, serverModelWorkerHealth, startServerModelWorker } from '../apps/server/src/model-worker.js';

const controls = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), stop: vi.fn(), request: vi.fn() }));
vi.mock('../packages/execution-integration/src/experimental-worker-transport.js', () => ({
  PermanentModelWorker: class {
    status = { state: 'starting' };
    constructor(options: unknown) { controls.construct(options); }
    start = controls.start;
    stop = controls.stop;
    request = controls.request;
  },
}));

const applications: ReturnType<typeof Fastify>[] = [];
const directories: string[] = [];
function application() {
  const app = Fastify();
  applications.push(app);
  app.get('/health', async () => ({ status: 'ok', ...serverModelWorkerHealth(app) }));
  return app;
}

afterEach(async () => {
  for (const app of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('server model worker lifecycle', () => {
  it('keeps the normal health response with the flag off', async () => {
    const app = application();
    await startServerModelWorker(app, { MOHASSAN_MODEL_WORKER_CONFIG: '/unused' });
    expect(controls.construct).not.toHaveBeenCalled();
    expect(getServerModelWorker(app)).toBeUndefined();
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
  });

  it('starts a single worker before any request and closes it with the app', async () => {
    const app = application();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-server-'));
    directories.push(directory);
    const configPath = join(directory, 'model.json');
    const identity = { modelId: 'fixture', tokenizerId: 'token-ids', checkpointId: 'a'.repeat(64) };
    await writeFile(configPath, JSON.stringify({ identity }));
    const env = { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath, UNUSED_SECRET: 'test value' };
    await Promise.all([startServerModelWorker(app, env), startServerModelWorker(app, env)]);
    expect(controls.start).toHaveBeenCalledTimes(1);
    const options = controls.construct.mock.calls[0]?.[0];
    expect(options).toEqual(expect.objectContaining({
      args: ['-I', '-B', expect.stringMatching(/model_worker[/\\]worker\.py$/), configPath, String(process.pid)],
      identity,
    }));
    expect(options.environment).toEqual(process.platform === 'win32' ? { PATH: dirname(options.executable) } : {});
    expect(getServerModelWorker(app)).toBeDefined();
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok', modelWorker: { state: 'starting' } });
    await app.close();
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  // Production: createApplication() runs app.ready() and index.ts starts the worker afterwards.
  // On 2026-11-26 that order crashed the API (FST_ERR_INSTANCE_ALREADY_LISTENING from addHook).
  it('starts after app.ready() when the shutdown hook was installed before it', async () => {
    const app = application();
    installServerModelWorkerShutdown(app);
    await app.ready();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-server-'));
    directories.push(directory);
    const configPath = join(directory, 'model.json');
    await writeFile(configPath, JSON.stringify({ identity: { modelId: 'fixture', tokenizerId: 'token-ids', checkpointId: 'a'.repeat(64) } }));
    await expect(startServerModelWorker(app, { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath }))
      .resolves.toBeUndefined();
    expect(controls.start).toHaveBeenCalledTimes(1);
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok', modelWorker: { state: 'starting' } });
    await app.close();
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  it('reports degraded on an invalid configuration while the API stays up', async () => {
    const app = application();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-server-'));
    directories.push(directory);
    const configPath = join(directory, 'model.json');
    await writeFile(configPath, '{}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await startServerModelWorker(app, { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath });
    expect(controls.construct).not.toHaveBeenCalled();
    expect((await app.inject('/health')).json()).toEqual({
      status: 'ok', modelWorker: { state: 'degraded', reason: 'invalid_configuration', terminal: true },
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      level: 'warn', event: 'model_worker_degraded', reason: 'invalid_configuration', terminal: true,
    }));
  });

  it('reports a terminal startup refusal in health and logs', async () => {
    const app = application();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-server-'));
    directories.push(directory);
    const configPath = join(directory, 'model.json');
    await writeFile(configPath, JSON.stringify({ identity: { modelId: 'fixture', tokenizerId: 'token-ids', checkpointId: 'pinned' } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await startServerModelWorker(app, { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath });

    const refusal = { state: 'degraded', code: 'checkpoint_pin_mismatch', terminal: true };
    Object.assign(getServerModelWorker(app)!, { status: refusal });
    controls.construct.mock.calls[0]?.[0].onState(refusal);
    expect((await app.inject('/health')).json()).toEqual({
      status: 'ok', modelWorker: { state: 'degraded', reason: 'checkpoint_pin_mismatch', terminal: true },
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      level: 'warn', event: 'model_worker_degraded', reason: 'checkpoint_pin_mismatch', terminal: true,
    }));
  });

  it('leaves all existing own-model capabilities inactive with only a ready v5 head and no gate file', async () => {
    const app = application();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-v5-'));
    directories.push(directory);
    const configPath = join(directory, 'model-worker.json');
    const identity = { modelId: 'mohassan-chat-v5', tokenizerId: 'sha256:fixture', checkpointId: 'sha256:fixture' };
    await writeFile(configPath, JSON.stringify({ identity, model: { heads: { 'chat-v5': { kind: 'generate' } } } }));
    await startServerModelWorker(app, { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath,
      EXECUTOR_PYTHON: '/opt/mohassan/venv-execution/bin/python' });
    expect(controls.construct).toHaveBeenCalledWith(expect.objectContaining({
      executable: expect.stringMatching(/[/\\]opt[/\\]mohassan[/\\]venv-execution[/\\]bin[/\\]python$/),
    }));
    Object.assign(getServerModelWorker(app)!, { status: { state: 'ready', ready: {
      identity, text: true, configSha256: 'a'.repeat(64), heads: { 'chat-v5': 'generate' },
    } } });
    expect(getServerOwnModelGates(app)).toBeUndefined();

    const existing = createServerOwnModelReply(app);
    const signal = new AbortController().signal;
    const reply = 'The original answer';
    await existing.observe({ request: 'What about its population?', earlierUserTurns: ['Where is Japan?'], route: 'web_search', signal });
    await expect(existing.phrase({ plan: { next: 0, steps: [] }, reply, status: 'completed', evidence: [],
      question: 'What about its population?', signal })).resolves.toBe(reply);
    expect(controls.request).not.toHaveBeenCalled();
  });
});
