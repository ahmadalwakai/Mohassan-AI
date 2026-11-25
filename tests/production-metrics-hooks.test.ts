import Fastify from 'fastify';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { registerRequestMetrics } from '../apps/server/src/ops/metrics/request.js';
import { sampleProcessResources, type ProcessResources } from '../apps/server/src/ops/metrics/resources.js';

it('records a Fastify route pattern and leaves responses alone when the collector fails', async () => {
  const app = Fastify();
  const sink = vi.fn<Parameters<typeof registerRequestMetrics>[2]>(() => { throw new Error('fixture collector failure'); });
  registerRequestMetrics(app, () => Promise.resolve('owner'), sink);
  app.get('/fixture/:id', async (_request, reply) => reply.code(500).send({ ok: false }));
  try {
    expect((await app.inject('/fixture/private-id?private-query=value')).statusCode).toBe(500);
    expect((await app.inject('/unmatched/private-id')).statusCode).toBe(404);
    await setImmediate();
    expect(sink).toHaveBeenCalledExactlyOnceWith('owner', 'GET /fixture/:id', 500, expect.any(Number));
    expect(sink.mock.calls[0]?.[3]).toBeGreaterThanOrEqual(0);
  } finally {
    await app.close();
  }
});

it('samples process resources every 30 seconds and stops on cleanup', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const observations: ProcessResources[] = [];
  const stop = sampleProcessResources(sample => observations.push(sample));
  try {
    vi.advanceTimersByTime(29_999);
    expect(observations).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.heapUsedBytes).toBeGreaterThan(0);
    expect(observations[0]!.rssBytes).toBeGreaterThan(0);
    expect(observations[0]!.openHandles).toBeGreaterThanOrEqual(0);
    vi.advanceTimersByTime(30_000);
    expect(observations).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(30_000);
    expect(observations).toHaveLength(2);
  } finally {
    stop();
    vi.useRealTimers();
  }
});
