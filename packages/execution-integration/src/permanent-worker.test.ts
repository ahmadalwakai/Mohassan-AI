import { afterEach, describe, expect, it } from 'vitest';
import {
  PermanentModelWorker, type PermanentModelWorkerOptions, type PermanentModelWorkerStatus,
} from './experimental-worker-transport.js';
import { MODEL_WORKER_PROTOCOL } from './permanent-worker-protocol.js';

const identity = { modelId: 'tiny-random', tokenizerId: 'local-tokens', checkpointId: 'pinned-tiny' };
const fixture = String.raw`
  const readline = require('node:readline');
  const { protocol, identity, startup } = JSON.parse(process.argv[1]);
  const send = (frame, callback) => process.stdout.write(JSON.stringify({ protocol, ...frame }) + '\n', callback);
  let total = 0;
  const hanging = new Map();
  const input = readline.createInterface({ input: process.stdin });
  if (startup === 'pin') {
    send({ kind: 'startup_error', code: 'checkpoint_pin_mismatch' }, () => process.exit(1));
  } else if (startup !== 'silent') {
    send({
      kind: 'ready',
      identity: startup === 'wrong-id' ? { ...identity, checkpointId: 'incorrect' } : identity,
      ...(startup === 'bad-config-digest' ? { configSha256: 'invalid' } : {}),
      ...(startup === 'chat' ? { text: true, heads: { 'chat-v5': 'generate' } }
        : { heads: { route: 'classify', text: 'generate', options: 'score-options' } }),
      limits: { maxBatchSize: 2, maxBatchWaitMs: 5, maxPending: 2, maxInputBytes: 2048,
        maxOutputBytes: 2048, maxOutputTokens: 8, maxTimeoutMs: 30000 },
      startupMs: 1,
      device: 'cpu',
      parity: startup === 'chat' ? {} : {
        route: { top1Agreement: 1, maxAbsoluteLogitDifference: 0.001, greedyTokenAgreement: null,
          adopted: true, reason: 'passed', samples: 2 },
      },
    });
  }
  input.on('line', line => {
    const request = JSON.parse(line);
    const { kind, requestId } = request;
    if (kind === 'shutdown') {
      input.close();
      process.stdin.pause();
      return;
    }
    if (kind === 'cancel') {
      if (hanging.get(requestId) === 'hang') {
        hanging.delete(requestId);
        send({ kind: 'error', requestId, code: 'cancelled' });
      }
      return;
    }
    const mode = request.input.mode;
    total++;
    if (mode === 'crash') process.exit(12);
    if (mode === 'hang' || mode === 'ignoreCancel') {
      hanging.set(requestId, mode);
      return;
    }
    if (mode === 'extra') {
      send({ kind: 'result', requestId, result: {}, extra: 'forbidden' });
      return;
    }
    if (mode === 'unknown-id') {
      send({ kind: 'result', requestId: 'unrequested', result: {} });
      return;
    }
    if (mode === 'invalid-utf8') {
      process.stdout.write(Buffer.from([0xc0, 0xa2, 10]));
      return;
    }
    if (mode === 'fragmented') {
      const bytes = Buffer.from(JSON.stringify({ protocol, kind: 'result', requestId, result: { label: 'مرحبا' } }) + '\n');
      const split = bytes.indexOf(Buffer.from('م')) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
      return;
    }
    if (mode === 'over-budget') {
      send({ kind: 'result', requestId, result: { value: 'x'.repeat(4096) } });
      return;
    }
    if (request.operation === 'generate') {
      if (request.input.messages) {
        if (mode === 'token-frame') { send({ kind: 'token', requestId, token: 5, index: 0 }); return; }
        const result = mode === 'context-limit' ? { text: '', stopReason: 'context_limit', loopCut: false }
          : { text: 'أهلاً', stopReason: 'length', loopCut: mode !== 'bad-chat-result' ? true : 'true' };
        send({ kind: 'result', requestId, result });
        return;
      }
      send({ kind: 'token', requestId, token: 5, index: 0 });
      send({ kind: 'token', requestId, token: 2, index: 1 });
      send({ kind: 'result', requestId, result: { tokenIds: mode === 'bad-final' ? [4, 2] : [5, 2], stopReason: 'eos' } });
      return;
    }
    if (request.operation === 'score-options') {
      send({ kind: 'result', requestId, result: { scores: mode === 'short-scores' ? [-2] : [-2, 1] } });
      return;
    }
    send({ kind: 'result', requestId, result: { pid: process.pid, total } });
  });
`;

