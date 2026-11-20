import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
import { createAdsModelWorker, type AdsModelWorker, type AdsWorkerConfig } from '../apps/server/src/ads-lab.ts';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Record<string, unknown>[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.requests.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });
  readonly kill = vi.fn(() => true);
  send(message: unknown) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  ready(overrides: Record<string, unknown> = {}) {
    this.send({ ready: true, device: 'cpu', parameters: 1000, finetune_step: 12, prompt_hint: null,
      tokenizer_identity: 'tokenizer-test', config_identity: 'config-test', context: 1024,
      checkpoint_sha256: 'a'.repeat(64), languages: ['ar', 'en'], ...overrides });
  }
  answer(text = 'verified answer') {
    const request = this.requests.at(-1);
    if (!request) throw new Error('No generation request');
    this.send({ id: request.id, candidates: [{ text, finished: true }], ms: 9 });
  }
}

const config: AdsWorkerConfig = { run: 'C:/fixture-run', finetune: 'fixture-v1', python: 'python.exe', packageDir: 'C:/fixture-package',
  device: 'cpu', startupTimeoutMs: 500, requestTimeoutMs: 100 };
let children: FakeChild[];
let workers: AdsModelWorker[];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function worker(overrides: Partial<AdsWorkerConfig> = {}) {
  const result = createAdsModelWorker({ ...config, ...overrides });
  workers.push(result);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  workers = [];
  mocked.spawn.mockReset().mockImplementation(() => {
    const process = new FakeChild();
    children.push(process);
    return process as unknown as ChildProcessWithoutNullStreams;
  });
});
afterEach(() => {
  workers.forEach(instance => instance.stop());
  children.forEach(process => { process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy(); });
  vi.useRealTimers();
});

