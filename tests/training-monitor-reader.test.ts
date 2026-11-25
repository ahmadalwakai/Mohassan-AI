import { constants, createWriteStream, open as openCallback, openSync } from 'node:fs';
import { open, appendFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTrainingRunReader,
  readTrainingJsonlTail,
} from '../apps/server/src/training-monitor/reader';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const observed = {
    open: vi.fn(fs.open),
    appendFile: vi.fn(fs.appendFile),
    mkdir: vi.fn(fs.mkdir),
    rename: vi.fn(fs.rename),
    rm: vi.fn(fs.rm),
    unlink: vi.fn(fs.unlink),
    writeFile: vi.fn(fs.writeFile),
  };
  return { ...fs, ...observed, default: { ...fs, ...observed } };
});

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const observed = {
    open: vi.fn(fs.open),
    openSync: vi.fn(fs.openSync),
    createWriteStream: vi.fn(fs.createWriteStream),
  };
  return { ...fs, ...observed, default: { ...fs, ...observed } };
});

const NOW = Date.parse('2026-11-25T00:08:00Z');
const RUN = 'text-b5-2026-11-23';
const SHAPE = '85m';
const PROCESSED = 494_355_456;
const TOTAL = 1_000_000_000;

let root: string;
let shape: string;
let campaign: string;
let readTrainingRuns: ReturnType<typeof createTrainingRunReader>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mohassan-training-reader-'));
  shape = join(root, 'artifacts', 'execution-model-runs', RUN, SHAPE);
  campaign = join(root, 'artifacts', 'chat-training', 'v5', 'foundation-20261123');
  readTrainingRuns = createTrainingRunReader();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function status(fields: Record<string, unknown> = {}, path = shape) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'status.json'), JSON.stringify({
    status: 'running',
    step: 60_350,
    processed_tokens: PROCESSED,
    language_tokens: { ar: 247_177_728, en: 247_177_728 },
    best_weighted_validation_loss: 2.679,
    best_step: 48_832,
    best_checkpoint_sha256: 'a'.repeat(64),
    last_validation: { ar: 2.5486, en: 2.8095 },
    minutes: 1343.34,
    updated_at: '2026-11-25T00:07:28Z',
    settings: {
      total_tokens: TOTAL,
      checkpoint_every_tokens: 100_000_000,
      exact_token_milestones: [100_000_000, 400_000_000, 500_000_000, TOTAL],
    },
    ready_for_chat: false,
    last_checkpoint_tokens: 400_000_000,
    best_checkpoint_tokens: 400_000_000,
    attempt: join(campaign, 'attempt-current'),
    ...fields,
  }));
}

function speedRow(activeSeconds: number, rate: number, slowSeconds = 0) {
  return {
    time: new Date(NOW - (31_547 - activeSeconds) * 1000).toISOString(),
    run: SHAPE,
    active_training_seconds: activeSeconds,
    tokens_per_second: rate,
    first_minute_tokens_per_second: 7175.2,
    consecutive_slow_seconds: slowSeconds,
  };
}

async function logs(path: string, name: string, rows: object[]) {
  await writeFile(join(path, name), rows.map(row => JSON.stringify(row) + '\n').join(''));
}

async function attempt(id = 'attempt-current', started = '2026-11-24T15:22:00Z') {
  const path = join(campaign, id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'gpu-start.json'), JSON.stringify({
    start_time: started,
    pid: 100,
    stage: 'v5-2-foundation',
    nvidia_smi: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096, 242, 0',
  }));
  return path;
}

