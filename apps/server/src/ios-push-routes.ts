import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { IosPushRegistrationSchema, IosPushTokenSchema } from '@mohassan/contracts';
import { assertMemberFeatureAccess } from './member-deletion.js';
import { registerIosPushDevice, unregisterIosPushDevice } from './ios-push-devices.js';

const devices = '/api/push/devices';
const device = `${devices}/:token`;
export const IOS_PUSH_MEMBER_ROUTES = [`POST ${devices}`, `DELETE ${device}`];

export function registerIosPushRoutes(app: FastifyInstance, db: Kysely<any>, owner: (request: FastifyRequest) => Promise<{ id: string }>) {
  app.post(devices, async (request, reply) => {
    const { id } = await owner(request);
    const input = IosPushRegistrationSchema.parse(request.body);
    const registered = await db.transaction().execute(async tx => {
      await assertMemberFeatureAccess(tx, id);
      return registerIosPushDevice(tx as Kysely<any>, id, input);
    });
    if (!registered) return reply.code(409).send({ error: { code: 'PUSH_DEVICE_IN_USE', message: 'هذا الجهاز مرتبط بحساب آخر.' } });
    return reply.code(204).send();
  });
  app.delete<{ Params: { token: string } }>(device, async (request, reply) => {
    const { id } = await owner(request);
    await unregisterIosPushDevice(db, id, IosPushTokenSchema.parse(request.params.token));
    return reply.code(204).send();
  });
}
