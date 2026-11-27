import type { MessagePort } from 'node:worker_threads';
import { loadOcrModelFromBytes } from './ocr-model.js';
import { readImage, type ImageReading } from './read-image.js';
import { recognizeLine, type LineCrop, type LineRecognition } from './recognize.js';

export type WorkerRequest = { v: 1; id: number } & (
  | { type: 'recognize'; crops: readonly LineCrop[] }
  | { type: 'read-image'; bytes: Uint8Array }
  | { type: 'image-crops-result'; results: LineRecognition[] }
  | { type: 'cancel-image' }
);

export type WorkerPacket = { v: 1 } & (
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | ({ id: number } & (
    | { type: 'result'; results: LineRecognition[]; elapsedMs: number }
    | { type: 'image-result'; reading: ImageReading }
    | { type: 'image-crops'; crops: readonly LineCrop[] }
    | { type: 'rejected'; error: string }
  ))
);

export function startWorker(port: MessagePort, manifest: Uint8Array, weights: Uint8Array): void {
  const model = loadOcrModelFromBytes(manifest, weights);
  const images = new Map<number, {
    controller: AbortController;
    resolveCrops?: (results: LineRecognition[]) => void;
    rejectCrops?: (reason: unknown) => void;
  }>();
  const post = (packet: WorkerPacket, transfer?: ArrayBuffer[]) => port.postMessage(packet, transfer);

  port.on('message', async (packet: WorkerRequest) => {
    if (packet?.v !== 1 || !Number.isInteger(packet.id)) return;
    const { id } = packet;
    const image = images.get(id);
    if (packet.type === 'image-crops-result') {
      image?.resolveCrops?.(packet.results);
      return;
    }
    if (packet.type === 'cancel-image') {
      image?.controller.abort();
      image?.rejectCrops?.(image.controller.signal.reason);
      return;
    }
    try {
      if (packet.type === 'recognize') {
        const start = performance.now();
        const results = packet.crops.map(crop => recognizeLine(model, crop));
        post({ v: 1, type: 'result', id, results, elapsedMs: performance.now() - start });
      } else if (packet.type === 'read-image') {
        const job: NonNullable<typeof image> = { controller: new AbortController() };
        images.set(id, job);
        const { signal } = job.controller;
        try {
          const reading = await readImage(packet.bytes, {
            model, signal,
            // Yield this worker while the parent distributes recognition across the same pool.
            recognize: crops => new Promise((resolve, reject) => {
              job.resolveCrops = resolve;
              job.rejectCrops = reject;
              // The layout owns these pixel buffers and only needs their
              // metadata once recognition starts.
              const transfer = new Set<ArrayBuffer>();
              for (const crop of crops) {
                if (crop.pixels.buffer instanceof ArrayBuffer) transfer.add(crop.pixels.buffer);
              }
              post({ v: 1, type: 'image-crops', id, crops }, [...transfer]);
            }),
          });
          if (!signal.aborted) post({ v: 1, type: 'image-result', id, reading });
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally {
          images.delete(id);
        }
      }
    } catch (error) {
      post({ v: 1, type: 'rejected', id, error: error instanceof Error ? error.message : String(error) });
    }
  });
  post({ v: 1, type: 'ready' });
}
