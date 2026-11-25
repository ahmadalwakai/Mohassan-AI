import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerTestDrivenCoding } from '../apps/server/src/assistant/test-driven-coding/reply.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

const prompt = 'Implement a Python function to combine two adjustments.\nassert add_adjustments(21, -9) == 12';
const searchTimeout = { status: 'failed', reason: 'assertion-failed', searchLimit: 'search-cpu-time', tried: 1 };

function answer() {
  vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
  return answerTestDrivenCoding(prompt, { authorized: true, signal: new AbortController().signal,
    originalHash: createHash('sha256').update(prompt).digest('hex'), scrub: text => text });
}

function respond(result: object, delay = 0) {
  execFile.mockImplementationOnce((_program, _args, _options, callback) => {
    setTimeout(() => callback(null, JSON.stringify(result)), delay);
    return {};
  });
}

afterEach(() => {
  execFile.mockReset();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform !== 'linux')('verified Python search timeout recovery', () => {
  it('retries once with the same isolation launch and the remaining wall budget', async () => {
    respond(searchTimeout, 20);
    respond({ status: 'passed', source: 'def add_adjustments(a, b):\n    return a + b\n' });
    expect(await answer()).toMatchObject({ status: 'completed', verification: { reason: 'passed', searchLimit: 'search-cpu-time' } });
    expect(execFile).toHaveBeenCalledTimes(2);
    const [first, second] = execFile.mock.calls;
    expect(first[0]).toBe('python3');
    expect(first[1].slice(0, 3)).toEqual(['-I', '-B', '-S']);
    expect(second[1]).toEqual(first[1]);
    expect(first[2]).toMatchObject({ timeout: 2500, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' });
    expect(second[2]).toEqual({ ...first[2], timeout: expect.any(Number) });
    expect(second[2].timeout).toBeGreaterThan(0);
    expect(second[2].timeout).toBeLessThan(first[2].timeout);
  });

  it('keeps a failed second search blocked without retrying again', async () => {
    respond(searchTimeout);
    respond(searchTimeout);
    expect(await answer()).toMatchObject({ status: 'blocked', verification: { reason: 'assertion-failed', searchLimit: 'search-cpu-time' } });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('keeps an assertion failure without a search deadline blocked after one attempt', async () => {
    respond({ status: 'failed', reason: 'assertion-failed', tried: 1 });
    expect(await answer()).toMatchObject({ status: 'blocked', verification: { reason: 'assertion-failed' } });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('does not retry a worker killed at the wall deadline', async () => {
    execFile.mockImplementationOnce((_program, _args, _options, callback) => {
      callback({ killed: true, signal: 'SIGKILL' }, '');
      return {};
    });
    expect(await answer()).toMatchObject({ status: 'blocked', verification: { reason: 'worker-wall-time' } });
    expect(execFile).toHaveBeenCalledOnce();
  });
});
