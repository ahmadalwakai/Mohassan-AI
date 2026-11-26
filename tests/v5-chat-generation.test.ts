import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateV5ChatReply, isV5ChatReady } from '../apps/server/src/v5-chat.js';
import { ModelTransportError } from '../packages/execution-integration/src/transport.js';

const { workerFor, record } = vi.hoisted(() => ({ workerFor: vi.fn(), record: vi.fn() }));
vi.mock('../apps/server/src/model-worker.js', () => ({ getServerModelWorker: workerFor }));
vi.mock('../apps/server/src/ops/metrics/index.js', () => ({ recordV5ChatMetrics: record }));

const app = {} as FastifyInstance;
const messages = [{ role: 'user', content: 'كيف حالك؟' }] as const;
const ready = {
  identity: {
    modelId: 'mohassan-chat-v5',
    checkpointId: 'sha256:246983b5a42a9a14de7379c6da7f74a599c3131d58c848ed4b5ad0922aa14c39',
    tokenizerId: 'sha256:297eaad3d1cd08b822fa1b7f215112633873d1603b83846dbf5bf7c48b49cbb7',
  },
  device: 'cpu', text: true, heads: { 'chat-v5': 'generate' },
  limits: { maxInputBytes: 262_144, maxOutputTokens: 192, maxTimeoutMs: 60_000 },
};
const output = { text: '  مرحباً  ', stopReason: 'eos', loopCut: false };
const request = vi.fn();

function pendingWorkerResult() {
  let resolve!: (result: typeof output) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof output>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  workerFor.mockReturnValue({ status: { state: 'ready', ready }, request });
  request.mockResolvedValue(output);
});

afterEach(() => {
  workerFor.mockReset();
  request.mockReset();
  record.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('owner v5 generation', () => {
  it('requires the pinned v5 generate head and records only aggregate metrics', async () => {
    expect(isV5ChatReady(app)).toBe(true);
    await expect(generateV5ChatReply(app, messages)).resolves.toBe('مرحباً');
    await expect(generateV5ChatReply(app, messages)).resolves.toBe('مرحباً');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'generate', head: 'chat-v5', timeoutMs: expect.any(Number),
      input: { messages, temperature: 0.7, topP: 0.9, topK: 0, maxNewTokens: 192, seed: expect.any(Number) },
    }));
    expect(request.mock.calls[0][0].input.seed).not.toBe(request.mock.calls[1][0].input.seed);
    expect(record).toHaveBeenCalledWith(app, {
      generation: true, latencyMs: expect.any(Number), stopReason: 'eos', loopCut: false, timeout: false, fallback: false,
    });

    workerFor.mockReturnValue({ status: { state: 'ready', ready: { ...ready, heads: { lm: 'generate' } } }, request });
    expect(isV5ChatReady(app)).toBe(false);
    workerFor.mockReturnValue({ status: { state: 'ready', ready: { ...ready, identity: { ...ready.identity, checkpointId: 'other' } } }, request });
    expect(isV5ChatReady(app)).toBe(false);
    await expect(generateV5ChatReply(app, messages)).resolves.toBeUndefined();
    expect(record).toHaveBeenLastCalledWith(app, { fallback: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('drops older messages at the transport size limit without truncating the last turn', async () => {
    workerFor.mockReturnValue({ status: { state: 'ready', ready: { ...ready, limits: { ...ready.limits, maxInputBytes: 1024 } } }, request });
    const old = { role: 'user', content: 'ض'.repeat(500) } as const;
    await expect(generateV5ChatReply(app, [old, ...messages])).resolves.toBe('مرحباً');
    expect(request.mock.calls[0][0].input.messages).toEqual(messages);
    await expect(generateV5ChatReply(app, [old])).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('records length stops and cuts, and falls back on empty output, action claims and worker failure', async () => {
    request.mockResolvedValueOnce({ ...output, stopReason: 'length', loopCut: true });
    await expect(generateV5ChatReply(app, messages)).resolves.toBe('مرحباً');
    expect(record).toHaveBeenLastCalledWith(app, expect.objectContaining({ stopReason: 'length', loopCut: true, fallback: false }));
    for (const text of [' \n ', 'I sent the email.', 'تم إرسال الرسالة.', 'The document was saved.']) {
      request.mockResolvedValueOnce({ ...output, text });
      await expect(generateV5ChatReply(app, messages)).resolves.toBeUndefined();
      expect(record).toHaveBeenLastCalledWith(app, expect.objectContaining({ generation: true, fallback: true }));
    }
    request.mockRejectedValueOnce(new ModelTransportError('model_process_failure'));
    await expect(generateV5ChatReply(app, messages)).resolves.toBeUndefined();
    expect(record).toHaveBeenLastCalledWith(app, expect.objectContaining({ generation: true, fallback: true }));
  });

  it('runs one request, queues two and gives queued requests only the remaining time', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const firstResult = pendingWorkerResult();
    const secondResult = pendingWorkerResult();
    request.mockReturnValueOnce(firstResult.promise).mockReturnValueOnce(secondResult.promise);
    const first = generateV5ChatReply(app, messages);
    const second = generateV5ChatReply(app, messages);
    const third = generateV5ChatReply(app, messages);
    await expect(generateV5ChatReply(app, messages)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);

    now = 40_000;
    firstResult.resolve(output);
    await expect(first).resolves.toBe('مرحباً');
    expect(request.mock.calls[1][0].timeoutMs).toBe(20_000);
    now = 59_999;
    secondResult.reject(new ModelTransportError('timeout'));
    await expect(second).resolves.toBeUndefined();
    expect(request.mock.calls[2][0].timeoutMs).toBe(1);
    await expect(third).resolves.toBe('مرحباً');
    expect(record).toHaveBeenCalledWith(app, expect.objectContaining({ generation: true, timeout: true, fallback: true }));
  });

  it('expires an entire queued request after 60 seconds', async () => {
    vi.useFakeTimers();
    const activeResult = pendingWorkerResult();
    request.mockReturnValueOnce(activeResult.promise);
    const active = generateV5ChatReply(app, messages);
    const queued = generateV5ChatReply(app, messages);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(queued).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenLastCalledWith(app, expect.objectContaining({ timeout: true, fallback: true }));
    activeResult.reject(new ModelTransportError('timeout'));
    await expect(active).resolves.toBeUndefined();
  });
});
