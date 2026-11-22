import { describe, expect, it } from 'vitest';
import { ChatQuestionFieldSchema } from '@mohassan/contracts';
import {
  composeDocumentSpec, documentCreatedReply, documentEditedReply, documentInfoReply, documentQuestion, documentTask, noSourceReply, pdfPaths, unsupportedDocumentReply,
  type DocumentCreateTask, type DocumentEditTask,
} from '../apps/server/src/assistant/documents.js';
import { isDocumentRequest, notWebReason, tidy } from '../apps/server/src/assistant/hands.js';
import { writingTask } from '../apps/server/src/assistant/writer.js';
import { unsupportedRequest } from '../apps/server/src/assistant/unsupported-request.js';

describe('documentTask: creating', () => {
  it('recognises Arabic and English requests for a new PDF, with the design and title it names', () => {
    expect(documentTask('اصنع لي ملف pdf')).toEqual({ kind: 'create', lang: 'ar' });
    expect(documentTask('أنشئ تقرير PDF بعنوان «مبيعات نوفمبر»')).toEqual({ kind: 'create', lang: 'ar', theme: 'report', title: 'مبيعات نوفمبر' });
    expect(documentTask('سوّي لي فاتورة بي دي اف عن صيانة المكيف')).toMatchObject({ kind: 'create', lang: 'ar', theme: 'invoice', topic: 'صيانة المكيف' });
    expect(documentTask('Make a PDF titled "Weekly plan" in a modern design')).toMatchObject({ kind: 'create', lang: 'en', title: 'Weekly plan', theme: 'modern' });
    expect(documentTask('Can you design a simple pdf letter for me?')).toMatchObject({ kind: 'create', lang: 'en', theme: 'letter' });
  });

  it('keeps supplied content exactly: after a line break, after a body marker, or after a colon', () => {
    const body = '# المقدمة\nالسطر الأول.\n- نقطة ١\n- نقطة ٢';
    expect(documentTask(`اصنع ملف pdf بعنوان «خطة العمل»\n${body}`)).toEqual({ kind: 'create', lang: 'ar', title: 'خطة العمل', suppliedText: body });
    expect(documentTask('حوّل إلى pdf بالنص «نص قصير جدًا»')).toMatchObject({ kind: 'create', suppliedText: 'نص قصير جدًا' });
    expect(documentTask('Convert this to a pdf: Delivery is late by two days because of shipping.')).toMatchObject({ kind: 'create', lang: 'en', suppliedText: 'Delivery is late by two days because of shipping.' });
  });

  it('leaves questions about PDF, other formats and unrelated requests alone', () => {
    expect(documentTask('ما هو ملف pdf؟')).toBeNull();
    expect(documentTask('How do I open a PDF on my phone?')).toBeNull();
    expect(documentTask('كم سعر الذهب اليوم')).toBeNull();
    expect(documentTask('اكتب رسالة اعتذار لعميل')).toBeNull();
    expect(documentTask('حوّل ملف report.docx إلى pdf')).toEqual({ kind: 'unsupported', lang: 'ar', reason: 'convert_format' });
    expect(documentTask('')).toBeNull();
  });
});

