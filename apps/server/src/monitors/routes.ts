import { MonitorApproveSchema, MonitorListSchema } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { registerMonitorAlertFeedbackRoute, withMonitorCardAlerts } from '../monitors-phase1/feedback.js';
import { monitorPaths } from './route-keys.js';
import { monitorChat } from './chat.js';
import { monitorRecordingSetting, setMonitorRecordingSetting } from './decision/records.js';
import { MonitorError, type ReserveMonitorApproval } from './store.js';

const listQuery = z.object({ conversationId: z.uuid().optional() }).strict();
const v2ListQuery = listQuery.extend({ control: z.literal('v2').optional() });
const v2Mutation = z.union([
  MonitorApproveSchema,
  z.object({ proposalId: z.uuid(), candidateId: z.string().min(1).max(128) }).strict(),
  z.object({ actionId: z.uuid(), approved: z.boolean().optional(), targetId: z.uuid().optional() }).strict(),
  z.object({ proactiveOffers: z.boolean() }).strict(),
]);
const emptyBody = z.object({}).strict();
const recordingSetting = z.strictObject({ decisionRecording: z.boolean() });

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
  registerMonitorAlertFeedbackRoute(app, db, owner, mutation);
  app.get(monitorPaths.base, { onRequest: access }, async request => {
    const query = (control.v2 ? v2ListQuery : listQuery).parse(request.query);
    const ownerId = (await owner(request)).id;
    if ('control' in query && query.control === 'v2') return control.v2State(ownerId, query.conversationId);
    return MonitorListSchema.parse({ monitors: await withMonitorCardAlerts(db, ownerId, await control.store.list(ownerId, query.conversationId)) });
  });
  app.post(monitorPaths.base, mutation, async request => {
    const body = (control.v2 ? v2Mutation : MonitorApproveSchema).parse(request.body);
    const ownerId = (await owner(request)).id;
    if ('actionId' in body) return control.confirmAction(ownerId, body.actionId, body.approved ?? true, body.targetId);
    if ('proactiveOffers' in body) return control.setProactiveOffers(ownerId, body.proactiveOffers);
    const result = 'candidateId' in body && typeof body.candidateId === 'string'
      ? await control.store.choose(ownerId, body.proposalId, body.candidateId)
      : await control.store.approve(ownerId, body.proposalId, reserveApproval);
    const [card] = await withMonitorCardAlerts(db, ownerId, [result]);
    return card;
  });
  for (const action of ['pause', 'resume', 'stop'] as const) {
    app.post<{ Params: { id: string } }>(monitorPaths[action], mutation, async request => {
      emptyBody.parse(request.body ?? {});
      const { id } = await owner(request);
      const [card] = await withMonitorCardAlerts(db, id, [await control.store.change(id, z.uuid().parse(request.params.id), action)]);
      return card;
    });
  }
  app.get(monitorPaths.decisionRecording, { onRequest: access }, async request => monitorRecordingSetting(db, (await owner(request)).id));
  app.post(monitorPaths.decisionRecording, mutation, async request => {
    const { decisionRecording } = recordingSetting.parse(request.body);
    return setMonitorRecordingSetting(db, (await owner(request)).id, decisionRecording);
  });
  app.addHook('onReady', async () => { control.runtime.start(); });
  app.addHook('preClose', async () => { await control.runtime.stop(); });
}
