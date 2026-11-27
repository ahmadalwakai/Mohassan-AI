import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ReminderDeliverySummary } from '@mohassan/contracts';
import { memberDeletionQuery } from '../member-deletion.js';
import { backgroundAccountCanReceive } from '../notifications-store.js';
import type { PushSender } from '../web-push.js';
import { reminderAccountResumedAfter, suspendedReminderMemberQuery } from './delivery-access.js';
import { deliverQueuedReminderPush, queueReminderPush } from './push-delivery.js';
import { OWNER_ACTIVE_REMINDER_LIMIT, readReminderRecurrence, reminderUpdatedAt, type ReminderRecord } from './storage.js';
import { nextReminderOccurrence, ReminderCalendarExhausted } from './time.js';

export const REMINDER_POLL_MS = 30_000;
// A poll can drain one account's full backlog while bounding work before yielding.
const MAX_DELIVERIES_PER_POLL = OWNER_ACTIVE_REMINDER_LIMIT;
// Use the same retry budget as the runtime task queue in packages/runtime/src/index.ts.
const MAX_DELIVERY_ATTEMPTS = 3;

export interface ReminderDeliveryPort {
  /** Delivery effects must be durable in this transaction and keyed by delivery.id. External senders can use an outbox. */
  deliver(tx: Transaction<any>, delivery: ReminderDeliverySummary & { userId: string }): Promise<void>;
}

export const conversationReminderDelivery: ReminderDeliveryPort = {
  async deliver(tx, reminder) {
    const scheduledTime = new Intl.DateTimeFormat('ar-u-ca-gregory', {
      timeZone: reminder.timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
    }).format(new Date(reminder.dueAt));
    await tx.insertInto('chat_messages').values({
      id: reminder.id, conversation_id: reminder.conversationId, role: 'assistant', created_at: new Date(reminder.deliveredAt),
      text: `تذكير: ${reminder.text}\nالموعد: ${scheduledTime}${reminder.late ? ' (متأخر)' : ''}`,
    }).onConflict(conflict => conflict.column('id').doNothing()).execute();
    await tx.updateTable('chat_conversations').set({ updated_at: sql`greatest(updated_at, ${new Date(reminder.deliveredAt)}::timestamptz)` })
      .where('id', '=', reminder.conversationId).where('owner_id', '=', reminder.userId).execute();
  },
};

interface SchedulerOptions {
  now?: () => Date;
  delivery?: ReminderDeliveryPort;
  sendPush?: PushSender;
  onError?: () => void;
}

