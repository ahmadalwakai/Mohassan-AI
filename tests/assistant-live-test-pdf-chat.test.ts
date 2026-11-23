import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createPdfRenderer, parseDocumentText, renderDocumentHtml } from '@mohassan/pdf';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createDocumentControl, migrateDocuments, type DocumentControl } from '../apps/server/src/documents.js';

/**
 * PDF cases of the live functional test of 2026-11-23, with the real PDF engine (Chromium print, the bundled Noto Naskh
 * Arabic font) and pdf.js reading every file back: what the file says, how many pages, which font, where list markers sit.
 */
const OWNER = 'owner-live-test-pdf';
const LINK = /\[(?:Download the file|تنزيل الملف)\]\((http:\/\/web\.test\/api\/documents\/([0-9a-f-]{36})\/content)\)/u;
const FONTS = path.resolve('packages/pdf/fonts');

async function readPdf(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const items: { str: string; x: number; y: number; page: number }[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    for (const item of content.items) if ('str' in item && item.str.trim()) items.push({ str: item.str, x: Math.round(item.transform[4]), y: Math.round(item.transform[5]), page: number });
  }
  const text = items.map(item => item.str).join(' ');
  // The Arabic letters of each printed line. Chromium's PDF maps some Arabic glyphs (a letter's dots drawn as a glyph of their
  // own) to no character in its text table, and not the same way in every run (measured 2026-11-23 on the same words), so
  // the drawn Arabic is checked by its embedded font and its mapped letters here, and visually in the end-to-end check.
  const lines = new Map<string, string>();
  for (const item of items) lines.set(`${item.page}:${item.y}`, (lines.get(`${item.page}:${item.y}`) ?? '') + item.str);
  const arabicLines = [...lines.values()].map(line => line.normalize('NFKC').replace(/[^\p{Script=Arabic}]/gu, '')).filter(Boolean);
  return { pages: pdf.numPages, items, text, arabicLines, width: Math.round((await pdf.getPage(1)).getViewport({ scale: 1 }).width),
    embedsArabicFont: Buffer.from(bytes).toString('latin1').includes('NotoNaskhArabic') };
}

