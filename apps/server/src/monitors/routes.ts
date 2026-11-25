import { MonitorApproveSchema, MonitorListSchema } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { monitorPaths } from './route-keys.js';
import { monitorChat } from './chat.js';
import { monitorRecordingSetting, recordMonitorAlertFeedback, setMonitorRecordingSetting } from './decision/records.js';

const listQuery = z.object({ conversationId: z.uuid().optional() }).strict();
const v2ListQuery = listQuery.extend({ control: z.literal('v2').optional() }).or(z.strictObject({ control: z.literal('decision-recording') }));
const v2Mutation = z.union([
  MonitorApproveSchema,
  z.object({ proposalId: z.uuid(), candidateId: z.string().min(1).max(128) }).strict(),
  z.object({ actionId: z.uuid(), approved: z.boolean().optional(), targetId: z.uuid().optional() }).strict(),
  z.object({ proactiveOffers: z.boolean() }).strict(),
  z.strictObject({ decisionRecording: z.boolean() }),
  z.strictObject({ noticeId: z.uuid(), helpful: z.boolean() }),
]);
const emptyBody = z.object({}).strict();
const mutation = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };

export async function registerMonitorRuntime(app: FastifyInstance, db: Kysely<any>, owner: (request: FastifyRequest) => Promise<{ id: string }>) {
  const control = monitorChat(db);
  if (!control) return;
  await control.initialize(true);
  app.get(monitorPaths.base, async request => {
    const query = (control.v2 ? v2ListQuery : listQuery).parse(request.query);
    const ownerId = (await owner(request)).id;
    if ('control' in query && query.control === 'decision-recording') return monitorRecordingSetting(db, ownerId);
    if ('control' in query && query.control === 'v2') return control.v2State(ownerId, query.conversationId);
    return MonitorListSchema.parse({ monitors: await control.store.list(ownerId, query.conversationId) });
  });
  app.post(monitorPaths.base, mutation, async request => {
    const body = (control.v2 ? v2Mutation : MonitorApproveSchema).parse(request.body);
    const ownerId = (await owner(request)).id;
    if ('decisionRecording' in body) return setMonitorRecordingSetting(db, ownerId, body.decisionRecording);
    if ('noticeId' in body) {
      const recorded = await db.transaction().execute(tx => recordMonitorAlertFeedback(tx, ownerId, body.noticeId, body.helpful));
      return { recorded };
    }
    if ('actionId' in body) return control.confirmAction(ownerId, body.actionId, body.approved ?? true, body.targetId);
    if ('proactiveOffers' in body) return control.setProactiveOffers(ownerId, body.proactiveOffers);
    if ('candidateId' in body && typeof body.candidateId === 'string') return control.store.choose(ownerId, body.proposalId, body.candidateId);
    return control.store.approve(ownerId, body.proposalId);
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
