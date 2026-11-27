import { Worker } from 'node:worker_threads';
import { pdfEditMessages, withReplyMessage } from '@mohassan/contracts/reply-messages';
import { PdfError } from './errors.ts';
import { PDF_LIMITS } from './limits.ts';

/**
 * Structural PDF edits with pdf-lib inside a terminable worker: merge, extract or delete pages,
 * rotate, reorder, metadata, a stamped overlay (the Chromium-rendered watermark) and page numbers.
 * Text is never drawn here except Western digits for page numbers: Arabic text always comes from
 * Chromium, which shapes it, and arrives as an overlay page.
 */
export interface PdfInfo {
  pages: number;
  title: string | null; author: string | null; subject: string | null; keywords: string | null;
  creator: string | null; producer: string | null; created: string | null; modified: string | null;
  pageSize: { width: number; height: number };
}
export interface EditOptions { signal?: AbortSignal; timeoutMs?: number }

const messages = pdfEditMessages(PDF_LIMITS);
const statusByWorkerCode: Record<keyof typeof messages.worker, number> = {
  PDF_INVALID: 400,
  PDF_ENCRYPTED: 400,
  PDF_PAGE_LIMIT: 400,
  PDF_PAGE_RANGE: 400,
  PDF_OUTPUT_LIMIT: 400,
  PDF_PARAMS: 400,
  PDF_EDIT_FAILED: 500,
};
let running = 0;

function editError(code: string, message: { ar: string; en: string }, status?: number): PdfError {
  return withReplyMessage(new PdfError(code, message.ar, status), message);
}

function assertPdf(bytes: Uint8Array, position: number): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw editError('PDF_INVALID', messages.worker.PDF_INVALID);
  if (bytes.byteLength > PDF_LIMITS.inputBytes) throw editError('PDF_SIZE_LIMIT', messages.oversizedInput(position));
  if (bytes.byteLength < 16 || !Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-')) throw editError('PDF_INVALID', messages.invalidInput(position));
  return bytes;
}

async function runWorker(op: string, inputs: readonly Uint8Array[], params: Record<string, unknown>, options: EditOptions): Promise<{ bytes?: Uint8Array; info?: PdfInfo }> {
  if (!inputs.length || inputs.length > PDF_LIMITS.inputFiles) throw editError('PDF_INPUT_COUNT', messages.inputCount);
  const copies = inputs.map((bytes, index) => Uint8Array.from(assertPdf(bytes, index + 1)));
  if (options.signal?.aborted) throw editError('PDF_EDIT_ABORTED', messages.aborted, 409);
  if (running >= PDF_LIMITS.workers) throw editError('PDF_EDIT_BUSY', messages.busy, 429);
  const timeoutMs = Math.max(1, Math.min(PDF_LIMITS.editTimeoutMs, Math.floor(options.timeoutMs ?? PDF_LIMITS.editTimeoutMs)));
  running++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./edit-worker.mjs', import.meta.url), {
      workerData: { op, inputs: copies, params, limits: { pages: PDF_LIMITS.pages, outputBytes: PDF_LIMITS.outputBytes } },
      transferList: copies.map(copy => copy.buffer), execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      stdout: true, stderr: true,
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: PdfError, result?: { bytes?: Uint8Array; info?: PdfInfo }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result!);
      };
      const abort = () => finish(editError('PDF_EDIT_ABORTED', messages.aborted, 409));
      const timer = setTimeout(() => finish(editError('PDF_EDIT_TIMEOUT', messages.timeout, 504)), timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      worker!.once('message', (message: unknown) => {
        const result = (message ?? {}) as { bytes?: unknown; info?: unknown; error?: unknown };
        if (typeof result.error === 'string') {
          const code = Object.hasOwn(statusByWorkerCode, result.error) ? result.error as keyof typeof statusByWorkerCode : 'PDF_EDIT_FAILED';
          return finish(editError(code, messages.worker[code], statusByWorkerCode[code]));
        }
        if (result.bytes instanceof Uint8Array && result.bytes.byteLength > 0 && result.bytes.byteLength <= PDF_LIMITS.outputBytes) return finish(undefined, { bytes: result.bytes });
        if (result.info && typeof result.info === 'object') return finish(undefined, { info: result.info as PdfInfo });
        finish(editError('PDF_EDIT_FAILED', messages.worker.PDF_EDIT_FAILED, 500));
      });
      worker!.once('error', () => finish(editError('PDF_EDIT_FAILED', messages.resources, 500)));
      worker!.once('exit', () => finish(editError('PDF_EDIT_FAILED', messages.earlyExit, 500)));
    });
  } finally {
    // Await termination even on timeout or cancellation: nothing keeps parsing after return.
    if (worker) await worker.terminate().catch(() => {});
    running--;
  }
}