describe('documentTask: editing', () => {
  it('reads merge, pages, rotation, watermark, numbering, info and metadata requests with their sources', () => {
    expect(documentTask('ادمج الملفين')).toBeNull();
    expect(documentTask('ادمج الملفين', { hasDocuments: true })).toEqual({ kind: 'edit', lang: 'ar', operation: 'merge', sources: [{ kind: 'all' }] });
    expect(documentTask('احذف الصفحة الأخيرة', { hasDocuments: true })).toMatchObject({ operation: 'delete', sources: [{ kind: 'latest', count: 1 }] });
    expect(documentTask('اصنع ملف جديد', { hasDocuments: true })).toBeNull();
    expect(documentTask('ادمج ملفات pdf')).toEqual({ kind: 'edit', lang: 'ar', operation: 'merge', sources: [{ kind: 'all' }] });
    expect(documentTask('ادمج C:\\Docs\\a.pdf و C:\\Docs\\b.pdf')).toEqual({ kind: 'edit', lang: 'ar', operation: 'merge', sources: [{ kind: 'path', path: 'C:\\Docs\\a.pdf' }, { kind: 'path', path: 'C:\\Docs\\b.pdf' }] });
    expect(documentTask('Merge "C:\\My Files\\first one.pdf" with "C:\\My Files\\second one.pdf"')).toMatchObject({ operation: 'merge', sources: [{ kind: 'path', path: 'C:\\My Files\\first one.pdf' }, { kind: 'path', path: 'C:\\My Files\\second one.pdf' }] });
    expect(documentTask('احذف الصفحة 2 من آخر ملف pdf')).toEqual({ kind: 'edit', lang: 'ar', operation: 'delete', sources: [{ kind: 'latest', count: 1 }], pages: expect.stringContaining('2') });
    expect(documentTask('استخرج الصفحات من ١ إلى ٣ من الملف pdf')).toMatchObject({ operation: 'extract', pages: expect.stringContaining('1 الي 3') });
    expect(documentTask('Delete pages 1-2 and the last page of the pdf')).toMatchObject({ operation: 'delete', lang: 'en', pages: expect.stringMatching(/1-2.*last/u) });
    expect(documentTask('دوّر صفحات ملف pdf 90 درجة')).toMatchObject({ operation: 'rotate', angle: 90 });
    expect(documentTask('اقلب الصفحة 3 في ملف pdf')).toMatchObject({ operation: 'rotate', angle: 180, pages: expect.stringContaining('3') });
    expect(documentTask('Rotate the pdf 270 degrees')).toMatchObject({ operation: 'rotate', angle: 270 });
    expect(documentTask('أضف علامة مائية «سري» على ملف pdf')).toMatchObject({ operation: 'watermark', text: 'سري' });
    expect(documentTask('ضع علامة مائية مسودة على آخر ملف pdf')).toMatchObject({ operation: 'watermark', text: 'مسودة' });
    expect(documentTask('Add a watermark CONFIDENTIAL to the pdf')).toMatchObject({ operation: 'watermark', text: 'CONFIDENTIAL' });
    expect(documentTask('رقّم صفحات ملف pdf')).toMatchObject({ operation: 'number' });
    expect(documentTask('add page numbers to the pdf')).toMatchObject({ operation: 'number' });
    expect(documentTask('كم صفحة في ملف C:\\Docs\\a.pdf؟')).toMatchObject({ operation: 'info', sources: [{ kind: 'path', path: 'C:\\Docs\\a.pdf' }] });
    expect(documentTask('غيّر عنوان ملف pdf إلى "تقرير 2026"')).toMatchObject({ operation: 'metadata', title: 'تقرير 2026' });
    expect(documentTask('Set the pdf author to Ahmad')).toMatchObject({ operation: 'metadata', author: 'Ahmad' });
  });

  it('asks for what is missing instead of guessing pages or text', () => {
    expect(documentTask('احذف صفحات من ملف pdf')).toEqual({ kind: 'unsupported', lang: 'ar', reason: 'missing_pages' });
    expect(documentTask('أضف علامة مائية على ملف pdf')).toEqual({ kind: 'unsupported', lang: 'ar', reason: 'missing_text' });
    expect(unsupportedDocumentReply({ reason: 'missing_pages', lang: 'ar' })).toContain('احذف الصفحة 2');
    expect(unsupportedDocumentReply({ reason: 'convert_format', lang: 'en' })).toContain('Word');
  });

  it('extracts quoted and bare paths without changing their characters', () => {
    expect(pdfPaths('افتح «D:\\ملفات العمل\\تقرير 2026.pdf» و C:/tmp/x.pdf')).toEqual(['D:\\ملفات العمل\\تقرير 2026.pdf', 'C:/tmp/x.pdf']);
    expect(pdfPaths('no files here')).toEqual([]);
  });
});

describe('routing', () => {
  it('keeps PDF work out of web search, letters and the unsupported list, while PDF questions stay web questions', () => {
    for (const text of ['اصنع لي ملف pdf عن الصيانة', 'ادمج الملفين pdf', 'Add a watermark DRAFT to the pdf', 'احذف الصفحة 2 من C:\\Docs\\a.pdf']) {
      expect(isDocumentRequest(tidy(text)), text).toBe(true);
      expect(notWebReason(tidy(text)), text).toBe('document');
    }
    expect(notWebReason(tidy('ما هو ملف pdf؟'))).not.toBe('document');
    expect(notWebReason(tidy('How to open a pdf file?'))).not.toBe('document');
    expect(notWebReason(tidy('What is PDF/A?'))).toBeNull();
    expect(isDocumentRequest(tidy('أرسل لي ملف'))).toBe(false);
    expect(unsupportedRequest('اصنع لي ملف pdf عن الصيانة')).toBeNull();
    expect(writingTask('اكتب رسالة اعتذار لعميل')).toMatchObject({ kind: 'apology' });
  });
});