const workers: PermanentModelWorker[] = [];

function newWorker(overrides: Partial<PermanentModelWorkerOptions> = {}, startup?: string): PermanentModelWorker {
  const worker = new PermanentModelWorker({
    executable: process.execPath,
    args: ['-e', fixture, JSON.stringify({ protocol: MODEL_WORKER_PROTOCOL, identity, startup })],
    cwd: process.cwd(),
    environment: {},
    identity,
    startupTimeoutMs: 2_000,
    cleanupTimeoutMs: 400,
    restartMinMs: 80,
    restartMaxMs: 160,
    ...overrides,
  });
  workers.push(worker);
  return worker;
}

async function ready(worker: PermanentModelWorker) {
  await expect.poll(() => worker.status.state).toBe('ready');
  const status = worker.status;
  if (status.state !== 'ready') throw new Error('Worker lost readiness');
  return status;
}

function classify(worker: PermanentModelWorker, mode = '', timeoutMs?: number, signal?: AbortSignal) {
  return worker.request({ operation: 'classify', head: 'route', input: { mode }, timeoutMs, signal });
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
});

describe('permanent model worker supervision', () => {
  it('starts eagerly, serves concurrent requests and streams generation over a single child', async () => {
    const worker = newWorker();
    expect(worker.status.state).toBe('stopped');
    await expect(classify(worker)).rejects.toMatchObject({ code: 'model_process_failure' });
    worker.start();
    expect(worker.status.state).toBe('starting');
    const status = await ready(worker);
    expect(status.startupMs).toBeGreaterThan(0);
    expect(status.ready).toMatchObject({ identity, device: 'cpu', startupMs: 1 });
    expect(status.ready.parity.route).toEqual({
      top1Agreement: 1, maxAbsoluteLogitDifference: 0.001, greedyTokenAgreement: null,
      adopted: true, reason: 'passed', samples: 2,
    });
    const responses = await Promise.all([classify(worker), classify(worker)]);
    expect(responses).toEqual([{ pid: status.pid, total: 1 }, { pid: status.pid, total: 2 }]);
    await expect(classify(worker, 'fragmented')).resolves.toEqual({ label: 'مرحبا' });

    const tokens: unknown[] = [];
    await expect(worker.request({
      operation: 'generate', head: 'text', input: { maxNewTokens: 2 }, onToken: token => tokens.push(token),
    })).resolves.toEqual({ tokenIds: [5, 2], stopReason: 'eos' });
    expect(tokens).toEqual([{ token: 5, index: 0 }, { token: 2, index: 1 }]);
    await worker.stop();
    expect(worker.status.state).toBe('stopped');
  });

  it('reports degraded, applies backoff, and starts a fresh process without replaying failed requests', async () => {
    const changes: PermanentModelWorkerStatus[] = [];
    const worker = newWorker({ onState: change => changes.push(change) });
    worker.start();
    const first = await ready(worker);
    await expect(classify(worker, 'crash')).rejects.toMatchObject({ code: 'model_process_failure' });
    expect(changes).toContainEqual({ state: 'degraded', code: 'model_process_failure', restartInMs: 80 });
    const second = await ready(worker);
    expect(second.pid).not.toBe(first.pid);
    await expect(classify(worker)).resolves.toEqual({ pid: second.pid, total: 1 });

    await expect(classify(worker, 'crash')).rejects.toMatchObject({ code: 'model_process_failure' });
    expect(changes).toContainEqual({ state: 'degraded', code: 'model_process_failure', restartInMs: 160 });
    const third = await ready(worker);
    expect(third.pid).not.toBe(second.pid);
    await expect(classify(worker)).resolves.toEqual({ pid: third.pid, total: 1 });
  });

  it('cancels and times out individual requests and enforces pending capacity', async () => {
    const worker = newWorker();
    worker.start();
    const { pid } = await ready(worker);
    const cancel = new AbortController();
    const aborted = classify(worker, 'hang', 1_000, cancel.signal);
    const timed = classify(worker, 'hang', 120);
    const timedResult = expect(timed).rejects.toMatchObject({ code: 'timeout' });
    await expect(classify(worker)).rejects.toMatchObject({ code: 'resource_exhaustion' });
    cancel.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });
    await expect(classify(worker, '', 1_000, cancel.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await timedResult;
    await expect.poll(async () => {
      try { return (await classify(worker)).pid; }
      catch { return undefined; }
    }).toBe(pid);
  });

  it('recycles a worker that ignores cancellation', async () => {
    const changes: PermanentModelWorkerStatus[] = [];
    const worker = newWorker({ cleanupTimeoutMs: 100, onState: change => changes.push(change) });
    worker.start();
    const before = await ready(worker);
    await expect(classify(worker, 'ignoreCancel', 50)).rejects.toMatchObject({ code: 'timeout' });
    await expect.poll(() => changes).toContainEqual({ state: 'degraded', code: 'timeout', restartInMs: 80 });
    const after = await ready(worker);
    expect(after.pid).not.toBe(before.pid);
  });

  it.each([
    ['pin', 'checkpoint_pin_mismatch'],
    ['wrong-id', 'model_identity_mismatch'],
    ['bad-config-digest', 'invalid_model_output'],
    ['silent', 'timeout'],
  ])('refuses startup %s', async (startup, code) => {
    const worker = newWorker({ startupTimeoutMs: 400, restartMinMs: 1_000, restartMaxMs: 1_000 }, startup);
    worker.start();
    await expect.poll(() => worker.status).toMatchObject({ state: 'degraded', code });
    await expect(classify(worker)).rejects.toMatchObject({ code: 'model_process_failure' });
    await worker.stop();
    expect(worker.status).toEqual({ state: 'stopped' });
  });

  it.each([
    ['extra', 'invalid_model_output'],
    ['unknown-id', 'invalid_model_output'],
    ['invalid-utf8', 'invalid_model_output'],
    ['over-budget', 'resource_exhaustion'],
  ])('fails closed when the peer sends %s', async (mode, code) => {
    const worker = newWorker({ restartMinMs: 1_000, restartMaxMs: 1_000 });
    worker.start();
    await ready(worker);
    await expect(classify(worker, mode)).rejects.toMatchObject({ code });
    expect(worker.status).toMatchObject({ state: 'degraded', code });
  });

  it('rejects a generation result inconsistent with its stream', async () => {
    const worker = newWorker();
    worker.start();
    await ready(worker);
    await expect(worker.request({
      operation: 'generate', head: 'text', input: { mode: 'bad-final', maxNewTokens: 2 },
    })).rejects.toMatchObject({ code: 'invalid_model_output' });
  });

  it('accepts compact chat results and context limits without streaming provisional tokens', async () => {
    const worker = newWorker({}, 'chat');
    worker.start();
    await ready(worker);
    const input = { messages: [{ role: 'user', content: 'مرحباً' }], maxNewTokens: 2 };
    const request = { operation: 'generate', head: 'chat-v5', input } as const;
    await expect(worker.request(request)).resolves.toEqual({ text: 'أهلاً', stopReason: 'length', loopCut: true });
    await expect(worker.request({ ...request, input: { ...input, mode: 'context-limit' } }))
      .resolves.toEqual({ text: '', stopReason: 'context_limit', loopCut: false });
    await expect(worker.request({ ...request, input: { ...input, mode: 'bad-chat-result' } }))
      .rejects.toMatchObject({ code: 'invalid_model_output' });
  });

  it('rejects a token frame for a nonstreaming chat generation', async () => {
    const worker = newWorker({}, 'chat');
    worker.start();
    await ready(worker);
    await expect(worker.request({ operation: 'generate', head: 'chat-v5',
      input: { messages: [{ role: 'user', content: 'Hello' }], maxNewTokens: 2, mode: 'token-frame' },
    })).rejects.toMatchObject({ code: 'invalid_model_output' });
  });

  it.each(['short-scores', 'positive-score'])('rejects an incompatible closed-list result (%s)', async mode => {
    const worker = newWorker();
    worker.start();
    await ready(worker);
    await expect(worker.request({
      operation: 'score-options', head: 'options', input: { mode, inputIds: [1], options: [[2], [3]] },
    })).rejects.toMatchObject({ code: 'invalid_model_output' });
  });

  it('enforces the generation token budget supplied by the caller', async () => {
    const worker = newWorker();
    worker.start();
    await ready(worker);
    await expect(worker.request({
      operation: 'generate', head: 'text', input: { maxNewTokens: 9 },
    })).rejects.toMatchObject({ code: 'invalid_request' });
    const streamed: number[] = [];
    await expect(worker.request({
      operation: 'generate', head: 'text', input: { maxNewTokens: 1 }, onToken: event => streamed.push(event.token),
    })).rejects.toMatchObject({ code: 'invalid_model_output' });
    expect(streamed).toEqual([5]);
  });
});
