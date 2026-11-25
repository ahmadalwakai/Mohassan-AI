import { sql, type Kysely } from 'kysely';
import type { IosPushPayload } from '@mohassan/contracts';
import { sendToApnsDevice, type ApnsSender, type IosPushDevice } from './apns.js';
import { backgroundPayload, type BackgroundNotificationEvent } from './background-notification-payload.js';
import { backgroundAccountCanReceive, backgroundRetryAt, isQuietHours, notificationPreferences } from './notifications-store.js';

function dueApnsDeliveries(db: Kysely<any>, now: Date) {
  return db.selectFrom('background_apns_deliveries as d').innerJoin('chat_notifications as n', 'n.task_id', 'd.event_id')
    .innerJoin('chat_conversations as c', join => join.onRef('c.id', '=', 'n.conversation_id').onRef('c.owner_id', '=', 'n.user_id'))
    .where('n.delivery', '!=', 'suppressed').where('d.delivered_at', 'is', null).where('d.next_at', '<=', now);
}

export async function dispatchBackgroundApns(db: Kysely<any>, send: ApnsSender, isActive: (id: string) => Promise<boolean>, now: Date) {
  const due = await dueApnsDeliveries(db, now).select(['d.event_id', 'd.registration_id', 'n.user_id'])
    .orderBy('d.next_at').limit(20).execute() as Array<{ event_id: string; registration_id: string; user_id: string }>;
  await Promise.all(due.map(async ({ event_id: eventId, registration_id: registrationId, user_id: userId }) => {
    const active = await isActive(userId);
    await db.transaction().execute(async tx => {
      // Lock the device before its delivery so token expiry can safely cascade
      // through other queued events for the same token.
      const device = await tx.selectFrom('ios_push_devices').selectAll().where('registration_id', '=', registrationId)
        .where('user_id', '=', userId).forUpdate().skipLocked().executeTakeFirst() as IosPushDevice | undefined;
      if (!device) return;
      const event = await dueApnsDeliveries(tx, now).where('d.event_id', '=', eventId).where('d.registration_id', '=', registrationId)
        .select(['n.task_id', 'n.conversation_id', 'n.run_id', 'n.background_outcome', 'n.background_language', 'n.result_preview', 'd.attempts'])
        .select(sql<string | null>`to_jsonb(n)->>'monitor_id'`.as('monitor_id'))
        .forUpdate('d').skipLocked().executeTakeFirst() as (BackgroundNotificationEvent & { attempts: number }) | undefined;
      if (!event) return;

      const delivery = tx.updateTable('background_apns_deliveries').where('event_id', '=', eventId).where('registration_id', '=', registrationId);
      const notificationDb: Kysely<any> = tx;
      const preferences = active && await backgroundAccountCanReceive(tx, userId) && await notificationPreferences(notificationDb, userId);
      if (!preferences || isQuietHours(preferences.quietHours, now)) {
        await delivery.set({ next_at: backgroundRetryAt(now) }).execute();
        return;
      }
      const { title, body, runKind: kind, conversationId, runId, monitorId } = backgroundPayload(event, preferences);
      const payload: IosPushPayload = {
        aps: { alert: { title, body }, sound: 'mohassan-done.caf', 'thread-id': conversationId },
        conversationId, runId, kind, ...(monitorId && { monitorId }),
      };
      const result = await sendToApnsDevice(tx, send, device, payload, eventId);
      if (result === 'expired') return;
      await delivery.set(result === 'delivered' ? { delivered_at: now } : {
        next_at: backgroundRetryAt(now, event.attempts), attempts: event.attempts + 1,
      }).execute();
    });
  }));
}
