import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand, type DesktopCommand } from '@mohassan/desktop';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createDocumentControl, migrateDocuments, type DocumentControl } from '../apps/server/src/documents.js';

const OWNER = 'owner-pdf-chat';
const MEMBER = 'member-pdf-chat';
const LINK = /\[تنزيل الملف\]\((http:\/\/web\.test\/api\/documents\/[0-9a-f-]{36}\/content)\)/u;

/** The chat with no model, a browser that must never be touched, and the real PDF engine. */
describe('PDF files from the chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let documents: DocumentControl;
  let owner: Awaited<ReturnType<typeof createCommandChatControl>>;
  let member: Awaited<ReturnType<typeof createCommandChatControl>>;
  let dir: string, root: string;
  let browserCalls = 0;
  const desktopCalls: DesktopCommand[] = [];

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateAuth(database.db); await migrate(database.db); await migrateDocuments(database.db);
    dir = await mkdtemp(path.join(tmpdir(), 'mohassan-pdf-chat-'));
    root = await mkdtemp(path.join(tmpdir(), 'mohassan-pdf-root-'));
    documents = createDocumentControl(database.db, { dir, allowedRoots: async ownerId => ownerId === OWNER ? [root] : [] });
    const browserIO = async () => { browserCalls++; throw new Error('The browser must not be used for PDF work.'); };
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {}, act: browserIO, observe: browserIO, screen: browserIO, prepareAction: browserIO } as unknown as AgentBrowser;
    const desktop = new class {
      parse(text: string) { return parseDesktopCommand(text); }
      describe(command: DesktopCommand, language: 'ar' | 'en') { return describeDesktopCommand(command, language); }
      async execute(command: DesktopCommand) {
        desktopCalls.push(command);
        return { status: 'completed' as const, text: 'Desktop file contents were returned.' };
      }
    }();
    const shared = { browser, desktop, recordExperiences: false as const, models: { fast: [], deep: [], vision: '' }, documents: { control: documents, link: (id: string) => `http://web.test/api/documents/${id}/content` } };
    owner = await createCommandChatControl(database.db, shared);
    member = await createCommandChatControl(database.db, { ...shared, fullAccess: async () => false });
  });
  afterAll(async () => {
    await owner.shutdown(); await member.shutdown();
    await documents.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  async function settle(control: typeof owner, ownerId: string, id: string) {
    await control.settled(id);
    return control.detail(ownerId, id);
  }

  // Real Chromium renders and pdf-lib workers: generous budgets, so a busy machine does not fail the test.
  it('asks one card, builds the file from the answers, then edits it on request', { timeout: 120_000 }, async () => {
    const { id } = await owner.create(OWNER, { goal: 'اصنع لي تقرير pdf عن مبيعات الربع الثالث' });
    const asked = await settle(owner, OWNER, id);
    expect(asked.status).toBe('waiting_user');
    expect(asked.question?.fields?.map(field => field.id)).toEqual(['title', 'content', 'style']);
    expect(asked.question?.fields?.[0]).toMatchObject({ initialValue: 'مبيعات الربع الثالث' });
    expect(asked.question?.fields?.[2]?.suggestions[0]).toEqual({ label: 'تقرير' });

    await owner.send(OWNER, id, { questionId: asked.question!.id, answers: [
      { fieldId: 'title', value: 'تقرير مبيعات الربع الثالث' },
      { fieldId: 'content', value: '# الملخص\nارتفعت المبيعات بنسبة 12%.\n- ورق: 1,200\n- حبر: 850\n\n| المنتج | المبيعات |\n|---|---|\n| ورق | 1200 |' },
      { fieldId: 'style', value: 'تقرير' },
    ] });
    const created = await settle(owner, OWNER, id);
    expect(created.status, created.error ?? '').toBe('idle');
    const reply = created.messages.at(-1)!.text;
    expect(reply).toContain('أنشأت ملف PDF: **تقرير مبيعات الربع الثالث.pdf**');
    expect(reply).toContain('تصميم «تقرير»');
    expect(reply).toContain('لم يكتبه نموذج');
    const url = LINK.exec(reply)![1]!;
    const stored = await documents.list(OWNER, id);
    expect(stored).toHaveLength(1);
    expect(url).toBe(`http://web.test/api/documents/${stored[0]!.id}/content`);
    expect(stored[0]).toMatchObject({ pages: 1, theme: 'report', source: 'created' });
    expect((await documents.content(OWNER, stored[0]!.id)).bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    await owner.send(OWNER, id, { text: 'أضف علامة مائية «سري» على آخر ملف pdf' });
    const marked = await settle(owner, OWNER, id);
    expect(marked.status, marked.error ?? '').toBe('idle');
    expect(marked.messages.at(-1)!.text).toContain('تم إضافة العلامة المائية «سري». الملف الجديد: **تقرير مبيعات الربع الثالث watermark.pdf**');
    expect(await documents.list(OWNER, id)).toHaveLength(2);

    await owner.send(OWNER, id, { text: 'ادمج الملفين' });
    const merged = await settle(owner, OWNER, id);
    expect(merged.status, merged.error ?? '').toBe('idle');
    expect(merged.messages.at(-1)!.text).toContain('تم دمج الملفات');
    const [newest] = await documents.list(OWNER, id, 1);
    expect(newest!.pages).toBe(2);

    await owner.send(OWNER, id, { text: 'كم صفحة في آخر ملف pdf؟' });
    const info = await settle(owner, OWNER, id);
    expect(info.messages.at(-1)!.text).toContain('- **الصفحات:** 2');
    expect(browserCalls).toBe(0);
  });

  it('creates straight away when the message carries the content, and stops politely on the stop button', { timeout: 120_000 }, async () => {
    const { id } = await owner.create(OWNER, { goal: 'Make a modern pdf titled "Weekly plan"\nMonday: gym\nTuesday: dentist\n- call the supplier' });
    const created = await settle(owner, OWNER, id);
    expect(created.status, created.error ?? '').toBe('idle');
    expect(created.messages.at(-1)!.text).toContain('Created the PDF: **Weekly plan.pdf**');
    expect(created.messages.at(-1)!.text).toContain('Modern design');
    const stopping = await owner.create(OWNER, { goal: 'اصنع ملف pdf' });
    const asked = await settle(owner, OWNER, stopping.id);
    expect(asked.status).toBe('waiting_user');
    await owner.respond(OWNER, stopping.id, { questionId: asked.question!.id, optionId: 'stop' });
    const stopped = await settle(owner, OWNER, stopping.id);
    expect(stopped.status).toBe('idle');
    expect(stopped.question).toBeNull();
    expect(await documents.list(OWNER, stopping.id)).toHaveLength(0);
    // A later request in the same conversation starts fresh instead of reusing the abandoned card.
    await owner.send(OWNER, stopping.id, { text: 'اصنع ملف pdf بعنوان «جديد»\nسطر واحد فقط.' });
    const fresh = await settle(owner, OWNER, stopping.id);
    expect(fresh.status, fresh.error ?? '').toBe('idle');
    expect(fresh.messages.at(-1)!.text).toContain('**جديد.pdf**');
  });

  it('reads, summarizes and edits the named PDF from this conversation, even when another PDF is newer', { timeout: 120_000 }, async () => {
    const body = 'Inspect the equipment each morning. Leave the side door clear. Log any outages in the register. Send a copy of the report to the caretaker.';
    const { id } = await owner.create(OWNER, { goal: `Create a file named "Building guide.pdf" with the text: ${body}` });
    const created = await settle(owner, OWNER, id);
    expect(created.question).toBeNull();
    expect(created.messages.at(-1)!.text).toContain('Building guide.pdf');

    await owner.send(OWNER, id, { text: 'Generate a PDF titled Delivery note with this text: Stack the tiles in the garage.' });
    expect((await settle(owner, OWNER, id)).messages.at(-1)!.text).toContain('Delivery note.pdf');

    await owner.send(OWNER, id, { text: 'Read the file "Building guide.pdf".' });
    const read = (await settle(owner, OWNER, id)).messages.at(-1)!.text;
    expect(read).toContain('Text from the file');
    expect(read).toContain('Send a copy of the report to the caretaker.');
    expect(read).not.toContain('tiles');

    await owner.send(OWNER, id, { text: 'Summarize "Building guide.pdf".' });
    const summary = (await settle(owner, OWNER, id)).messages.at(-1)!.text;
    expect(summary).toContain('Summary using excerpts from the file');
    expect(summary).toContain('Leave the side door clear.');
    expect(summary).not.toContain('caretaker');

    await owner.send(OWNER, id, { text: 'Rotate "Building guide.pdf" 180 degrees.' });
    const edited = (await settle(owner, OWNER, id)).messages.at(-1)!.text;
    expect(edited).toContain('Building guide rotated.pdf');
    expect(edited).toContain('From: Building guide.pdf');
    expect(browserCalls).toBe(0);
    expect(desktopCalls).toHaveLength(0);

    await owner.send(OWNER, id, { text: 'Read the file instructions.txt.' });
    expect((await settle(owner, OWNER, id)).messages.at(-1)!.text).toContain('Desktop file contents were returned.');
    expect(desktopCalls).toEqual([{ kind: 'file_read', path: 'instructions.txt', folder: null }]);

    const unrelated = await owner.create(OWNER, { goal: 'Read "Building guide.pdf".' });
    const unavailable = (await settle(owner, OWNER, unrelated.id)).messages.at(-1)!.text;
    expect(unavailable).toContain('could not find the requested PDF');
    expect(unavailable).not.toContain('equipment');
  });

  it('reads an owner path inside the allowed roots, refuses paths outside them and refuses them for members', { timeout: 120_000 }, async () => {
    const [source] = await documents.list(OWNER);
    const file = path.join(root, 'عقد.pdf');
    await writeFile(file, (await documents.content(OWNER, source!.id)).bytes);
    const { id } = await owner.create(OWNER, { goal: `كم صفحة في ملف «${file}»؟` });
    const info = await settle(owner, OWNER, id);
    expect(info.status, info.error ?? '').toBe('idle');
    expect(info.messages.at(-1)!.text).toContain('- **الملف:** عقد.pdf');

    await owner.send(OWNER, id, { text: `رقّم صفحات ملف «${path.join(dir, 'other.pdf')}»` });
    const denied = await settle(owner, OWNER, id);
    expect(denied.status).toBe('idle');
    expect(denied.messages.at(-1)!.text).toContain('خارج المجلدات المسموح');

    const veto = await owner.create(OWNER, { goal: `Read the file "${file}". Do not read my computer.` });
    expect((await settle(owner, OWNER, veto.id)).messages.at(-1)!.text).not.toContain('Text from the file');

    const fromMember = await member.create(MEMBER, { goal: `احذف الصفحة 1 من ملف «${file}»` });
    const refused = await settle(member, MEMBER, fromMember.id);
    expect(refused.messages.at(-1)!.text).toContain('متاحة لحساب المالك فقط');

    const nothing = await member.create(MEMBER, { goal: 'رقّم صفحات آخر ملف pdf' });
    const empty = await settle(member, MEMBER, nothing.id);
    expect(empty.messages.at(-1)!.text).toContain('لا يوجد ملف PDF في هذه المحادثة بعد');
    expect(empty.messages.at(-1)!.text).not.toContain('C:\\');
  });

  it('answers honestly when the request names pages or text it cannot find', async () => {
    const { id } = await owner.create(OWNER, { goal: 'احذف صفحات من ملف pdf' });
    expect((await settle(owner, OWNER, id)).messages.at(-1)!.text).toContain('أي صفحات؟');
    await owner.send(OWNER, id, { text: 'حوّل ملف report.docx إلى pdf' });
    expect((await settle(owner, OWNER, id)).messages.at(-1)!.text).toContain('لا أحوّل ملفات Word');
  });
});
