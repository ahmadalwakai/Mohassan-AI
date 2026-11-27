import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { deletePages, extractPages, mergePdfs, numberPages, parsePageSelection, pdfInfo, reorderPages, rotatePages, setPdfMetadata, stampPdf } from './edit.ts';
import { PDF_LIMITS } from './limits.ts';
import { extractPdfText } from '../../learning/src/pdf.ts';
import { pdfFixture } from '../../learning/src/pdf-fixture.ts';

/** Real PDFs with one Latin line per page, so the extractor can prove page order and content. */
async function makePdf(pages: readonly string[], options: { landscape?: boolean; title?: string } = {}): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = document.addPage(options.landscape ? [842, 595] : [595, 842]);
    page.drawText(text, { x: 60, y: page.getHeight() - 80, size: 18, font });
  }
  if (options.title) document.setTitle(options.title);
  return Buffer.from(await document.save());
}
const pageTexts = async (bytes: Uint8Array) => (await extractPdfText(bytes)).split(/\n{2,}/u).map(part => part.trim()).filter(Boolean);

describe('pdf-lib edits in a worker', () => {
  it('reports pages, size and metadata', async () => {
    const info = await pdfInfo(await makePdf(['one', 'two'], { title: 'Two pages' }));
    expect(info).toMatchObject({ pages: 2, title: 'Two pages', pageSize: { width: 595, height: 842 } });
  });

  it('merges files in order and marks the producer', async () => {
    const merged = await mergePdfs([await makePdf(['A1', 'A2']), await makePdf(['B1'], { landscape: true })]);
    expect(await pageTexts(merged)).toEqual(['A1', 'A2', 'B1']);
    const info = await pdfInfo(merged);
    expect(info.pages).toBe(3);
    expect(info.producer).toBe('Mohassan PDF');
    expect(() => mergePdfs([merged])).toThrow(expect.objectContaining({ code: 'PDF_INPUT_COUNT' }));
  });

  it('extracts, deletes, reorders and rotates pages', async () => {
    const source = await makePdf(['p1', 'p2', 'p3', 'p4']);
    expect(await pageTexts(await extractPages(source, [2, 4]))).toEqual(['p2', 'p4']);
    expect(await pageTexts(await deletePages(source, [1, 3]))).toEqual(['p2', 'p4']);
    expect(await pageTexts(await reorderPages(source, [4, 3, 2, 1]))).toEqual(['p4', 'p3', 'p2', 'p1']);
    const rotated = await PDFDocument.load(await rotatePages(source, 90, [2]));
    expect(rotated.getPage(0).getRotation().angle).toBe(0);
    expect(rotated.getPage(1).getRotation().angle).toBe(90);
    await expect(extractPages(source, [5])).rejects.toMatchObject({ code: 'PDF_PAGE_RANGE' });
    await expect(deletePages(source, [1, 2, 3, 4])).rejects.toMatchObject({ code: 'PDF_PAGE_RANGE' });
    await expect(reorderPages(source, [1, 1, 2, 3])).rejects.toMatchObject({ code: 'PDF_PAGE_RANGE' });
  });

  it('sets metadata, stamps an overlay on chosen pages and numbers pages', async () => {
    const source = await makePdf(['first', 'second', 'third']);
    const titled = await setPdfMetadata(source, { title: 'عنوان جديد', author: 'موحسن', keywords: ['pdf', 'test'] });
    expect(await pdfInfo(titled)).toMatchObject({ title: 'عنوان جديد', author: 'موحسن', keywords: 'pdf test' });

    const overlayDocument = await PDFDocument.create();
    const overlayPage = overlayDocument.addPage([595, 842]);
    overlayPage.drawRectangle({ x: 100, y: 100, width: 300, height: 300, color: rgb(0.9, 0.2, 0.2) });
    const overlayFont = await overlayDocument.embedFont(StandardFonts.Helvetica);
    overlayPage.drawText('STAMP', { x: 150, y: 400, size: 40, font: overlayFont });
    const stamped = await stampPdf(source, Buffer.from(await overlayDocument.save()), { pages: [1, 3], opacity: 0.5 });
    const texts = await pageTexts(stamped);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('STAMP');
    expect(texts[1]).not.toContain('STAMP');
    expect(texts[2]).toContain('STAMP');

    const numbered = await numberPages(source);
    const pages = await pageTexts(numbered);
    expect(pages[0]).toContain('1 / 3');
    expect(pages[2]).toContain('3 / 3');
    expect((await pageTexts(await numberPages(source, { total: false, start: 5 })))[1]).toContain('6');
  });

  it('refuses garbage, encrypted files, oversized inputs, too many files and cancelled work', async () => {
    const source = await makePdf(['x']);
    await expect(pdfInfo(Buffer.from('%PDF-1.7 not really a pdf at all, just text'))).rejects.toMatchObject({ code: 'PDF_INVALID' });
    await expect(pdfInfo(Buffer.from('plain text'))).rejects.toMatchObject({ code: 'PDF_INVALID' });
    await expect(pdfInfo(pdfFixture(['secret'], { encrypted: true }))).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
    await expect(pdfInfo(Buffer.alloc(PDF_LIMITS.inputBytes + 1))).rejects.toMatchObject({ code: 'PDF_SIZE_LIMIT' });
    await expect(mergePdfs(Array.from({ length: PDF_LIMITS.inputFiles + 1 }, () => source))).rejects.toMatchObject({ code: 'PDF_INPUT_COUNT' });
    const controller = new AbortController();
    controller.abort();
    await expect(pdfInfo(source, { signal: controller.signal })).rejects.toMatchObject({ code: 'PDF_EDIT_ABORTED' });
    expect((await pdfInfo(source)).pages).toBe(1);
  });
});

describe('parsePageSelection', () => {
  it('reads ranges, Arabic digits, «من … إلى» and «الأخيرة»', () => {
    expect(parsePageSelection('الصفحات 1-3 و 5', 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageSelection('من ٢ إلى ٤', 10)).toEqual([2, 3, 4]);
    expect(parsePageSelection('pages 7 to 8 and the last', 10)).toEqual([7, 8, 10]);
    expect(parsePageSelection('الصفحة الأخيرة', 4)).toEqual([4]);
    expect(() => parsePageSelection('الصفحة 12', 10)).toThrow(expect.objectContaining({ code: 'PDF_PAGE_RANGE' }));
    expect(() => parsePageSelection('بدون أرقام', 10)).toThrow(expect.objectContaining({ code: 'PDF_PAGE_RANGE' }));
    expect(() => parsePageSelection('3-1', 10)).toThrow(expect.objectContaining({ code: 'PDF_PAGE_RANGE' }));
  });
});
