import { Worker } from 'node:worker_threads';
import { loadOcrModelFromBytes } from './ocr-model.js';
import type { LineCrop, LineRecognition } from './recognize.js';

/**
 * A small pool of worker threads that each hold one copy of the OCR model, so a
 * screenshot with many lines reads in parallel without blocking the server.
 */
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
  stats(): { readonly requests: number; readonly crops: number; readonly failures: number; readonly restarts: number; readonly busyMs: number };
  close(): Promise<void>;
}

// Constant bootstrap: the worker only ever runs this module's exports on validated bytes.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
(async () => {
  try {
    const entry = await import(workerData.loaderUrl);
    const model = entry.loadForWorker(workerData.manifest, workerData.weights);
    parentPort.on('message', packet => {
      if (!packet || packet.v !== 1 || packet.type !== 'recognize' || !Number.isInteger(packet.id) || !Array.isArray(packet.crops)) return;
      const start = performance.now();
      try {
        const results = entry.recognizeMany(model, packet.crops.map(crop => ({ width: crop.width, pixels: new Uint8Array(crop.pixels) })));
        parentPort.postMessage({ v: 1, type: 'result', id: packet.id, results, elapsedMs: performance.now() - start });
      } catch (error) {
        parentPort.postMessage({ v: 1, type: 'rejected', id: packet.id, error: String(error && error.message || error) });
      }
    });
    parentPort.postMessage({ v: 1, type: 'ready', modelId: model.modelId });
  } catch (error) {
    parentPort.postMessage({ v: 1, type: 'failed', error: String(error && error.message || error) });
  }
})();
`;

interface Pending { resolve(results: LineRecognition[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Slot { worker: Worker | null; ready: Promise<boolean>; busy: number; pending: Map<number, Pending> }

export function createOcrPool(options: OcrPoolOptions): OcrPool {
  const model = loadOcrModelFromBytes(options.manifestBytes, options.weightsBytes);
  const size = Math.max(1, Math.min(8, options.size ?? 3)), timeoutMs = options.timeoutMs ?? 30_000, startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const manifest = Uint8Array.from(options.manifestBytes), weights = Uint8Array.from(options.weightsBytes);
  const loaderUrl = new URL('./ocr-worker-entry.js', import.meta.url).href;
  const counters = { requests: 0, crops: 0, failures: 0, restarts: 0, busyMs: 0 };
  let closed = false, nextId = 1;
  const slots: Slot[] = [];

  function spawn(slot: Slot): void {
    const worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], name: 'mohassan-ocr', stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      workerData: { loaderUrl, manifest: Uint8Array.from(manifest), weights: Uint8Array.from(weights) } });
    worker.stdout?.on('data', () => {}); worker.stderr?.on('data', () => {});
    slot.worker = worker;
    slot.ready = new Promise<boolean>(resolve => {
      const startup = setTimeout(() => { resolve(false); void worker.terminate(); }, startupTimeoutMs);
      worker.on('message', (packet: { v: number; type: string; id?: number; results?: LineRecognition[]; error?: string; elapsedMs?: number }) => {
        if (!packet || packet.v !== 1) return;
        if (packet.type === 'ready') { clearTimeout(startup); resolve(true); return; }
        if (packet.type === 'failed') { clearTimeout(startup); resolve(false); return; }
        if (typeof packet.id !== 'number') return;
        const pending = slot.pending.get(packet.id);
        if (!pending) return;
        slot.pending.delete(packet.id); clearTimeout(pending.timer); slot.busy--;
        if (packet.type === 'result' && Array.isArray(packet.results)) { counters.busyMs += packet.elapsedMs ?? 0; pending.resolve(packet.results); }
        else { counters.failures++; pending.reject(new Error(packet.error ?? 'OCR_WORKER_REJECTED')); }
      });
      const fail = () => { clearTimeout(startup); resolve(false); for (const pending of slot.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('OCR_WORKER_EXITED')); } slot.pending.clear(); slot.busy = 0; slot.worker = null; if (!closed) { counters.restarts++; spawn(slot); } };
      worker.on('error', fail);
      worker.on('exit', fail);
    });
    worker.unref();
  }
  for (let i = 0; i < size; i++) { const slot: Slot = { worker: null, ready: Promise.resolve(false), busy: 0, pending: new Map() }; spawn(slot); slots.push(slot); }

  function send(slot: Slot, crops: readonly LineCrop[]): Promise<LineRecognition[]> {
    return new Promise<LineRecognition[]>((resolve, reject) => {
      const worker = slot.worker;
      if (!worker) { reject(new Error('OCR_WORKER_DOWN')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { slot.pending.delete(id); slot.busy--; counters.failures++; reject(new Error('OCR_WORKER_TIMEOUT')); void worker.terminate(); }, timeoutMs);
      slot.pending.set(id, { resolve, reject, timer });
      slot.busy++;
      const payload = crops.map(crop => ({ width: crop.width, pixels: Uint8Array.from(crop.pixels) }));
      worker.postMessage({ v: 1, type: 'recognize', id, crops: payload }, payload.map(crop => crop.pixels.buffer));
    });
  }

  return {
    modelId: model.modelId,
    size,
    async ready() { const states = await Promise.all(slots.map(slot => slot.ready)); return states.some(Boolean); },
    async recognize(crops, signal) {
      if (closed) throw new Error('OCR_POOL_CLOSED');
      signal?.throwIfAborted();
      counters.requests++; counters.crops += crops.length;
      if (!crops.length) return [];
      const states = await Promise.all(slots.map(slot => slot.ready));
      const live = slots.filter((slot, index) => states[index] && slot.worker);
      if (!live.length) throw new Error('OCR_POOL_UNAVAILABLE');
      const chunks = Math.min(live.length, crops.length), per = Math.ceil(crops.length / chunks);
      const ordered = live.slice().sort((a, b) => a.busy - b.busy);
      const parts = await Promise.all(Array.from({ length: chunks }, (_, index) => send(ordered[index % ordered.length], crops.slice(index * per, (index + 1) * per))));
      signal?.throwIfAborted();
      return parts.flat();
    },
    stats() { return { ...counters }; },
    async close() { closed = true; await Promise.all(slots.map(slot => slot.worker?.terminate())); },
  };
}
