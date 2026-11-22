import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfInfo } from './edit.ts';
import { renderDocumentHtml, watermarkHtml, WATERMARK_PRINT } from './html.ts';
import { DEFAULT_FONTS_DIR, createPdfRenderer, loadFontFaces, type PdfRenderer } from './render.ts';
import { extractPdfText } from '../../learning/src/pdf.ts';

/** The PostScript names of the fonts each page's resources reference, subset prefixes (AAAAAA+) removed. */
async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const document = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const page of document.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
    if (!(fonts instanceof PDFDict)) continue;
    for (const [, ref] of fonts.entries()) {
      const font = document.context.lookup(ref);
      if (!(font instanceof PDFDict)) continue;
      const base = font.get(PDFName.of('BaseFont'))?.toString();
      if (base) names.add(base.replace(/^\/(?:[A-Z]{6}\+)?/u, ''));
    }
  }
  return [...names].sort();
}

/** Shaped Arabic comes back from pdf.js as presentation forms, sometimes in visual (reversed) order; NFKC folds them to letters. */
const letters = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
const hasWord = (text: string, word: string) => letters(text).includes(letters(word)) || letters(text).includes([...letters(word)].reverse().join(''));

describe('Chromium PDF renderer', () => {
  let renderer: PdfRenderer;
  let server: Server;
  let origin: string;
  const hits: string[] = [];

  beforeAll(async () => {
    renderer = createPdfRenderer({ idleMs: 60_000 });
    server = createServer((request, response) => { hits.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'text/css' }); response.end('body{color:red}'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await renderer.close();
    await new Promise(resolve => server.close(resolve));
  });

  it('renders an Arabic document with shaped text, a title and page numbers', async () => {
    const started = performance.now();
    const document = renderDocumentHtml({
      title: 'تقرير المبيعات', subtitle: 'الربع الثالث', author: 'موحسن', date: '2026-11-22', theme: 'report',
      blocks: [{ kind: 'heading', level: 1, text: 'الملخص' }, { kind: 'paragraph', text: 'ارتفعت المبيعات بنسبة 12% مقارنة بالربع السابق. Revenue grew.' },
        { kind: 'table', header: ['المنتج', 'المبيعات'], rows: [['ورق', '1,200'], ['حبر', '850']] }],
    });
    const bytes = await renderer.render(document.html, { print: document.print });
    const elapsed = performance.now() - started;
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const info = await pdfInfo(bytes);
    expect(info).toMatchObject({ pages: 1, title: 'تقرير المبيعات' });
    // Chromium's A4 is 8.27 × 11.69 inches, a point or two off ISO's 595 × 842.
    expect(Math.abs(info.pageSize.width - 595)).toBeLessThanOrEqual(2);
    expect(Math.abs(info.pageSize.height - 842)).toBeLessThanOrEqual(2);
    const text = await extractPdfText(bytes);
    expect(text).toContain('Revenue grew');
    // Digits inside the right-to-left run come back split by the extractor; the characters are all there.
    expect(text.replace(/\s+/gu, '')).toMatch(/12|21/u);
    expect(text).toContain('%');
    expect(hasWord(text, 'الملخص')).toBe(true);
    expect(text.replace(/\s+/gu, '')).toContain('1/1');
    expect(elapsed).toBeLessThan(25_000);
  });

  it('flows long text over several pages and honours Letter landscape', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) => ({ kind: 'paragraph' as const, text: `Paragraph ${index + 1}. ${'Mohassan writes nothing of its own. '.repeat(12)}` }));
    const document = renderDocumentHtml({ title: 'Long report', pageSize: 'Letter', orientation: 'landscape', blocks: paragraphs });
    const info = await pdfInfo(await renderer.render(document.html, { print: document.print }));
    expect(info.pages).toBeGreaterThan(2);
    expect(Math.abs(info.pageSize.width - 792)).toBeLessThanOrEqual(2);
    expect(Math.abs(info.pageSize.height - 612)).toBeLessThanOrEqual(2);
  });

  it('blocks every network request and never runs scripts from the content', async () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${origin}/style.css"><title>Original</title></head><body><img src="${origin}/pixel.png"><script>document.title = 'HACKED';</script><p>Visible</p></body></html>`;
    const bytes = await renderer.render(html);
    expect(hits).toEqual([]);
    expect((await pdfInfo(bytes)).title).toBe('Original');
    expect(await extractPdfText(bytes)).toContain('Visible');
  });

  it('embeds the bundled Noto Naskh Arabic for Arabic, Latin and bold text, so the body needs no system font', async () => {
    const faces = await renderer.fontFaces();
    expect(faces).toContain('font-family: "Mohassan Document"');
    expect(faces).toContain('font-weight: 100 900');
    const document = renderDocumentHtml({ title: 'عقد توريد', theme: 'letter', blocks: [{ kind: 'paragraph', text: 'الطرف الأول يورّد 120 طنًا. Delivery in **March**.' }, { kind: 'heading', level: 2, text: 'الشروط' }] }, faces);
    const body = await fontNames(await renderer.render(document.html, { print: { ...document.print, displayHeaderFooter: false } }));
    expect(body.length).toBeGreaterThan(0);
    expect(body.every(name => /NotoNaskhArabic/u.test(name)), body.join(', ')).toBe(true);
    // The footer is Chromium's own document, drawn with the system font: digits only, so it reads anywhere.
    expect(document.print.footerTemplate).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>');
    const withFooter = await fontNames(await renderer.render(document.html, { print: document.print }));
    expect(withFooter.some(name => /NotoNaskhArabic/u.test(name))).toBe(true);
    const mark = await renderer.render(watermarkHtml('سري', {}, faces), { print: WATERMARK_PRINT });
    expect((await fontNames(mark)).every(name => /NotoNaskhArabic/u.test(name))).toBe(true);
  });

  it('renders a watermark page without margins', async () => {
    const bytes = await renderer.render(watermarkHtml('سري'), { print: WATERMARK_PRINT });
    expect((await pdfInfo(bytes)).pages).toBe(1);
    expect(hasWord(await extractPdfText(bytes), 'سري')).toBe(true);
  });

  it('rejects empty content, a cancelled request and renders after close', async () => {
    await expect(renderer.render('   ')).rejects.toMatchObject({ code: 'PDF_RENDER_INPUT' });
    const controller = new AbortController();
    controller.abort();
    await expect(renderer.render('<p>x</p>', { signal: controller.signal })).rejects.toMatchObject({ code: 'PDF_RENDER_ABORTED' });
    const other = createPdfRenderer();
    await other.close();
    await expect(other.render('<p>x</p>')).rejects.toMatchObject({ code: 'PDF_RENDER_CLOSED' });
  });

  it('reports an unavailable engine as a bounded error', async () => {
    const broken = createPdfRenderer({ launch: async () => { throw new Error('no chromium'); } });
    await expect(broken.render('<p>x</p>')).rejects.toMatchObject({ code: 'PDF_RENDER_UNAVAILABLE', statusCode: 503 });
    await broken.close();
  });
});

describe('loadFontFaces', () => {
  it('embeds bundled fonts as data URIs and ignores other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mohassan-fonts-'));
    try {
      await writeFile(join(dir, 'Arabic-Regular.ttf'), Buffer.from([0, 1, 0, 0, 7]));
      await writeFile(join(dir, 'Arabic-Bold.ttf'), Buffer.from([0, 1, 0, 0, 9]));
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      const css = await loadFontFaces(dir);
      expect(css.match(/@font-face/gu)).toHaveLength(2);
      expect(css).toContain('font-weight: 700');
      expect(css).toContain('data:font/ttf;base64,AAEAAAk=');
      expect(css).not.toContain('notes');
      expect(await loadFontFaces(join(dir, 'missing'))).toBe('');
      expect(await loadFontFaces(undefined)).toBe('');
      const bundled = await loadFontFaces(DEFAULT_FONTS_DIR);
      expect(bundled).toContain('font-weight: 100 900');
      expect(bundled.length).toBeGreaterThan(300_000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
