import { EventEmitter } from 'node:events';
import type { WorkerOptions } from 'node:worker_threads';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOcrModelFromBytes } from './ocr-model.js';
import { createOcrPool, OcrPoolUnavailable, type OcrPool } from './ocr-pool.js';
import { createTinyOcrModel } from './ocr-test-model.js';
import { readImage } from './read-image.js';
import { recognizeLine, type LineCrop } from './recognize.js';

const fixture = createTinyOcrModel();
const model = loadOcrModelFromBytes(fixture.manifestBytes, fixture.weightsBytes);
const crop = { width: model.downsample * 2, pixels: new Uint8Array(model.height * model.downsample * 2).fill(255) };

class TestWorker extends EventEmitter {
  readonly unref = vi.fn();
  readonly terminate = vi.fn(async () => {
    this.emit('exit', 1);
    return 1;
  });

  postMessage(packet: { id: number; crops: LineCrop[] }) {
    queueMicrotask(() => {
      const started = performance.now();
      const results = packet.crops.map(crop => recognizeLine(model, crop));
      this.emit('message', { v: 1, type: 'result', id: packet.id, results, elapsedMs: performance.now() - started });
    });
  }

  reportReady() {
    this.emit('message', { v: 1, type: 'ready', modelId: fixture.modelId });
  }

  failStartup() {
    this.emit('message', { v: 1, type: 'failed', error: 'fixture startup failure' });
    this.emit('exit', 0);
  }
}

let workers: TestWorker[] | undefined;

vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: function (source: string, options: WorkerOptions) {
      if (!workers) return new actual.Worker(source, options);
      const worker = new TestWorker();
      workers.push(worker);
      return worker;
    },
  };
});

let pool: OcrPool | undefined;

afterEach(async () => {
  try {
    await pool?.close();
  } finally {
    pool = undefined;
    workers = undefined;
    vi.useRealTimers();
  }
});

function simulateWorkers(options: { size?: number; startupTimeoutMs?: number } = {}) {
  vi.useFakeTimers();
  const spawned: TestWorker[] = [];
  workers = spawned;
  const simulatedPool = createOcrPool({ ...fixture, size: 1, ...options });
  pool = simulatedPool;
  return { spawned, simulatedPool };
}

describe('OCR worker pool', () => {
  it('runs recognition and the full image pipeline in real workers using zero weights', async () => {
    pool = createOcrPool({ ...fixture, size: 2 });
    expect(await pool.ready(), pool.stats().lastError).toBe(true);
    expect(await pool.recognize([crop])).toEqual([recognizeLine(model, crop)]);

    const width = 128, height = 64;
    const pixels = new Uint8Array(width * height).fill(255);
    for (let x = 12; x < width - 12; x += 12) {
      for (let y = 24; y < 38; y++) pixels.fill(0, y * width + x, y * width + x + 8);
    }
    const image = await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
    const expected = await readImage(image, { model });
    expect(expected.candidates).toBeGreaterThan(0);
    expect(await pool.readImage(image)).toEqual({ ...expected, durationMs: expect.any(Number) });
  });

  it('schedules one replacement when the same worker emits error and exit', async () => {
    const { simulatedPool, spawned } = simulateWorkers();
    spawned[0].reportReady();
    expect(await simulatedPool.ready()).toBe(true);

    spawned[0].emit('error', new Error('fixture worker crash'));
    spawned[0].emit('exit', 1);
    expect(await simulatedPool.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);
    expect(simulatedPool.stats().restarts).toBe(1);

    spawned[1].reportReady();
    await vi.advanceTimersByTimeAsync(100);
    expect(spawned).toHaveLength(2);
    expect(await simulatedPool.ready()).toBe(true);
    await simulatedPool.close();
    expect(spawned[1].terminate).toHaveBeenCalledTimes(1);
  });

  it('delays startup failures exponentially and caps replacements in the rolling window', async () => {
    const { simulatedPool, spawned } = simulateWorkers();
    const cap = 5, initialDelay = 100, restartWindow = 30_000;
    let elapsed = 0;
    for (let attempt = 0; attempt < cap; attempt++) {
      spawned[attempt].failStartup();
      const delay = initialDelay * 2 ** attempt;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(spawned).toHaveLength(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawned).toHaveLength(attempt + 2);
      elapsed += delay;
    }

    spawned[cap].failStartup();
    await vi.advanceTimersByTimeAsync(restartWindow + initialDelay - elapsed - 1);
    expect(spawned).toHaveLength(cap + 1);
    expect(simulatedPool.stats().restarts).toBe(cap);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(cap + 2);
    expect(simulatedPool.stats().restarts).toBe(cap + 1);
  });

  it('rechecks readiness and recognizes crops after a transient startup failure', async () => {
    const { simulatedPool, spawned } = simulateWorkers();
    const firstReadiness = simulatedPool.ready();
    spawned[0].failStartup();
    expect(await firstReadiness).toBe(false);
    await expect(simulatedPool.recognize([crop])).rejects.toThrow('OCR_POOL_UNAVAILABLE');

    await vi.advanceTimersByTimeAsync(100);
    spawned[1].reportReady();
    expect(await simulatedPool.ready()).toBe(true);
    expect(await simulatedPool.recognize([crop])).toEqual([recognizeLine(model, crop)]);
  });

  it('retires a worker that never reports ready before starting a replacement', async () => {
    const startupTimeoutMs = 25;
    const { simulatedPool, spawned } = simulateWorkers({ startupTimeoutMs });
    const readiness = simulatedPool.ready();
    await vi.advanceTimersByTimeAsync(startupTimeoutMs);
    expect(await readiness).toBe(false);
    expect(spawned[0].terminate).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(spawned).toHaveLength(2);
    spawned[1].reportReady();
    expect(await simulatedPool.ready()).toBe(true);
  });

  it('aborts an image read while every worker is still starting', async () => {
    const { simulatedPool, spawned } = simulateWorkers({ size: 2 });
    const controller = new AbortController();
    const reason = new Error('fixture image read aborted');
    const onReject = vi.fn();
    const reading = simulatedPool.readImage(new Uint8Array(), controller.signal).catch(onReject);
    controller.abort(reason);

    await vi.advanceTimersByTimeAsync(0);
    expect(onReject).toHaveBeenCalledExactlyOnceWith(reason);
    await reading;
    for (const worker of spawned) {
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.reportReady();
    }
    expect(await simulatedPool.ready()).toBe(true);
  });

  it('rejects an image read as unavailable when the ready pool closes before dispatch', async () => {
    const { simulatedPool, spawned } = simulateWorkers({ size: 2 });
    for (const worker of spawned) worker.reportReady();
    const reading = expect(simulatedPool.readImage(new Uint8Array())).rejects.toThrow(OcrPoolUnavailable);
    await simulatedPool.close();
    await reading;
    for (const worker of spawned) expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels scheduled replacements when closed', async () => {
    const { simulatedPool, spawned } = simulateWorkers();
    spawned[0].failStartup();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    await simulatedPool.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawned).toHaveLength(1);
    expect(simulatedPool.stats().restarts).toBe(0);
    expect(await simulatedPool.ready()).toBe(false);
  });
});
