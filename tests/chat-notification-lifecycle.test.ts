import { randomUUID } from 'node:crypto';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startChatRecoveryTimer } from '../apps/server/src/chat-lease-recovery.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

it('does not overlap recovery ticks and waits for an in-flight sweep at shutdown', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let finishSweep!: () => void;
  const sweep = new Promise<void>(resolve => { finishSweep = resolve; });
  const recover = vi.fn(() => sweep);
  const stop = startChatRecoveryTimer(recover);
  try {
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersToNextTimerAsync();
    expect(recover).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishSweep();
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finishSweep();
    await stop();
    vi.useRealTimers();
  }
});

describe('chat notification lifecycle', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  let recoveryTick: () => void;
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
      async activity() { return null; },
      async screen() { return Buffer.from('frame'); },
      async close() {},
    } as unknown as AgentBrowser;
    const schedule = globalThis.setInterval;
    const timers = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
      recoveryTick = () => { callback(...args); };
      return schedule(() => {}, delay);
    });
    try {
      chat = await createCommandChatControl(database.db, {
        browser,
        fullAccess: async userId => userId === ownerId,
        models: { fast: [], deep: [], vision: '' },
        recordExperiences: false,
      });
    } finally {
      timers.mockRestore();
    }
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

  it('commits and enqueues a run deadline failure without waiting for another request', async () => {
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
      const { id } = await chat.create(ownerId, { goal: 'Open https://notifications-fixture.test/ and read the page.' });
      await chat.settled(id);

      expect(fireDeadline).toBeDefined();
      const run = await database.db.selectFrom('chat_runs').select(['id', 'status'])
        .where('conversation_id', '=', id).executeTakeFirstOrThrow();
      expect(run.status).toBe('failed');
      const conversation = await database.db.selectFrom('chat_conversations').select('error')
        .where('id', '=', id).executeTakeFirstOrThrow();
      expect(conversation.error).toContain('استغرقت هذه المهمة وقتًا طويلًا');
      expect(await outcomes(id)).toEqual([expect.objectContaining({
        kind: 'task_failed', task_id: run.id, user_id: ownerId, conversation_id: id,
      })]);
    } finally {
      timers.mockRestore();
    }
  });

  async function seedExpiredRun(conversationId: string, userId: string, status = 'running') {
    const runId = randomUUID();
    const now = Date.now();
    const startedAt = new Date(now - 90_000);
    await database.db.transaction().execute(async tx => {
      await tx.insertInto('chat_runs').values({
        id: runId,
        conversation_id: conversationId,
        owner_id: userId,
        status,
        goal: 'Expired background task fixture',
        created_at: startedAt,
        lease_token: randomUUID(),
        lease_expires_at: new Date(now - 60_000),
        worker_id: randomUUID(),
      }).execute();
      await tx.updateTable('chat_conversations').set({ status, active_run_id: runId })
        .where('id', '=', conversationId).execute();
    });
    return { runId, startedAt };
  }

  it('recovers only the requested expired conversation after owner and status checks', async () => {
    const requested = await chat.create(ownerId);
    const unrelated = await chat.create(ownerId);
    const otherAccount = await chat.create(memberId);
    await seedExpiredRun(requested.id, ownerId, 'waiting_input');
    await seedExpiredRun(unrelated.id, ownerId);
    await seedExpiredRun(otherAccount.id, memberId);

    await expect(chat.detail(memberId, requested.id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    await expect(chat.screen(memberId, requested.id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    await expect(chat.browserActivity(memberId, requested.id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    expect((await chat.list(ownerId)).conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requested.id, status: 'waiting_input' }),
      expect.objectContaining({ id: unrelated.id, status: 'running' }),
    ]));
    expect(await chat.browserActivity(ownerId, requested.id)).toBeNull();
    expect(await chat.screen(ownerId, requested.id)).toEqual(Buffer.from('frame'));
    expect(await outcomes(requested.id)).toEqual([]);

    expect((await chat.detail(ownerId, requested.id)).status).toBe('failed');
    expect(await outcomes(requested.id)).toEqual([expect.objectContaining({ kind: 'task_failed' })]);
    expect(await outcomes(unrelated.id)).toEqual([]);
    expect(await outcomes(otherAccount.id)).toEqual([]);
  });

  it('recovers abandoned runs on the timer and enqueues failure without a chat request', async () => {
    const { id } = await chat.create(ownerId);
    const { runId, startedAt } = await seedExpiredRun(id, ownerId);

    recoveryTick();
    await vi.waitFor(async () => {
      const run = await database.db.selectFrom('chat_runs').select('status').where('id', '=', runId).executeTakeFirstOrThrow();
      expect(run.status).toBe('interrupted');
    });
    await chat.recoverExpired();
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
