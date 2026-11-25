import { MonitorApproveSchema, MonitorListSchema } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { monitorPaths } from './route-keys.js';
import { monitorChat } from './chat.js';
import { MonitorError, type ReserveMonitorApproval } from './store.js';

const listQuery = z.object({ conversationId: z.uuid().optional() }).strict();
const emptyBody = z.object({}).strict();

export async function registerMonitorRuntime(app: FastifyInstance, db: Kysely<any>,
  owner: (request: FastifyRequest) => Promise<{ id: string }>, reserveApproval: ReserveMonitorApproval) {
  const control = monitorChat(db);
  if (!control) return;
  await control.initialize(true);
  const access = async (request: FastifyRequest) => {
    if (!await control.availableTo((await owner(request)).id)) {
      throw new MonitorError(403, 'MONITOR_FORBIDDEN', 'Monitoring is unavailable for this account.');
    }
  };
  const mutation = { onRequest: access, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };
  app.get(monitorPaths.base, { onRequest: access }, async request => {
    const { conversationId } = listQuery.parse(request.query);
    return MonitorListSchema.parse({ monitors: await control.store.list((await owner(request)).id, conversationId) });
  });
  app.post(monitorPaths.base, mutation, async request => {
    const { proposalId } = MonitorApproveSchema.parse(request.body);
    return control.store.approve((await owner(request)).id, proposalId, reserveApproval);
  });
  for (const action of ['pause', 'resume', 'stop'] as const) {
    app.post<{ Params: { id: string } }>(monitorPaths[action], mutation, async request => {
      emptyBody.parse(request.body ?? {});
      return control.store.change((await owner(request)).id, z.uuid().parse(request.params.id), action);
    });
  }
  app.addHook('onReady', async () => { control.runtime.start(); });
  app.addHook('preClose', async () => { await control.runtime.stop(); });
}