describe('local Ads worker lifecycle', () => {
  it('kills a timed-out generation, starts its queued successor, and ignores the old exit and output', async () => {
    const instance = worker();
    const first = instance.sample('first', {}, 1).catch(error => error);
    const second = instance.sample('second', {}, 1);
    await flush();
    const old = children[0]!;
    old.ready();
    await flush();
    expect(old.requests).toHaveLength(1);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(await first).toMatchObject({ code: 'TIMEOUT', statusCode: 504 });
    expect(old.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
    const fresh = children[1]!;
    old.emit('exit', 1);
    old.ready();
    expect(instance.info().state).toBe('starting');
    fresh.ready();
    await flush();
    expect(fresh.requests[0]?.prompt).toBe('second');
    old.answer('stale answer');
    old.emit('exit', 0);
    expect(instance.info().state).toBe('ready');
    fresh.answer('fresh answer');
    await expect(second).resolves.toEqual({ candidates: [{ text: 'fresh answer', finished: true }], ms: 9 });
    expect(fresh.kill).not.toHaveBeenCalled();
  });

  it('cancels during startup without stranding the queue or letting an old handshake restore readiness', async () => {
    const instance = worker();
    const abort = new AbortController();
    const cancelled = instance.sample('cancel me', {}, 1, { signal: abort.signal }).catch(error => error);
    const later = instance.sample('next', {}, 1);
    await flush();
    const old = children[0]!;
    abort.abort();
    await flush();
    expect(await cancelled).toMatchObject({ code: 'WORKER_STOPPED' });
    expect(old.kill).toHaveBeenCalledOnce();
    expect(children).toHaveLength(2);
    old.ready();
    old.emit('exit', 1);
    expect(instance.info().state).toBe('starting');
    const fresh = children[1]!;
    fresh.ready();
    await flush();
    fresh.answer();
    await expect(later).resolves.toMatchObject({ candidates: [{ text: 'verified answer' }] });
  });

  it('does not start a process for an already-cancelled request', async () => {
    const instance = worker();
    const abort = new AbortController();
    abort.abort();
    await expect(instance.sample('cancelled', {}, 1, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it('recovers after a startup timeout', async () => {
    const instance = worker();
    const first = instance.sample('first', {}, 1).catch(error => error);
    await flush();
    await vi.advanceTimersByTimeAsync(501);
    expect(await first).toMatchObject({ code: 'WORKER_FAILED' });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    const retry = instance.sample('retry', {}, 1);
    await flush();
    children[1]!.ready();
    await flush();
    children[1]!.answer();
    await expect(retry).resolves.toMatchObject({ ms: 9 });
  });

  it('rejects a different checkpoint before sending a prompt to it', async () => {
    const expected = 'a'.repeat(64);
    const instance = worker({ expectedCheckpointSha256: expected });
    const result = instance.sample('private prompt', {}, 1).catch(error => error);
    await flush();
    expect(mocked.spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--checkpoint-sha256', expected]));
    children[0]!.ready({ checkpoint_sha256: 'b'.repeat(64) });
    expect(await result).toMatchObject({ code: 'WORKER_FAILED' });
    expect(children[0]!.requests).toHaveLength(0);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('rejects malformed candidates and permits a later valid request', async () => {
    const instance = worker();
    const bad = instance.sample('first', {}, 1).catch(error => error);
    await flush();
    children[0]!.ready();
    await flush();
    children[0]!.send({ id: children[0]!.requests[0]!.id, candidates: [{ text: 17, finished: 'yes' }], ms: 9 });
    expect(await bad).toMatchObject({ code: 'BAD_MODEL_RESPONSE', statusCode: 502 });
    const good = instance.sample('second', {}, 1);
    await flush();
    children.at(-1)!.answer();
    await expect(good).resolves.toMatchObject({ ms: 9 });
  });

  it.each([
    { parameters: -1 }, { parameters: '1000' }, { device: 'remote' }, { context: 0 },
    { tokenizer_identity: '' }, { config_identity: '   ' }, { finetune_step: -2 },
    { languages: ['unknown'] }, { checkpoint_sha256: 'not-a-digest' },
  ])('rejects malformed ready metadata %j before sending requests', async invalid => {
    const instance = worker();
    const result = instance.sample('do not send', {}, 1).catch(error => error);
    await flush();
    children[0]!.ready(invalid);
    expect(await result).toMatchObject({ code: 'WORKER_FAILED' });
    expect(children[0]!.requests).toHaveLength(0);
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it.each([
    { candidates: [], ms: 0 },
    { candidates: [{ text: 'ok', finished: true }], ms: -1 },
    { candidates: [{ text: 'ok', finished: true }], ms: '9' },
    { candidates: [{ text: 'ok', finished: true }], ms: null },
    { candidates: [{ text: 'ok', finished: true }], ms: undefined },
    { candidates: Array.from({ length: 9 }, () => ({ text: 'ok', finished: true })), ms: 1 },
  ])('rejects an empty, oversized or invalid-duration response %j', async invalid => {
    const instance = worker();
    const result = instance.sample('first', {}, 1).catch(error => error);
    await flush();
    children[0]!.ready();
    await flush();
    children[0]!.send({ id: children[0]!.requests[0]!.id, ...invalid });
    expect(await result).toMatchObject({ code: 'BAD_MODEL_RESPONSE', statusCode: 502 });
  });

  it('rejects nonfinite durations from JSON numeric overflow', async () => {
    const instance = worker();
    const result = instance.sample('first', {}, 1).catch(error => error);
    await flush();
    children[0]!.ready();
    await flush();
    const id = children[0]!.requests[0]!.id;
    children[0]!.stdout.write(`{"id":${JSON.stringify(id)},"candidates":[{"text":"ok","finished":true}],"ms":1e400}\n`);
    expect(await result).toMatchObject({ code: 'BAD_MODEL_RESPONSE' });
  });

  it.each([null, 'text', 17, false])('handles malformed non-object JSON frame %j without throwing or hanging', async frame => {
    const instance = worker();
    const result = instance.sample('first', {}, 1).catch(error => error);
    await flush();
    children[0]!.ready();
    await flush();
    expect(() => children[0]!.send(frame)).not.toThrow();
    expect(await result).toMatchObject({ code: 'WORKER_FAILED' });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it('can retry after synchronous process creation failure', async () => {
    mocked.spawn.mockImplementationOnce(() => { throw new Error('spawn denied'); });
    const instance = worker();
    const failed = instance.sample('first', {}, 1).catch(error => error);
    expect(await failed).toBeInstanceOf(Error);
    const retry = instance.sample('retry', {}, 1).catch(error => error);
    await flush();
    expect(mocked.spawn).toHaveBeenCalledTimes(2);
    children[0]!.ready();
    await flush();
    children[0]!.answer();
    expect(await retry).toMatchObject({ ms: 9 });
  });
});