describe('PDF requests of the live test, with the real PDF engine', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let documents: DocumentControl;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let dir: string;

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateAuth(database.db); await migrate(database.db); await migrateDocuments(database.db);
    dir = await mkdtemp(path.join(tmpdir(), 'mohassan-live-pdf-'));
    documents = createDocumentControl(database.db, { dir, fontsDir: FONTS, allowedRoots: async () => [] });
    const never = async () => { throw new Error('The browser must not be used for PDF work.'); };
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {}, act: never, observe: never, screen: never, prepareAction: never } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, recordExperiences: false, models: { fast: [], deep: [], vision: '' },
      documents: { control: documents, link: (id: string) => `http://web.test/api/documents/${id}/content` } });
  });
  afterAll(async () => { await control?.shutdown(); await documents?.shutdown(); await database?.close(); await rm(dir, { recursive: true, force: true }); });

  async function settle(id: string) { await control.settled(id); return control.detail(OWNER, id); }
  const lastReply = (detail: Awaited<ReturnType<typeof settle>>) => detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
  const runStatus = async (id: string) => (await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).orderBy('created_at', 'desc').executeTakeFirstOrThrow()).status;

  it('D: a complete request makes the file at once, with its own name, words, design and one page', { timeout: 120_000 }, async () => {
    const { id } = await control.create(OWNER, { goal: 'Create a downloadable one-page PDF named sample.pdf. Title: Sample Document. Body: Hello from the browser. Arabic text: مرحباً، هذا مستند تجريبي. Use a plain white background and black text. The content is complete; generate the file now and provide its download link.' });
    const detail = await settle(id);
    expect(detail.question).toBeNull();
    expect(detail.status, detail.error ?? '').toBe('idle');
    const reply = lastReply(detail);
    expect(reply).toContain('Created the PDF: **sample.pdf**');
    expect(reply).toContain('1 page');
    expect(reply).not.toContain('What are you referring to');
    expect(await runStatus(id)).toBe('completed');
    const { bytes, document } = await documents.content(OWNER, LINK.exec(reply)![2]!);
    expect(document).toMatchObject({ name: 'sample.pdf', pages: 1, theme: 'plain' });
    const read = await readPdf(bytes);
    expect(read.pages).toBe(1);
    expect(read.text).toContain('Sample Document');
    expect(read.text).toContain('Hello from the browser.');
    expect(read.embedsArabicFont).toBe(true);
    // One printed line holds the Arabic sentence, apart from the English one.
    expect(read.arabicLines).toHaveLength(1);
    expect(read.arabicLines[0]!.length).toBeGreaterThanOrEqual(8);
    // The instructions are not content.
    expect(read.text).not.toContain('white background');
    expect(read.text).not.toContain('download link');
  });

  it('D: an incomplete request asks only for what is missing, then finishes the same task', { timeout: 120_000 }, async () => {
    const { id } = await control.create(OWNER, { goal: 'Create a PDF titled Weekly Notes' });
    const asked = await settle(id);
    expect(asked.status).toBe('waiting_user');
    expect(asked.question?.fields?.map(field => field.id)).toEqual(['content', 'style']);
    await control.send(OWNER, id, { questionId: asked.question!.id, answers: [
      { fieldId: 'content', value: 'Plan for the week.\n- Monday: review\n- Tuesday: ship' }, { fieldId: 'style', value: 'Plain' },
    ] });
    const created = await settle(id);
    const reply = lastReply(created);
    expect(reply).toContain('Created the PDF: **Weekly Notes.pdf**');
    const read = await readPdf((await documents.content(OWNER, LINK.exec(reply)![2]!)).bytes);
    expect(read.text).toContain('Weekly Notes');
    expect(read.text).toContain('Monday: review');
    expect(read.items.filter(item => item.str === '•')).toHaveLength(2);
  });

  it('D: «Title:» after an existing file stays an edit of that file', { timeout: 120_000 }, async () => {
    const { id } = await control.create(OWNER, { goal: 'Create a PDF named report.pdf. Title: Quarter report. Body: Sales rose.' });
    expect(lastReply(await settle(id))).toContain('Created the PDF: **report.pdf**');
    await control.send(OWNER, id, { text: 'Set the title of the last PDF to Annual report' });
    const edited = await settle(id);
    expect(lastReply(edited)).toContain('I updated the file details');
  });

  it('E: the guided card still makes an Arabic file, and its bullets are drawn inside the page', { timeout: 120_000 }, async () => {
    // The web's own PDF suggestion chip (apps/web/components/assistant-app.tsx SUGGESTIONS).
    const { id } = await control.create(OWNER, { goal: 'اصنع لي ملف PDF من نصّ أكتبه' });
    const asked = await settle(id);
    expect(asked.question?.fields?.map(field => field.id)).toEqual(['title', 'content', 'style']);
    await control.send(OWNER, id, { questionId: asked.question!.id, answers: [
      { fieldId: 'title', value: 'خطة الأسبوع' },
      { fieldId: 'content', value: 'مهام هذا الأسبوع:\n- مراجعة التقرير\n- إرسال العرض\n- Book the venue' },
      { fieldId: 'style', value: 'بسيط' },
    ] });
    const created = await settle(id);
    const reply = lastReply(created);
    expect(reply).toContain('أنشأت ملف PDF: **خطة الأسبوع.pdf**');
    const read = await readPdf((await documents.content(OWNER, LINK.exec(reply)![2]!)).bytes);
    expect(read.embedsArabicFont).toBe(true);
    expect(read.text).toContain('Book the venue');
    const bullets = read.items.filter(item => item.str === '•');
    expect(bullets).toHaveLength(3);
    // Inside the printable area (17 mm margins on an A4 page of 596 pt): an English item in an Arabic file included.
    for (const bullet of bullets) expect(bullet.x).toBeGreaterThan(47), expect(bullet.x).toBeLessThan(read.width - 47);
  });
});

describe('list markers in every direction of text', () => {
  const renderer = createPdfRenderer({ fontsDir: FONTS });
  afterAll(async () => { await renderer.close(); });

  it.each([
    ['an Arabic file with Arabic items', 'قائمة', 'مقدمة.\n- البند الأول\n- البند الثاني\n1. خطوة أولى\n2. خطوة ثانية'],
    ['an Arabic file with English items', 'قائمة مختلطة', 'مقدمة بالعربية.\n- First item\n- Second item'],
    ['an English file with English items', 'List', 'Short intro.\n- First item\n- Second item\n1. Step one\n2. Step two'],
    ['an English file with Arabic items', 'Mixed list', 'An English intro.\n- البند الأول\n- البند الثاني'],
  ])('draws a bullet for every item of %s, inside the page', { timeout: 60_000 }, async (_name, title, content) => {
    const blocks = parseDocumentText(content);
    const document = renderDocumentHtml({ title, theme: 'plain', blocks }, await renderer.fontFaces());
    const read = await readPdf(await renderer.render(document.html, { print: document.print }));
    const bullets = read.items.filter(item => item.str === '•');
    expect(bullets).toHaveLength(2);
    for (const bullet of bullets) expect(bullet.x).toBeGreaterThan(47), expect(bullet.x).toBeLessThan(read.width - 47);
    const numbered = blocks.find(block => block.kind === 'numbered');
    if (numbered) expect(read.items.filter(item => /^(?:1\.|\.1|2\.|\.2)$/u.test(item.str))).toHaveLength(2);
  });
});
