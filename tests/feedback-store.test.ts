import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '@mohassan/database';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { FEEDBACK_LOOP_MIGRATION } from '../apps/server/src/feedback-migration.js';
import { feedbackPageKey } from '../apps/server/src/feedback-page-key.js';
import {
  feedbackEvidencePolicy, feedbackQuestionKey, listFeedback, recordFeedbackAnswer, reviewFeedback, safeFeedbackNote,
} from '../apps/server/src/feedback-store.js';

const owner = { id: randomUUID(), role: 'owner' } as const;
const member = { id: randomUUID(), role: 'member' } as const;
const otherOwner = { id: randomUUID(), role: 'owner' } as const;
const source = new URL(`/station/${randomUUID()}`, 'https://rail.example.test');
const session = randomUUID();
const secretHeader = `Cookie: better-auth.session_token=${session}`;
const secretUrl = new URL(source.href);
secretUrl.searchParams.set('session', session);
let database: Awaited<ReturnType<typeof createDatabase>>;

async function publish(db: Kysely<any>, options: {
  account?: string; question: string; previousQuestion?: string; reply?: string; evidenceUrls?: string[]; note?: string;
}) {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const eventId = randomUUID();
  await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: options.account ?? owner.id, title: 'Feedback fixture' }).execute();
  await db.insertInto('chat_messages').values([
    { id: randomUUID(), conversation_id: conversationId, role: 'user', text: options.question, created_at: new Date(1000) },
    { id: messageId, conversation_id: conversationId, role: 'assistant', text: options.reply ?? 'A fixture answer.', created_at: new Date(2000) },
  ]).execute();
  if (options.evidenceUrls) await recordFeedbackAnswer(db, {
    messageId, question: options.question, previousQuestion: options.previousQuestion, evidenceUrls: options.evidenceUrls,
  });
  await db.insertInto('chat_events').values({ id: eventId, conversation_id: conversationId, kind: 'feedback', message: 'wrong',
    data: JSON.stringify({ messageId, verdict: 'wrong', note: options.note ?? null }) }).execute();
  return { conversationId, messageId, eventId };
}

let legacy: Awaited<ReturnType<typeof publish>>;
let safeLegacy: Awaited<ReturnType<typeof publish>>;

beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  await commandChatMigration(database.db, async tx => {
    legacy = await publish(tx, { question: 'Where is the legacy fixture station?', reply: secretHeader, note: secretHeader });
    safeLegacy = await publish(tx, { question: 'When does the legacy fixture close?', note: 'The closing time is wrong.' });
  });
}, 20000);

afterAll(async () => { await database?.close(); });

