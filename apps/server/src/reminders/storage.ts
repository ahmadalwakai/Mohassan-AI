import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  CreateReminderInput, ReminderDeliverySummary, ReminderRecurrence, ReminderSummary, UpdateReminderInput,
} from '@mohassan/contracts';
import { roleOf } from '../members.js';
import { reminderLocalTime } from './time.js';

export const OWNER_ACTIVE_REMINDER_LIMIT = 200;
export const MEMBER_ACTIVE_REMINDER_LIMIT = 50;
const DUE_LIST_LIMIT = OWNER_ACTIVE_REMINDER_LIMIT;

export class ReminderError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ReminderError';
  }
}

export interface ReminderRecord {
  id: string;
  user_id: string;
  conversation_id: string;
  text: string;
  due_at: Date | string;
  time_zone: string;
  recurrence: ReminderRecurrence | string | null;
  status: ReminderSummary['status'];
  attempts: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  delivery_key: string;
}

interface ReminderDeliveryRecord {
  delivery_key: string;
  reminder_id: string;
  conversation_id: string;
  text: string;
  due_at: Date | string;
  time_zone: string;
  delivered_at: Date | string;
  late: boolean;
}

export type ReminderRevision = Pick<ReminderSummary, 'dueAt' | 'updatedAt'>;

export interface ReminderStore {
  list(userId: string): Promise<ReminderSummary[]>;
  listDue(userId: string): Promise<ReminderDeliverySummary[]>;
  create(userId: string, input: CreateReminderInput): Promise<ReminderSummary>;
  update(userId: string, id: string, input: UpdateReminderInput, expected?: ReminderRevision): Promise<ReminderSummary>;
  cancel(userId: string, id: string, expected?: ReminderRevision): Promise<ReminderSummary>;
  postpone(userId: string, id: string, shift: (base: Date, timeZone: string) => Date, expected?: ReminderRevision): Promise<ReminderSummary>;
  getTimeZone(userId: string): Promise<string | null>;
  setTimeZone(userId: string, timeZone: string): Promise<void>;
  inTransaction(tx: Transaction<any>): ReminderStore;
}

export function readReminderRecurrence(row: ReminderRecord): ReminderRecurrence | null {
  return typeof row.recurrence === 'string' ? JSON.parse(row.recurrence) as ReminderRecurrence : row.recurrence;
}

export function reminderUpdatedAt(row: ReminderRecord, now: Date): Date {
  return new Date(Math.max(now.getTime(), new Date(row.updated_at).getTime() + 1));
}

