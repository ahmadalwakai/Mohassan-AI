import type { Kysely } from 'kysely';
import type { IosPushEnvironment, NotificationSyncRequest } from '@mohassan/contracts';
import { assertMemberFeatureAccess } from './member-deletion.js';

export const hideNotificationTitleByDefault = true;
export const notificationPresenceMs = 25_000;
const devicesPerTransport = 16;
const tabsPerAccount = 32;

type Registration = { endpoint: string } | { token: string; environment: IosPushEnvironment };

function lockNotificationAccount(tx: Kysely<any>, userId: string) {
  return tx.selectFrom('user').select('id').where('id', '=', userId).forNoKeyUpdate().executeTakeFirst();
}

export async function checkPushRegistration(tx: Kysely<any>, userId: string, registration: Registration) {
  await lockNotificationAccount(tx, userId);
  await assertMemberFeatureAccess(tx, userId);
  if ('endpoint' in registration) {
    const devices = tx.selectFrom('push_subscriptions').select('id').where('user_id', '=', userId);
    if (await devices.where('endpoint', '=', registration.endpoint).executeTakeFirst()) return;
    if ((await devices.limit(devicesPerTransport).execute()).length < devicesPerTransport) return;
  } else {
    const devices = tx.selectFrom('ios_push_devices').select('registration_id').where('user_id', '=', userId);
    if (await devices.where('environment', '=', registration.environment).where('token', '=', registration.token).executeTakeFirst()) return;
    if ((await devices.limit(devicesPerTransport).execute()).length < devicesPerTransport) return;
  }
  throw Object.assign(new Error('وصلت إلى الحد الأقصى للأجهزة المسجّلة لهذا الحساب.'), {
    statusCode: 429, code: 'PUSH_DEVICE_LIMIT',
  });
}

export async function updateNotificationPresence(db: Kysely<any>, userId: string, input: NotificationSyncRequest, now: Date) {
  await db.transaction().execute(async tx => {
    if (!await lockNotificationAccount(tx, userId)) return;
    await tx.deleteFrom('notification_tabs').where('user_id', '=', userId).where(eb => eb.or([
      eb('expires_at', '<=', now), ...(input.state === 'closed' ? [eb('tab_id', '=', input.tabId)] : []),
    ])).execute();
    if (input.state === 'closed') return;
    const tabs = tx.selectFrom('notification_tabs').select('tab_id').where('user_id', '=', userId);
    if (!await tabs.where('tab_id', '=', input.tabId).executeTakeFirst() &&
      (await tabs.limit(tabsPerAccount).execute()).length >= tabsPerAccount) return;
    const presence = { visible: input.state === 'visible', expires_at: new Date(now.getTime() + notificationPresenceMs) };
    await tx.insertInto('notification_tabs').values({ user_id: userId, tab_id: input.tabId, ...presence })
      .onConflict(conflict => conflict.columns(['user_id', 'tab_id']).doUpdateSet(presence)).execute();
  });
}
