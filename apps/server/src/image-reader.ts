import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createOcrPool, OcrPoolUnavailable, readOcrModelFiles, type ImageReading } from '@mohassan/vision';

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

const unavailableArabic = 'تعذّرت قراءة الصورة الآن؛ أعد المحاولة بعد قليل';
const unavailableEnglish = 'The image could not be read right now. Please try again shortly.';

export function imageReaderUnavailableMessage(request: string): string {
  return !request.trim() || /[؀-ۿ]/u.test(request) ? unavailableArabic : unavailableEnglish;
}

export class ImageReaderUnavailable extends Error {
  constructor(options?: ErrorOptions) { super(`${unavailableArabic}\n${unavailableEnglish}`, options); }
}

export async function createImageReader(options: { modelDir: string; workers?: number }): Promise<ImageReader> {
  const dir = options.modelDir;
  if (!existsSync(join(dir, 'manifest.json')) || !existsSync(join(dir, 'weights.bin'))) {
    return { available: false, modelId: null, async read() { throw new ImageReaderUnavailable(); }, async close() {} };
  }
  const files = await readOcrModelFiles(dir);
  const pool = createOcrPool({ ...files, size: options.workers });
  return {
    available: true,
    modelId: pool.modelId,
    async read(bytes, signal) {
      try {
        return await pool.readImage(bytes, signal);
      } catch (error) {
        if (error instanceof OcrPoolUnavailable) throw new ImageReaderUnavailable({ cause: error });
        throw error;
      }
    },
    close: () => pool.close(),
  };
}
