import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { dispatchPushNotifications } from '../apps/server/src/notifications-routes.ts';
import {
  claimNotification, isQuietHours, ownsPushNotification, recordNotificationOutcome, saveNotificationPreferences, syncNotifications,
} from '../apps/server/src/notifications-store.ts';
import type { NotificationKind, NotificationPayload, PushDevice } from '@mohassan/contracts';
import { generateVAPIDKeys } from 'web-push';

const send = vi.hoisted(() => vi.fn(async (_endpoint: string, _payload: NotificationPayload) => 'delivered' as const));
vi.mock('../apps/server/src/web-push.js', async importOriginal => ({
  ...await importOriginal<typeof import('../apps/server/src/web-push.js')>(),
  sendWebPushNotification: (_config: unknown, subscription: { endpoint: string }, payload: NotificationPayload) => send(subscription.endpoint, payload),
}));

const origin = 'http://127.0.0.1:3000';
const secret = 'notification-test-internal-secret-2026';
const owner = { name: 'Notification owner', email: 'notification-owner@example.test', password: 'Notification-Owner-42' };
const member = { name: 'Notification member', email: 'notification-member@example.test', password: 'Notification-Member-42' };
const subscription = (token: string, label = token) => {
  const p256dh = createECDH('prime256v1').generateKeys().toString('base64url');
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys: { p256dh, auth: randomBytes(16).toString('base64url') }, label };
};

describe('quiet hours', () => {
  it('respects both boundaries across midnight', () => {
    const schedule = { start: '22:00', end: '07:00', timeZone: 'UTC' };
    expect(isQuietHours(schedule, new Date('2026-11-25T21:59:59Z'))).toBe(false);
    expect(isQuietHours(schedule, new Date('2026-11-25T22:00:00Z'))).toBe(true);
    expect(isQuietHours(schedule, new Date('2026-11-26T00:00:00Z'))).toBe(true);
    expect(isQuietHours(schedule, new Date('2026-11-26T06:59:59Z'))).toBe(true);
    expect(isQuietHours(schedule, new Date('2026-11-26T07:00:00Z'))).toBe(false);
    expect(isQuietHours({ ...schedule, end: schedule.start }, new Date('2026-11-25T22:00:00Z'))).toBe(false);
  });

  it('uses the account time zone and its daylight-saving offset', () => {
    const instant = new Date('2026-07-02T21:30:00Z');
    const schedule = { start: '22:00', end: '07:00', timeZone: 'Europe/London' };
    expect(isQuietHours(schedule, instant)).toBe(true);
    expect(isQuietHours({ ...schedule, timeZone: 'America/New_York' }, instant)).toBe(false);
    expect(isQuietHours(schedule, new Date('2026-11-25T21:30:00Z'))).toBe(false);
    expect(isQuietHours({ start: '08:00', end: '17:00', timeZone: 'Asia/Riyadh' }, instant)).toBe(false);
    expect(isQuietHours({ start: '08:00', end: '17:00', timeZone: 'Asia/Riyadh' }, new Date('2026-11-25T05:00:00Z'))).toBe(true);
  });
});

