import { randomUUID } from 'node:crypto';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { replyLanguage } from '../apps/server/src/assistant/reply-check.js';

describe('chat notification lifecycle', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  const bindAccount = vi.fn(async () => {});
  const ownerId = 'notification-chat-owner';
  const memberId = 'notification-chat-member';

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {},
      bindAccount,
      async hasPage() { return false; },
      async close() {},
    } as unknown as AgentBrowser;
    chat = await createCommandChatControl(database.db, {
      browser,
      fullAccess: async userId => userId === ownerId,
      models: { fast: [], deep: [], vision: '' },
      recordExperiences: false,
    });
  });

  afterAll(async () => {
    await chat?.shutdown();
    await database?.close();
  });

  function outcomes(conversationId: string) {
    return database.db.selectFrom('chat_notifications').select(['kind', 'task_id', 'user_id', 'conversation_id', 'started_at'])
      .where('conversation_id', '=', conversationId).execute();
  }

  it('enqueues a completed run with its own account and durable start time', async () => {
    const { id } = await chat.create(ownerId, { goal: 'كم ١٢٫٥٪ من ٤٨٠؟' });
    await chat.settled(id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'created_at', 'status'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();

    expect(run.status).toBe('completed');
    expect(await outcomes(id)).toEqual([{
      kind: 'task_completed', task_id: run.id, user_id: ownerId, conversation_id: id, started_at: run.created_at,
    }]);
  });

  it('keeps the same member task ID and only the needs-you event after its eventual answer', async () => {
    const { id } = await chat.create(memberId, { goal: 'What about it?' });
    await chat.settled(id);
    const paused = await chat.detail(memberId, id);

    expect(paused.status).toBe('waiting_user');
    const pending = await outcomes(id);
    expect(pending).toEqual([expect.objectContaining({ kind: 'needs_you', user_id: memberId, conversation_id: id })]);

    await chat.send(memberId, id, { questionId: paused.question!.id, text: 'Convert 12:00 Europe/London to UTC.' });
    await chat.settled(id);

    const run = await database.db.selectFrom('chat_runs').select(['id', 'status'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run).toEqual({ id: pending[0]!.task_id, status: 'completed' });
    expect(await outcomes(id)).toEqual(pending);
  });

  it('enqueues a failed notification for a blocked run', async () => {
    const { id } = await chat.create(ownerId, { goal: 'احسب ٧ ÷ ٠' });
    await chat.settled(id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();

    expect(run.status).toBe('blocked');
    expect(await outcomes(id)).toEqual([expect.objectContaining({
      kind: 'task_failed', task_id: run.id, user_id: ownerId, conversation_id: id,
    })]);
  });

  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L4062 (retrieved 2026-11-27)
  it.each([
    { lang: 'en', goal: 'Open https://notifications-fixture.test/ and read the page.', text: /took too long/iu },
    { lang: 'ar', goal: 'افتح https://notifications-fixture.test/ واقرأ الصفحة.', text: /استغرقت هذه المهمة وقتًا طويلًا/u },
  ])('commits and enqueues a $lang run deadline failure without waiting for another request', async ({ lang, goal, text }) => {
    const schedule = globalThis.setTimeout;
    let fireDeadline: (() => void) | undefined;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 15 * 60_000) fireDeadline = () => { callback(...args); };
      return schedule(callback, delay, ...args);
    });
    try {
      bindAccount.mockImplementationOnce(async () => {
        fireDeadline?.();
        throw new Error('The fixture stopped at the chat deadline.');
      });
      const { id } = await chat.create(ownerId, { goal });
      await chat.settled(id);

      expect(fireDeadline).toBeDefined();
      const run = await database.db.selectFrom('chat_runs').select(['id', 'status'])
        .where('conversation_id', '=', id).executeTakeFirstOrThrow();
      expect(run.status).toBe('failed');
      const conversation = await database.db.selectFrom('chat_conversations').select('error')
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(conversation.error).toMatch(text);
      expect(replyLanguage(conversation.error ?? '').replyLang).toBe(lang);
      if (lang === 'en') expect(conversation.error).not.toMatch(/\p{Script=Arabic}/u);
      expect(await outcomes(id)).toEqual([expect.objectContaining({
        kind: 'task_failed', task_id: run.id, user_id: ownerId, conversation_id: id,
      })]);
    } finally {
      timers.mockRestore();
    }
  });

  it('recovers an abandoned run and enqueues its failure without a chat request', async () => {
    const { id } = await chat.create(ownerId);
    const runId = randomUUID();
    const now = Date.now();
    const startedAt = new Date(now - 90_000);
    await database.db.transaction().execute(async tx => {
      await tx.insertInto('chat_runs').values({
        id: runId,
        conversation_id: id,
        owner_id: ownerId,
        status: 'running',
        goal: 'Expired background task fixture',
        created_at: startedAt,
        lease_token: randomUUID(),
        lease_expires_at: new Date(now - 60_000),
        worker_id: randomUUID(),
      }).execute();
      await tx.updateTable('chat_conversations').set({ status: 'running', active_run_id: runId })
        .where('id', '=', id).execute();
    });

    await chat.recoverExpired();
    await chat.recoverExpired();

    const run = await database.db.selectFrom('chat_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('interrupted');
    expect(await outcomes(id)).toEqual([{
      kind: 'task_failed', task_id: runId, user_id: ownerId, conversation_id: id, started_at: startedAt,
    }]);
  });

  it('does not enqueue another outcome when the user cancels', async () => {
    const { id } = await chat.create(ownerId, { goal: 'What about it?' });
    await chat.settled(id);
    const pending = await outcomes(id);
    expect(pending).toHaveLength(1);

    await chat.cancel(ownerId, id);
    expect(await outcomes(id)).toEqual(pending);
  });
});