const output = async (promise: Promise<{ bytes?: Uint8Array }>) => Buffer.from((await promise).bytes!);

export async function pdfInfo(bytes: Uint8Array, options: EditOptions = {}): Promise<PdfInfo> {
  return (await runWorker('info', [bytes], {}, options)).info!;
}
export function mergePdfs(files: readonly Uint8Array[], options: EditOptions = {}): Promise<Buffer> {
  if (files.length < 2) throw editError('PDF_INPUT_COUNT', messages.mergeCount);
  return output(runWorker('merge', files, {}, options));
}
export function extractPages(bytes: Uint8Array, pages: readonly number[], options: EditOptions = {}): Promise<Buffer> {
  return output(runWorker('extract', [bytes], { pages: [...pages] }, options));
}
export function deletePages(bytes: Uint8Array, pages: readonly number[], options: EditOptions = {}): Promise<Buffer> {
  return output(runWorker('extract', [bytes], { pages: [...pages], exclude: true }, options));
}
export function rotatePages(bytes: Uint8Array, angle: 90 | 180 | 270, pages?: readonly number[], options: EditOptions = {}): Promise<Buffer> {
  return output(runWorker('rotate', [bytes], { angle, ...(pages ? { pages: [...pages] } : {}) }, options));
}
export function reorderPages(bytes: Uint8Array, order: readonly number[], options: EditOptions = {}): Promise<Buffer> {
  return output(runWorker('reorder', [bytes], { order: [...order] }, options));
}
export function setPdfMetadata(bytes: Uint8Array, metadata: { title?: string; author?: string; subject?: string; keywords?: string[] }, options: EditOptions = {}): Promise<Buffer> {
  return output(runWorker('metadata', [bytes], { ...metadata }, options));
}
/** Draws the first page of `overlay` over the chosen pages, stretched to each page's size. */
export function stampPdf(bytes: Uint8Array, overlay: Uint8Array, options: EditOptions & { pages?: readonly number[]; opacity?: number } = {}): Promise<Buffer> {
  const { pages, opacity, ...rest } = options;
  return output(runWorker('overlay', [bytes, overlay], { ...(pages ? { pages: [...pages] } : {}), ...(opacity !== undefined ? { opacity } : {}) }, rest));
}
export function numberPages(bytes: Uint8Array, options: EditOptions & { size?: number; margin?: number; start?: number; total?: boolean; pages?: readonly number[] } = {}): Promise<Buffer> {
  const { size, margin, start, total, pages, ...rest } = options;
  return output(runWorker('number', [bytes], { size, margin, start, total, ...(pages ? { pages: [...pages] } : {}) }, rest));
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/gu;
/** «1-3, 5» or «من ٢ إلى ٤» or «الأخيرة» into 1-based page numbers, sorted and unique. */
export function parsePageSelection(text: string, total: number): number[] {
  if (!Number.isInteger(total) || total < 1) throw editError('PDF_PAGE_RANGE', messages.worker.PDF_PAGE_RANGE);
  let value = text.replace(ARABIC_DIGITS, digit => String(digit.charCodeAt(0) % 16)).toLowerCase();
  value = value.replace(/(?:^|[^\p{L}])(?:الاخيره|الأخيرة|الاخيرة|اخر صفحه|آخر صفحة|last)(?![\p{L}])/giu, ` ${total} `);
  value = value.replace(/(?:من|from)\s+(\d+)\s+(?:الى|إلى|حتى|to|through|until)\s+(\d+)/giu, '$1-$2').replace(/(\d+)\s*(?:الى|إلى|to|through)\s*(\d+)/giu, '$1-$2');
  const pages = new Set<number>();
  for (const part of value.match(/\d+\s*[-–]\s*\d+|\d+/gu) ?? []) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/u.exec(part);
    if (range) {
      const from = Number(range[1]), to = Number(range[2]);
      if (from < 1 || to > total || from > to || to - from > PDF_LIMITS.pages) throw editError('PDF_PAGE_RANGE', messages.worker.PDF_PAGE_RANGE);
      for (let page = from; page <= to; page++) pages.add(page);
    } else {
      const page = Number(part);
      if (page < 1 || page > total) throw editError('PDF_PAGE_RANGE', messages.worker.PDF_PAGE_RANGE);
      pages.add(page);
    }
  }
  if (!pages.size) throw editError('PDF_PAGE_RANGE', messages.noPages);
  return [...pages].sort((a, b) => a - b);
}