describe('authenticated notifications', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie = '', memberCookie = '', ownerId = '', memberId = '';
  const db = () => application.database.db;
  const url = (suffix: string) => `/api/notifications/${suffix}`;
  const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': secret, cookie });
  const cookieOf = (cookies: string | string[] | undefined) => [cookies].flat().filter(Boolean).map(value => value!.split(';')[0]).join('; ');
  const now = new Date('2026-01-10T12:00:00Z');
  const later = new Date(now.getTime() + 3_000);
  async function login(credentials: typeof owner) {
    const result = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: credentials });
    expect(result.statusCode, result.body).toBe(200);
    return cookieOf(result.headers['set-cookie']);
  }
  async function subscribe(cookie: string, input: ReturnType<typeof subscription>) {
    const result = await application.app.inject({ method: 'POST', url: url('subscribe'), headers: headers(cookie), payload: input });
    expect(result.statusCode, result.body).toBe(200);
    return result.json().device as PushDevice;
  }
  async function conversation(userId: string) {
    const id = randomUUID();
    await db().insertInto('chat_conversations').values({ id, owner_id: userId, title: 'عنوان خاص', status: 'idle' }).execute();
    await db().insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'assistant', text: 'نص محادثة خاص' }).execute();
    return id;
  }
  async function outcome(userId: string, conversationId: string, kind: NotificationKind, elapsed = 25_000,
    happenedAt = now, taskId = randomUUID()) {
    await recordNotificationOutcome(db(), { taskId, userId, conversationId, kind,
      startedAt: new Date(happenedAt.getTime() - elapsed) }, happenedAt);
    return taskId;
  }

  beforeAll(async () => {
    const vapid = generateVAPIDKeys();
    vi.stubEnv('WEB_PUSH_VAPID_PUBLIC_KEY', vapid.publicKey);
    vi.stubEnv('WEB_PUSH_VAPID_PRIVATE_KEY', vapid.privateKey);
    vi.stubEnv('WEB_PUSH_VAPID_SUBJECT', 'mailto:notifications@example.test');
    const setupToken = 'notification-setup-token-fixture-2026';
    application = await createApplication({ authSecret: 'notification-test-auth-secret-2026', internalSecret: secret,
      setupToken, webOrigin: origin, production: false, runWorker: false });
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
    expect(setup.statusCode, setup.body).toBe(200);
    ownerCookie = await login(owner);
    const invite = await application.app.inject({ method: 'POST', url: '/api/members/invites',
      headers: headers(ownerCookie), payload: { name: member.name, email: member.email } });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    const accepted = await application.app.inject({ method: 'POST', url: '/api/invites/accept',
      headers: headers(), payload: { name: member.name, password: member.password, token } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    memberCookie = await login(member);
    ownerId = (await application.app.inject({ url: '/api/access', headers: headers(ownerCookie) })).json().user.id;
    memberId = (await application.app.inject({ url: '/api/access', headers: headers(memberCookie) })).json().user.id;
  }, 60_000);

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    for (const table of ['chat_notifications', 'notification_tabs', 'notification_preferences', 'push_subscriptions']) {
      await db().deleteFrom(table).execute();
    }
    send.mockClear();
  });

  it('subscribes, lists and unsubscribes only the caller’s devices', async () => {
    const ownerInput = subscription('owner-device', 'Owner browser');
    const ownerDevice = await subscribe(ownerCookie, ownerInput);
    expect(await subscribe(ownerCookie, { ...ownerInput, label: 'Renamed' })).toMatchObject({ id: ownerDevice.id, label: 'Renamed' });
    const memberInput = subscription('member-device', 'Member browser');
    const memberDevice = await subscribe(memberCookie, memberInput);
    const settings = (cookie: string) => application.app.inject({ url: url('settings'), headers: headers(cookie) });
    expect((await settings('')).statusCode).toBe(401);
    const memberSettings = (await settings(memberCookie)).json();
    expect(memberSettings.devices).toEqual([memberDevice]);
    expect(JSON.stringify(memberSettings)).not.toContain(memberInput.endpoint);
    expect(JSON.stringify(memberSettings)).not.toContain(memberInput.keys.auth);
    expect((await settings(ownerCookie)).json().devices.map((device: PushDevice) => device.id)).toEqual([ownerDevice.id]);
    const collision = await application.app.inject({ method: 'POST', url: url('subscribe'), headers: headers(memberCookie), payload: ownerInput });
    expect(collision.statusCode).toBe(409);
    const remove = (cookie: string, id: string) => application.app.inject({ method: 'DELETE', url: url(`devices/${id}`), headers: headers(cookie) });
    expect((await remove(memberCookie, ownerDevice.id)).json()).toEqual({ removed: false });
    expect((await remove(ownerCookie, memberDevice.id)).json()).toEqual({ removed: false });
    expect((await remove(memberCookie, memberDevice.id)).json()).toEqual({ removed: true });
    expect((await remove(memberCookie, memberDevice.id)).json()).toEqual({ removed: false });
    expect((await settings(memberCookie)).json().devices).toEqual([]);
    expect((await remove(ownerCookie, ownerDevice.id)).json()).toEqual({ removed: true });
  });

  it('isolates preferences and explicit test pushes, with no lock-screen title in a test', async () => {
    const ownerInput = subscription('owner-test-device');
    const memberInput = subscription('member-test-device');
    const ownerDevice = await subscribe(ownerCookie, ownerInput), memberDevice = await subscribe(memberCookie, memberInput);
    const prefs = { hideTitle: true, quietHours: { start: '00:00', end: '23:59', timeZone: 'Asia/Riyadh' } };
    const setSettings = (payload: unknown) => application.app.inject({ method: 'POST', url: url('settings'), headers: headers(memberCookie), payload: payload as object });
    expect((await setSettings({ ...prefs, quietHours: { ...prefs.quietHours, timeZone: '+03:00' } })).statusCode).toBe(400);
    expect((await setSettings(prefs)).json().preferences).toEqual(prefs);
    expect((await application.app.inject({ url: url('settings'), headers: headers(ownerCookie) })).json().preferences)
      .toEqual({ hideTitle: false, quietHours: null });
    const tested = await application.app.inject({ method: 'POST', url: url('test'), headers: headers(memberCookie), payload: {} });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toEqual({ delivered: 1 });
    expect(send).toHaveBeenCalledExactlyOnceWith(memberInput.endpoint, {
      kind: 'task_completed', conversationId: null, taskId: expect.any(String),
    });
    const testTask = send.mock.calls[0]![1].taskId;
    expect((await application.app.inject({ url: url(`events/${testTask}`), headers: headers(memberCookie) })).statusCode).toBe(204);
    expect((await application.app.inject({ url: url(`events/${testTask}`), headers: headers(ownerCookie) })).statusCode).toBe(404);
    const devices = (await application.app.inject({ url: url('settings'), headers: headers(memberCookie) })).json().devices;
    expect(devices).toEqual([{ ...memberDevice, lastSuccessAt: expect.any(String) }]);
    expect((await setSettings({ hideTitle: false, quietHours: null })).statusCode).toBe(200);
    for (const [cookie, device] of [[ownerCookie, ownerDevice], [memberCookie, memberDevice]] as const) {
      await application.app.inject({ method: 'DELETE', url: url(`devices/${device.id}`), headers: headers(cookie) });
    }
  });

  it('gives needs_you priority before a claim and never notifies twice as a run resumes', async () => {
    const id = await conversation(ownerId), tabId = randomUUID();
    const task = await outcome(ownerId, id, 'task_completed');
    await outcome(ownerId, id, 'needs_you', 25_000, now, task);
    await outcome(ownerId, id, 'task_failed', 25_000, now, task);
    const synced = await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, later);
    expect(synced).toEqual({ backgroundTask: true, pending: [{ taskId: task, kind: 'needs_you', conversationId: id, conversationTitle: 'عنوان خاص' }] });
    const claimed = await Promise.all([
      claimNotification(db(), ownerId, task, 'tab', later, tabId),
      claimNotification(db(), ownerId, task, 'tab', later, tabId),
    ]);
    expect(claimed.filter(Boolean)).toEqual(synced.pending);
    await outcome(ownerId, id, 'task_completed', 28_000, later, task);
    expect((await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, later)).pending).toEqual([]);
  });

  it('permanently skips fast visible completions and offers permission only once work can cross 20 seconds', async () => {
    const id = await conversation(ownerId), tabId = randomUUID();
    await syncNotifications(db(), ownerId, { tabId, state: 'visible' }, now);
    const fast = await outcome(ownerId, id, 'task_completed', 19_999);
    const threshold = await outcome(ownerId, id, 'task_completed', 20_000);
    expect((await syncNotifications(db(), ownerId, { tabId, state: 'visible' }, later)).pending).toEqual([]);
    const hidden = await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, later);
    expect(hidden.backgroundTask).toBe(true);
    expect(hidden.pending.map(event => event.taskId)).toContain(threshold);
    expect(hidden.pending.map(event => event.taskId)).not.toContain(fast);
    await claimNotification(db(), ownerId, threshold, 'tab', later, tabId);
    expect((await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, later)).backgroundTask).toBe(false);
    const startedAt = new Date(later.getTime() - 19_999);
    await db().insertInto('chat_runs').values({ id: randomUUID(), owner_id: ownerId, conversation_id: id,
      status: 'running', goal: 'background fixture', lease_token: randomUUID(), lease_expires_at: new Date(later.getTime() + 30_000), created_at: startedAt }).execute();
    expect((await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, later)).backgroundTask).toBe(false);
    expect((await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, new Date(later.getTime() + 1))).backgroundTask).toBe(true);
    await db().deleteFrom('chat_conversations').where('id', '=', id).execute();
    await syncNotifications(db(), ownerId, { tabId, state: 'closed' }, later);
  });

  it('keeps notifications within the conversation account, excludes messages, and omits a hidden title', async () => {
    const own = await conversation(ownerId), other = await conversation(memberId);
    const time = new Date(Date.now() - 3_000);
    const ownerTask = await outcome(ownerId, own, 'task_failed', 30_000, time);
    const memberTask = await outcome(memberId, other, 'task_completed', 25_000, time);
    await saveNotificationPreferences(db(), memberId, { quietHours: null, hideTitle: true });
    const tabId = randomUUID();
    const sync = (cookie: string) => application.app.inject({ method: 'POST', url: url('sync'), headers: headers(cookie), payload: { tabId, state: 'hidden' } });
    const claim = (cookie: string, taskId: string) => application.app.inject({ method: 'POST', url: url(`events/${taskId}/claim`), headers: headers(cookie), payload: { tabId } });
    expect((await sync(ownerCookie)).json().pending).toEqual([{ taskId: ownerTask, kind: 'task_failed', conversationId: own, conversationTitle: 'عنوان خاص' }]);
    expect((await sync(memberCookie)).json().pending).toEqual([{ taskId: memberTask, kind: 'task_completed', conversationId: other }]);
    expect((await claim(memberCookie, ownerTask)).json()).toEqual({ notification: null });
    expect((await claim(ownerCookie, memberTask)).json()).toEqual({ notification: null });
    expect((await claim(memberCookie, memberTask)).json().notification).toEqual({ taskId: memberTask, kind: 'task_completed', conversationId: other });
    expect((await claim(ownerCookie, ownerTask)).json().notification).toEqual({ taskId: ownerTask, kind: 'task_failed', conversationId: own, conversationTitle: 'عنوان خاص' });
    await saveNotificationPreferences(db(), memberId, { quietHours: null, hideTitle: false });
    for (const userId of [ownerId, memberId]) await syncNotifications(db(), userId, { tabId, state: 'closed' });
  });

  it('does not enqueue a quiet-hour outcome or deliver a queued outcome into quiet hours', async () => {
    const id = await conversation(memberId), tabId = randomUUID();
    const preferences = { quietHours: { start: '12:00', end: '13:00', timeZone: 'UTC' }, hideTitle: false };
    await saveNotificationPreferences(db(), memberId, preferences);
    const quiet = await outcome(memberId, id, 'task_failed');
    const beforeQuiet = await outcome(memberId, id, 'needs_you', 25_000, new Date(now.getTime() - 2_500));
    const hidden = await syncNotifications(db(), memberId, { tabId, state: 'hidden' }, later);
    expect(hidden.pending).toEqual([]);
    for (const task of [quiet, beforeQuiet]) expect(await claimNotification(db(), memberId, task, 'tab', later, tabId)).toBeNull();
    const rows = await db().selectFrom('chat_notifications').select('delivery').where('task_id', 'in', [quiet, beforeQuiet]).execute();
    expect(rows).toEqual([{ delivery: 'suppressed' }, { delivery: 'suppressed' }]);
    await saveNotificationPreferences(db(), memberId, { quietHours: null, hideTitle: false });
    await syncNotifications(db(), memberId, { tabId, state: 'closed' }, later);
  });

  it('dispatches only with closed tabs, expires a 410 device, and sends at most one successful push', async () => {
    const tabId = randomUUID();
    const backup = subscription('backup-push'), expired = subscription('expired-push');
    const backupDevice = await subscribe(memberCookie, backup);
    const expiredDevice = await subscribe(memberCookie, expired);
    await db().updateTable('push_subscriptions').set({ failure_count: 1 }).where('id', '=', backupDevice.id).execute();
    const other = await subscribe(ownerCookie, subscription('other-account-push'));
    const id = await conversation(memberId);
    await syncNotifications(db(), memberId, { tabId, state: 'hidden' }, now);
    const taskId = await outcome(memberId, id, 'needs_you', 20_000);
    const transport = vi.fn(async (device: { endpoint: string }, _payload: NotificationPayload) =>
      device.endpoint === expired.endpoint ? 'expired' as const : 'delivered' as const);
    await dispatchPushNotifications(db(), transport, async () => true, later);
    expect(transport).not.toHaveBeenCalled();
    await syncNotifications(db(), memberId, { tabId, state: 'closed' }, later);
    await dispatchPushNotifications(db(), transport, async () => false, later);
    expect(transport).not.toHaveBeenCalled();
    await Promise.all([dispatchPushNotifications(db(), transport, async () => true, later), dispatchPushNotifications(db(), transport, async () => true, later)]);
    expect(transport.mock.calls.map(([device]) => device.endpoint)).toEqual([expired.endpoint, backup.endpoint]);
    for (const [, payload] of transport.mock.calls) expect(payload).toEqual({ kind: 'needs_you', taskId, conversationId: id, conversationTitle: 'عنوان خاص' });
    expect(await ownsPushNotification(db(), memberId, taskId, later)).toBe(true);
    expect(await ownsPushNotification(db(), ownerId, taskId, later)).toBe(false);
    const saved = (await application.app.inject({ url: url('settings'), headers: headers(memberCookie) })).json().devices;
    expect(saved).toEqual([{ ...backupDevice, lastSuccessAt: expect.any(String) }]);
    expect(saved.some((device: PushDevice) => device.id === expiredDevice.id)).toBe(false);
    expect((await application.app.inject({ url: url('settings'), headers: headers(ownerCookie) })).json().devices).toEqual([other]);
  });

  it('falls back to push when tab presence expires without retrying an ambiguous transport failure', async () => {
    const id = await conversation(ownerId), tabId = randomUUID();
    const first = subscription('first-delivery'), second = subscription('second-delivery');
    const selected = await subscribe(ownerCookie, first), alternate = await subscribe(ownerCookie, second);
    await db().updateTable('push_subscriptions').set({ failure_count: 1 }).where('id', '=', alternate.id).execute();
    await saveNotificationPreferences(db(), ownerId, { quietHours: null, hideTitle: true });
    await syncNotifications(db(), ownerId, { tabId, state: 'hidden' }, now);
    const taskId = await outcome(ownerId, id, 'task_failed');
    const transport = vi.fn(async (_device: { endpoint: string }, _payload: NotificationPayload) => 'failed' as const);
    const expiredPresence = new Date(now.getTime() + 25_001);
    await dispatchPushNotifications(db(), transport, async () => true, expiredPresence);
    await dispatchPushNotifications(db(), transport, async () => true, expiredPresence);
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endpoint: first.endpoint }), { taskId, kind: 'task_failed', conversationId: id });
    const devices = (await application.app.inject({ url: url('settings'), headers: headers(ownerCookie) })).json().devices as PushDevice[];
    expect(devices.find(device => device.id === selected.id)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
    expect(devices.find(device => device.id === alternate.id)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
  });
});