describe('the card and the composed specification', () => {
  it('asks three valid questions with the guessed design chosen in advance and the supplied text shown', () => {
    const task = documentTask('اصنع تقرير pdf عن مبيعات الربع الثالث') as DocumentCreateTask;
    const card = documentQuestion(task);
    expect(card.fields.map(field => field.id)).toEqual(['title', 'content', 'style']);
    for (const field of card.fields) expect(() => ChatQuestionFieldSchema.parse(field)).not.toThrow();
    expect(card.fields[0]).toMatchObject({ initialValue: 'مبيعات الربع الثالث' });
    expect(card.fields[2]!.suggestions[0]).toEqual({ label: 'تقرير' });
    expect(card.fields[2]!.selected).toEqual([0]);
    const english = documentQuestion({ kind: 'create', lang: 'en', suppliedText: 'Line one\nLine two' });
    expect(english.fields[1]).toMatchObject({ multiline: true, initialValue: 'Line one\nLine two' });
  });

  it('builds the specification from the answers alone: title, parsed blocks, design and language', () => {
    const task: DocumentCreateTask = { kind: 'create', lang: 'ar', theme: 'report' };
    const composed = composeDocumentSpec(task, { title: 'تقرير المبيعات', content: '# تقرير المبيعات\nارتفعت المبيعات.\n- ورق\n- حبر', style: 'حديث' });
    expect(composed.theme).toBe('modern');
    expect(composed.emptyContent).toBe(false);
    expect(composed.spec).toEqual({ title: 'تقرير المبيعات', theme: 'modern', lang: 'ar', blocks: [{ kind: 'paragraph', text: 'ارتفعت المبيعات.' }, { kind: 'bullets', items: ['ورق', 'حبر'] }] });
    const fromMessage = composeDocumentSpec({ kind: 'create', lang: 'en', suppliedText: 'Weekly plan\nMonday: gym\nTuesday: dentist' });
    expect(fromMessage.spec.title).toBe('Weekly plan');
    expect(fromMessage.spec.blocks).toEqual([{ kind: 'keyvalue', items: [{ key: 'Monday', value: 'gym' }, { key: 'Tuesday', value: 'dentist' }] }]);
    const empty = composeDocumentSpec({ kind: 'create', lang: 'ar' }, { title: '' });
    expect(empty).toMatchObject({ emptyContent: true, spec: { title: 'مستند', blocks: [] } });
  });

  it('writes replies with the download link and the honest note', () => {
    const created = documentCreatedReply({ name: 'تقرير.pdf', pages: 2, size: 48_000, theme: 'report' }, 'http://127.0.0.1:3000/api/documents/abc/content', 'ar');
    expect(created).toContain('**تقرير.pdf**');
    expect(created).toContain('صفحتان، 48 كيلوبايت، تصميم «تقرير»');
    expect(created).toContain('[تنزيل الملف](http://127.0.0.1:3000/api/documents/abc/content)');
    expect(created).toContain('لم يكتبه نموذج');
    const edit: DocumentEditTask = { kind: 'edit', lang: 'en', operation: 'watermark', sources: [{ kind: 'latest', count: 1 }], text: 'DRAFT' };
    const edited = documentEditedReply(edit, { name: 'report watermark.pdf', pages: 2, size: 1_200_000 }, 'http://x/api/documents/1/content', ['report.pdf']);
    expect(edited).toContain('added the watermark “DRAFT”');
    expect(edited).toContain('From: report.pdf');
    expect(edited).toContain('1.2 MB');
    expect(documentInfoReply('a.pdf', 2048, { pages: 3, title: null, author: 'x', subject: null, keywords: null, creator: null, producer: null, created: '2026-11-22T00:00:00.000Z', modified: null, pageSize: { width: 595, height: 842 } }, 'ar')).toContain('- **الصفحات:** 3');
    expect(noSourceReply({ ...edit, operation: 'merge' }, true)).toContain('Merging needs at least two files');
    expect(noSourceReply({ ...edit, lang: 'ar' }, false)).not.toContain('C:\\');
  });
});
