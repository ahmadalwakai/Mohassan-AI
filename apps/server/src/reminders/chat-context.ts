import type { Kysely } from 'kysely';
import type { ReminderSummary } from '@mohassan/contracts';

const enabled = new WeakSet<Kysely<any>>();

export function registerReminderContext(db: Kysely<any>) {
  enabled.add(db);
}

export async function conversationReminderContext(db: Kysely<any>, connection: Kysely<any>,
    userId: string, conversationId: string, limit: number): Promise<Pick<ReminderSummary, 'status' | 'recurrence'>[]> {
  if (!enabled.has(db)) return [];
  return connection.selectFrom('reminders').select(['status', 'recurrence'])
    .where('user_id', '=', userId).where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
}
