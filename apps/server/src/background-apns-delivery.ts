import { sql, type Kysely } from 'kysely';
import type { IosPushPayload } from '@mohassan/contracts';
import { sendToApnsDevice, type ApnsSender, type IosPushDevice } from './apns.js';
import { backgroundDeliveryDeadlineReached, backgroundDeliveryExpired, backgroundDeliveryTime, type BackgroundDeliveryClock } from './background-delivery-lifetime.js';
import { backgroundPayload, type BackgroundNotificationEvent } from './background-notification-payload.js';
import { backgroundAccountCanReceive, backgroundRetryAt, isQuietHours, notificationPreferences } from './notifications-store.js';
import { monitorMetricTransaction } from './ops/metrics/monitor-events.js';

// Infinity reserves next_at for lifetime expiry, keeping delivered_at for provider acceptance.
// https://www.postgresql.org/docs/current/datatype-datetime.html#DATATYPE-DATETIME-SPECIAL-VALUES (retrieved 2026-11-27)
const lifetimeExpired = sql<Date>`'infinity'::timestamptz`;

async function closeExpiredApnsDeliveries(db: Kysely<any>, now: Date, lifetimeHours: number) {
  await sql`WITH expired AS (
    SELECT d.event_id, d.registration_id FROM background_apns_deliveries AS d
    JOIN chat_notifications AS n ON n.task_id = d.event_id
    WHERE d.delivered_at IS NULL AND d.next_at < ${lifetimeExpired} AND ${backgroundDeliveryExpired(now, lifetimeHours)}
    FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE background_apns_deliveries AS d SET next_at = ${lifetimeExpired}
  FROM expired WHERE d.event_id = expired.event_id AND d.registration_id = expired.registration_id`.execute(db);
}

function dueApnsDeliveries(db: Kysely<any>, now: Date, lifetimeHours?: number) {
  const due = db.selectFrom('background_apns_deliveries as d').innerJoin('chat_notifications as n', 'n.task_id', 'd.event_id')
    .innerJoin('chat_conversations as c', join => join.onRef('c.id', '=', 'n.conversation_id').onRef('c.owner_id', '=', 'n.user_id'))
    .where('n.delivery', '!=', 'suppressed').where('d.delivered_at', 'is', null).where('d.next_at', '<=', now);
  return lifetimeHours === undefined ? due : due.where(eb => eb.not(backgroundDeliveryExpired(now, lifetimeHours)));
}

export async function dispatchBackgroundApns(db: Kysely<any>, send: ApnsSender | undefined, isActive: (id: string) => Promise<boolean>, clock: BackgroundDeliveryClock, lifetimeHours?: number) {
  const now = backgroundDeliveryTime(clock);
  if (lifetimeHours !== undefined) await closeExpiredApnsDeliveries(db, now, lifetimeHours);
  if (!send) return;
  const due = await dueApnsDeliveries(db, now, lifetimeHours).select(['d.event_id', 'd.registration_id', 'n.user_id'])
    .orderBy(sql`row_number() over (partition by n.user_id order by d.next_at, d.event_id, d.registration_id)`)
    .orderBy('d.next_at').orderBy('d.event_id').orderBy('d.registration_id').limit(20).execute() as Array<{ event_id: string; registration_id: string; user_id: string }>;
  await Promise.all(due.map(async ({ event_id: eventId, registration_id: registrationId, user_id: userId }) => {
    const active = await isActive(userId);
    await monitorMetricTransaction(db, async (tx, observe) => {
      // Lock the device before its delivery so token expiry can safely cascade
      // through other queued events for the same token.
      const device = await tx.selectFrom('ios_push_devices').selectAll().where('registration_id', '=', registrationId)
        .where('user_id', '=', userId).forUpdate().skipLocked().executeTakeFirst() as IosPushDevice | undefined;
      if (!device) return;
      const event = await dueApnsDeliveries(tx, now, lifetimeHours).where('d.event_id', '=', eventId).where('d.registration_id', '=', registrationId)
        .select(['n.task_id', 'n.conversation_id', 'n.run_id', 'n.background_outcome', 'n.background_language', 'n.result_preview', 'n.happened_at', 'd.attempts'])
        .select(sql<string | null>`to_jsonb(n)->>'monitor_id'`.as('monitor_id'))
        .forUpdate('d').skipLocked().executeTakeFirst() as (BackgroundNotificationEvent & { attempts: number; happened_at: Date }) | undefined;
      if (!event) return;

      const delivery = tx.updateTable('background_apns_deliveries').where('event_id', '=', eventId).where('registration_id', '=', registrationId);
      const notificationDb: Kysely<any> = tx;
      const preferences = active && await backgroundAccountCanReceive(tx, userId) && await notificationPreferences(notificationDb, userId);
      if (lifetimeHours !== undefined && backgroundDeliveryDeadlineReached(event.happened_at, backgroundDeliveryTime(clock), lifetimeHours)) {
        await delivery.set({ next_at: lifetimeExpired }).execute();
        return;
      }
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
      if (monitorId && result === 'delivered') observe({ kind: 'delivery', channel: 'apns' });
    });
  }));
}