async function checkpoint(tokens: number, losses: Record<string, number>) {
  const directory = join(shape, 'checkpoints', `tokens-${String(tokens).padStart(12, '0')}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    tokens, fixed_reference_validation_loss: losses,
  }));
  return directory;
}

describe('training monitor reader', () => {
  it('reports active and recent shapes, progress, average speed, both ETAs, validation and the GPU lock', async () => {
    await status();
    await status({ status: 'completed', updated_at: '2026-11-24T00:00:00Z', attempt: null },
      join(root, 'artifacts', 'execution-model-runs', RUN, '38m'));
    const current = await attempt();
    await logs(current, 'training-speed.jsonl', [
      speedRow(29_730, 9_000), speedRow(31_530, 6000), speedRow(31_535, 6530.2),
    ]);
    await logs(current, 'log.jsonl', [{ step: 60_350, validation: { ar: 2.6, en: 2.8095 } }]);
    await checkpoint(400_000_000, { ar: 2.4, en: 2.8 });
    await checkpoint(450_000_000, { ar: 2.5, en: 2.7 });
    await writeFile(join(shape, 'checkpoints', 'tokens-000999999999'), 'not a checkpoint directory');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'gpu.lock'), JSON.stringify({
      owner: 'local owner', purpose: 'foundation run', pid: 100, started: '2026-11-24T15:22:00Z',
    }));

    const snapshot = await readTrainingRuns(root, NOW);
    expect(snapshot?.recent.map(run => run.shape)).toEqual(['38m']);
    const active = snapshot?.active;
    expect(active).toMatchObject({
      run: RUN, shape: SHAPE, status: 'running', processedTokens: PROCESSED, totalTokens: TOTAL,
      step: 60_350, updatedAt: '2026-11-25T00:07:28.000Z', stopRequested: false, currentAttempt: 'attempt-current',
      lastValidation: { ar: 2.5486, en: 2.8095 }, bestValidation: { ar: 2.4, en: 2.7 },
      lastCheckpoint: { tokens: 450_000_000, savedAt: expect.any(String) },
    });
    expect(active?.percentDone).toBeCloseTo(49.4355456);
    expect(active?.speed).toMatchObject({
      current: 6530.2, average30Minutes: 6265.1, averageWindowSeconds: 10,
      firstMinute: 7175.2, consecutiveSlowSeconds: 0, sampledAt: '2026-11-25T00:07:48.000Z',
    });
    expect(active?.etaAt).toBe(new Date(NOW + (TOTAL - PROCESSED) / 6265.1 * 1000).toISOString());
    expect(active?.nextCheckpoint).toEqual({
      tokens: 500_000_000,
      etaAt: new Date(NOW + (500_000_000 - PROCESSED) / 6265.1 * 1000).toISOString(),
    });
    expect(snapshot?.gpuLock).toEqual({
      owner: 'local owner', purpose: 'foundation run', pid: 100, started: '2026-11-24T15:22:00.000Z',
    });
  });

  it('returns a signed guard-line distance and the trainer’s consecutive slow seconds', async () => {
    await status();
    const current = await attempt();
    await logs(current, 'training-speed.jsonl', [speedRow(31_530, 6500), speedRow(31_535, 4800, 95)]);
    const speed = (await readTrainingRuns(root, NOW))?.active?.speed;
    expect(speed?.guardLine).toBeCloseTo(5022.64);
    expect(speed?.distanceFromGuardLine).toBeCloseTo(-222.64);
    expect(speed?.consecutiveSlowSeconds).toBe(95);
  });

  it('combines overlapping tails to reach a complete 30-minute window and resets on a different attempt', async () => {
    const first = await attempt();
    await status();
    const rows = (from: number, to: number, rate: number) => {
      const lines = [];
      for (let elapsed = from; elapsed <= to; elapsed += 5) {
        lines.push(JSON.stringify(speedRow(elapsed, rate)).padEnd(220, ' ') + '\n');
      }
      return lines.join('');
    };
    const speed = join(first, 'training-speed.jsonl');
    await writeFile(speed, rows(60, 2000, 6000));
    const read = createTrainingRunReader();
    const firstSample = (await read(root, NOW))?.active?.speed;
    expect(firstSample?.averageWindowSeconds).toBeLessThan(1800);
    expect(firstSample?.average30Minutes).toBe(6000);
    await appendFile(speed, rows(2005, 2450, 5000));
    const followingSample = (await read(root, NOW + 10_000))?.active?.speed;
    expect(followingSample?.averageWindowSeconds).toBe(1800);
    expect(followingSample?.average30Minutes).toBe(5750);

    const restarted = await attempt('attempt-restarted', '2026-11-25T00:08:00Z');
    await status({ attempt: restarted });
    await logs(restarted, 'training-speed.jsonl', [speedRow(60, 7200)]);
    const restartedSample = (await read(root, NOW + 20_000))?.active?.speed;
    expect(restartedSample?.averageWindowSeconds).toBe(60);
    expect(restartedSample?.average30Minutes).toBe(7200);
  });

  it('orders three attempts by observed starts and shows failure, crash and restart history', async () => {
    const first = await attempt('attempt-z', '2026-11-23T12:00:00Z');
    await writeFile(join(first, 'manifest.json'), JSON.stringify({
      resumed: false,
      end_time: '2026-11-23T14:00:00Z',
      result: null,
      failure: 'RuntimeError: GPU speed stop',
    }));
    const second = await attempt('evening-restart', '2026-11-23T16:00:00Z');
    await logs(second, 'log.jsonl', [{ event: 'resume', checkpoint_tokens: 100_000_000, checkpoint_step: 12_208 }]);
    const third = await attempt('attempt-b', '2026-11-24T00:00:00Z');
    await logs(third, 'log.jsonl', [{ event: 'resume', checkpoint_tokens: 400_000_000, checkpoint_step: 48_832 }]);
    await status({ attempt: 'artifacts/chat-training/v5/foundation-20261123/attempt-b' });
    const snapshot = await readTrainingRuns(root, NOW);
    expect(snapshot?.active?.attempts).toEqual([
      { id: 'attempt-z', status: 'failed', resumed: false, startedAt: '2026-11-23T12:00:00.000Z', endedAt: '2026-11-23T14:00:00.000Z' },
      { id: 'evening-restart', status: 'crashed', resumed: true, startedAt: '2026-11-23T16:00:00.000Z', endedAt: null },
      { id: 'attempt-b', status: 'running', resumed: true, startedAt: '2026-11-24T00:00:00.000Z', endedAt: null },
    ]);
  });

  it('reports newer validation from the log while preserving a due checkpoint until it is committed', async () => {
    const current = await attempt();
    await status({ processed_tokens: 500_000_000 });
    await logs(current, 'log.jsonl', [{ step: 60_351, validation: { ar: 2.3, en: 2.6 } }]);
    await logs(current, 'training-speed.jsonl', [speedRow(31_535, 6530.2)]);
    const report = (await readTrainingRuns(root, NOW))?.active;
    expect(report?.lastValidation).toEqual({ ar: 2.3, en: 2.6 });
    expect(report?.nextCheckpoint).toEqual({ tokens: 500_000_000, etaAt: new Date(NOW).toISOString() });

    await status({ processed_tokens: 0, last_checkpoint_tokens: 0, settings: { total_tokens: 0 } });
    expect((await readTrainingRuns(root, NOW))?.active).toMatchObject({
      totalTokens: null, percentDone: null, etaAt: null, lastCheckpoint: null,
    });
  });

  it('suppresses ETAs while STOP is present and resolves terminal attempt evidence over a running status', async () => {
    const current = await attempt();
    await status();
    await logs(current, 'training-speed.jsonl', [speedRow(31_535, 6530.2)]);
    await writeFile(join(shape, 'STOP'), '');
    expect((await readTrainingRuns(root, NOW))?.active).toMatchObject({
      status: 'running', stopRequested: true, etaAt: null, nextCheckpoint: { etaAt: null },
    });
    await writeFile(join(current, 'manifest.json'), JSON.stringify({
      resumed: true, result: { status: 'paused_by_stop_file' },
      end_time: '2026-11-25T00:08:12Z', failure: null,
    }));
    const stopped = await readTrainingRuns(root, NOW);
    expect(stopped?.active).toBeNull();
    expect(stopped?.recent[0]).toMatchObject({
      status: 'paused_by_stop_file', stopRequested: true, etaAt: null, nextCheckpoint: null,
      attempts: [{ status: 'paused_by_stop_file', endedAt: '2026-11-25T00:08:12.000Z' }],
    });
  });

  it('handles missing or partial files and ignores an attempt path outside the artifacts directory', async () => {
    expect(await readTrainingRuns(root, NOW)).toBeNull();
    await mkdir(shape, { recursive: true });
    await writeFile(join(shape, 'status.json'), '{"status":"running"');
    expect(await readTrainingRuns(root, NOW)).toBeNull();

    await status({ step: null, settings: {}, last_validation: { ar: null, en: 2.8 }, attempt: join(root, 'other') });
    await mkdir(join(root, 'other'));
    await logs(join(root, 'other'), 'training-speed.jsonl', [speedRow(31_535, 100_000)]);
    const partial = await readTrainingRuns(root, NOW);
    expect(partial?.active).toMatchObject({
      speed: null, step: null, totalTokens: null, percentDone: null, etaAt: null,
      lastValidation: { en: 2.8 }, bestValidation: { en: 2.8 }, currentAttempt: null, attempts: [],
    });
    expect(partial?.gpuLock).toBeNull();

    const current = await attempt();
    await status();
    await logs(current, 'training-speed.jsonl', [speedRow(31_535, 6530.2)]);
    await appendFile(join(current, 'training-speed.jsonl'), '{"time":"2026-11-25T00:07');
    expect((await readTrainingRuns(root, NOW))?.active?.speed?.current).toBe(6530.2);
  });

  it('reads only the final 64 KiB of a 50 MiB log in under 50 ms', async () => {
    const path = join(root, 'long.jsonl');
    const contents = Buffer.alloc(50 * 1024 * 1024, '{"padding":true}\n');
    const tail = Buffer.from('\n{"keep":1}\n{"keep":2}\n{"incomplete"');
    tail.copy(contents, contents.length - tail.length);
    await writeFile(path, contents);
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let read: unknown;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await realFs.open(...args);
      read = vi.spyOn(file, 'read');
      return file;
    });
    const start = performance.now();
    const rows = await readTrainingJsonlTail(path);
    const elapsed = performance.now() - start;
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 64 * 1024, contents.length - 64 * 1024);
    expect(rows.slice(-2)).toEqual([{ keep: 1 }, { keep: 2 }]);
    expect(elapsed).toBeLessThan(50);
  });

  it('opens training artifacts and the GPU lock with read-only flags and never invokes filesystem mutations', async () => {
    const current = await attempt();
    await status();
    await logs(current, 'training-speed.jsonl', [speedRow(31_535, 6530.2)]);
    await logs(current, 'log.jsonl', [{ event: 'resume' }]);
    await checkpoint(400_000_000, { ar: 2.5, en: 2.8 });
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'gpu.lock'), '{"pid":100}');
    const mutations = [appendFile, mkdir, rename, rm, unlink, writeFile, createWriteStream];
    const openFunctions = [open, openCallback, openSync];
    for (const operation of [...openFunctions, ...mutations]) vi.mocked(operation).mockClear();

    const snapshot = await readTrainingRuns(root, NOW);
    expect(snapshot?.active?.speed?.current).toBe(6530.2);
    expect(snapshot?.gpuLock?.pid).toBe(100);
    expect(open).toHaveBeenCalled();
    const writeFlags = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;
    for (const operation of openFunctions) {
      for (const [, flags] of vi.mocked(operation).mock.calls) {
        if (typeof flags === 'number') expect(flags & writeFlags).toBe(0);
        else expect(flags === undefined || flags === 'r' || flags === 'rs' || typeof flags === 'function').toBe(true);
      }
    }
    for (const operation of mutations) expect(operation).not.toHaveBeenCalled();
  });
});
