import { constants } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGpuSampler } from '../apps/server/src/training-monitor/gpu.ts';

const mocked = vi.hoisted(() => ({
  execFile: vi.fn(),
  getPriority: vi.fn(),
  setPriority: vi.fn(),
  kill: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: mocked.execFile }));
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(),
  getPriority: mocked.getPriority,
  setPriority: mocked.setPriority,
}));

const firstGpu = { temperatureC: 80, utilizationPercent: 96, memoryUsedMiB: 3650 };

function mockCommand(error: Error | null, stdout = '', pid: number | null = 321) {
  mocked.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout));
    return { pid: pid ?? undefined, kill: mocked.kill };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.getPriority.mockReturnValue(constants.priority.PRIORITY_NORMAL);
});

describe('training GPU sampling', () => {
  it('runs the read-only query with a five-second timeout and lowers only the telemetry child priority', async () => {
    mockCommand(null, '80, 96, 3650\r\n');
    await expect(createGpuSampler()()).resolves.toEqual(firstGpu);
    expect(mocked.execFile).toHaveBeenCalledExactlyOnceWith('nvidia-smi', [
      '--query-gpu=temperature.gpu,utilization.gpu,memory.used',
      '--format=csv,noheader,nounits',
    ], expect.objectContaining({ timeout: 5000, killSignal: 'SIGKILL', windowsHide: true }), expect.any(Function));
    expect(mocked.getPriority).toHaveBeenCalledExactlyOnceWith(321);
    expect(mocked.setPriority).toHaveBeenCalledExactlyOnceWith(321, constants.priority.PRIORITY_BELOW_NORMAL);
    expect(mocked.kill).not.toHaveBeenCalled();
  });

  it('keeps an already lower process priority', async () => {
    mockCommand(null, '80, 96, 3650');
    mocked.getPriority.mockReturnValue(constants.priority.PRIORITY_LOW);
    await expect(createGpuSampler()()).resolves.toEqual(firstGpu);
    expect(mocked.setPriority).not.toHaveBeenCalled();
  });

  it('discards the sample and stops the telemetry child if its priority cannot be lowered', async () => {
    mockCommand(null, '80, 96, 3650');
    mocked.setPriority.mockImplementation(() => { throw new Error('access denied'); });
    await expect(createGpuSampler()()).resolves.toBeNull();
    expect(mocked.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('shares one in-flight sample and caches it for at least thirty seconds', async () => {
    let resolveFirstQuery!: (stdout: string) => void;
    const firstQuery = new Promise<string>(resolve => { resolveFirstQuery = resolve; });
    const query = vi.fn().mockReturnValueOnce(firstQuery).mockResolvedValue('81, 77, 3300');
    let now = 0;
    const sample = createGpuSampler(query, () => now);

    const pending = sample();
    expect(sample()).toBe(pending);
    now = 30_000;
    expect(sample()).toBe(pending);
    resolveFirstQuery('80, 96, 3650\r\n55, 20, 100');
    await expect(pending).resolves.toEqual(firstGpu);

    now = 59_999;
    expect(sample()).toBe(pending);
    expect(query).toHaveBeenCalledOnce();
    now = 60_000;
    await expect(sample()).resolves.toEqual({ temperatureC: 81, utilizationPercent: 77, memoryUsedMiB: 3300 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns and caches an unavailable sample after a command failure until the next eligible request', async () => {
    mockCommand(new Error('command timed out'));
    let now = 0;
    const sample = createGpuSampler(undefined, () => now);

    await expect(sample()).resolves.toBeNull();
    now = 29_999;
    await expect(sample()).resolves.toBeNull();
    expect(mocked.execFile).toHaveBeenCalledOnce();
    now = 30_000;
    expect(mocked.execFile).toHaveBeenCalledOnce();
    mockCommand(null, '80, 96, 3650');
    await expect(sample()).resolves.toEqual(firstGpu);
    expect(mocked.execFile).toHaveBeenCalledTimes(2);
  });

  it('returns an unavailable sample if nvidia-smi is absent', async () => {
    mockCommand(new Error('spawn nvidia-smi ENOENT'), '', null);
    await expect(createGpuSampler()()).resolves.toBeNull();
    expect(mocked.getPriority).not.toHaveBeenCalled();
    expect(mocked.kill).not.toHaveBeenCalled();
  });

  it.each(['', '[N/A], 96, 3650', '80, 96', '80, 101, 3650', '80,,3650'])('rejects malformed output %j', async stdout => {
    await expect(createGpuSampler(async () => stdout)()).resolves.toBeNull();
  });
});
