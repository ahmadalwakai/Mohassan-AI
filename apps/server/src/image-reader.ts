import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createOcrPool, loadOcrModelFromBytes, readImage, readOcrModelFiles, type ImageReading, type OcrModel, type OcrPool } from '@mohassan/vision';

/**
 * The server's handle on the own image reader. The exported model lives in
 * `artifacts/vision/ocr-v1` (or MOHASSAN_OCR_MODEL_DIR); without it, image
 * messages are refused with a clear message rather than guessed at.
 */
export interface ImageReader {
  readonly available: boolean;
  readonly modelId: string | null;
  read(bytes: Uint8Array, signal?: AbortSignal): Promise<ImageReading>;
  close(): Promise<void>;
}

export class ImageReaderUnavailable extends Error {
  constructor() { super('IMAGE_READER_UNAVAILABLE'); }
}

export async function createImageReader(options: { modelDir: string; workers?: number }): Promise<ImageReader> {
  const dir = options.modelDir;
  if (!existsSync(join(dir, 'manifest.json')) || !existsSync(join(dir, 'weights.bin'))) {
    return { available: false, modelId: null, async read() { throw new ImageReaderUnavailable(); }, async close() {} };
  }
  const files = await readOcrModelFiles(dir);
  const model: OcrModel = loadOcrModelFromBytes(files.manifestBytes, files.weightsBytes);
  let pool: OcrPool | null = null, poolReady: Promise<boolean> | null = null;
  const ensurePool = async (): Promise<OcrPool | null> => {
    if (!pool) {
      try { pool = createOcrPool({ manifestBytes: files.manifestBytes, weightsBytes: files.weightsBytes, size: options.workers ?? 3 }); poolReady = pool.ready(); } catch { pool = null; poolReady = Promise.resolve(false); }
    }
    return (await poolReady) ? pool : null;
  };
  return {
    available: true,
    modelId: model.modelId,
    async read(bytes, signal) {
      const workers = await ensurePool();
      // Without live workers the main thread reads the image itself; slower, never silent.
      return readImage(bytes, { model, signal, ...(workers ? { recognize: crops => workers.recognize(crops, signal) } : {}) });
    },
    async close() { await pool?.close(); },
  };
}
