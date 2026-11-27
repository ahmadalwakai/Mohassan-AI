import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelectQueryNode, TableNode, sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { describeDesktopCommand, parseDesktopCommand } from '@mohassan/desktop';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { reviewReply } from '../apps/server/src/assistant/review/checks.js';
import { buildConversationLedger, buildConversationSummary, splitRequest, SUMMARY_MIN_MESSAGES, type ConversationSummary, type ReviewMessage } from '../apps/server/src/assistant/review/ledger.js';
import { REVIEW_MESSAGE_WINDOW, reviewJudgedReply } from '../apps/server/src/assistant/review/publication.js';
import { createCommandChatControl, type CommandChatConfig } from '../apps/server/src/command-chat.js';
import { developmentConversations } from '../scripts/conversation-review/dev-conversations.js';

const owner = 'conversation-publication-test-owner';
const request = 'ما النوافذ المفتوحة؟';
const draft = 'Hello, Shivawn! The catalogue is ready.';
const preference = 'My name is Siobhán, not Shivawn.';
const acknowledgment = 'Understood.';
const thanks = 'Thanks.';
const fixtures = new Map(developmentConversations().map(fixture => [fixture.id, fixture]));
const source = {
  url: 'https://reviewer-fixtures.test/france', title: 'فرنسا',
  text: 'فرنسا دولة في أوروبا الغربية، عاصمتها باريس وهي أكبر مدنها وأهمها.\nيبلغ عدد سكان فرنسا نحو 68 مليون نسمة حسب تقديرات سنة 2025.',
};

