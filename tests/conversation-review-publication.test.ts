import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand } from '@mohassan/desktop';
import { createJudgeShadow } from '../apps/server/src/assistant/judge-shadow.js';
import { SUMMARY_MIN_MESSAGES } from '../apps/server/src/assistant/review/ledger.js';
import { conversationReviewSettings } from '../apps/server/src/assistant/review/publication.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';

const owner = 'conversation-publication-test-owner';
const request = 'ما النوافذ المفتوحة؟';
const draft = 'Hello, Shivawn! The catalogue is ready.';
const preference = 'My name is Siobhán, not Shivawn.';
const source = {
  url: 'https://reviewer-fixtures.test/france', title: 'فرنسا',
  text: 'فرنسا دولة في أوروبا الغربية، عاصمتها باريس وهي أكبر مدنها وأهمها.\nيبلغ عدد سكان فرنسا نحو 68 مليون نسمة حسب تقديرات سنة 2025.',
};

describe('conversation review at chat publication', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let shadow: Awaited<ReturnType<typeof createCommandChatControl>>;
  let active: typeof shadow;
  let directory: string;
  let judge: ReturnType<typeof createJudgeShadow>;
  const noIO = async (): Promise<never> => { throw new Error('Unexpected fixture I/O'); };
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
    async close() {}, async dropHeld() {}, act: noIO, observe: noIO,
  } as unknown as AgentBrowser;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    directory = await mkdtemp(join(tmpdir(), 'mohassan-conversation-review-'));
    judge = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
    const config: CommandChatConfig = {
      browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false, judgeShadow: judge,
      searchProvider: { name: 'conversation-review-fixture', async search(query) {
        if (!query.includes('فرنسا')) return noIO();
        return [{ url: source.url, title: source.title, snippet: source.text }];
      } },
      async readPage(url) {
        if (url !== source.url) return noIO();
        return { ...source, status: 200 };
      },
      desktop: {
        parse: parseDesktopCommand, describe: describeDesktopCommand,
        async execute(command) {
          if (command.kind === 'window_list') return { status: 'completed', text: draft };
          if (command.kind === 'file_delete') return { status: 'needs_approval', text: 'هل أتابع؟',
            approval: { label: 'حذف الملف', prompt: 'هل أنقل الملف إلى سلة المحذوفات؟', detail: 'لا حذف نهائي.' } };
          throw new Error('Unexpected desktop fixture command');
        },
      },
      imageReader: {
        available: true, modelId: null,
        async read() {
          return {
            facts: { width: 80, height: 40, format: 'png', orientation: 'landscape', meanBrightness: 240,
              darkBackground: false, colorfulness: 0, distinctColors: 1, flatShare: 1, dominant: [], surface: 'graphic' },
            lines: [], blocks: [], text: '', direction: 'none', kind: 'graphic', candidates: 0, dropped: 0, durationMs: 0, modelId: 'f'.repeat(64),
          };
        },
      },
    };
    shadow = await createCommandChatControl(database.db, { ...config, conversationReview: conversationReviewSettings({}) });
    active = await createCommandChatControl(database.db, { ...config, conversationReview: conversationReviewSettings({ MOHASSAN_CONVERSATION_REVIEW_APPLY: '1' }) });
  });

  afterAll(async () => {
    await shadow?.shutdown();
    await active?.shutdown();
    await judge?.flush();
    await database?.close();
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  async function seed(conversationId: string, count: number) {
    await database.db.insertInto('chat_messages').values(Array.from({ length: count }, (_, index) => ({
      id: randomUUID(), conversation_id: conversationId, created_at: new Date(Date.UTC(2024, 0, 1, 0, index)),
      role: index % 2 ? 'assistant' : 'user',
      text: index === 0 ? preference : index % 2 ? 'Understood.' : 'Thanks.',
    }))).execute();
  }

  async function stored(id: string, messageId: string) {
    return database.db.selectFrom('chat_messages').select(['text', 'conversation_review'])
      .where('conversation_id', '=', id).where('id', '=', messageId).executeTakeFirstOrThrow();
  }

  async function last(control: typeof shadow, id: string) {
    await control.settled(id);
    const conversation = await control.detail(owner, id);
    const message = conversation.messages.at(-1)!;
    expect(message.role, conversation.error ?? '').toBe('assistant');
    return { conversation, message, row: await stored(id, message.id) };
  }

  it('keeps shadow text and stores only check codes alongside the actual judge decision', async () => {
    const { id } = await shadow.create(owner);
    await seed(id, 2);
    await shadow.send(owner, id, { text: request });
    const { conversation, message, row } = await last(shadow, id);
    expect(message.text).toBe(draft);
    expect(row.conversation_review).toMatchObject({
      version: 1, runId: conversation.run?.id, action: 'fix', applied: false,
      judge: [{ decision: expect.any(String), source: 'pre_send' }],
      findings: expect.arrayContaining([expect.objectContaining({ check: 'preferences' })]),
      ms: expect.any(Number),
    });
    expect(JSON.stringify(row.conversation_review)).not.toMatch(/Shivawn|Siobhán|catalogue/u);
  });

  it('fixes a name from an old turn with the flag on and advances the persisted summary', async () => {
    const { id } = await active.create(owner);
    await seed(id, SUMMARY_MIN_MESSAGES + 2);
    for (let index = 0; index < 2; index += 1) {
      await active.send(owner, id, { text: request });
      const { message, row } = await last(active, id);
      expect(message.text).toContain('Hello, Siobhán!');
      expect(message.text).not.toContain('Shivawn');
      expect(row.conversation_review).toMatchObject({ action: 'fix', applied: true });
      const { review_summary } = await database.db.selectFrom('chat_conversations').select('review_summary')
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(review_summary).toMatchObject({ messageCount: SUMMARY_MIN_MESSAGES + 4 + index * 2,
        throughMessageId: message.id, preferences: expect.arrayContaining([expect.objectContaining({ kind: 'name', value: 'Siobhán' })]) });
    }
  });

  it('records a single verdict for a waiting reply and keeps the approval prompt intact', async () => {
    const { id } = await shadow.create(owner, { goal: 'احذف ملف old.txt من سطح المكتب' });
    const { conversation, message, row } = await last(shadow, id);
    expect(conversation.status).toBe('waiting_approval');
    expect(conversation.approval?.prompt).toBe(message.text);
    expect(row.conversation_review).toMatchObject({ applied: false, judge: [{ source: 'pre_send' }] });
  });

  it('reviews a joined web reply once and keeps the two actual part verdicts in order', async () => {
    const { id } = await shadow.create(owner, { goal: 'ما عاصمة فرنسا؟ ثم كم عدد سكانها؟' });
    const { conversation, message, row } = await last(shadow, id);
    expect(conversation.messages.filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(message.text).toContain('عاصمتها باريس');
    expect(message.text).toContain('68 مليون');
    expect(row.conversation_review).toMatchObject({ applied: false,
      judge: [{ source: 'pre_send', decision: 'send' }, { source: 'pre_send', decision: 'send' }] });
  });

  it('reviews an image reply that has no associated run', async () => {
    const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { id: imageId } = await shadow.uploadImage(owner, { mimeType: 'image/png', data: image.toString('base64') });
    const conversation = await shadow.create(owner, { images: [imageId] });
    const { message, row } = await last(shadow, conversation.id);
    expect(message.text).toBe(row.text);
    expect(row.conversation_review).toMatchObject({ runId: null, applied: false,
      judge: [{ decision: expect.any(String), applied: false, source: 'publication' }] });
  });

  it('publishes the original text when review storage fails inside the transaction', async () => {
    await sql`ALTER TABLE chat_messages ADD CONSTRAINT fixture_reject_review CHECK (conversation_review IS NULL) NOT VALID`.execute(database.db);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id } = await shadow.create(owner);
      await seed(id, 2);
      await shadow.send(owner, id, { text: request });
      const { message, row } = await last(shadow, id);
      expect(message.text).toBe(draft);
      expect(row.conversation_review).toBeNull();
      expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'conversation_review_unavailable' }));
    } finally {
      log.mockRestore();
      await sql`ALTER TABLE chat_messages DROP CONSTRAINT fixture_reject_review`.execute(database.db);
    }
  });
});
