import { createHash, randomUUID } from 'node:crypto';
import { sql, type Generated, type Kysely, type Selectable } from 'kysely';
import {
  NOTIFICATION_AFTER_MS, type NotificationKind, type NotificationPayload, type NotificationPreferences,
  type NotificationQuietHours, type NotificationSyncRequest, type NotificationSyncResponse,
  type PushDevice, type PushSubscribeRequest,
} from '@mohassan/contracts';
import type { PushSender, WebPushPayload } from './web-push.js';
import { backgroundKinds, backgroundPayload, type BackgroundNotificationEvent, type BackgroundOutcome } from './background-notification-payload.js';
import { memberReminderDeliveryAllowed } from './member-deletion.js';
import { hideNotificationTitleByDefault, notificationPresenceMs, updateNotificationPresence } from './notification-security.js';
import { monitorMetricTransaction } from './ops/metrics/monitor-events.js';

const PRIORITY_WINDOW_MS = 2_000;
const EVENT_TTL_MS = 5 * 60_000;
export const backgroundRetryAt = (now: Date, attempts = 0) =>
  new Date(now.getTime() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts, 4)));

interface NotificationEvent {
  task_id: string;
  user_id: string;
  conversation_id: string | null;
  kind: WebPushPayload['kind'];
  started_at: Date;
  happened_at: Date;
  available_at: Date;
  delivery: 'pending' | 'tab' | 'push' | 'suppressed';
  run_id: Generated<string | null>;
  monitor_id?: string | null;
  background_outcome: Generated<BackgroundOutcome | null>;
  background_language: Generated<BackgroundNotificationEvent['background_language'] | null>;
  result_preview: Generated<string | null>;
  web_push_after: Generated<Date | null>;
  web_push_attempts: Generated<number>;
  web_push_device_id: Generated<string | null>;
  tab_claim_id: Generated<string | null>;
  tab_claim_until: Generated<Date | null>;
}
interface DeviceRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: Date;
  last_success_at: Date | null;
  failure_count: number;
}
interface NotificationDatabase {
  chat_notifications: NotificationEvent;
  notification_tabs: { user_id: string; tab_id: string; visible: boolean; expires_at: Date };
  notification_preferences: { user_id: string; quiet_start: string | null; quiet_end: string | null; time_zone: string | null; hide_title: boolean;
    completion_sound: Generated<boolean>; show_result_preview: Generated<boolean> };
  push_subscriptions: Omit<DeviceRow, 'created_at' | 'failure_count'> & { created_at: Generated<Date>; failure_count: Generated<number> };
  chat_runs: { owner_id: string; created_at: Date; status: string };
  chat_conversations: { id: string; owner_id: string; title: string };
}
type Database = Kysely<NotificationDatabase>;
type Delivery = 'tab' | 'push';
export type PushDeliveryResult = 'delivered' | 'expired' | 'failed';
export type StoredPushDevice = Pick<DeviceRow, 'id' | 'user_id' | 'endpoint' | 'p256dh' | 'auth'>;

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function isQuietHours(hours: NotificationQuietHours | null, now: Date): boolean {
  if (!hours || hours.start === hours.end) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(now);
  const current = minutes(local), start = minutes(hours.start), end = minutes(hours.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export async function notificationPreferences(db: Database, userId: string): Promise<NotificationPreferences> {
  const row = await db.selectFrom('notification_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const quietHours = row?.quiet_start && row.quiet_end && row.time_zone
    ? { start: row.quiet_start, end: row.quiet_end, timeZone: row.time_zone } : null;
  return { quietHours, hideTitle: row?.hide_title ?? hideNotificationTitleByDefault,
    ...(row?.completion_sound === false && { completionSound: false }),
    ...(row?.show_result_preview === true && { showResultPreview: true }) };
}

export async function saveNotificationPreferences(db: Database, userId: string, preferences: NotificationPreferences) {
  const settings = {
    quiet_start: preferences.quietHours?.start ?? null, quiet_end: preferences.quietHours?.end ?? null,
    time_zone: preferences.quietHours?.timeZone ?? null, hide_title: preferences.hideTitle,
    ...(preferences.completionSound !== undefined && { completion_sound: preferences.completionSound }),
    ...(preferences.showResultPreview !== undefined && { show_result_preview: preferences.showResultPreview }),
  };
  await db.insertInto('notification_preferences').values({ user_id: userId, ...settings })
    .onConflict(conflict => conflict.column('user_id').doUpdateSet(settings)).execute();
}

function deviceSummary(row: DeviceRow): PushDevice {
  return { id: row.id, label: row.label, createdAt: row.created_at.toISOString(),
    lastSuccessAt: row.last_success_at?.toISOString() ?? null, failureCount: row.failure_count };
}

function ownDevices(db: Database, userId: string) {
  return db.selectFrom('push_subscriptions').where('user_id', '=', userId).orderBy('created_at').orderBy('id');
}

export async function listPushDevices(db: Database, userId: string) {
  return (await ownDevices(db, userId).selectAll().execute()).map(deviceSummary);
}

export async function subscribePushDevice(db: Database, userId: string, input: PushSubscribeRequest) {
  const values = { label: input.label, p256dh: input.keys.p256dh, auth: input.keys.auth };
  const row = await db.insertInto('push_subscriptions').values({
    id: randomUUID(), user_id: userId, endpoint: input.endpoint, ...values,
  }).onConflict(conflict => conflict.column('endpoint').doUpdateSet(values).where('push_subscriptions.user_id', '=', userId))
    .returningAll().executeTakeFirst();
  return row ? deviceSummary(row) : null;
}

export async function unsubscribePushDevice(db: Database, userId: string, id: string) {
  const result = await db.deleteFrom('push_subscriptions').where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export function pushDeliveryDevices(db: Database, userId: string) {
  return ownDevices(db, userId).clearOrderBy().orderBy('failure_count').orderBy('last_success_at', ob => ob.desc().nullsLast())
    .orderBy('created_at', 'desc').select(['id', 'user_id', 'endpoint', 'p256dh', 'auth']).execute();
}

export async function recordPushResult(db: Database, device: StoredPushDevice, result: PushDeliveryResult, now = new Date()) {
  const { id, user_id: userId, p256dh, auth } = device;
  if (result === 'expired') {
    await db.deleteFrom('push_subscriptions').where('id', '=', id).where('user_id', '=', userId)
      .where('p256dh', '=', p256dh).where('auth', '=', auth).execute();
    return;
  }
  await db.updateTable('push_subscriptions').set(eb => result === 'delivered'
    ? { failure_count: 0, last_success_at: now } : { failure_count: eb('failure_count', '+', 1) })
    .where('id', '=', id).where('user_id', '=', userId).where('p256dh', '=', p256dh).where('auth', '=', auth).execute();
}

export async function sendToPushDevice<Payload extends WebPushPayload>(db: Database, send: PushSender<Payload>, userId: string, payload: Payload) {
  for (const device of await pushDeliveryDevices(db, userId)) {
    const result = await deliverToWebDevice(db, send, device, payload);
    if (result === 'delivered') return 1;
    // Only definite expiration permits trying another device without risking a second notification.
    if (result === 'failed') break;
  }
  return 0;
}

async function deliverToWebDevice<Payload extends WebPushPayload>(db: Database, send: PushSender<Payload>, device: StoredPushDevice, payload: Payload) {
  const result = await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload);
  await recordPushResult(db, device, result);
  return result;
}

export async function backgroundAccountCanReceive(tx: Kysely<any>, userId: string) {
  if (!await memberReminderDeliveryAllowed(tx, userId)) return false;
  const owner = await tx.selectFrom('workspace_owner').select('id').where('id', '=', 1).where('owner_id', '=', userId).executeTakeFirst();
  return Boolean(owner || await tx.selectFrom('workspace_members').select('user_id').where('user_id', '=', userId)
    .where('disabled_at', 'is', null).forShare().skipLocked().executeTakeFirst());
}

function activeTabs(db: Database, now: Date) {
  return db.selectFrom('notification_tabs').select('tab_id').where('expires_at', '>', now);
}

export async function recordNotificationOutcome(db: Database, outcome: {
  taskId: string; userId: string; conversationId: string; startedAt: Date; kind: NotificationKind;
}, now = new Date()) {
  const { taskId, userId, conversationId, startedAt, kind } = outcome;
  const quickAnswer = kind === 'task_completed' && now.getTime() - startedAt.getTime() < NOTIFICATION_AFTER_MS;
  // An older tab may have closed without delivering its last heartbeat. Use the most recent view for this one-way decision.
  const tab = quickAnswer ? await activeTabs(db, now).select('visible').where('user_id', '=', userId)
    .orderBy('expires_at', 'desc').orderBy('visible').limit(1).executeTakeFirst() : undefined;
  const { quietHours } = await notificationPreferences(db, userId);
  const delivery = tab?.visible || isQuietHours(quietHours, now) ? 'suppressed' : 'pending';
  const status = { kind, delivery, happened_at: now, available_at: new Date(now.getTime() + PRIORITY_WINDOW_MS) } as const;
  await db.insertInto('chat_notifications').values({ task_id: taskId, user_id: userId,
    conversation_id: conversationId, started_at: startedAt, ...status })
    .onConflict(conflict => kind !== 'needs_you' ? conflict.column('task_id').doNothing()
      : conflict.column('task_id').doUpdateSet(status).where('chat_notifications.user_id', '=', userId)
        .where('chat_notifications.kind', '!=', 'needs_you').where('chat_notifications.delivery', 'in', ['pending', 'suppressed']))
    .execute();
}

export async function recordBackgroundRunOutcome(db: Database, event: {
  runId: string; userId: string; conversationId: string; startedAt: Date; outcome: BackgroundOutcome;
  language: BackgroundNotificationEvent['background_language']; preview?: string; step?: number; monitorId?: string;
}, now = new Date()) {
  const { runId, userId, conversationId, startedAt, outcome, language, monitorId } = event;
  const { kind } = backgroundKinds[outcome];
  const key = createHash('sha256').update(`${runId}/notification/${outcome}/${event.step ?? 0}`).digest('hex');
  const taskId = monitorId || kind !== 'needs_you' ? runId
    : `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const preview = outcome === 'completed' && event.preview?.trim().split(/\r?\n/u, 1)[0]?.trim().slice(0, 160) || null;
  const availableAt = new Date(now.getTime() + PRIORITY_WINDOW_MS);
  // The event, final reply and terminal run state commit together. One APNs row
  // per registration preserves accepted deliveries while other devices retry.
  await sql`WITH event AS (
    INSERT INTO chat_notifications
      (task_id, user_id, conversation_id, kind, started_at, happened_at, available_at, delivery,
       run_id, background_outcome, background_language, result_preview${monitorId ? sql`, monitor_id` : sql``})
    VALUES (${taskId}, ${userId}, ${conversationId}, ${kind}, ${startedAt}, ${now}, ${availableAt}, 'pending',
      ${monitorId ? null : runId}, ${outcome}, ${language}, ${preview}${monitorId ? sql`, ${monitorId}` : sql``})
    ON CONFLICT (task_id) DO NOTHING
    RETURNING task_id, user_id
  )
    INSERT INTO background_apns_deliveries (event_id, registration_id, next_at)
    SELECT event.task_id, device.registration_id, ${availableAt}
    FROM event JOIN ios_push_devices AS device ON event.user_id = device.user_id`.execute(db);
}

function events(db: Database) {
  return db.selectFrom('chat_notifications as n').innerJoin('chat_conversations as c', join =>
    join.onRef('n.conversation_id', '=', 'c.id').onRef('n.user_id', '=', 'c.owner_id'))
    .where('n.kind', '!=', 'reminder_due')
    .selectAll('n').select('c.title')
    .$narrowType<{ kind: NotificationKind }>();
}

type EventWithTitle = Selectable<NotificationEvent> & { kind: NotificationKind; title: string };

function eventPayload(event: EventWithTitle, preferences: NotificationPreferences): NotificationPayload {
  if ((event.run_id || event.monitor_id) && event.background_outcome && event.background_language && event.conversation_id) {
    return backgroundPayload({ ...event, run_id: event.run_id, background_outcome: event.background_outcome,
      background_language: event.background_language, conversation_id: event.conversation_id }, preferences);
  }
  return { taskId: event.task_id, kind: event.kind, conversationId: event.conversation_id,
    ...(!preferences.hideTitle && { conversationTitle: event.title.slice(0, 100) }) };
}

export const oldestEvent = (now: Date) => new Date(now.getTime() - EVENT_TTL_MS);

export async function syncNotifications(db: Database, userId: string, input: NotificationSyncRequest, now = new Date()): Promise<NotificationSyncResponse> {
  await updateNotificationPresence(db, userId, input, now);
  if (input.state === 'closed') return { backgroundTask: false, pending: [] };
  const visible = input.state === 'visible';
  let recentEvents = events(db).where('n.user_id', '=', userId).where('n.delivery', '=', 'pending')
    .where(eb => eb.or([eb('n.tab_claim_until', 'is', null), eb('n.tab_claim_until', '<=', now), eb('n.tab_claim_id', '=', input.tabId)]))
    .where(eb => eb.or([eb('n.happened_at', '>', oldestEvent(now)), eb('n.background_outcome', 'is not', null)]))
    .where(eb => eb.or([
      eb.not(eb.exists(eb.selectFrom('push_subscriptions').select('id').whereRef('push_subscriptions.id', '=', 'n.web_push_device_id'))),
      ...(visible ? [eb('n.web_push_attempts', '>', 0)] : []),
    ]));
  if (visible) recentEvents = recentEvents.where('n.background_outcome', 'is not', null);
  const [preferences, running, recent, hasVisible] = await Promise.all([
    notificationPreferences(db, userId),
    db.selectFrom('chat_runs').select('status').where('owner_id', '=', userId).where('status', '=', 'running')
      .where('created_at', '<=', new Date(now.getTime() - NOTIFICATION_AFTER_MS)).limit(1).executeTakeFirst(),
    recentEvents.orderBy('n.available_at').limit(25).execute(),
    activeTabs(db, now).where('user_id', '=', userId).where('visible', '=', true).limit(1).executeTakeFirst(),
  ]);
  const backgroundTask = !hasVisible && (Boolean(running) || recent.some(event => event.happened_at.getTime() - event.started_at.getTime() >= NOTIFICATION_AFTER_MS));
  const pending = (hasVisible && !visible) || isQuietHours(preferences.quietHours, now) ? [] : recent
    .filter(event => event.available_at <= now).map(event => eventPayload(event, preferences));
  return { backgroundTask, pending };
}

export async function claimNotification(db: Database, userId: string, id: string, channel: Delivery, now: Date, tabId?: string, acknowledge = false) {
  return monitorMetricTransaction(db, async (tx, observe) => {
    const event = await events(tx).where('n.task_id', '=', id).where('n.user_id', '=', userId)
      .where('n.delivery', '=', 'pending').where('n.available_at', '<=', now)
      .where(eb => eb.or([eb('n.happened_at', '>', oldestEvent(now)), eb('n.background_outcome', 'is not', null)]))
      .forUpdate('n').executeTakeFirst();
    if (!event) return null;
    const preferences = await notificationPreferences(tx, userId);
    const quiet = isQuietHours(preferences.quietHours, now);
    const tabs = activeTabs(tx, now).where('user_id', '=', userId);
    if (event.run_id || event.monitor_id) {
      if (channel !== 'tab' || !tabId) return null;
      const row = tx.updateTable('chat_notifications').where('task_id', '=', id);
      if (acknowledge) {
        const committed = await row.set({ delivery: 'tab', tab_claim_id: null, tab_claim_until: null }).where('tab_claim_id', '=', tabId).executeTakeFirst();
        if (event.monitor_id && committed.numUpdatedRows > 0n) observe({ kind: 'delivery', channel: 'tab' });
        return null;
      }
      if (quiet || (event.tab_claim_until && event.tab_claim_until > now && event.tab_claim_id !== tabId)) return null;
      const tab = await tabs.select('visible').where('tab_id', '=', tabId).executeTakeFirst();
      if (!tab || (!tab.visible && await tabs.where('visible', '=', true).executeTakeFirst())) return null;
      if ((!tab.visible || !event.web_push_attempts) && event.web_push_device_id && await tx.selectFrom('push_subscriptions').select('id')
        .where('id', '=', event.web_push_device_id).executeTakeFirst()) return null;
      await row.set({ tab_claim_id: tabId, tab_claim_until: new Date(now.getTime() + notificationPresenceMs) }).execute();
      return eventPayload(event, preferences);
    }
    if (acknowledge) return null;
    if (!quiet && channel === 'tab' && (!tabId || !await tabs.where('tab_id', '=', tabId).where('visible', '=', false).executeTakeFirst())) return null;
    const result = await tx.updateTable('chat_notifications').set({ delivery: quiet ? 'suppressed' : channel })
      .where('task_id', '=', id).where(eb => eb.not(eb.exists(channel === 'push' ? tabs : tabs.where('visible', '=', true))))
      .returning('task_id').executeTakeFirst();
    return result && !quiet ? eventPayload(event, preferences) : null;
  });
}

function webPushCandidates(db: Database, now: Date, retryPinned = false) {
  return events(db).clearSelect().select(['n.task_id', 'n.user_id'])
    .where('n.delivery', '=', 'pending').where('n.available_at', '<=', now)
    .where(eb => {
      const tabs = eb.selectFrom('notification_tabs').select('tab_id').where('expires_at', '>', now)
        .whereRef('notification_tabs.user_id', '=', 'n.user_id');
      const closed = eb.not(eb.exists(tabs));
      if (!retryPinned) return closed;
      return eb.or([closed, eb.and([
        eb.exists(eb.selectFrom('push_subscriptions').select('id').whereRef('push_subscriptions.id', '=', 'n.web_push_device_id')),
        eb.or([eb('n.web_push_attempts', '=', 0), eb.not(eb.exists(tabs.where('visible', '=', true)))]),
      ])]);
    })
    .where(eb => eb.exists(eb.selectFrom('push_subscriptions').select('id').whereRef('push_subscriptions.user_id', '=', 'n.user_id')));
}

export function pendingPushNotifications(db: Database, now: Date, excludeBackground = false) {
  const pending = webPushCandidates(db, now).where('n.happened_at', '>', oldestEvent(now)).orderBy('n.available_at').limit(20);
  return (excludeBackground ? pending.where('n.background_outcome', 'is', null) : pending).execute();
}

function lockDueWebPush(db: Database, id: string, now: Date) {
  return events(db).where('n.task_id', '=', id).where('n.delivery', '=', 'pending')
    .where(eb => eb.or([eb('n.tab_claim_until', 'is', null), eb('n.tab_claim_until', '<=', now)]))
    .where(eb => eb.or([eb('n.web_push_after', 'is', null), eb('n.web_push_after', '<=', now)]))
    .forUpdate('n').skipLocked().executeTakeFirst();
}

async function reserveBackgroundWebPush(db: Database, userId: string, id: string, now: Date, active: boolean) {
  return db.transaction().execute(async tx => {
    const event = await lockDueWebPush(tx, id, now);
    if (!event) return;
    const row = tx.updateTable('chat_notifications').where('task_id', '=', id);
    const preferences = active && await backgroundAccountCanReceive(tx, userId) && await notificationPreferences(tx, userId);
    if (!preferences || isQuietHours(preferences.quietHours, now)) {
      await row.set({ web_push_after: backgroundRetryAt(now) }).execute();
      return;
    }
    const devices = await pushDeliveryDevices(tx, userId);
    const prior = devices.find(device => device.id === event.web_push_device_id);
    const tabs = activeTabs(tx, now).where('user_id', '=', userId);
    if (prior) {
      if (event.web_push_attempts && await tabs.where('visible', '=', true).executeTakeFirst()) return;
      return prior.id;
    }
    const next = devices[0];
    if (!next || await tabs.executeTakeFirst()) return;
    // Commit the target first so a crash after provider acceptance retries the
    // same browser. A returned failure lets a visible tab recover the notice.
    await row.set({ web_push_device_id: next.id, web_push_attempts: 0 }).execute();
    return next.id;
  });
}

export async function dispatchBackgroundWebPush(db: Database, send: PushSender<NotificationPayload>, isActive: (id: string) => Promise<boolean>, now: Date) {
  const pending = await webPushCandidates(db, now, true).where('n.background_outcome', 'is not', null)
    .where(eb => eb.or([eb('n.tab_claim_until', 'is', null), eb('n.tab_claim_until', '<=', now)]))
    .where(eb => eb.or([eb('n.web_push_after', 'is', null), eb('n.web_push_after', '<=', now)]))
    .orderBy(sql`row_number() over (partition by n.user_id order by n.available_at, n.task_id)`)
    .orderBy('n.available_at').orderBy('n.task_id').limit(20).execute();
  await Promise.all(pending.map(async ({ user_id: userId, task_id: id }) => {
    const deviceId = await reserveBackgroundWebPush(db, userId, id, now, await isActive(userId));
    if (!deviceId) return;
    await monitorMetricTransaction(db, async (tx, observe) => {
      const event = await lockDueWebPush(tx, id, now);
      if (!event || event.web_push_device_id !== deviceId) return;
      if (event.web_push_attempts && await activeTabs(tx, now).where('user_id', '=', userId).where('visible', '=', true).executeTakeFirst()) return;
      const row = tx.updateTable('chat_notifications').where('task_id', '=', id);
      const preferences = await backgroundAccountCanReceive(tx, userId) && await notificationPreferences(tx, userId);
      if (!preferences || isQuietHours(preferences.quietHours, now)) {
        await row.set({ web_push_after: backgroundRetryAt(now) }).execute();
        return;
      }
      const device = await ownDevices(tx, userId).select(['id', 'user_id', 'endpoint', 'p256dh', 'auth'])
        .where('id', '=', deviceId).executeTakeFirst();
      const result = device ? await deliverToWebDevice(tx, send, device, eventPayload(event, preferences)) : 'expired';
      if (result === 'delivered') {
        await row.set({ delivery: 'push', web_push_device_id: null }).execute();
        if (event.monitor_id) observe({ kind: 'delivery', channel: 'webPush' });
      }
      else if (result === 'expired') await row.set({ web_push_device_id: null, web_push_after: null, web_push_attempts: 0 }).execute();
      else await row.set({ web_push_after: backgroundRetryAt(now, event.web_push_attempts), web_push_attempts: event.web_push_attempts + 1 }).execute();
    });
  }));
}

export async function createTestNotification(db: Database, userId: string, now = new Date()): Promise<NotificationPayload> {
  const taskId = randomUUID();
  await db.deleteFrom('chat_notifications').where('conversation_id', 'is', null).where('happened_at', '<=', oldestEvent(now)).execute();
  await db.insertInto('chat_notifications').values({ task_id: taskId, user_id: userId, conversation_id: null, kind: 'task_completed',
    started_at: now, happened_at: now, available_at: now, delivery: 'push' }).execute();
  return { taskId, kind: 'task_completed', conversationId: null };
}

export async function ownsPushNotification(db: Database, userId: string, id: string, now = new Date()) {
  const background = sql<boolean>`COALESCE(to_jsonb(n)->>'run_id', to_jsonb(n)->>'monitor_id') IS NOT NULL`;
  return Boolean(await db.selectFrom('chat_notifications as n').select('n.task_id')
    .where('n.task_id', '=', id).where('n.user_id', '=', userId).where(eb => eb.or([
      eb('n.delivery', '=', 'push'),
      // The worker may check ownership before the provider's response reaches the reminder scheduler.
      eb.and([eb.or([eb('n.kind', '=', 'reminder_due'), background]), eb('n.delivery', '=', 'pending')]),
    ]))
    .where(eb => eb.or([eb('n.happened_at', '>', oldestEvent(now)), background])).where(eb => eb.or([
      eb('n.conversation_id', 'is', null),
      eb.exists(eb.selectFrom('chat_conversations as c').select('c.id').whereRef('c.id', '=', 'n.conversation_id').whereRef('c.owner_id', '=', 'n.user_id')),
    ])).executeTakeFirst());
}