describe('feedback store', () => {
  it('applies 049 on a fresh schema, sanitizes legacy notes, and keeps reviews on rerun', async () => {
    const db = database.db;
    const items = await listFeedback(db, owner);
    expect(items.find(item => item.id === legacy.eventId)).toMatchObject({
      note: null, reply: null, evidenceUrls: [], decision: null,
    });
    expect(items.find(item => item.id === safeLegacy.eventId)).toMatchObject({ note: 'The closing time is wrong.' });
    const event = await db.selectFrom('chat_events').select('data').where('id', '=', legacy.eventId).executeTakeFirstOrThrow();
    expect(event.data).toMatchObject({ messageId: legacy.messageId, verdict: 'wrong', note: null });
    await expect(reviewFeedback(db, owner, legacy.eventId, { decision: 'pin', sourceUrl: source.href }))
      .rejects.toMatchObject({ statusCode: 409 });
    const review = await reviewFeedback(db, owner, legacy.eventId, { decision: 'dismiss' });

    await commandChatMigration(db);
    const versions = await db.selectFrom('schema_migrations').select('version').where('version', '=', FEEDBACK_LOOP_MIGRATION).execute();
    expect(versions).toEqual([{ version: FEEDBACK_LOOP_MIGRATION }]);
    expect((await listFeedback(db, owner)).find(item => item.id === legacy.eventId)).toEqual(review);
    expect((await listFeedback(db, owner, { pendingOnly: true })).map(item => item.id)).not.toContain(legacy.eventId);
  });

  it('applies only reviews to recorded sources for the matching owner and question', async () => {
    const db = database.db;
    const question = `When does the station on the ${randomUUID()} line close?`;
    const tracked = new URL(source.href);
    tracked.searchParams.set('utm_source', 'fixture');
    tracked.hash = 'hours';
    const first = await publish(db, { question, evidenceUrls: [source.href, tracked.href, secretUrl.href] });
    const second = await publish(db, { question, evidenceUrls: [source.href] });
    const foreign = await publish(db, { account: member.id, question, evidenceUrls: [source.href] });

    const finding = (await listFeedback(db, owner)).find(item => item.id === first.eventId);
    expect(finding).toMatchObject({ decision: null, evidenceUrls: [source.href] });
    expect((await listFeedback(db, owner)).map(item => item.id)).not.toContain(foreign.eventId);
    expect((await feedbackEvidencePolicy(db, owner, question)).blocked.size).toBe(0);
    await expect(reviewFeedback(db, member, first.eventId, { decision: 'block', sourceUrl: source.href }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(reviewFeedback(db, owner, foreign.eventId, { decision: 'pin', sourceUrl: source.href }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(reviewFeedback(db, owner, first.eventId, { decision: 'block', sourceUrl: new URL('./other', source).href }))
      .rejects.toMatchObject({ statusCode: 409 });
    const pinned = await reviewFeedback(db, owner, first.eventId, { decision: 'pin', sourceUrl: source.href });
    expect(await reviewFeedback(db, owner, first.eventId, { decision: 'pin', sourceUrl: source.href })).toEqual(pinned);
    expect((await feedbackEvidencePolicy(db, owner, ` ${question} `)).pinned).toEqual(new Set([source.href]));

    await reviewFeedback(db, owner, second.eventId, { decision: 'block', sourceUrl: source.href });
    expect(await feedbackEvidencePolicy(db, owner, question)).toEqual({ blocked: new Set([source.href]), pinned: new Set() });
    for (const actor of [otherOwner, { ...owner, role: 'member' } as const]) {
      expect(await feedbackEvidencePolicy(db, actor, question)).toEqual({ blocked: new Set(), pinned: new Set() });
    }
    expect((await feedbackEvidencePolicy(db, owner, `${question} Tomorrow?`)).blocked.size).toBe(0);

    expect(await reviewFeedback(db, owner, second.eventId, { decision: 'clear' })).toMatchObject({ decision: null, sourceUrl: null });
    expect((await feedbackEvidencePolicy(db, owner, question)).pinned).toEqual(new Set([source.href]));
    await db.deleteFrom('chat_events').where('conversation_id', '=', first.conversationId).execute();
    await db.deleteFrom('chat_conversations').where('id', '=', first.conversationId).execute();
    expect((await feedbackEvidencePolicy(db, owner, question)).pinned.size).toBe(0);
  });

  it('keeps follow-up context distinct and drops credential-bearing snapshot data before storing it', async () => {
    const db = database.db;
    const question = 'What about its closing time?';
    const context = 'Where is the northern station?';
    expect(feedbackQuestionKey(question, context)).toBeTruthy();
    expect(feedbackQuestionKey(question, context)).not.toBe(feedbackQuestionKey(question, 'Where is the southern station?'));
    expect(feedbackQuestionKey(question, `[محجوب] ${context}`)).toBeNull();
    expect(feedbackQuestionKey(`${context} ${secretHeader}`)).toBeNull();
    expect(feedbackPageKey(secretUrl.href)).toBeNull();
    expect(feedbackPageKey(`${source.href}#access_token=${session}`)).toBeNull();
    expect(safeFeedbackNote(secretHeader)).toBeNull();
    expect(safeFeedbackNote(`See ${secretUrl.href}`)).toBeNull();
    expect(safeFeedbackNote('The note has no credentials.')).toBe('The note has no credentials.');

    const privateAnswer = await publish(db, { question: `${context} ${secretHeader}`, evidenceUrls: [source.href] });
    expect(await db.selectFrom('chat_feedback_evidence').select('message_id').where('message_id', '=', privateAnswer.messageId).execute()).toEqual([]);
    expect((await listFeedback(db, owner)).find(item => item.id === privateAnswer.eventId)).toMatchObject({ question: null, evidenceUrls: [] });
  });
});
