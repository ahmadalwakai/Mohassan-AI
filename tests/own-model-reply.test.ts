import { OwnModelProvider } from '@mohassan/providers/own-model';
import { describe, expect, it, vi } from 'vitest';
import { createOwnModelReply } from '../apps/server/src/assistant/own-model-reply.js';
import { ROUTES, type Route } from '../apps/server/src/assistant/router.js';
import { loadOwnModelGates, type OwnModelGates } from '../apps/server/src/own-model-gates.js';
import { ownModelTestPython, startOwnModelTestWorker } from './fixtures/own-model-worker.js';

const workerSha = 'a'.repeat(64);
const routerSha = 'b'.repeat(64);
const calibration = { temperature: 2, minConfidence: 0.7, minMargin: 0.3 };
const identity = { modelId: 'test', tokenizerId: 'test', checkpointId: 'test' };
const quote = 'Tokyo is the capital of Japan.';
const url = 'https://example.test/japan';
const request = 'What is the capital of Japan?';
const signal = new AbortController().signal;
const reply = `${quote}\n\n**Source:** [Japan](${url})`;
const phraseInput = {
  plan: { next: 1, steps: [{ kind: 'search' as const, query: request, site: null, ask: true }], lang: 'en' as const,
    found: { url, title: 'Japan', lines: [quote] } },
  reply, status: 'completed', question: request, signal,
  evidence: [{ kind: 'page' as const, text: quote, url, title: 'Japan' }],
};

function setup(gates: OwnModelGates, expectedRouterSha = routerSha) {
  const choose = vi.fn<Parameters<typeof createOwnModelReply>[0]['provider']['choose']>();
  const generate = vi.fn<Parameters<typeof createOwnModelReply>[0]['provider']['generate']>();
  const scores: Partial<Record<Route, number>> = { web_search: 4, news: 3, chat: 2 };
  const bias = Float32Array.from(ROUTES, route => scores[route] ?? 0);
  const router = vi.fn(async () => ({ headerSha256: expectedRouterSha, buckets: 1, dim: 1, routes: ROUTES,
    embedding: new Float32Array(1), weight: new Float32Array(ROUTES.length), bias }));
  const record = vi.fn();
  const service = createOwnModelReply({
    provider: { choose, generate, health: () => ({ state: 'ready', identity, configSha256: workerSha, generation: true, decisions: true }) },
    gates: () => gates, router, record,
  });
  return { service, choose, generate, router, record };
}

function testGates(...enabled: string[]): OwnModelGates {
  return { get: vi.fn((capability, digest) => digest === workerSha && enabled.includes(capability)
    ? capability === 'phrasing' ? { mode: 'active' } : { mode: 'shadow', calibration, routerSha256: routerSha }
    : undefined) } as OwnModelGates;
}

describe('own model reply integration', () => {
  it('does not load the router, score or generate without a pinned capability even with a ready worker', async () => {
    const { service, choose, generate, router, record } = setup(await loadOwnModelGates());
    await service.observe({ request, earlierUserTurns: ['Where is Japan?'], signal, route: 'web_search' });
    expect(await service.phrase(phraseInput)).toBe(reply);
    expect(choose).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(router).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.skipIf(!ownModelTestPython)('makes no model calls without pinned gates even when the real worker is ready', async () => {
    const { worker, stop } = await startOwnModelTestWorker();
    try {
      const provider = new OwnModelProvider({ worker: () => worker });
      expect(provider.health()).toMatchObject({ state: 'ready', generation: true, decisions: true });
      const workerRequest = vi.spyOn(worker, 'request');
      const gates = await loadOwnModelGates();
      const router = vi.fn(async () => null);
      const service = createOwnModelReply({ provider, gates: () => gates, router, record: vi.fn() });
      await service.observe({ request, earlierUserTurns: ['Where is Japan?'], signal, route: 'web_search' });
      expect(await service.phrase(phraseInput)).toBe(reply);
      expect(workerRequest).not.toHaveBeenCalled();
      expect(router).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });

  it('offers exactly the scored top three router candidates without changing the route', async () => {
    const { service, choose, generate, record } = setup(testGates('route-choice'));
    choose.mockImplementation(async input => ({ option: input.options[0].id, confidence: 0.8 }));
    await expect(service.observe({ request, earlierUserTurns: ['Where is Japan?'], signal, route: 'chat' })).resolves.toBeUndefined();
    expect(choose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      options: [{ id: 'web_search', label: 'web search' }, { id: 'news', label: 'news' }, { id: 'chat', label: 'chat' }],
      calibration, signal, expectedConfigSha256: workerSha,
    }));
    expect(record).toHaveBeenCalledExactlyOnceWith({
      event: 'own_model_reply', capability: 'route-choice', outcome: 'chosen', agreed: false, baselineInOptions: true, latencyMs: expect.any(Number),
    });
    expect(await service.phrase(phraseInput)).toBe(reply);
    expect(generate).not.toHaveBeenCalled();
  });

  it('skips route scoring when the router artifact is different from the one the gate evaluated', async () => {
    const { service, choose } = setup(testGates('route-choice'), 'c'.repeat(64));
    await service.observe({ request, earlierUserTurns: [], signal, route: 'web_search' });
    expect(choose).not.toHaveBeenCalled();
  });

  it('scores contextual turn types independently and records abstention and agreement', async () => {
    const { service, choose, router, record } = setup(testGates('follow-up-turn-type'));
    await service.observe({ request, earlierUserTurns: [], signal, route: 'web_search' });
    expect(choose).not.toHaveBeenCalled();

    choose.mockResolvedValueOnce({ option: null, confidence: 0.2 });
    choose.mockImplementationOnce(async input => ({
      option: input.options.find(option => option.id === 'follow_up_property')!.id, confidence: 0.9,
    }));
    const followUp = { request: 'And its population?', earlierUserTurns: [request], signal, route: 'web_search' };
    await service.observe(followUp);
    await service.observe(followUp);
    expect(router).not.toHaveBeenCalled();
    expect(choose.mock.calls[0][0]).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ id: 'follow_up_property' })]),
      calibration, signal, expectedConfigSha256: workerSha,
    });
    expect(record.mock.calls).toEqual([
      [expect.objectContaining({ capability: 'follow-up-turn-type', outcome: 'abstained', latencyMs: expect.any(Number) })],
      [expect.objectContaining({ capability: 'follow-up-turn-type', outcome: 'chosen', agreed: true, latencyMs: expect.any(Number) })],
    ]);
  });

  it('records judge rejections without recording evidence or publishing the candidate', async () => {
    const { service, generate, record } = setup(testGates('phrasing'));
    generate.mockResolvedValue({ text: 'Penguins nest on exposed rock.', model: 'test', provider: 'test', usage: { inputTokens: 1, outputTokens: 1 } });
    expect(await service.phrase(phraseInput)).toBe(reply);
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedConfigSha256: workerSha, signal }));
    expect(record).toHaveBeenCalledExactlyOnceWith({
      event: 'own_model_reply', capability: 'phrasing', outcome: 'rejected', judgeRejected: true, latencyMs: expect.any(Number),
    });
  });
});
