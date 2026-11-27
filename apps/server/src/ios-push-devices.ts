import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { IosNotificationDevice, IosPushEnvironment, IosPushRegistration } from '@mohassan/contracts';

export interface IosPushDevice {
  registration_id: string;
  user_id: string;
  session_id: string | null;
  registration_generation: string;
  token: string;
  environment: IosPushEnvironment;
  app_version: string;
  registered_at: Date;
}

interface DeviceDatabase {
  ios_push_devices: IosPushDevice;
  session: { id: string; userId: string; expiresAt: Date };
  background_apns_deliveries: { registration_id: string; delivered_at: Date | null };
}
type Database = Kysely<DeviceDatabase>;

const sessionIsLive = sql<boolean>`"expiresAt" > clock_timestamp()`;

// Enqueue and dispatch both query the registration as `device`.
export const liveApnsRegistration = sql<boolean>`(device.session_id IS NULL OR EXISTS (
  SELECT 1 FROM session WHERE id = device.session_id AND "userId" = device.user_id AND ${sessionIsLive}
))`;

function registeringSession(db: Database, userId: string, sessionId: string) {
  return db.selectFrom('session').where('id', '=', sessionId).where('userId', '=', userId);
}

export async function lockLiveApnsSession(db: Database, device: IosPushDevice) {
  if (device.session_id === null) return true;
  // Revocation locks the session before cascading to the device. Dispatch
  // holds the device lock already, so skip a session that is being changed.
  return Boolean(await registeringSession(db, device.user_id, device.session_id)
    .select('id').where(sessionIsLive).forShare().skipLocked().executeTakeFirst());
}

export async function registerIosPushDevice(tx: Transaction<DeviceDatabase>, userId: string, sessionId: string, device: IosPushRegistration) {
  const session = await registeringSession(tx, userId, sessionId).select('id').where(sessionIsLive).forShare().executeTakeFirst();
  if (!session) throw Object.assign(new Error('سجّل الدخول للمتابعة.'), { statusCode: 401, code: 'UNAUTHORIZED' });

  const existing = await tx.selectFrom('ios_push_devices').select(['registration_id', 'user_id', 'session_id'])
    .where('token', '=', device.token).where('environment', '=', device.environment).forUpdate().executeTakeFirst();
  if (existing && existing.user_id !== userId) {
    if (existing.session_id === null) return false;
    const previous = await registeringSession(tx, existing.user_id, existing.session_id)
      .select(sessionIsLive.as('live')).forShare().skipLocked().executeTakeFirst();
    if (!previous || previous.live) return false;
    // Cascades the old account's queued deliveries before assigning a new ID.
    await removeIosPushRegistration(tx, existing.user_id, existing.registration_id);
  }

  const registration = {
    registration_generation: randomUUID(), user_id: userId, session_id: sessionId,
    app_version: device.appVersion, registered_at: new Date(),
  };
  const row = await tx.insertInto('ios_push_devices')
    .values({ ...registration, registration_id: randomUUID(), token: device.token, environment: device.environment })
    .onConflict(conflict => conflict.columns(['environment', 'token']).doUpdateSet(registration)
      .where('ios_push_devices.user_id', '=', userId)).returning('registration_id').executeTakeFirst();
  return Boolean(row);
}

function accountDevices(db: Database, userId: string) {
  return db.selectFrom('ios_push_devices').selectAll().where('user_id', '=', userId);
}

export function listApnsDevices(db: Database, userId: string) {
  return accountDevices(db, userId).orderBy('registered_at').orderBy('registration_id').execute();
}

export function currentApnsDevice(db: Database, userId: string, registrationId: string) {
  return accountDevices(db, userId).where('registration_id', '=', registrationId).executeTakeFirst();
}

export async function listIosNotificationDevices(db: Database, userId: string): Promise<IosNotificationDevice[]> {
  const devices = await db.selectFrom('ios_push_devices as device')
    .select(['device.registration_id', 'device.registered_at'])
    .select(eb => eb.selectFrom('background_apns_deliveries as delivery')
      .select(inner => inner.fn.max<Date | null>('delivery.delivered_at').as('last_delivery_at'))
      .whereRef('delivery.registration_id', '=', 'device.registration_id').as('last_delivery_at'))
    .where('device.user_id', '=', userId).orderBy('device.registered_at').orderBy('device.registration_id').execute();
  return devices.map(device => ({
    id: device.registration_id, label: 'iPhone', registeredAt: new Date(device.registered_at).toISOString(),
    lastDeliveryAt: device.last_delivery_at ? new Date(device.last_delivery_at).toISOString() : null,
  }));
}

export async function removeIosPushRegistration(db: Database, userId: string, registrationId: string) {
  const result = await db.deleteFrom('ios_push_devices').where('user_id', '=', userId)
    .where('registration_id', '=', registrationId).executeTakeFirstOrThrow();
  return result.numDeletedRows > 0n;
}

export async function unregisterIosPushDevice(db: Database, userId: string, token: string) {
  await db.deleteFrom('ios_push_devices').where('user_id', '=', userId).where('token', '=', token).execute();
}

export async function expireIosPushDevice(db: Database, device: IosPushDevice) {
  // A response for an earlier registration must never delete the current registration.
  await db.deleteFrom('ios_push_devices').where('user_id', '=', device.user_id)
    .where('registration_id', '=', device.registration_id)
    .where('registration_generation', '=', device.registration_generation).execute();
}
