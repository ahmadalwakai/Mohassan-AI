import type { FastifyInstance } from 'fastify';
import type { TrainingMonitorSnapshot } from '@mohassan/contracts';
import { createTrainingMonitorEvents } from './events.js';
import { createGpuSampler } from './gpu.js';
import { createTrainingRunReader } from './reader.js';

const CACHE_MS = 10_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function localTrainingMonitorRoot(env: NodeJS.ProcessEnv, webOrigin: string, root: string): string | undefined {
  if (env.NODE_ENV === 'production' && env.MOHASSAN_DESKTOP_SHELL !== '1') return;
  const host = env.SERVER_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && host !== '::1') return;
  if (URL.canParse(webOrigin) && LOOPBACK.has(new URL(webOrigin).hostname)) return root;
}

interface TrainingMonitorOptions {
  root?: string;
  readRuns?: ReturnType<typeof createTrainingRunReader>;
  sampleGpu?: ReturnType<typeof createGpuSampler>;
  now?: () => number;
  clock?: () => number;
}

export function createTrainingMonitor({ root, readRuns = createTrainingRunReader(), sampleGpu = createGpuSampler(), now = Date.now,
  clock = () => performance.now() }: TrainingMonitorOptions) {
  const { emitter, observe } = createTrainingMonitorEvents();
  let cache: { snapshot: TrainingMonitorSnapshot | null; expiresAt: number } | undefined;
  let pending: Promise<TrainingMonitorSnapshot | null> | undefined;

  async function refresh(localRoot: string): Promise<TrainingMonitorSnapshot | null> {
    const runs = await readRuns(localRoot, now());
    if (!runs) return null;
    const sampledAt = new Date(now()).toISOString();
    const gpu = await sampleGpu();
    observe(runs, sampledAt);
    return { ...runs, gpu, sampledAt };
  }

  async function snapshot(): Promise<TrainingMonitorSnapshot | null> {
    if (!root) return null;
    if (cache && clock() < cache.expiresAt) return cache.snapshot;
    if (!pending) {
      pending = refresh(root).then(result => {
        cache = { snapshot: result, expiresAt: clock() + CACHE_MS };
        return result;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  return { snapshot, events: emitter };
}

export function registerTrainingMonitorRoutes(app: FastifyInstance, root: string | undefined) {
  const monitor = createTrainingMonitor({ root });

  // The application's default member gate checks the session and owner role before this handler.
  app.get('/api/training-monitor', async (_request, reply) => {
    const snapshot = await monitor.snapshot();
    if (snapshot) return snapshot;
    const message = root
      ? 'لم يجد موحسن ملفات حالة تدريب قابلة للقراءة على جهاز المالك.'
      : 'مراقبة التدريب متاحة على جهاز المالك الذي يشغّل التدريب.';
    return reply.code(503).send({ error: { code: 'TRAINING_MONITOR_UNAVAILABLE', message } });
  });

  return monitor;
}
