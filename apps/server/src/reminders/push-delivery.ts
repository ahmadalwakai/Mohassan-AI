import type { Kysely } from 'kysely';
import { memberDeletionQuery, memberReminderDeliveryAllowed } from '../member-deletion.js';
import { isQuietHours, notificationPreferences, oldestEvent, sendToPushDevice } from '../notifications-store.js';
import type { PushSender } from '../web-push.js';
import type { ReminderDeliveryPort } from './scheduler.js';

export const queueReminderPush: ReminderDeliveryPort = {
  async deliver(tx, reminder) {
    const at = new Date(reminder.deliveredAt);
    await tx.insertInto('chat_notifications').values({
      task_id: reminder.id, user_id: reminder.userId, conversation_id: reminder.conversationId,
      kind: 'reminder_due', started_at: new Date(reminder.dueAt), happened_at: at, available_at: at, delivery: 'pending',
    }).onConflict(conflict => conflict.column('task_id').doNothing()).execute();
  },
};

export function deliverQueuedReminderPush(db: Kysely<any>, send: PushSender | undefined,
  fallback: ReminderDeliveryPort, now: Date, visited: string[]): Promise<string | undefined> {
  return db.transaction().execute(async tx => {
    let candidates = tx.selectFrom('chat_notifications as n').innerJoin('chat_conversations as c', join =>
      join.onRef('n.conversation_id', '=', 'c.id').onRef('n.user_id', '=', 'c.owner_id'))
      .select(['n.task_id', 'c.title']).where('n.kind', '=', 'reminder_due').where('n.delivery', '=', 'pending')
      .where('n.available_at', '<=', now)
      .where(eb => eb.not(eb.exists(memberDeletionQuery(tx).select('d.user_id').whereRef('d.user_id', '=', 'n.user_id'))));
    if (visited.length) candidates = candidates.where('n.task_id', 'not in', visited);
    // Lock the conversation before the queued event, in the same order as scheduling and chat writes.
    const candidate = await candidates.orderBy('n.available_at').orderBy('n.task_id').limit(1)
      .forNoKeyUpdate('c').skipLocked().executeTakeFirst();
    if (!candidate) return undefined;
    const id: string = candidate.task_id;
    const event = await tx.selectFrom('chat_notifications').select(['user_id', 'conversation_id', 'happened_at'])
      .where('task_id', '=', id).where('delivery', '=', 'pending').forUpdate().skipLocked().executeTakeFirst();
    if (!event || !await memberReminderDeliveryAllowed(tx, event.user_id)) return id;

    const delivered = await tx.selectFrom('reminder_deliveries').selectAll().where('delivery_key', '=', id)
      .where('user_id', '=', event.user_id).where('conversation_id', '=', event.conversation_id).executeTakeFirst();
    let pushed = false;
    if (delivered && send && new Date(event.happened_at) > oldestEvent(now)) {
      const notificationDb: Kysely<any> = tx;
      const { quietHours, hideTitle } = await notificationPreferences(notificationDb, event.user_id);
      if (!isQuietHours(quietHours, now)) {
        const sendOrFail: PushSender = async (subscription, payload) => {
          try { return await send(subscription, payload); }
          catch { return 'failed'; }
        };
        pushed = Boolean(await sendToPushDevice(notificationDb, sendOrFail, event.user_id, {
          kind: 'reminder_due', taskId: id, conversationId: event.conversation_id,
          ...(!hideTitle && { conversationTitle: candidate.title.slice(0, 100) }),
        }));
      }
    }
    if (!pushed && delivered) {
      await fallback.deliver(tx, {
        id, reminderId: delivered.reminder_id, userId: event.user_id, conversationId: event.conversation_id,
        text: delivered.text, dueAt: new Date(delivered.due_at).toISOString(), timeZone: delivered.time_zone,
        deliveredAt: new Date(delivered.delivered_at).toISOString(), late: delivered.late,
      });
    }
    await tx.updateTable('chat_notifications').set({ delivery: pushed ? 'push' : 'suppressed' })
      .where('task_id', '=', id).execute();
    return id;
  });
}