export function createReminderScheduler(db: Kysely<any>, {
  now = () => new Date(), sendPush, delivery = sendPush ? queueReminderPush : conversationReminderDelivery,
  onError = () => console.error('[reminders] Poll failed; retrying.'),
}: SchedulerOptions = {}) {
  let interval: NodeJS.Timeout | undefined;
  let startupAt: Date | undefined;
  let pending: Promise<void> | null = null;
  let stopping = false;

  async function deliverOne(at: Date, visited: string[]): Promise<string | undefined> {
    const retryBefore = new Date(at.getTime() - REMINDER_POLL_MS);
    return db.transaction().execute(async tx => {
      // Chat sends and deletes lock the conversation first. Respect that order before touching a reminder or writing a message.
      // PostgreSQL locking clause semantics: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE (retrieved 2026-11-25).
      let candidates = tx.selectFrom('reminders as r').innerJoin('chat_conversations as c', 'c.id', 'r.conversation_id')
        .select('r.id').where('r.status', '=', 'scheduled').where('r.due_at', '<=', at)
        .where(eb => eb.not(eb.exists(memberDeletionQuery(tx).select('d.user_id').whereRef('d.user_id', '=', 'r.user_id'))))
        .where(eb => eb.not(eb.exists(suspendedReminderMemberQuery(tx).whereRef('m.user_id', '=', 'r.user_id'))))
        .where(eb => eb.or([eb('r.attempts', '=', 0), eb('r.updated_at', '<=', retryBefore)]));
      if (visited.length) candidates = candidates.where('r.id', 'not in', visited);
      const candidate = await candidates.orderBy('r.due_at').orderBy('r.id').limit(1).forNoKeyUpdate('c').skipLocked().executeTakeFirst();
      if (!candidate) return undefined;
      const row = await tx.selectFrom('reminders').selectAll().where('id', '=', candidate.id)
        .where('status', '=', 'scheduled').where('due_at', '<=', at)
        .where(eb => eb.or([eb('attempts', '=', 0), eb('updated_at', '<=', retryBefore)]))
        .forUpdate().skipLocked().executeTakeFirst() as ReminderRecord | undefined;
      if (!row) return candidate.id as string;
      if (!await backgroundAccountCanReceive(tx, row.user_id)) return row.id;

      const dueAt = new Date(row.due_at);
      const reminder = {
        id: row.delivery_key, reminderId: row.id, conversationId: row.conversation_id, userId: row.user_id, text: row.text,
        dueAt: dueAt.toISOString(), timeZone: row.time_zone, deliveredAt: at.toISOString(),
        late: dueAt < retryBefore || (startupAt !== undefined && dueAt < startupAt)
          || await reminderAccountResumedAfter(tx, row.user_id, dueAt),
      };
      const updatedAt = reminderUpdatedAt(row, at);
      // A failed adapter can roll back partial writes and still record the retry on the locked reminder.
      // https://www.postgresql.org/docs/current/sql-savepoint.html (retrieved 2026-11-25).
      await sql`SAVEPOINT just_reminder_delivery`.execute(tx);
      try {
        const receipt = await tx.insertInto('reminder_deliveries').values({
          delivery_key: reminder.id, reminder_id: row.id, conversation_id: row.conversation_id, user_id: row.user_id,
          text: row.text, due_at: dueAt, time_zone: row.time_zone, delivered_at: at, late: reminder.late,
        }).onConflict(conflict => conflict.column('delivery_key').doNothing()).returning('delivery_key').executeTakeFirst();
        if (receipt) await delivery.deliver(tx, reminder);

        const recurrence = readReminderRecurrence(row);
        let next: Date | null = null;
        if (recurrence) {
          try { next = nextReminderOccurrence(recurrence, row.time_zone, at); }
          catch (error) {
            if (!(error instanceof ReminderCalendarExhausted)) throw error;
          }
        }
        await tx.updateTable('reminders').set(next ? {
          due_at: next, delivery_key: randomUUID(), attempts: 0, last_error: null, updated_at: updatedAt,
        } : {
          status: 'sent', attempts: row.attempts + 1, last_error: null, updated_at: updatedAt,
        }).where('id', '=', row.id).execute();
      } catch {
        await sql`ROLLBACK TO SAVEPOINT just_reminder_delivery`.execute(tx);
        const attempts = row.attempts + 1;
        await tx.updateTable('reminders').set({
          status: attempts < MAX_DELIVERY_ATTEMPTS ? 'scheduled' : 'failed', attempts,
          last_error: 'REMINDER_DELIVERY_FAILED', updated_at: updatedAt,
        }).where('id', '=', row.id).execute();
      }
      return row.id;
    });
  }

  async function poll() {
    const visited: string[] = [];
    while (visited.length < MAX_DELIVERIES_PER_POLL && !stopping) {
      const id = await deliverOne(now(), visited);
      if (!id) break;
      visited.push(id);
    }
    const checkedPushes: string[] = [];
    while (checkedPushes.length < MAX_DELIVERIES_PER_POLL && !stopping) {
      const id = await deliverQueuedReminderPush(db, sendPush, conversationReminderDelivery, now(), checkedPushes);
      if (!id) break;
      checkedPushes.push(id);
    }
  }

  function runOnce(): Promise<void> {
    if (stopping) return Promise.resolve();
    pending ??= poll().finally(() => { pending = null; });
    return pending;
  }

  return {
    runOnce,
    start() {
      if (interval) return;
      stopping = false;
      startupAt = now();
      const tick = () => { if (!pending) void runOnce().catch(onError); };
      interval = setInterval(tick, REMINDER_POLL_MS);
      interval.unref();
      tick();
    },
    async stop() {
      stopping = true;
      if (interval) clearInterval(interval);
      interval = undefined;
      await pending?.catch(() => {});
    },
  };
}
