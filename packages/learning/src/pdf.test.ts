import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractPdfText, PDF_LIMITS } from './pdf.ts';
import { pdfFixture } from './pdf-fixture.ts';

describe('bounded PDF text extraction in a terminable worker', () => {
  it('extracts Arabic and multiple pages without executing document JavaScript', async () => {
    const text = await extractPdfText(pdfFixture(['مورد الورق المعتمد هو الأرز', 'Second page delivery 09:30'], { script: 'throw new Error("PDF_SCRIPT_EXECUTED");' }));
    expect(text).toContain('مورد الورق المعتمد هو الأرز');
    expect(text).toContain('Second page delivery 09:30');
    expect(text).not.toContain('PDF_SCRIPT_EXECUTED');
  });
  it('rejects malformed and encrypted PDFs with bounded public errors', async () => {
    await expect(extractPdfText(Buffer.from('invalid private-source'))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_INVALID' });
    await expect(extractPdfText(Buffer.from('%PDF-1.7\nprivate-source\n%%EOF'))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_INVALID' });
    await expect(extractPdfText(pdfFixture(['Secret content'], { encrypted: true }))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_ENCRYPTED' });
  });
  it('rejects image-only files and states that OCR is unavailable', async () => {
    await expect(extractPdfText(pdfFixture([''], { imageOnly: true }))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_NO_TEXT', message: expect.stringContaining('OCR') });
  });
  it('enforces byte, page, and expanded-text limits without truncating a successful result', async () => {
    await expect(extractPdfText(Buffer.alloc(PDF_LIMITS.bytes + 1))).rejects.toMatchObject({ code: 'KNOWLEDGE_SIZE_LIMIT' });
    await expect(extractPdfText(pdfFixture(Array.from({ length: PDF_LIMITS.pages + 1 }, () => 'page')))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_PAGE_LIMIT' });
    const compressed = deflateSync(Buffer.from(`BT /F1 1 Tf 10 400 Td <${'0041'.repeat(500)}> Tj ET\n`.repeat(520)));
    await expect(extractPdfText(pdfFixture(['A'], { compressed }))).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_TEXT_LIMIT' });
  });
  it('terminates on deadline or cancellation and releases capacity for the next document', async () => {
    const bytes = pdfFixture(['following request still works']);
    await expect(extractPdfText(bytes, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_TIMEOUT' });
    const controller = new AbortController();
    const pending = extractPdfText(bytes, { signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_ABORTED' });
    await expect(extractPdfText(bytes, { signal: controller.signal })).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_ABORTED' });
    expect(await extractPdfText(bytes)).toContain('following request still works');
  });
  it('limits concurrent parsers and releases both slots after cancellation', async () => {
    const controller = new AbortController(), bytes = pdfFixture(['bounded parallel processing']);
    const first = extractPdfText(bytes, { signal: controller.signal }), second = extractPdfText(bytes, { signal: controller.signal });
    const settled = Promise.allSettled([first, second]);
    await expect(extractPdfText(bytes)).rejects.toMatchObject({ code: 'KNOWLEDGE_PDF_BUSY' });
    controller.abort();
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(await extractPdfText(bytes)).toContain('bounded parallel processing');
  });
});