function summary(row: ReminderRecord): ReminderSummary {
  return {
    id: row.id, conversationId: row.conversation_id, text: row.text,
    dueAt: new Date(row.due_at).toISOString(), timeZone: row.time_zone, recurrence: readReminderRecurrence(row),
    status: row.status, attempts: row.attempts, lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function checkFuture(dueAt: Date, now: Date) {
  if (!(dueAt > now)) throw new ReminderError(400, 'REMINDER_TIME_IN_PAST', 'اختر وقتًا قادمًا للتذكير.');
}

const serializeRecurrence = (recurrence: ReminderRecurrence | null | undefined) => recurrence ? JSON.stringify(recurrence) : null;

export function createReminderStore(db: Kysely<any>, { now = () => new Date() }: { now?: () => Date } = {}): ReminderStore {
  const transaction = <T>(execute: (tx: Transaction<any>) => Promise<T>) => db.isTransaction
    ? execute(db as Transaction<any>) : db.transaction().execute(execute);

  async function scheduled(tx: Transaction<any>, userId: string, id: string, expected?: ReminderRevision): Promise<ReminderRecord> {
    const row = await tx.selectFrom('reminders').selectAll().where('id', '=', id).where('user_id', '=', userId)
      .where('status', '=', 'scheduled').forUpdate().executeTakeFirst() as ReminderRecord | undefined;
    if (!row) throw new ReminderError(404, 'REMINDER_NOT_FOUND', 'التذكير غير موجود أو لم يعد مجدولًا.');
    if (expected && (expected.dueAt !== new Date(row.due_at).toISOString() || expected.updatedAt !== new Date(row.updated_at).toISOString())) {
      throw new ReminderError(409, 'REMINDER_CHANGED', 'تغيّر التذكير. اعرض التذكيرات مجددًا واختره.');
    }
    return row;
  }

  async function change(tx: Transaction<any>, userId: string, row: ReminderRecord, values: object, at: Date) {
    const updated = await tx.updateTable('reminders').set({ ...values, updated_at: reminderUpdatedAt(row, at) })
      .where('id', '=', row.id).where('user_id', '=', userId).returningAll().executeTakeFirstOrThrow() as ReminderRecord;
    return summary(updated);
  }

  return {
    async list(userId) {
      const rows = await db.selectFrom('reminders').selectAll().where('user_id', '=', userId).where('status', '=', 'scheduled')
        .orderBy('due_at').orderBy('id').execute() as ReminderRecord[];
      return rows.map(summary);
    },

    async listDue(userId) {
      const rows = await db.selectFrom('reminder_deliveries').selectAll().where('user_id', '=', userId)
        .orderBy('delivered_at', 'desc').orderBy('delivery_key', 'desc').limit(DUE_LIST_LIMIT).execute() as ReminderDeliveryRecord[];
      return rows.map(row => ({
        id: row.delivery_key, reminderId: row.reminder_id, conversationId: row.conversation_id, text: row.text,
        dueAt: new Date(row.due_at).toISOString(), timeZone: row.time_zone,
        deliveredAt: new Date(row.delivered_at).toISOString(), late: row.late,
      }));
    },

    create(userId, input) {
      return transaction(async tx => {
        const conversation = await tx.selectFrom('chat_conversations').select('id')
          .where('id', '=', input.conversationId).where('owner_id', '=', userId).forKeyShare().executeTakeFirst();
        if (!conversation) throw new ReminderError(404, 'REMINDER_CONVERSATION_NOT_FOUND', 'المحادثة غير موجودة.');
        // The lock covers counting and insertion, even for concurrent creates in different conversations.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reminder-quota:${userId}`}, 0))`.execute(tx);
        const role = await roleOf(tx, userId);
        if (!role) throw new ReminderError(403, 'REMINDER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
        const max = role === 'owner' ? OWNER_ACTIVE_REMINDER_LIMIT : MEMBER_ACTIVE_REMINDER_LIMIT;
        const active = await tx.selectFrom('reminders').select(eb => eb.fn.countAll<string>().as('count'))
          .where('user_id', '=', userId).where('status', '=', 'scheduled').executeTakeFirstOrThrow();
        if (Number(active.count) >= max) throw new ReminderError(409, 'REMINDER_LIMIT', `وصلت إلى حد ${max} تذكيرًا مجدولًا.`);
        const dueAt = new Date(input.dueAt), at = now();
        checkFuture(dueAt, at);
        const row = await tx.insertInto('reminders').values({
          id: randomUUID(), user_id: userId, conversation_id: conversation.id, text: input.text,
          due_at: dueAt, time_zone: input.timeZone, recurrence: serializeRecurrence(input.recurrence),
          created_at: at, updated_at: at, delivery_key: randomUUID(),
        }).returningAll().executeTakeFirstOrThrow() as ReminderRecord;
        return summary(row);
      });
    },

    update(userId, id, input, expected) {
      return transaction(async tx => {
        const row = await scheduled(tx, userId, id, expected);
        const at = now(), dueAt = new Date(input.dueAt ?? row.due_at), timeZone = input.timeZone ?? row.time_zone;
        const rescheduled = input.dueAt !== undefined || input.timeZone !== undefined || input.recurrence !== undefined;
        if (rescheduled) checkFuture(dueAt, at);
        let recurrence = input.recurrence === undefined ? readReminderRecurrence(row) : input.recurrence;
        if (recurrence && input.recurrence === undefined && (input.dueAt !== undefined || input.timeZone !== undefined)) {
          const { hour, minute } = reminderLocalTime(dueAt, timeZone);
          recurrence = { ...recurrence, hour, minute };
        }
        return change(tx, userId, row, {
          text: input.text ?? row.text, due_at: dueAt, time_zone: timeZone, recurrence: serializeRecurrence(recurrence),
          ...(rescheduled ? { attempts: 0, last_error: null } : {}),
        }, at);
      });
    },

    cancel(userId, id, expected) {
      return transaction(async tx => change(tx, userId, await scheduled(tx, userId, id, expected), { status: 'cancelled' }, now()));
    },

    postpone(userId, id, shift, expected) {
      return transaction(async tx => {
        const row = await scheduled(tx, userId, id, expected);
        const at = now(), base = new Date(Math.max(at.getTime(), new Date(row.due_at).getTime()));
        const dueAt = shift(base, row.time_zone);
        checkFuture(dueAt, base);
        return change(tx, userId, row, { due_at: dueAt, attempts: 0, last_error: null }, at);
      });
    },

    async getTimeZone(userId) {
      const result = await db.selectFrom('reminder_preferences').select('time_zone').where('user_id', '=', userId).executeTakeFirst();
      return (result?.time_zone as string | undefined) ?? null;
    },

    async setTimeZone(userId, timeZone) {
      await db.insertInto('reminder_preferences').values({ user_id: userId, time_zone: timeZone })
        .onConflict(conflict => conflict.column('user_id').doUpdateSet({ time_zone: timeZone })).execute();
    },

    inTransaction(tx) {
      return createReminderStore(tx, { now });
    },
  };
}
