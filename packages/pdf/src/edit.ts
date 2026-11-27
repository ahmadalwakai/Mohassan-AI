import { postPdfEdit } from './edit-worker-pool.ts';
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

const MESSAGES: Record<string, [string, number]> = {
  PDF_INVALID: ['ملف PDF غير صالح أو تعذرت قراءته.', 400],
  PDF_ENCRYPTED: ['ملفات PDF المشفرة أو المحمية بكلمة مرور غير مدعومة.', 400],
  PDF_PAGE_LIMIT: [`عدد الصفحات يتجاوز ${PDF_LIMITS.pages} صفحة.`, 400],
  PDF_PAGE_RANGE: ['أرقام الصفحات خارج نطاق الملف.', 400],
  PDF_OUTPUT_LIMIT: ['الملف الناتج أكبر من المسموح.', 400],
  PDF_PARAMS: ['معاملات التعديل غير صالحة.', 400],
  PDF_EDIT_FAILED: ['تعذر تعديل ملف PDF.', 500],
};

function assertPdf(bytes: Uint8Array, position: number): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new PdfError('PDF_INVALID', MESSAGES.PDF_INVALID![0]);
  if (bytes.byteLength > PDF_LIMITS.inputBytes) throw new PdfError('PDF_SIZE_LIMIT', `حجم الملف ${position} يتجاوز ${Math.round(PDF_LIMITS.inputBytes / 1_000_000)} ميغابايت.`);
  if (bytes.byteLength < 16 || !Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-')) throw new PdfError('PDF_INVALID', `الملف ${position} ليس ملف PDF.`);
  return bytes;
}

async function runWorker(op: string, inputs: readonly Uint8Array[], params: Record<string, unknown>, options: EditOptions): Promise<{ bytes?: Uint8Array; info?: PdfInfo }> {
  if (!inputs.length || inputs.length > PDF_LIMITS.inputFiles) throw new PdfError('PDF_INPUT_COUNT', `يمكن معالجة من ملف واحد إلى ${PDF_LIMITS.inputFiles} ملفًا في العملية الواحدة.`);
  const copies = inputs.map((bytes, index) => Uint8Array.from(assertPdf(bytes, index + 1)));
  const message = await postPdfEdit({ op, inputs: copies, params }, options);
  const result = (message ?? {}) as { bytes?: unknown; info?: unknown; error?: unknown };
  if (typeof result.error === 'string') {
    const code = Object.hasOwn(MESSAGES, result.error) ? result.error : 'PDF_EDIT_FAILED';
    throw new PdfError(code, ...MESSAGES[code]!);
  }
  if (result.bytes instanceof Uint8Array && result.bytes.byteLength > 0 && result.bytes.byteLength <= PDF_LIMITS.outputBytes) return { bytes: result.bytes };
  if (result.info && typeof result.info === 'object') return { info: result.info as PdfInfo };
  throw new PdfError('PDF_EDIT_FAILED', ...MESSAGES.PDF_EDIT_FAILED!);
}

const output = async (promise: Promise<{ bytes?: Uint8Array }>) => Buffer.from((await promise).bytes!);

export async function pdfInfo(bytes: Uint8Array, options: EditOptions = {}): Promise<PdfInfo> {
  return (await runWorker('info', [bytes], {}, options)).info!;
}
export function mergePdfs(files: readonly Uint8Array[], options: EditOptions = {}): Promise<Buffer> {
  if (files.length < 2) throw new PdfError('PDF_INPUT_COUNT', 'الدمج يحتاج ملفين على الأقل.');
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
/** Stretches the first page of `overlay` to the visible area of each chosen page. */
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
  if (!Number.isInteger(total) || total < 1) throw new PdfError('PDF_PAGE_RANGE', MESSAGES.PDF_PAGE_RANGE![0]);
  let value = text.replace(ARABIC_DIGITS, digit => String(digit.charCodeAt(0) % 16)).toLowerCase();
  value = value.replace(/(?:^|[^\p{L}])(?:الاخيره|الأخيرة|الاخيرة|اخر صفحه|آخر صفحة|last)(?![\p{L}])/giu, ` ${total} `);
  value = value.replace(/(?:من|from)\s+(\d+)\s+(?:الى|إلى|حتى|to|through|until)\s+(\d+)/giu, '$1-$2').replace(/(\d+)\s*(?:الى|إلى|to|through)\s*(\d+)/giu, '$1-$2');
  const pages = new Set<number>();
  for (const part of value.match(/\d+\s*[-–]\s*\d+|\d+/gu) ?? []) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/u.exec(part);
    if (range) {
      const from = Number(range[1]), to = Number(range[2]);
      if (from < 1 || to > total || from > to || to - from > PDF_LIMITS.pages) throw new PdfError('PDF_PAGE_RANGE', MESSAGES.PDF_PAGE_RANGE![0]);
      for (let page = from; page <= to; page++) pages.add(page);
    } else {
      const page = Number(part);
      if (page < 1 || page > total) throw new PdfError('PDF_PAGE_RANGE', MESSAGES.PDF_PAGE_RANGE![0]);
      pages.add(page);
    }
  }
  if (!pages.size) throw new PdfError('PDF_PAGE_RANGE', 'لم أجد أرقام صفحات في الطلب.');
  return [...pages].sort((a, b) => a - b);
}
