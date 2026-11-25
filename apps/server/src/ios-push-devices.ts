import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { IosPushEnvironment, IosPushRegistration } from '@mohassan/contracts';

export interface IosPushDevice {
  registration_id: string;
  user_id: string;
  registration_generation: string;
  token: string;
  environment: IosPushEnvironment;
  app_version: string;
  registered_at: Date;
}

interface DeviceDatabase { ios_push_devices: IosPushDevice }
type Database = Kysely<DeviceDatabase>;

export async function registerIosPushDevice(db: Database, userId: string, device: IosPushRegistration) {
  const registration = { registration_generation: randomUUID(), user_id: userId, app_version: device.appVersion, registered_at: new Date() };
  const row = await db.insertInto('ios_push_devices')
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

export async function unregisterIosPushDevice(db: Database, userId: string, token: string) {
  await db.deleteFrom('ios_push_devices').where('user_id', '=', userId).where('token', '=', token).execute();
}

export async function expireIosPushDevice(db: Database, device: IosPushDevice) {
  // A response for an earlier registration must never delete the current registration.
  await db.deleteFrom('ios_push_devices').where('user_id', '=', device.user_id)
    .where('registration_id', '=', device.registration_id)
    .where('registration_generation', '=', device.registration_generation).execute();
}
