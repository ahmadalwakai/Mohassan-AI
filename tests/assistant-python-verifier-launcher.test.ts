import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerTestDrivenCoding, initializeTestDrivenCoding } from '../apps/server/src/assistant/test-driven-coding/reply.js';

const { access, execFile, realpath, stat } = vi.hoisted(() => ({
  access: vi.fn(), execFile: vi.fn(), realpath: vi.fn(), stat: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), access, realpath, stat,
}));

const prompt = 'Write a Python function to add two numbers.\nassert add(2, 3) == 5';
const originalHash = createHash('sha256').update(prompt).digest('hex');
const passed = { status: 'passed', source: 'def add(a, b):\n    return a + b\n' };
const trustedExecutable = { isFile: () => true, uid: 0, mode: 0o755 };
const permissionDenied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

function answer(accountId: string) {
  return answerTestDrivenCoding(prompt, { accountId, authorized: true, signal: new AbortController().signal,
    originalHash, scrub: text => text });
}

function respond(stdout: string) {
  execFile.mockImplementationOnce((_program, _args, _options, callback) => {
    callback(null, stdout);
    return {};
  });
}

function holdWorker() {
  return new Promise<() => void>(resolve => {
    execFile.mockImplementationOnce((_program, _args, _options, callback) => {
      resolve(() => callback(null, JSON.stringify(passed)));
      return {};
    });
  });
}

describe.skipIf(process.platform !== 'linux')('verified Python launcher', () => {
  beforeEach(() => {
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    vi.spyOn(process, 'geteuid').mockReturnValue(1000);
    access.mockRejectedValue(permissionDenied);
    realpath.mockImplementation(async path => path);
    stat.mockResolvedValue(trustedExecutable);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('rejects a relative interpreter at startup without consulting PATH', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', 'python3');
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(await answer('relative-interpreter')).toMatchObject({ verification: { reason: 'worker-start-failed' } });
    expect(realpath).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects an interpreter writable by the service user before running it', async () => {
    const python = '/trusted/writable/python3';
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', python);
    access.mockResolvedValueOnce(undefined);
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(access).toHaveBeenCalledWith(python, constants.W_OK);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects an interpreter the service can replace through a writable parent', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', '/trusted/writable-parent/python3');
    access.mockRejectedValueOnce(permissionDenied).mockResolvedValueOnce(undefined);
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(access).toHaveBeenCalledWith('/trusted/writable-parent', constants.W_OK);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects a non-root-owned interpreter before executing it', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', '/trusted/non-root/python3');
    stat.mockResolvedValueOnce({ ...trustedExecutable, uid: 2000 });
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects an interpreter older than Python 3.11 after the version probe', async () => {
    const python = '/trusted/old/python3';
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', python);
    respond('3 10\n');
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(await answer('old-interpreter')).toMatchObject({ verification: { reason: 'worker-start-failed' } });
    expect(execFile).toHaveBeenCalledExactlyOnceWith(python, ['-I', '-B', '-S', '-c', expect.any(String)],
      expect.objectContaining({ env: {}, timeout: 2500, killSignal: 'SIGKILL' }), expect.any(Function));
  });

  it('refuses to start the worker as root', async () => {
    vi.spyOn(process, 'geteuid').mockReturnValue(0);
    expect(await initializeTestDrivenCoding()).toBeNull();
    expect(await answer('root-account')).toMatchObject({ verification: { reason: 'isolation-unavailable' } });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('uses the validated absolute interpreter and fails closed when isolation is unavailable', async () => {
    const python = '/trusted/verified/python3.11';
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', '/trusted/verified/python3');
    realpath.mockResolvedValueOnce(python);
    respond('3 11\n');
    expect(await initializeTestDrivenCoding()).toBe(python);
    respond(JSON.stringify({ status: 'unavailable', reason: 'isolation-unavailable' }));
    expect(await answer('isolation-unavailable')).toMatchObject({ status: 'blocked', verification: { reason: 'isolation-unavailable' } });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenLastCalledWith(python, ['-I', '-B', '-S', expect.stringMatching(/\/worker\.py$/u)],
      expect.objectContaining({ env: {}, timeout: 2500, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' }), expect.any(Function));
  });

  it('limits each account through completion and cooldown while keeping two global slots', async () => {
    vi.stubEnv('TEST_DRIVEN_CODING_PYTHON', '/trusted/concurrency/python3');
    respond('3 12\n');
    await initializeTestDrivenCoding();

    const firstStarted = holdWorker();
    const first = answer('first');
    const finishFirst = await firstStarted;
    const busy = { status: 'blocked', verification: { reason: 'busy' } };
    expect(await answer('first')).toMatchObject(busy);

    const secondStarted = holdWorker();
    const second = answer('second');
    const finishSecond = await secondStarted;
    expect(await answer('third')).toMatchObject(busy);

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    finishFirst();
    expect(await first).toMatchObject({ status: 'completed' });
    expect(await answer('first')).toMatchObject(busy);
    await vi.advanceTimersByTimeAsync(250);
    respond(JSON.stringify(passed));
    expect(await answer('first')).toMatchObject({ status: 'completed' });
    finishSecond();
    expect(await second).toMatchObject({ status: 'completed' });
    await vi.advanceTimersByTimeAsync(250);
    expect(execFile).toHaveBeenCalledTimes(4);
  });
});
