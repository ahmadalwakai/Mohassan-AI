import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  PermanentModelWorker,
  type PermanentModelWorkerStatus,
} from '../../../packages/execution-integration/src/experimental-worker-transport.js';
import type { ModelIdentity } from '../../../packages/execution-integration/src/transport.js';
import { loadOwnModelGates, readOwnModelGateConfig, type OwnModelGates } from './own-model-gates.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const maxConfigBytes = 16 * 1024 * 1024;
type Service = { worker?: PermanentModelWorker; ownModelGates?: OwnModelGates; state: 'starting' | 'degraded' };
const services = new WeakMap<FastifyInstance, Service>();

async function readIdentity(path: string): Promise<ModelIdentity> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxConfigBytes) throw new Error('Invalid model worker configuration');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error('Model worker configuration changed');
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    const identity = config?.identity;
    if (!identity || typeof identity.modelId !== 'string' || typeof identity.tokenizerId !== 'string'
        || typeof identity.checkpointId !== 'string') throw new Error('Missing model worker identity');
    return { modelId: identity.modelId, tokenizerId: identity.tokenizerId, checkpointId: identity.checkpointId };
  } finally {
    await file.close();
  }
}

function logState(status: PermanentModelWorkerStatus): void {
  if (status.state === 'ready') {
    console.log(JSON.stringify({
      level: 'info', event: 'model_worker_ready', startupMs: status.startupMs,
      workerStartupMs: status.ready.startupMs, device: status.ready.device,
      headCount: Object.keys(status.ready.heads).length,
    }));
  } else if (status.state === 'degraded') {
    console.log(JSON.stringify({
      level: 'warn', event: 'model_worker_degraded', reason: status.code, restartInMs: status.restartInMs,
    }));
  }
}

export function getServerModelWorker(app: FastifyInstance): PermanentModelWorker | undefined {
  return services.get(app)?.worker;
}

export function getServerOwnModelGates(app: FastifyInstance): OwnModelGates | undefined {
  return services.get(app)?.ownModelGates;
}

export function serverModelWorkerHealth(app: FastifyInstance): {
  modelWorker?: { state: PermanentModelWorkerStatus['state']; startupMs?: number };
} {
  const service = services.get(app);
  if (!service) return {};
  const status = service.worker?.status;
  if (status?.state === 'ready') return { modelWorker: { state: status.state, startupMs: status.startupMs } };
  return { modelWorker: { state: status?.state ?? service.state } };
}

export async function startServerModelWorker(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.MOHASSAN_MODEL_WORKER !== '1' || services.has(app)) return;
  const service: Service = { state: 'starting' };
  services.set(app, service);
  let closed = false;
  app.addHook('onClose', async () => {
    closed = true;
    await service.worker?.stop();
  });
  try {
    const configPath = resolve(root, env.MOHASSAN_MODEL_WORKER_CONFIG?.trim() || '.data/model-worker.json');
    const identity = await readIdentity(configPath);
    const gateConfig = await readOwnModelGateConfig(join(dirname(configPath), 'own-model-provider.json'));
    if (Object.keys(gateConfig).length) service.ownModelGates = await loadOwnModelGates(gateConfig);
    if (closed) return;
    const python = env.EXECUTOR_PYTHON?.trim();
    const executable = python ? resolve(root, python) : process.platform === 'win32'
      ? join(root, '.venv-execution', 'Scripts', 'python.exe')
      : join(root, '.venv-execution', 'bin', 'python');
    const environment: Record<string, string> = {};
    if (process.platform === 'win32') {
      const system = env.SystemRoot;
      if (system) environment.SystemRoot = system;
      environment.PATH = [dirname(executable), ...(system ? [join(system, 'System32'), system] : [])].join(delimiter);
    }
    service.worker = new PermanentModelWorker({
      executable,
      args: ['-I', '-B', join(root, 'packages', 'execution-integration', 'model_worker', 'worker.py'), configPath, String(process.pid)],
      cwd: root,
      environment,
      identity,
      onState: logState,
    });
    service.worker.start();
  } catch {
    service.state = 'degraded';
    const worker = service.worker;
    service.worker = undefined;
    await worker?.stop();
    console.log(JSON.stringify({ level: 'warn', event: 'model_worker_degraded', reason: 'invalid_configuration' }));
  }
}
