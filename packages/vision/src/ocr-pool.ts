import { Worker } from 'node:worker_threads';
import { loadOcrModelFromBytes } from './ocr-model.js';
import type { WorkerPacket, WorkerRequest } from './ocr-worker-entry.js';
import type { ImageReading } from './read-image.js';
import type { LineCrop, LineRecognition } from './recognize.js';

export interface OcrPoolOptions {
  readonly manifestBytes: Uint8Array;
  readonly weightsBytes: Uint8Array;
  readonly size?: number;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface OcrPool {
  readonly modelId: string;
  readonly size: number;
  ready(): Promise<boolean>;
  recognize(crops: readonly LineCrop[], signal?: AbortSignal): Promise<LineRecognition[]>;
  readImage(bytes: Uint8Array, signal?: AbortSignal): Promise<ImageReading>;
  stats(): {
    readonly requests: number;
    readonly crops: number;
    readonly failures: number;
    readonly restarts: number;
    readonly exhaustedSlots: number;
    readonly busyMs: number;
    readonly lastError: string;
  };
  close(): Promise<void>;
}

export class OcrPoolUnavailable extends Error {
  constructor(message = 'OCR_POOL_UNAVAILABLE') { super(message); }
}

// Limit restart frequency even for workers that report ready before crashing.
// Five consecutive startup failures also stop automatic restarts for the slot.
const RESTART_WINDOW_MS = 30_000;
const MAX_RESTARTS = 5;
const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5_000;
const IMAGE_TIMEOUT_MS = 140_000;

// While running TypeScript sources the entry's imports need the same loader.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    if (workerData.tsxUrl) { const tsx = await import(workerData.tsxUrl); tsx.register(); }
    const entry = await import(workerData.loaderUrl);
    entry.startWorker(parentPort, workerData.manifest, workerData.weights);
  } catch (error) {
    parentPort.postMessage({ v: 1, type: 'failed', error: String(error && error.message || error) });
  }
})();
`;

type JobResult = Extract<WorkerPacket, { type: 'result' | 'image-result' }>;
interface Pending {
  complete(packet: JobResult): void;
  reject(reason: unknown): void;
  recognize?(crops: readonly LineCrop[]): void;
}

interface ActiveWorker {
  worker: Worker;
  ready: Promise<void>;
  settleStartup(): void;
  readyAt: number | null;
  pending: Map<number, Pending>;
}

interface Slot {
  active?: ActiveWorker;
  stopping?: Promise<void>;
  restartTimer?: ReturnType<typeof setTimeout>;
  restartTimes: number[];
  startupFailures: number;
  retryAfter: number;
  backoffMs: number;
}

type LiveSlot = Slot & { active: ActiveWorker };

export function createOcrPool(options: OcrPoolOptions): OcrPool {
  const { modelId } = loadOcrModelFromBytes(options.manifestBytes, options.weightsBytes);
  const requestedSize = options.size ?? 3;
  const size = Number.isFinite(requestedSize) ? Math.max(1, Math.min(8, Math.ceil(requestedSize))) : 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const manifest = Uint8Array.from(options.manifestBytes);
  const weights = Uint8Array.from(options.weightsBytes);
  const typescript = import.meta.url.endsWith('.ts');
  const loaderUrl = new URL(typescript ? './ocr-worker-entry.ts' : './ocr-worker-entry.js', import.meta.url).href;
  let tsxUrl: string | undefined;
  if (typescript) { try { tsxUrl = import.meta.resolve('tsx/esm/api'); } catch { tsxUrl = undefined; } }
  const counters = { requests: 0, crops: 0, failures: 0, restarts: 0, busyMs: 0, lastError: '' };
  let closed = false;
  let nextId = 1;
  const slots: Slot[] = Array.from({ length: size }, () => ({
    restartTimes: [], startupFailures: 0, retryAfter: 0, backoffMs: INITIAL_BACKOFF_MS,
  }));

  function recordFailure(error: unknown): void {
    counters.failures++;
    counters.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }

  function restart(slot: Slot): void {
    slot.restartTimes.push(performance.now());
    counters.restarts++;
    spawn(slot);
  }

  function scheduleRestart(slot: Slot): void {
    if (closed) return;
    const now = performance.now();
    slot.restartTimes = slot.restartTimes.filter(time => now - time < RESTART_WINDOW_MS);
    const capDelay = slot.restartTimes.length >= MAX_RESTARTS ? slot.restartTimes[0] + RESTART_WINDOW_MS - now : 0;
    const delay = Math.max(slot.backoffMs, Math.ceil(capDelay));
    slot.backoffMs = Math.min(MAX_BACKOFF_MS, slot.backoffMs * 2);
    if (slot.startupFailures >= MAX_RESTARTS) {
      // Keep the cooldown for demand retries without arming a timer.
      slot.retryAfter = now + delay;
      return;
    }
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = undefined;
      if (!closed) restart(slot);
    }, delay);
    slot.restartTimer.unref();
  }

  function retryExhaustedSlot(): void {
    // An active worker may already be starting. Let concurrent requests wait
    // for that attempt before considering another exhausted slot.
    if (closed || slots.some(slot => slot.active || slot.stopping)) return;
    const now = performance.now();
    const slot = slots.find(slot => slot.startupFailures >= MAX_RESTARTS && now >= slot.retryAfter);
    if (slot) restart(slot);
  }

  function retire(slot: Slot, active: ActiveWorker, reason: string, jobError = 'OCR_WORKER_EXITED'): void {
    // Error, startup failure, timeout and exit can all arrive for the same worker.
    if (slot.active !== active) return;
    slot.active = undefined;
    if (active.readyAt !== null && performance.now() - active.readyAt >= RESTART_WINDOW_MS) {
      slot.backoffMs = INITIAL_BACKOFF_MS;
    }
    active.settleStartup();
    if (!closed) {
      if (active.readyAt === null) slot.startupFailures++;
      recordFailure(reason);
    }
    const error = new OcrPoolUnavailable(closed ? 'OCR_POOL_CLOSED' : jobError);
    for (const pending of active.pending.values()) pending.reject(error);
    slot.stopping = active.worker.terminate().then(() => {
      slot.stopping = undefined;
      scheduleRestart(slot);
    });
  }

  function spawn(slot: Slot): void {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true, name: 'mohassan-ocr', stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        workerData: { loaderUrl, tsxUrl, manifest, weights },
      });
    } catch (error) {
      slot.startupFailures++;
      recordFailure(error);
      scheduleRestart(slot);
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const startup = setTimeout(() => retire(slot, active, 'OCR_WORKER_STARTUP_TIMEOUT'), startupTimeoutMs);
    const active: ActiveWorker = {
      worker, ready, readyAt: null, pending: new Map(),
      settleStartup() { clearTimeout(startup); resolveReady(); },
    };
    slot.active = active;

    worker.on('message', (packet: WorkerPacket) => {
      if (slot.active !== active || packet?.v !== 1) return;
      if (packet.type === 'ready') {
        active.readyAt ??= performance.now();
        slot.startupFailures = 0;
        active.settleStartup();
        return;
      }
      if (packet.type === 'failed') {
        retire(slot, active, packet.error);
        return;
      }
      const pending = active.pending.get(packet.id);
      if (!pending) return;
      switch (packet.type) {
        case 'image-crops':
          pending.recognize?.(packet.crops);
          break;
        case 'rejected':
          recordFailure(packet.error);
          pending.reject(new Error(packet.error));
          break;
        case 'result':
          counters.busyMs += packet.elapsedMs;
          pending.complete(packet);
          break;
        case 'image-result':
          pending.complete(packet);
          break;
      }
    });
    worker.on('error', error => retire(slot, active, error.message));
    worker.on('exit', code => retire(slot, active, `OCR_WORKER_EXITED (${code})`));
    worker.unref();
  }

  for (const slot of slots) spawn(slot);

  function liveSlots(): LiveSlot[] {
    return slots.filter((slot): slot is LiveSlot => !!slot.active && slot.active.readyAt !== null);
  }

  async function waitForReady(signal?: AbortSignal): Promise<void> {
    if (liveSlots().length) return;
    // A healthy worker can take requests even while others are starting or backing off.
    const starting = slots.flatMap(slot => slot.active ? [slot.active] : []);
    if (!starting.length) return;
    const ready = Promise.any(starting.map(async active => {
      await active.ready;
      if (active.readyAt === null) throw new OcrPoolUnavailable();
    })).catch(() => {});
    if (!signal) return ready;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void ready.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  function send(slot: Slot, packet: WorkerRequest, transfer: ArrayBuffer[], limit: number, signal?: AbortSignal,
    recognizeCrops?: (crops: readonly LineCrop[]) => Promise<LineRecognition[]>): Promise<JobResult> {
    signal?.throwIfAborted();
    const active = slot.active;
    if (!active || active.readyAt === null) throw new OcrPoolUnavailable('OCR_WORKER_DOWN');
    const { id } = packet;
    const { worker, pending } = active;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(id);
      };
      const fail = (reason: unknown) => {
        cleanup();
        reject(reason);
        if (packet.type === 'read-image' && slot.active === active) {
          try {
            worker.postMessage({ v: 1, type: 'cancel-image', id } satisfies WorkerRequest);
          } catch {
            retire(slot, active, 'OCR_WORKER_UNREACHABLE');
          }
        }
      };
      const onAbort = () => {
        // A synchronous inference chunk cannot observe cancellation. Keep its
        // watchdog until it replies so a stuck thread is still retired.
        if (packet.type === 'recognize') reject(signal?.reason);
        else fail(signal?.reason);
      };
      const timer = setTimeout(() => {
        retire(slot, active, 'OCR_WORKER_TIMEOUT', 'OCR_WORKER_TIMEOUT');
      }, limit);
      pending.set(id, {
        complete(result) { cleanup(); resolve(result); },
        reject: fail,
        recognize: recognizeCrops && (crops => {
          void recognizeCrops(crops).then(results => {
            if (pending.has(id)) worker.postMessage({ v: 1, type: 'image-crops-result', id, results } satisfies WorkerRequest);
          }).catch(error => { if (pending.has(id)) fail(error); });
        }),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { worker.postMessage(packet, transfer); } catch (error) { fail(error); }
    });
  }

  async function recognize(crops: readonly LineCrop[], signal?: AbortSignal): Promise<LineRecognition[]> {
    if (closed) throw new OcrPoolUnavailable('OCR_POOL_CLOSED');
    signal?.throwIfAborted();
    counters.requests++;
    counters.crops += crops.length;
    if (!crops.length) return [];
    retryExhaustedSlot();
    await waitForReady(signal);
    signal?.throwIfAborted();
    if (closed) throw new OcrPoolUnavailable('OCR_POOL_CLOSED');
    const live = liveSlots();
    if (!live.length) throw new OcrPoolUnavailable();
    // Small chunks from a shared queue keep workers busy even when widths vary.
    const chunkSize = Math.max(1, Math.min(6, Math.ceil(crops.length / (live.length * 2))));
    const results: LineRecognition[] = [];
    let next = 0;
    let failed = false;
    const drain = async (slot: Slot) => {
      while (!failed && next < crops.length) {
        const start = next;
        next += chunkSize;
        const chunk = crops.slice(start, next);
        const limit = timeoutMs + chunk.reduce((sum, crop) => sum + crop.width, 0) * 8;
        const payload = chunk.map(crop => ({ width: crop.width, pixels: Uint8Array.from(crop.pixels) }));
        const result = await send(slot, { v: 1, type: 'recognize', id: nextId++, crops: payload },
          payload.map(crop => crop.pixels.buffer), limit, signal);
        if (result.type !== 'result' || result.results.length !== chunk.length) throw new Error('OCR_POOL_INCOMPLETE');
        for (let i = 0; i < result.results.length; i++) results[start + i] = result.results[i];
      }
    };
    try {
      await Promise.all(live.sort((a, b) => a.active.pending.size - b.active.pending.size).map(drain));
    } catch (error) {
      failed = true;
      throw error;
    }
    signal?.throwIfAborted();
    return results;
  }

  return {
    modelId,
    size,
    async ready() {
      await waitForReady();
      return liveSlots().length > 0;
    },
    recognize,
    async readImage(bytes, signal) {
      signal?.throwIfAborted();
      retryExhaustedSlot();
      await waitForReady(signal);
      signal?.throwIfAborted();
      if (closed) throw new OcrPoolUnavailable('OCR_POOL_CLOSED');
      const slot = liveSlots().sort((a, b) => a.active.pending.size - b.active.pending.size)[0];
      if (!slot) throw new OcrPoolUnavailable();
      const copy = Uint8Array.from(bytes);
      const controller = new AbortController();
      try {
        const result = await send(slot, { v: 1, type: 'read-image', id: nextId++, bytes: copy }, [copy.buffer],
          IMAGE_TIMEOUT_MS, signal, crops => recognize(crops, controller.signal));
        if (result.type !== 'image-result') throw new Error('OCR_POOL_INCOMPLETE');
        return result.reading;
      } finally {
        controller.abort();
      }
    },
    stats() {
      return { ...counters, exhaustedSlots: slots.filter(slot => slot.startupFailures >= MAX_RESTARTS).length };
    },
    async close() {
      closed = true;
      for (const slot of slots) {
        clearTimeout(slot.restartTimer);
        if (slot.active) retire(slot, slot.active, 'OCR_POOL_CLOSED');
      }
      await Promise.all(slots.map(slot => slot.stopping));
    },
  };
}