describe('conversation review at chat publication', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let shadow: Awaited<ReturnType<typeof createCommandChatControl>>;
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
    shadow = await createCommandChatControl(database.db, config);
  });

  beforeEach(() => vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', undefined));
  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await shadow?.shutdown();
    await judge?.flush();
    await database?.close();
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  async function seed(conversationId: string, count: number) {
    await database.db.insertInto('chat_messages').values(Array.from({ length: count }, (_, index) => ({
      id: randomUUID(), conversation_id: conversationId, created_at: new Date(Date.UTC(2024, 0, 1, 0, index)),
      role: index % 2 ? 'assistant' : 'user',
      text: index === 0 ? preference : index % 2 ? acknowledgment : thanks,
    }))).execute();
  }

  async function judgeLines(id: string) {
    await judge.flush();
    const log = await readFile(judge.logFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return log.trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as JudgeShadowLine).filter(line => line.conversationId === id);
  }

  async function reviewFixture(candidate: string, beforeFence?: (id: string) => Promise<void>) {
    const { id } = await shadow.create(owner);
    const runId = randomUUID();
    const reads = new WeakSet<object>();
    let rowsRead = 0;
    const db = database.db.withPlugin({
      transformQuery({ node, queryId }) {
        if (SelectQueryNode.is(node) && node.from?.froms.some(from => TableNode.is(from) && from.table.identifier.name === 'chat_messages')) {
          reads.add(queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (reads.has(queryId)) rowsRead += result.rows.length;
        return result;
      },
    });
    const context = { id, runId, db, allowApply: true, clean: (text: string) => text };
    const options = { status: 'completed' };
    async function publish(question: string, reply = candidate) {
      const before = rowsRead;
      const published = await reviewJudgedReply(async work => {
        await beforeFence?.(id);
        return db.transaction().execute(work);
      }, context, () => {
        judge.observe({ conversationId: id, runId, question, reply, ...options });
        return { text: reply, withheld: false };
      });
      return { published, rowsRead: rowsRead - before };
    }
    return {
      id, publish,
      async expectFullReview(messages: ReviewMessage[], summary?: ConversationSummary, reply = candidate) {
        const expected = reviewReply(buildConversationLedger(messages, summary), reply, options);
        const result = await publish(messages.at(-1)!.content, reply);
        expect(result.published.text).toBe(expected.reply);
        expect((await judgeLines(id)).at(-1)?.conversationReview).toMatchObject({
          action: expected.action, findings: expected.findings, applied: expected.reply !== reply,
        });
        return { ...result, expected };
      },
    };
  }

  function messageRows(id: string, messages: readonly ReviewMessage[], offset = 0) {
    return messages.map((message, index) => ({
      id: message.id ?? `${id}-${String(offset + index).padStart(5, '0')}`,
      conversation_id: id, role: message.role, text: message.content,
      created_at: new Date(Date.UTC(2024, 0, 1, 0, Math.floor((offset + index + 1) / 2))),
    }));
  }

  function filler(length: number): ReviewMessage[] {
    return Array.from({ length }, (_, index) => (length - index) % 2 === 0
      ? { role: 'user', content: thanks } : { role: 'assistant', content: acknowledgment });
  }

  async function last(id: string) {
    await shadow.settled(id);
    const conversation = await shadow.detail(owner, id);
    const message = conversation.messages.at(-1)!;
    expect(message.role, conversation.error ?? '').toBe('assistant');
    return { conversation, message, lines: await judgeLines(id) };
  }

  it('keeps shadow text and stores only check codes alongside the actual judge decision', async () => {
    const { id } = await shadow.create(owner);
    await seed(id, 2);
    await shadow.send(owner, id, { text: request });
    const { conversation, message, lines } = await last(id);
    expect(message.text).toBe(draft);
    expect(lines).toMatchObject([{ runId: conversation.run?.id, decision: expect.any(String), conversationReview: {
      version: 1, action: 'fix', applied: false,
      findings: expect.arrayContaining([expect.objectContaining({ check: 'preferences' })]), ms: expect.any(Number),
    } }]);
    expect(JSON.stringify(lines[0]!.conversationReview)).not.toMatch(/Shivawn|Siobhán|catalogue/u);
  });

  it('fixes a name from an old turn and checkpoints only messages already stored', async () => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const { id } = await shadow.create(owner);
    await seed(id, SUMMARY_MIN_MESSAGES + 2);
    for (let index = 0; index < 2; index += 1) {
      await shadow.send(owner, id, { text: request });
      const { conversation, message, lines } = await last(id);
      expect(message.text).toContain('Hello, Siobhán!');
      expect(message.text).not.toContain('Shivawn');
      expect(lines.at(-1)?.conversationReview).toMatchObject({ action: 'fix', applied: true });
      const { review_summary } = await database.db.selectFrom('chat_conversations').select('review_summary')
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(review_summary).toMatchObject({ messageCount: SUMMARY_MIN_MESSAGES + 3 + index * 2,
        throughMessageId: conversation.messages.at(-2)!.id,
        preferences: expect.arrayContaining([expect.objectContaining({ kind: 'name', value: 'Siobhán' })]) });
    }
  });

  it.each([
    { fixtureId: 'en-library-contradiction-issue', count: 500, keepFinalTurn: false },
    { fixtureId: 'en-library-commitments-issue', count: 500, keepFinalTurn: false },
    { fixtureId: 'ar-library-corrections-issue', count: 500, keepFinalTurn: true },
    { fixtureId: 'en-library-repetition-issue', count: 500, keepFinalTurn: true },
    { fixtureId: 'en-cafeteria-preferences-issue', count: 2_000, keepFinalTurn: false },
  ])('preserves old evidence for $fixtureId in $count messages', async ({ fixtureId, count, keepFinalTurn }) => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const fixture = fixtures.get(fixtureId)!;
    const earlier = keepFinalTurn ? fixture.messages : fixture.messages.slice(0, -1);
    const finalQuestion = keepFinalTurn ? thanks : fixture.messages.at(-1)!.content;
    const review = await reviewFixture(fixture.draft);
    const messages = [
      ...earlier.map(({ role, content }) => ({ role, content })),
      ...filler(count - earlier.length - 1),
      { role: 'user', content: finalQuestion },
    ] satisfies ReviewMessage[];
    const rows = messageRows(review.id, messages);
    const full = messages.map((message, index) => ({ ...message, id: rows[index]!.id }));
    const prior = full.slice(0, -2);
    const legacySummary = buildConversationSummary(buildConversationLedger(prior));
    await database.db.updateTable('chat_conversations').set({ review_summary: JSON.stringify(legacySummary) }).where('id', '=', review.id).execute();
    await database.db.insertInto('chat_messages').values(rows.slice(0, -2)).execute();
    await review.publish(prior.at(-1)!.content);
    await database.db.insertInto('chat_messages').values(rows.slice(-2)).execute();
    const { expected, rowsRead } = await review.expectFullReview(full, legacySummary);
    expect(expected.findings.map(finding => finding.check)).toEqual(expect.arrayContaining(fixture.expected));
    const recentOnly = reviewReply(buildConversationLedger(full.slice(-REVIEW_MESSAGE_WINDOW)), fixture.draft, { status: 'completed' });
    for (const check of fixture.expected) expect(recentOnly.findings).not.toContainEqual(expect.objectContaining({ check }));
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThanOrEqual(REVIEW_MESSAGE_WINDOW);
  });

  it('reopens old requests when a new turn rejects the checkpointed answer', async () => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const coverage = fixtures.get('en-library-coverage-clean')!;
    const questions = splitRequest(coverage.messages.at(-1)!.content);
    const feedback = fixtures.get('en-library-repetition-issue')!.messages.at(-1)!.content;
    const review = await reviewFixture(coverage.draft);
    const initial = [
      ...filler(500 - questions.length - 1),
      ...questions.map(({ text }) => ({ role: 'user' as const, content: text })),
      { role: 'assistant', content: coverage.draft },
    ] satisfies ReviewMessage[];
    const rows = messageRows(review.id, initial);
    const prior = initial.map((message, index) => ({ ...message, id: rows[index]!.id }));
    const priorLedger = buildConversationLedger(prior);
    const priorSummary = buildConversationSummary(priorLedger);
    expect(priorSummary.openRequests).toEqual([]);
    await database.db.insertInto('chat_messages').values(rows).execute();
    await review.publish(questions.at(-1)!.text);

    const [row] = messageRows(review.id, [{ role: 'user', content: feedback }], prior.length);
    await database.db.insertInto('chat_messages').values(row!).execute();
    const full = [...prior, { id: row!.id, role: 'user' as const, content: feedback }];
    const { expected } = await review.expectFullReview(full, priorSummary);
    expect(expected.findings).toContainEqual(expect.objectContaining({ check: 'repetition' }));
    const restoredSummary = buildConversationSummary(buildConversationLedger(full, priorSummary));
    expect(restoredSummary.openRequests).toEqual(expect.arrayContaining(priorLedger.requests));
    const { review_summary } = await database.db.selectFrom('chat_conversations').select('review_summary')
      .where('id', '=', review.id).executeTakeFirstOrThrow();
    expect(review_summary.openRequests).toEqual(restoredSummary.openRequests);

    const continuation = [
      { role: 'assistant', content: acknowledgment },
      // Reuse the explicit continuation from conversation-review-checks.test.ts.
      { role: 'user', content: 'Please continue.' },
    ] satisfies ReviewMessage[];
    const continuedRows = messageRows(review.id, continuation, full.length);
    await database.db.insertInto('chat_messages').values(continuedRows).execute();
    const continued = [...full, ...continuation.map((message, index) => ({ ...message, id: continuedRows[index]!.id }))];
    const addressOnly = fixtures.get('en-library-coverage-issue')!.draft;
    const partial = coverage.draft.slice(addressOnly.length).trim();
    const { expected: next } = await review.expectFullReview(continued, restoredSummary, partial);
    expect(next.findings).toContainEqual(expect.objectContaining({ check: 'coverage' }));
    expect(next.reply).toContain(priorLedger.requests[0]!.text);
  });

  it('compacts a full tail and preserves its evidence in the next bounded review', async () => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const fixture = fixtures.get('en-library-contradiction-issue')!;
    const language = fixtures.get('ar-gallery-preferences-issue')!.messages[0]!;
    const question = { role: 'user', content: fixture.messages.at(-1)!.content } satisfies ReviewMessage;
    const review = await reviewFixture(fixture.draft);
    const history: ReviewMessage[] = [];
    let prior: ConversationSummary | undefined;

    async function publishAfter(messages: ReviewMessage[]) {
      const rows = messageRows(review.id, messages, history.length);
      await database.db.insertInto('chat_messages').values(rows).execute();
      history.push(...messages.map((message, index) => ({ ...message, id: rows[index]!.id })));
      const result = await review.expectFullReview(history, prior);
      prior = buildConversationSummary(buildConversationLedger(history, prior));
      const { review_summary } = await database.db.selectFrom('chat_conversations').select('review_summary')
        .where('id', '=', review.id).executeTakeFirstOrThrow();
      expect(review_summary).toMatchObject(prior);
      return { ...result, checkpoint: review_summary.checkpoint };
    }

    const prefixLength = 2_000 - REVIEW_MESSAGE_WINDOW - 2;
    const prefix = await publishAfter([{ role: language.role, content: language.content }, ...filler(prefixLength - 2), question]);
    const claim = fixture.messages[1]!;
    const buffered = await publishAfter([
      { role: claim.role, content: claim.content }, ...filler(REVIEW_MESSAGE_WINDOW - 4), question,
    ]);
    expect(buffered.checkpoint.data).toBe(prefix.checkpoint.data);
    expect(buffered.checkpoint.cursor).toEqual(prefix.checkpoint.cursor);

    const nextTurn = [{ role: 'assistant', content: acknowledgment }, question] satisfies ReviewMessage[];
    const compacted = await publishAfter(nextTurn);
    expect(compacted.checkpoint.data).not.toBe(prefix.checkpoint.data);
    expect(compacted.checkpoint.cursor.id).toBe(history.at(-1)!.id);

    const warm = await publishAfter(nextTurn);
    expect(history).toHaveLength(2_000);
    expect(warm.expected.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: 'contradiction' }), expect.objectContaining({ code: 'reply_language' }),
    ]));
    expect(warm.checkpoint.data).toBe(compacted.checkpoint.data);
    expect(warm.checkpoint.cursor).toEqual(compacted.checkpoint.cursor);
    expect(warm.rowsRead).toBeGreaterThan(0);
    expect(warm.rowsRead).toBeLessThanOrEqual(REVIEW_MESSAGE_WINDOW);
  });

  it('rebuilds a checkpoint when a newly stored message sorts before it', async () => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const fixture = fixtures.get('en-cafeteria-preferences-issue')!;
    const requestedLanguage = fixtures.get('ar-gallery-preferences-issue')!.messages[0]!;
    const review = await reviewFixture(fixture.draft);
    const question = fixture.messages.at(-1)!;
    const initial = [...filler(499), { role: question.role, content: question.content }];
    const rows = messageRows(review.id, initial);
    await database.db.insertInto('chat_messages').values(rows).execute();
    const prior = initial.map((message, index) => ({ ...message, id: rows[index]!.id }));
    const { expected: before } = await review.expectFullReview(prior);

    const backdated = { ...requestedLanguage, id: `${rows[0]!.id}-backdated` };
    await database.db.insertInto('chat_messages').values(messageRows(review.id, [backdated])).execute();
    const full = [...prior.slice(0, 1), backdated, ...prior.slice(1)];
    const { expected: after } = await review.expectFullReview(full);
    expect(before.findings).not.toContainEqual(expect.objectContaining({ code: 'reply_language' }));
    expect(after.findings).toContainEqual(expect.objectContaining({ code: 'reply_language' }));
  });

  it('retries when the conversation changes between preparation and the fence', async () => {
    vi.stubEnv('MOHASSAN_CONVERSATION_REVIEW_APPLY', '1');
    const fixture = fixtures.get('en-cafeteria-preferences-issue')!;
    const requestedLanguage = fixtures.get('ar-gallery-preferences-issue')!.messages[0]!;
    let fences = 0;
    const review = await reviewFixture(fixture.draft, async id => {
      if (++fences !== 1) return;
      await database.db.transaction().execute(async tx => {
        await tx.insertInto('chat_messages').values(messageRows(id, [requestedLanguage])).execute();
        await tx.updateTable('chat_conversations').set({ updated_at: new Date() }).where('id', '=', id).execute();
      });
    });
    const initial = [...filler(SUMMARY_MIN_MESSAGES), fixture.messages.at(-1)!];
    const rows = messageRows(review.id, initial, 1);
    await database.db.insertInto('chat_messages').values(rows).execute();
    const full = [requestedLanguage, ...initial.map((message, index) => ({ ...message, id: rows[index]!.id }))];
    const { expected } = await review.expectFullReview(full);
    expect(expected.findings).toContainEqual(expect.objectContaining({ code: 'reply_language' }));
    expect(fences).toBe(2);
  });

  it('leaves waiting replies and approval prompts on the existing judge path', async () => {
    const { id } = await shadow.create(owner, { goal: 'احذف ملف old.txt من سطح المكتب' });
    const { conversation, message, lines } = await last(id);
    expect(conversation.status).toBe('waiting_approval');
    expect(conversation.approval?.prompt).toBe(message.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.conversationReview).toBeUndefined();
  });

  it('keeps the two web part verdicts in order for a reply that bypasses the single hook', async () => {
    const { id } = await shadow.create(owner, { goal: 'ما عاصمة فرنسا؟ ثم كم عدد سكانها؟' });
    const { conversation, message, lines } = await last(id);
    expect(conversation.messages.filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(message.text).toContain('عاصمتها باريس');
    expect(message.text).toContain('68 مليون');
    expect(lines.map(line => [line.decision, line.conversationReview])).toEqual([
      ['send', undefined], ['send', undefined],
    ]);
  });

  it('leaves direct image replies outside the judge hook', async () => {
    const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { id: imageId } = await shadow.uploadImage(owner, { mimeType: 'image/png', data: image.toString('base64') });
    const conversation = await shadow.create(owner, { images: [imageId] });
    const { conversation: stored, lines } = await last(conversation.id);
    expect(stored.messages).toHaveLength(2);
    expect(lines).toEqual([]);
  });

  it('keeps the normal judge and reply when the summary transaction fails', async () => {
    await sql`ALTER TABLE chat_conversations ADD CONSTRAINT fixture_reject_review CHECK (review_summary IS NULL) NOT VALID`.execute(database.db);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id } = await shadow.create(owner);
      await seed(id, SUMMARY_MIN_MESSAGES);
      await shadow.send(owner, id, { text: request });
      const { message, lines } = await last(id);
      expect(message.text).toBe(draft);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.conversationReview).toBeUndefined();
      expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'warn', event: 'conversation_review_unavailable' }));
    } finally {
      log.mockRestore();
      await sql`ALTER TABLE chat_conversations DROP CONSTRAINT fixture_reject_review`.execute(database.db);
    }
  });
});
