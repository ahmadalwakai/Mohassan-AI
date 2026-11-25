import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerModelWorker, serverModelWorkerHealth, startServerModelWorker } from '../apps/server/src/model-worker.js';

const controls = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../packages/execution-integration/src/experimental-worker-transport.js', () => ({
  PermanentModelWorker: class {
    status = { state: 'starting' };
    constructor(options: unknown) { controls.construct(options); }
    start = controls.start;
    stop = controls.stop;
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

  it('reports degraded on an invalid configuration while the API stays up', async () => {
    const app = application();
    const directory = await mkdtemp(join(tmpdir(), 'model-worker-server-'));
    directories.push(directory);
    const configPath = join(directory, 'model.json');
    await writeFile(configPath, '{}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await startServerModelWorker(app, { MOHASSAN_MODEL_WORKER: '1', MOHASSAN_MODEL_WORKER_CONFIG: configPath });
    expect(controls.construct).not.toHaveBeenCalled();
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok', modelWorker: { state: 'degraded' } });
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      level: 'warn', event: 'model_worker_degraded', reason: 'invalid_configuration',
    }));
  });
});
