import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { PdfError } from './errors.ts';
import type { PrintOptions } from './html.ts';
import { PDF_LIMITS } from './limits.ts';

/**
 * HTML to PDF through headless Chromium, the only engine here that shapes Arabic correctly.
 * Each render gets its own context with JavaScript off and every network request aborted, so the
 * owner's text can never fetch or run anything. Chromium is launched on demand and closed when idle.
 */
export interface RenderOptions {
  print?: Partial<PrintOptions>;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface PdfRenderer {
  render(html: string, options?: RenderOptions): Promise<Buffer>;
  /** @font-face CSS for the fonts bundled in the fonts directory; empty when there are none. */
  fontFaces(): Promise<string>;
  close(): Promise<void>;
}
export interface PdfRendererOptions {
  /** Directory of .ttf/.otf/.woff2 files embedded into every document as "Mohassan Document"; the package's own fonts/ folder by default. */
  fontsDir?: string;
  /** Milliseconds without a render before Chromium is closed to free its memory. */
  idleMs?: number;
  launch?: () => Promise<Browser>;
}

const FONT_FORMATS: Record<string, [mime: string, format: string]> = {
  '.ttf': ['font/ttf', 'truetype'], '.otf': ['font/otf', 'opentype'], '.woff2': ['font/woff2', 'woff2'], '.woff': ['font/woff', 'woff'],
};
const MAX_FONT_BYTES = 6_000_000;
const MAX_HTML_CHARS = 4_000_000;
/** packages/pdf/fonts: Noto Naskh Arabic (OFL) ships there, so Arabic never depends on the machine's fonts. */
export const DEFAULT_FONTS_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));
const DEFAULT_PRINT: PrintOptions = { format: 'A4', landscape: false, margin: { top: '18mm', right: '17mm', bottom: '20mm', left: '17mm' }, displayHeaderFooter: false, headerTemplate: '', footerTemplate: '' };

/** Bundled fonts become data URIs, so a document never depends on the machine's installed fonts. */
export async function loadFontFaces(dir: string | undefined): Promise<string> {
  if (!dir) return '';
  let names: string[];
  try { names = await readdir(dir); } catch { return ''; }
  const faces: string[] = [];
  for (const name of names.sort()) {
    const entry = FONT_FORMATS[extname(name).toLowerCase()];
    if (!entry) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FONT_BYTES) continue;
    const bytes = await readFile(path);
    // A variable font ([wght] axis) serves every weight; a static file is bold or regular by its name.
    const weight = /\[wght\]|variable/iu.test(name) ? '100 900' : /bold|black|heavy|700|800|900/iu.test(name) ? '700' : '400';
    faces.push(`@font-face { font-family: "Mohassan Document"; font-weight: ${weight}; font-display: block; src: url(data:${entry[0]};base64,${bytes.toString('base64')}) format("${entry[1]}"); }`);
  }
  return faces.join('\n');
}

export function createPdfRenderer(options: PdfRendererOptions = {}): PdfRenderer {
  const idleMs = Math.max(1000, options.idleMs ?? 90_000);
  let browser: Promise<Browser> | null = null;
  let idle: NodeJS.Timeout | undefined;
  let active = 0;
  let closed = false;
  let fonts: Promise<string> | undefined;
  const waiting: (() => void)[] = [];

  const acquire = () => new Promise<void>(resolve => {
    if (active < PDF_LIMITS.workers) { active++; resolve(); } else waiting.push(() => { active++; resolve(); });
  });
  function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
    else if (!active && !closed) { clearTimeout(idle); idle = setTimeout(() => { void closeBrowser(); }, idleMs); idle.unref(); }
  }
  async function closeBrowser() {
    const current = browser;
    browser = null;
    if (current) await current.then(instance => instance.close()).catch(() => {});
  }
  async function open(): Promise<Browser> {
    if (closed) throw new PdfError('PDF_RENDER_CLOSED', 'خدمة PDF تتوقف.', 503);
    if (browser) {
      const existing = await browser.catch(() => null);
      if (existing?.isConnected()) return existing;
      browser = null;
    }
    const pending = (options.launch ?? (() => chromium.launch({ headless: true })))();
    browser = pending;
    try { return await pending; }
    catch { if (browser === pending) browser = null; throw new PdfError('PDF_RENDER_UNAVAILABLE', 'تعذر تشغيل محرك PDF. ثبّت Chromium بالأمر: npx playwright install chromium', 503); }
  }

  return {
    fontFaces: () => (fonts ??= loadFontFaces(options.fontsDir ?? DEFAULT_FONTS_DIR)),
    async render(html, renderOptions = {}) {
      if (typeof html !== 'string' || !html.trim()) throw new PdfError('PDF_RENDER_INPUT', 'لا يوجد محتوى لتحويله إلى PDF.');
      if (html.length > MAX_HTML_CHARS) throw new PdfError('PDF_RENDER_INPUT', 'محتوى المستند أكبر من المسموح.');
      if (renderOptions.signal?.aborted) throw new PdfError('PDF_RENDER_ABORTED', 'أُلغي إنشاء PDF.', 409);
      const timeoutMs = Math.max(1000, Math.min(PDF_LIMITS.renderTimeoutMs, Math.floor(renderOptions.timeoutMs ?? PDF_LIMITS.renderTimeoutMs)));
      await acquire();
      clearTimeout(idle);
      let context: BrowserContext | undefined;
      let timedOut = false;
      const stop = () => { void context?.close().catch(() => {}); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      renderOptions.signal?.addEventListener('abort', stop, { once: true });
      try {
        const instance = await open();
        context = await instance.newContext({ javaScriptEnabled: false, viewport: { width: 794, height: 1123 }, locale: 'ar' });
        await context.route('**/*', route => route.abort('blockedbyclient'));
        if (renderOptions.signal?.aborted || timedOut) throw new Error('stopped');
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        const print = { ...DEFAULT_PRINT, ...renderOptions.print };
        const bytes = await page.pdf({
          format: print.format, landscape: print.landscape, margin: print.margin, printBackground: true, preferCSSPageSize: false,
          displayHeaderFooter: print.displayHeaderFooter, headerTemplate: print.headerTemplate || '<span></span>', footerTemplate: print.footerTemplate || '<span></span>',
        });
        if (bytes.length > PDF_LIMITS.outputBytes) throw new PdfError('PDF_OUTPUT_LIMIT', 'الملف الناتج أكبر من المسموح.');
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfError('PDF_RENDER_FAILED', 'لم ينتج المحرك ملف PDF صالحًا.', 500);
        return Buffer.from(bytes);
      } catch (error) {
        if (error instanceof PdfError) throw error;
        if (renderOptions.signal?.aborted) throw new PdfError('PDF_RENDER_ABORTED', 'أُلغي إنشاء PDF.', 409);
        if (timedOut) throw new PdfError('PDF_RENDER_TIMEOUT', 'تجاوز إنشاء PDF المهلة المسموحة.', 504);
        throw new PdfError('PDF_RENDER_FAILED', 'تعذر إنشاء PDF من هذا المحتوى.', 500);
      } finally {
        clearTimeout(timer);
        renderOptions.signal?.removeEventListener('abort', stop);
        await context?.close().catch(() => {});
        release();
      }
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      await closeBrowser();
    },
  };
}
