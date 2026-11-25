import { randomUUID } from 'node:crypto';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAuth } from '../apps/server/src/auth.ts';
import { commandChatMigration } from '../apps/server/src/command-chat.ts';
import { migrateMembers } from '../apps/server/src/members.ts';
import { migrateReminders } from '../apps/server/src/reminders/migration.ts';
import {
  conversationReminderDelivery,
  createReminderScheduler,
  REMINDER_POLL_MS,
} from '../apps/server/src/reminders/scheduler.ts';
import { createReminderStore } from '../apps/server/src/reminders/storage.ts';

// UTC interval and calendar arithmetic from ECMAScript (retrieved 2026-11-25).
// https://tc39.es/ecma262/#sec-time-values-and-time-range
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const baseline = Date.UTC(2026, 10, 25, 9);
const firstDue = baseline + hour;
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const ownerId = 'reminders-fixture-owner';
const memberId = 'reminders-fixture-member';
const timeZone = 'UTC';
const ownerConversation = randomUUID();
const otherOwnerConversation = randomUUID();
const memberConversation = randomUUID();
const otherMemberConversation = randomUUID();

function barrier() {
  let open!: () => void;
  const reached = new Promise<void>(resolve => { open = resolve; });
  return { reached, open };
}

describe('durable reminder scheduling', () => {
  let database: DatabaseHandle;
  let store: ReturnType<typeof createReminderStore>;
  let clock: number;
  const now = () => new Date(clock);
  const input = (conversationId = ownerConversation, dueAt = firstDue, text = 'الاجتماع') => ({
    conversationId, dueAt: iso(dueAt), text, timeZone,
  });
  const daily = { kind: 'daily', hour: new Date(firstDue).getUTCHours(), minute: 0 } as const;

  const messages = () => database.db.selectFrom('chat_messages')
    .select(['id', 'conversation_id', 'role', 'text']).orderBy('created_at').execute();
  const stateOf = (id: string) => database.db.selectFrom('reminders')
    .select(['status', 'attempts', 'last_error']).where('id', '=', id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    database = await createDatabase();
    await migrateAuth(database.db);
    await migrateMembers(database.db);
    await migrate(database.db);
    await commandChatMigration(database.db);
    await migrateReminders(database.db);
    await migrateReminders(database.db);
    await database.db.insertInto('user').values([
      { id: ownerId, name: 'Owner', email: 'owner@example.test' },
      { id: memberId, name: 'Member', email: 'member@example.test' },
    ]).execute();
    await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: ownerId }).execute();
    await database.db.insertInto('workspace_members').values({ user_id: memberId, role: 'member' }).execute();
    store = createReminderStore(database.db, { now });
  });

  beforeEach(async () => {
    clock = baseline;
    await database.db.deleteFrom('chat_conversations').execute();
    await database.db.insertInto('chat_conversations').values([
      { id: ownerConversation, owner_id: ownerId },
      { id: otherOwnerConversation, owner_id: ownerId },
      { id: memberConversation, owner_id: memberId },
      { id: otherMemberConversation, owner_id: memberId },
    ].map(row => ({ ...row, title: 'Fixture', created_at: now(), updated_at: now() }))).execute();
  });

  afterAll(async () => { await database?.close(); });

  it('claims a due occurrence once across concurrent schedulers and a fresh scheduler', async () => {
    const reminder = await store.create(ownerId, input());
    const deliver = vi.fn(conversationReminderDelivery.deliver);
    const options = { now, delivery: { deliver } };
    const first = createReminderScheduler(database.db, options);
    const second = createReminderScheduler(database.db, options);
    await first.runOnce();
    expect(await messages()).toEqual([]);

    clock = firstDue;
    await Promise.all([first.runOnce(), second.runOnce()]);
    await createReminderScheduler(database.db, options).runOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [delivery] = await store.listDue(ownerId);
    expect(await store.listDue(memberId)).toEqual([]);
    expect(delivery).toMatchObject({
      reminderId: reminder.id, conversationId: ownerConversation, text: reminder.text,
      dueAt: iso(firstDue), deliveredAt: iso(firstDue), late: false,
    });
    expect(await messages()).toEqual([{
      id: delivery.id, conversation_id: ownerConversation, role: 'assistant', text: expect.stringContaining('تذكير: الاجتماع'),
    }]);
    expect(await stateOf(reminder.id)).toEqual({ status: 'sent', attempts: 1, last_error: null });
    expect(await store.list(ownerId)).toEqual([]);
  });

  it('catches up after downtime once and preserves the missed time in the message and due feed', async () => {
    const reminder = await store.create(ownerId, input());
    clock = firstDue + 2 * hour;
    const scheduler = createReminderScheduler(database.db, { now });
    await scheduler.runOnce();
    await scheduler.runOnce();

    // Localized fields are defined by ECMA-402 (retrieved 2026-11-25).
    // https://tc39.es/ecma402/#sec-datetime-format-functions
    const originalTime = new Intl.DateTimeFormat('ar-u-ca-gregory', {
      timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
    }).format(new Date(firstDue));
    expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({
      reminderId: reminder.id, dueAt: iso(firstDue), deliveredAt: iso(clock), late: true,
    })]);
    expect(await messages()).toEqual([expect.objectContaining({ text: `تذكير: الاجتماع\nالموعد: ${originalTime} (متأخر)` })]);
  });

  it('marks an overdue reminder late on startup even within one normal polling interval', async () => {
    const reminder = await store.create(ownerId, input());
    clock = firstDue + REMINDER_POLL_MS / 2;
    const scheduler = createReminderScheduler(database.db, { now });
    scheduler.start();
    try {
      await scheduler.runOnce();
      expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({
        reminderId: reminder.id, dueAt: iso(firstDue), deliveredAt: iso(clock), late: true,
      })]);
    } finally {
      await scheduler.stop();
    }
  });

  it('delivers one catch-up for a recurring reminder and advances to the next future occurrence', async () => {
    const reminder = await store.create(ownerId, { ...input(), recurrence: daily });
    const scheduler = createReminderScheduler(database.db, { now });
    clock = firstDue + 3 * day + hour;
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(await store.list(ownerId)).toEqual([expect.objectContaining({
      id: reminder.id, dueAt: iso(firstDue + 4 * day), recurrence: daily, status: 'scheduled', attempts: 0,
    })]);
    const [catchUp] = await store.listDue(ownerId);
    expect(catchUp).toMatchObject({ reminderId: reminder.id, dueAt: iso(firstDue), late: true });
    expect(await messages()).toHaveLength(1);

    clock = firstDue + 4 * day;
    await scheduler.runOnce();
    const deliveries = await store.listDue(ownerId);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ reminderId: reminder.id, dueAt: iso(clock), late: false });
    expect(deliveries[0].id).not.toEqual(catchUp.id);
    expect((await store.list(ownerId))[0]?.dueAt).toEqual(iso(firstDue + 5 * day));
  });

  it('delivers the last representable occurrence and closes the recurring reminder', async () => {
    // The supported UTC calendar ends at the last day of the last four-digit year.
    // https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6 (retrieved 2026-11-25).
    const lastDue = Date.UTC(9999, 11, 31, daily.hour);
    clock = lastDue - hour;
    const reminder = await store.create(ownerId, { ...input(ownerConversation, lastDue), recurrence: daily });
    clock = lastDue;
    const scheduler = createReminderScheduler(database.db, { now });
    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({
      reminderId: reminder.id, dueAt: iso(lastDue), late: false,
    })]);
    expect(await messages()).toHaveLength(1);
    expect(await stateOf(reminder.id)).toEqual({ status: 'sent', attempts: 1, last_error: null });
  });

  it.each(['cancel', 'edit'] as const)('keeps a %s that commits before delivery', async action => {
    const reminder = await store.create(ownerId, input());
    clock = firstDue;
    const scheduler = createReminderScheduler(database.db, { now });
    const mutationReady = barrier();
    const releaseMutation = barrier();
    const moveTo = firstDue + hour;
    const mutation = database.db.transaction().execute(async tx => {
      const transactional = store.inTransaction(tx);
      try {
        if (action === 'cancel') await transactional.cancel(ownerId, reminder.id);
        else await transactional.update(ownerId, reminder.id, { dueAt: iso(moveTo) });
      } finally {
        mutationReady.open();
      }
      await releaseMutation.reached;
    });
    await mutationReady.reached;
    const poll = scheduler.runOnce();
    releaseMutation.open();
    await Promise.all([mutation, poll]);

    expect(await messages()).toEqual([]);
    expect(await store.listDue(ownerId)).toEqual([]);
    if (action === 'cancel') {
      expect(await stateOf(reminder.id)).toMatchObject({ status: 'cancelled' });
    } else {
      clock = moveTo;
      await scheduler.runOnce();
      expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({ dueAt: iso(moveTo), late: false })]);
    }
  });

  it.each(['cancel', 'edit'] as const)('rejects a stale %s after delivery advances the recurring series', async action => {
    const reminder = await store.create(ownerId, { ...input(), recurrence: daily });
    const claimed = barrier();
    const releaseDelivery = barrier();
    const scheduler = createReminderScheduler(database.db, {
      now,
      delivery: {
        async deliver(tx, delivery) {
          claimed.open();
          await releaseDelivery.reached;
          await conversationReminderDelivery.deliver(tx, delivery);
        },
      },
    });
    clock = firstDue;
    const poll = scheduler.runOnce();
    await Promise.race([claimed.reached, poll.then(() => { throw new Error('Due reminder was never claimed'); })]);
    const change = action === 'cancel'
      ? store.cancel(ownerId, reminder.id, reminder)
      : store.update(ownerId, reminder.id, { dueAt: iso(firstDue + hour) }, reminder);
    const rejected = expect(change).rejects.toMatchObject({ code: 'REMINDER_CHANGED', statusCode: 409 });
    releaseDelivery.open();
    await Promise.all([poll, rejected]);
    expect(await messages()).toHaveLength(1);
    expect((await store.list(ownerId))[0]?.dueAt).toEqual(iso(firstDue + day));
  });

  it('rolls back a delivery and retries once without leaking partial messages or advancing recurrence', async () => {
    const reminder = await store.create(ownerId, { ...input(), recurrence: daily });
    let shouldFail = true;
    const deliver = vi.fn(async (...args: Parameters<typeof conversationReminderDelivery.deliver>) => {
      await conversationReminderDelivery.deliver(...args);
      if (shouldFail) throw new Error('Synthetic delivery failure');
    });
    const scheduler = createReminderScheduler(database.db, { now, delivery: { deliver } });
    clock = firstDue;
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await messages()).toEqual([]);
    expect(await store.listDue(ownerId)).toEqual([]);
    expect(await stateOf(reminder.id)).toEqual({ status: 'scheduled', attempts: 1, last_error: 'REMINDER_DELIVERY_FAILED' });
    expect((await store.list(ownerId))[0]?.dueAt).toEqual(iso(firstDue));

    shouldFail = false;
    clock += REMINDER_POLL_MS;
    await scheduler.runOnce();
    const [delivered] = await store.listDue(ownerId);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][1].id).toEqual(delivered.id);
    expect(await messages()).toHaveLength(1);
    expect((await store.list(ownerId))[0]).toMatchObject({ dueAt: iso(firstDue + day), attempts: 0, lastError: null });
  });

  it('stops retrying when the scheduler caps repeated delivery failures', async () => {
    const reminder = await store.create(ownerId, input());
    const deliver = vi.fn(async () => { throw new Error('Synthetic delivery failure'); });
    const scheduler = createReminderScheduler(database.db, { now, delivery: { deliver } });
    // The scheduler's delivery policy retries at most three attempts.
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      clock = firstDue + attempt * REMINDER_POLL_MS;
      await scheduler.runOnce();
    }
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(await stateOf(reminder.id)).toEqual({ status: 'failed', attempts: 3, last_error: 'REMINDER_DELIVERY_FAILED' });
    expect(await messages()).toEqual([]);
    expect(await store.list(ownerId)).toEqual([]);
  });

  it('polls every 30 seconds and delivers a reminder due during the interval as on time', async () => {
    await store.create(ownerId, input());
    const observedNow = vi.fn(now);
    const scheduler = createReminderScheduler(database.db, { now: observedNow });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      // The polling period is specified in the feature requirements.
      const pollInterval = 30 * 1000;
      clock = firstDue - pollInterval / 2;
      scheduler.start();
      await scheduler.runOnce();
      expect(await messages()).toEqual([]);
      observedNow.mockClear();

      vi.advanceTimersByTime(pollInterval - 1);
      expect(observedNow).not.toHaveBeenCalled();
      clock += pollInterval;
      vi.advanceTimersByTime(1);
      expect(observedNow).toHaveBeenCalled();
      await scheduler.runOnce();
      expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({ dueAt: iso(firstDue), late: false })]);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it('waits for in-flight work on stop and schedules no further polls', async () => {
    const first = await store.create(ownerId, input());
    const second = await store.create(ownerId, input(otherOwnerConversation, firstDue + 1, 'مكالمة'));
    const arrived = barrier();
    const releaseDelivery = barrier();
    const deliver = vi.fn(async (...args: Parameters<typeof conversationReminderDelivery.deliver>) => {
      arrived.open();
      await releaseDelivery.reached;
      await conversationReminderDelivery.deliver(...args);
    });
    const scheduler = createReminderScheduler(database.db, { now, delivery: { deliver } });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      clock = firstDue + 1;
      scheduler.start();
      const poll = scheduler.runOnce();
      await Promise.race([arrived.reached, poll.then(() => { throw new Error('Due reminder was never claimed'); })]);
      let stopped = false;
      const stopping = scheduler.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      releaseDelivery.open();
      await stopping;
      clock += 2 * REMINDER_POLL_MS;
      await vi.advanceTimersByTimeAsync(2 * REMINDER_POLL_MS);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await stateOf(first.id)).toMatchObject({ status: 'sent' });
      expect(await stateOf(second.id)).toMatchObject({ status: 'scheduled' });
      expect(await store.listDue(ownerId)).toEqual([expect.objectContaining({ reminderId: first.id, late: true })]);
    } finally {
      releaseDelivery.open();
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    { account: ownerId, conversation: ownerConversation, second: otherOwnerConversation, limit: 200 },
    { account: memberId, conversation: memberConversation, second: otherMemberConversation, limit: 50 },
  ])('enforces the active cap of $limit across concurrent creates', async ({ account, conversation, second, limit }) => {
    await database.db.insertInto('reminders').values(Array.from({ length: limit - 1 }, () => ({
      id: randomUUID(), user_id: account, conversation_id: conversation, text: 'Fixture',
      due_at: new Date(firstDue), time_zone: timeZone, delivery_key: randomUUID(),
    }))).execute();
    const [first, other] = await Promise.allSettled([
      store.create(account, input(conversation)),
      store.create(account, input(second)),
    ]);
    const winner = first.status === 'fulfilled' ? first : other;
    const loser = first.status === 'rejected' ? first : other;
    expect(winner.status).toBe('fulfilled');
    expect(loser).toMatchObject({ status: 'rejected', reason: { statusCode: 409, code: 'REMINDER_LIMIT' } });
    expect(await store.list(account)).toHaveLength(limit);
    if (winner.status !== 'fulfilled') throw new Error('Expected a reminder at the quota boundary');
    await store.cancel(account, winner.value.id);
    await store.create(account, input(second));
    expect(await store.list(account)).toHaveLength(limit);
  });
});
