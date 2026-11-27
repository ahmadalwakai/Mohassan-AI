import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { IosPushRegistrationSchema, IosPushTokenSchema, type PushUnsubscribeResponse } from '@mohassan/contracts';
import { checkPushRegistration } from './notification-security.js';
import { registerIosPushDevice, removeIosPushRegistration, unregisterIosPushDevice } from './ios-push-devices.js';

const devices = '/api/push/devices';
const device = `${devices}/:token`;
const registration = `${devices}/registrations/:id`;
export const IOS_PUSH_MEMBER_ROUTES = [`POST ${devices}`, `DELETE ${device}`, `DELETE ${registration}`];

export function registerIosPushRoutes(app: FastifyInstance, db: Kysely<any>, owner: (request: FastifyRequest) => Promise<{ id: string; sessionId: string }>) {
  app.post(devices, async (request, reply) => {
    const { id, sessionId } = await owner(request);
    const input = IosPushRegistrationSchema.parse(request.body);
    const registered = await db.transaction().execute(async tx => {
      await checkPushRegistration(tx, id, input);
      return registerIosPushDevice(tx, id, sessionId, input);
    });
    if (!registered) return reply.code(409).send({ error: { code: 'PUSH_DEVICE_IN_USE', message: 'هذا الجهاز مرتبط بحساب آخر.' } });
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>(registration, async request => ({
    removed: await removeIosPushRegistration(db, (await owner(request)).id, z.uuid().parse(request.params.id)),
  } satisfies PushUnsubscribeResponse));
  app.delete<{ Params: { token: string } }>(device, async (request, reply) => {
    const { id } = await owner(request);
    await unregisterIosPushDevice(db, id, IosPushTokenSchema.parse(request.params.token));
    return reply.code(204).send();
  });
}
