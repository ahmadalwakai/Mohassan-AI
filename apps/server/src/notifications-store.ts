import { randomUUID } from 'node:crypto';
import type { Generated, Kysely } from 'kysely';
import {
  NOTIFICATION_AFTER_MS, type NotificationKind, type NotificationPayload, type NotificationPreferences,
  type NotificationQuietHours, type NotificationSyncRequest, type NotificationSyncResponse,
  type PushDevice, type PushSubscribeRequest,
} from '@mohassan/contracts';
import type { PushSender, WebPushPayload } from './web-push.js';

const PRESENCE_MS = 25_000;
const PRIORITY_WINDOW_MS = 2_000;
const EVENT_TTL_MS = 5 * 60_000;

interface NotificationEvent {
  task_id: string;
  user_id: string;
  conversation_id: string | null;
  kind: WebPushPayload['kind'];
  started_at: Date;
  happened_at: Date;
  available_at: Date;
  delivery: 'pending' | 'tab' | 'push' | 'suppressed';
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
  notification_preferences: { user_id: string; quiet_start: string | null; quiet_end: string | null; time_zone: string | null; hide_title: boolean };
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
  return { quietHours, hideTitle: row?.hide_title ?? false };
}

export async function saveNotificationPreferences(db: Database, userId: string, preferences: NotificationPreferences) {
  const settings = {
    quiet_start: preferences.quietHours?.start ?? null, quiet_end: preferences.quietHours?.end ?? null,
    time_zone: preferences.quietHours?.timeZone ?? null, hide_title: preferences.hideTitle,
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
    const result = await send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, payload);
    await recordPushResult(db, device, result);
    if (result === 'delivered') return 1;
    // Only definite expiration permits trying another device without risking a second notification.
    if (result === 'failed') break;
  }
  return 0;
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

function events(db: Database) {
  return db.selectFrom('chat_notifications as n').innerJoin('chat_conversations as c', join =>
    join.onRef('n.conversation_id', '=', 'c.id').onRef('n.user_id', '=', 'c.owner_id'))
    .where('n.kind', '!=', 'reminder_due')
    .select(['n.task_id', 'n.user_id', 'n.conversation_id', 'n.kind', 'n.started_at', 'n.happened_at', 'c.title'])
    .$narrowType<{ kind: NotificationKind }>();
}

function eventPayload(event: Pick<NotificationEvent, 'task_id' | 'conversation_id'> & { kind: NotificationKind; title: string }, hideTitle: boolean): NotificationPayload {
  return { taskId: event.task_id, kind: event.kind, conversationId: event.conversation_id,
    ...(!hideTitle && { conversationTitle: event.title.slice(0, 100) }) };
}

export const oldestEvent = (now: Date) => new Date(now.getTime() - EVENT_TTL_MS);

export async function syncNotifications(db: Database, userId: string, input: NotificationSyncRequest, now = new Date()): Promise<NotificationSyncResponse> {
  await db.deleteFrom('notification_tabs').where('user_id', '=', userId).where(eb => eb.or([
    eb('expires_at', '<=', now), ...(input.state === 'closed' ? [eb('tab_id', '=', input.tabId)] : []),
  ])).execute();
  if (input.state === 'closed') return { backgroundTask: false, pending: [] };
  const presence = { visible: input.state === 'visible', expires_at: new Date(now.getTime() + PRESENCE_MS) };
  await db.insertInto('notification_tabs').values({ user_id: userId, tab_id: input.tabId, ...presence })
    .onConflict(conflict => conflict.columns(['user_id', 'tab_id']).doUpdateSet(presence)).execute();
  if (input.state === 'visible') return { backgroundTask: false, pending: [] };

  const [preferences, running, recent, hasVisible] = await Promise.all([
    notificationPreferences(db, userId),
    db.selectFrom('chat_runs').select('status').where('owner_id', '=', userId).where('status', '=', 'running')
      .where('created_at', '<=', new Date(now.getTime() - NOTIFICATION_AFTER_MS)).limit(1).executeTakeFirst(),
    events(db).select('n.available_at').where('n.user_id', '=', userId).where('n.delivery', '=', 'pending')
      .where('n.happened_at', '>', oldestEvent(now)).orderBy('n.available_at').limit(25).execute(),
    activeTabs(db, now).where('user_id', '=', userId).where('visible', '=', true).limit(1).executeTakeFirst(),
  ]);
  const backgroundTask = !hasVisible && (Boolean(running) || recent.some(event => event.happened_at.getTime() - event.started_at.getTime() >= NOTIFICATION_AFTER_MS));
  const pending = hasVisible || isQuietHours(preferences.quietHours, now) ? [] : recent
    .filter(event => event.available_at <= now).map(event => eventPayload(event, preferences.hideTitle));
  return { backgroundTask, pending };
}

