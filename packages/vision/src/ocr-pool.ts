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
  stats(): { readonly requests: number; readonly crops: number; readonly failures: number; readonly restarts: number; readonly busyMs: number; readonly lastError: string };
  close(): Promise<void>;
}

// Constant bootstrap: the worker only ever runs this module's exports on validated bytes.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
(async () => {
  try {
    // While the server runs TypeScript sources, the worker thread needs the same loader for the entry's imports.
    if (workerData.tsxUrl) { const tsx = await import(workerData.tsxUrl); tsx.register(); }
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
  // The entry is loaded by its real extension: `.ts` while the server runs TypeScript sources, `.js` when compiled.
  const typescript = import.meta.url.endsWith('.ts');
  const loaderUrl = new URL(typescript ? './ocr-worker-entry.ts' : './ocr-worker-entry.js', import.meta.url).href;
  let tsxUrl: string | undefined;
  if (typescript) { try { tsxUrl = import.meta.resolve('tsx/esm/api'); } catch { tsxUrl = undefined; } }
  const counters = { requests: 0, crops: 0, failures: 0, restarts: 0, busyMs: 0, lastError: '' };
  let closed = false, nextId = 1;
  const slots: Slot[] = [];

  function spawn(slot: Slot): void {
    // execArgv is inherited on purpose: the server runs TypeScript through `--import tsx`, and the worker must load the entry the same way.
    const worker = new Worker(WORKER_SOURCE, { eval: true, name: 'mohassan-ocr', stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      workerData: { loaderUrl, tsxUrl, manifest: Uint8Array.from(manifest), weights: Uint8Array.from(weights) } });
    worker.stdout?.on('data', () => {}); worker.stderr?.on('data', () => {});
    slot.worker = worker;
    slot.ready = new Promise<boolean>(resolve => {
      const startup = setTimeout(() => { resolve(false); void worker.terminate(); }, startupTimeoutMs);
      worker.on('message', (packet: { v: number; type: string; id?: number; results?: LineRecognition[]; error?: string; elapsedMs?: number }) => {
        if (!packet || packet.v !== 1) return;
        if (packet.type === 'ready') { clearTimeout(startup); resolve(true); return; }
        if (packet.type === 'failed') { clearTimeout(startup); counters.lastError = String(packet.error ?? 'worker failed').slice(0, 300); resolve(false); return; }
        if (typeof packet.id !== 'number') return;
        const pending = slot.pending.get(packet.id);
        if (!pending) return;
        slot.pending.delete(packet.id); clearTimeout(pending.timer); slot.busy--;
        if (packet.type === 'result' && Array.isArray(packet.results)) { counters.busyMs += packet.elapsedMs ?? 0; pending.resolve(packet.results); }
        else { counters.failures++; pending.reject(new Error(packet.error ?? 'OCR_WORKER_REJECTED')); }
      });
      const fail = () => { clearTimeout(startup); resolve(false); for (const pending of slot.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('OCR_WORKER_EXITED')); } slot.pending.clear(); slot.busy = 0; slot.worker = null; if (!closed) { counters.restarts++; spawn(slot); } };
      worker.on('error', (error: Error) => { counters.lastError = String(error?.message ?? error).slice(0, 300); fail(); });
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
      // A long line on a busy machine can take seconds; the limit grows with the work sent.
      const limit = timeoutMs + crops.reduce((sum, crop) => sum + crop.width, 0) * 8;
      const timer = setTimeout(() => { slot.pending.delete(id); slot.busy--; counters.failures++; reject(new Error('OCR_WORKER_TIMEOUT')); void worker.terminate(); }, limit);
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
      // Small chunks from a shared queue: every worker stays busy until the last crop, whatever the line widths.
      const chunkSize = Math.max(1, Math.min(6, Math.ceil(crops.length / (live.length * 2))));
      const chunks: { start: number; crops: LineCrop[] }[] = [];
      for (let start = 0; start < crops.length; start += chunkSize) chunks.push({ start, crops: crops.slice(start, start + chunkSize) });
      const results: LineRecognition[] = new Array(crops.length);
      let next = 0;
      const drain = async (slot: Slot) => {
        while (next < chunks.length) {
          const chunk = chunks[next++];
          const part = await send(slot, chunk.crops);
          for (let i = 0; i < part.length; i++) results[chunk.start + i] = part[i];
          signal?.throwIfAborted();
        }
      };
      await Promise.all(live.slice().sort((a, b) => a.busy - b.busy).map(slot => drain(slot)));
      if (results.some(item => !item)) throw new Error('OCR_POOL_INCOMPLETE');
      return results;
    },
    stats() { return { ...counters }; },
    async close() { closed = true; await Promise.all(slots.map(slot => slot.worker?.terminate())); },
  };
}
