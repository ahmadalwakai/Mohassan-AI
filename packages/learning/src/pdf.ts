import { Worker } from 'node:worker_threads';
import { LearningContentError } from './lessons.ts';

export const PDF_EXTRACTION_POLICY = 'pdfjs-6.5.438-bounded-text-v1';
export const PDF_LIMITS = Object.freeze({ bytes: 10_000_000, pages: 100, textBytes: 256_000, timeoutMs: 15_000, workers: 2 });
let running = 0;

/** Trusted configuration only. Callers can tighten, never enlarge, the extraction deadline. */
export interface PdfExtractionOptions { signal?: AbortSignal; timeoutMs?: number; }

export async function extractPdfText(bytes: Uint8Array, options: PdfExtractionOptions = {}): Promise<string> {
  if (bytes.byteLength > PDF_LIMITS.bytes) throw new LearningContentError('KNOWLEDGE_SIZE_LIMIT', 'حجم PDF يتجاوز 10 ميغابايت.');
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new LearningContentError('KNOWLEDGE_PDF_INVALID', 'ملف PDF غير صالح.');
  if (options.signal?.aborted) throw new LearningContentError('KNOWLEDGE_PDF_ABORTED', 'أُلغي استخراج PDF.', 409);
  if (running >= PDF_LIMITS.workers) throw new LearningContentError('KNOWLEDGE_PDF_BUSY', 'استخراج المستندات مشغول؛ أعد المحاولة.', 429);
  const timeoutMs = Math.max(1, Math.min(PDF_LIMITS.timeoutMs, Math.floor(options.timeoutMs ?? PDF_LIMITS.timeoutMs)));
  if (!Number.isFinite(timeoutMs)) throw new LearningContentError('KNOWLEDGE_PDF_INVALID_OPTIONS', 'مهلة استخراج PDF غير صالحة.');
  running++;
  let worker: Worker | undefined;
  try {
    // No path or owner credentials enter the worker. The fixed module never runs PDF scripts.
    const data = Uint8Array.from(bytes);
    worker = new Worker(new URL('./pdf-worker.mjs', import.meta.url), {
      workerData: { bytes: data, limits: { pages: PDF_LIMITS.pages, textBytes: PDF_LIMITS.textBytes } },
      transferList: [data.buffer], execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,
    });
    // PDF diagnostics are untrusted and can contain source text; discard them.
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: LearningContentError, text?: string) => {
        if (settled) return; settled = true;
        clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(text!);
      };
      const abort = () => finish(new LearningContentError('KNOWLEDGE_PDF_ABORTED', 'أُلغي استخراج PDF.', 409));
      const timer = setTimeout(() => finish(new LearningContentError('KNOWLEDGE_PDF_TIMEOUT', 'تجاوز استخراج PDF المهلة المسموحة.')), timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      worker!.once('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return finish(new LearningContentError('KNOWLEDGE_PDF_INVALID', 'تعذر استخراج نص PDF.'));
        const result = message as { text?: unknown; error?: unknown };
        const errors: Record<string, string> = {
          KNOWLEDGE_PDF_ENCRYPTED: 'ملفات PDF المشفرة غير مدعومة؛ صدّر نسخة نصية غير مشفرة.',
          KNOWLEDGE_PDF_PAGE_LIMIT: 'عدد صفحات PDF يتجاوز 100 صفحة.',
          KNOWLEDGE_PDF_TEXT_LIMIT: 'النص المستخرج من PDF يتجاوز 256 كيلوبايت.',
          KNOWLEDGE_PDF_NO_TEXT: 'لا يحتوي PDF على نص قابل للاستخراج. التعرف الضوئي OCR غير متاح.',
          KNOWLEDGE_PDF_INVALID: 'ملف PDF غير صالح أو تعذر استخراج نصه.',
        };
        if (typeof result.error === 'string' && Object.hasOwn(errors, result.error)) return finish(new LearningContentError(result.error, errors[result.error]));
        if (typeof result.text !== 'string' || !result.text.trim() || Buffer.byteLength(result.text, 'utf8') > PDF_LIMITS.textBytes || result.text.includes('\0')) return finish(new LearningContentError('KNOWLEDGE_PDF_INVALID', 'تعذر استخراج نص PDF.'));
        finish(undefined, result.text);
      });
      worker!.once('error', () => finish(new LearningContentError('KNOWLEDGE_PDF_INVALID', 'تعذر استخراج PDF ضمن حدود الموارد.')));
      worker!.once('exit', () => finish(new LearningContentError('KNOWLEDGE_PDF_INVALID', 'توقف استخراج PDF قبل اكتماله.')));
    });
  } finally {
    // Await termination even on timeout/cancellation: no parsing continues after return.
    try { await worker?.terminate(); } finally { running--; }
  }
}