export async function claimNotification(db: Database, userId: string, id: string, channel: Delivery, now: Date, tabId?: string) {
  return db.transaction().execute(async tx => {
    const event = await events(tx).where('n.task_id', '=', id).where('n.user_id', '=', userId)
      .where('n.delivery', '=', 'pending').where('n.available_at', '<=', now)
      .where('n.happened_at', '>', oldestEvent(now)).forUpdate('n').executeTakeFirst();
    if (!event) return null;
    const { quietHours, hideTitle } = await notificationPreferences(tx, userId);
    const quiet = isQuietHours(quietHours, now);
    const tabs = activeTabs(tx, now).where('user_id', '=', userId);
    if (!quiet && channel === 'tab' && (!tabId || !await tabs.where('tab_id', '=', tabId).where('visible', '=', false).executeTakeFirst())) return null;
    const result = await tx.updateTable('chat_notifications').set({ delivery: quiet ? 'suppressed' : channel })
      .where('task_id', '=', id).where(eb => eb.not(eb.exists(channel === 'push' ? tabs : tabs.where('visible', '=', true))))
      .returning('task_id').executeTakeFirst();
    return result && !quiet ? eventPayload(event, hideTitle) : null;
  });
}

export function pendingPushNotifications(db: Database, now: Date) {
  return events(db).clearSelect().select(['n.task_id', 'n.user_id'])
    .where('n.delivery', '=', 'pending').where('n.available_at', '<=', now).where('n.happened_at', '>', oldestEvent(now))
    .where(eb => eb.not(eb.exists(eb.selectFrom('notification_tabs').select('tab_id')
      .where('expires_at', '>', now).whereRef('notification_tabs.user_id', '=', 'n.user_id'))))
    .where(eb => eb.exists(eb.selectFrom('push_subscriptions').select('id').whereRef('push_subscriptions.user_id', '=', 'n.user_id')))
    .orderBy('n.available_at').limit(20).execute();
}

export async function createTestNotification(db: Database, userId: string, now = new Date()): Promise<NotificationPayload> {
  const taskId = randomUUID();
  await db.deleteFrom('chat_notifications').where('conversation_id', 'is', null).where('happened_at', '<=', oldestEvent(now)).execute();
  await db.insertInto('chat_notifications').values({ task_id: taskId, user_id: userId, conversation_id: null, kind: 'task_completed',
    started_at: now, happened_at: now, available_at: now, delivery: 'push' }).execute();
  return { taskId, kind: 'task_completed', conversationId: null };
}

export async function ownsPushNotification(db: Database, userId: string, id: string, now = new Date()) {
  return Boolean(await db.selectFrom('chat_notifications as n').select('n.task_id')
    .where('n.task_id', '=', id).where('n.user_id', '=', userId).where(eb => eb.or([
      eb('n.delivery', '=', 'push'),
      // The worker may check ownership before the provider's response reaches the reminder scheduler.
      eb.and([eb('n.kind', '=', 'reminder_due'), eb('n.delivery', '=', 'pending')]),
    ]))
    .where('n.happened_at', '>', oldestEvent(now)).where(eb => eb.or([
      eb('n.conversation_id', 'is', null),
      eb.exists(eb.selectFrom('chat_conversations as c').select('c.id').whereRef('c.id', '=', 'n.conversation_id').whereRef('c.owner_id', '=', 'n.user_id')),
    ])).executeTakeFirst());
}
