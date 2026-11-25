import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { FeedbackReviewSchema, FeedbackTrainingSchema, type FeedbackQueue } from '@mohassan/contracts';
import { clearFeedbackPolicy, exportFeedbackRegression, feedbackMetrics, listFeedback, reviewFeedback, setFeedbackTraining } from './feedback-store.js';
import type { WorkspaceRole } from './members.js';

const PAGE_SIZE = 30;
const ListQuery = z.object({
  status: z.enum(['pending', 'all']).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).default(0),
}).strict();
const ExportQuery = z.object({ mode: z.enum(['regression', 'training']).default('regression') }).strict();
const Id = z.object({ id: z.uuid() });

export function registerFeedbackRoutes(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner(request: FastifyRequest): Promise<{ id: string }>;
  role(request: FastifyRequest): Promise<WorkspaceRole>;
}) {
  const { db } = options;
  const actor = async (request: FastifyRequest) => ({ id: (await options.owner(request)).id, role: await options.role(request) });

  app.get('/api/feedback', async (request): Promise<FeedbackQueue> => {
    const caller = await actor(request);
    const { status = caller.role === 'owner' ? 'pending' : 'all', offset } = ListQuery.parse(request.query);
    const items = await listFeedback(db, caller, { pendingOnly: status === 'pending', offset, limit: PAGE_SIZE + 1 });
    const page = { items: items.slice(0, PAGE_SIZE), nextOffset: items.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
    if (caller.role === 'owner') return { ...page, role: 'owner', metrics: await feedbackMetrics(db, caller) };
    return { ...page, role: 'member' };
  });

  app.post('/api/feedback/:id/review', async request => {
    const { id } = Id.parse(request.params);
    return reviewFeedback(db, await actor(request), id, FeedbackReviewSchema.parse(request.body).decision);
  });

  app.post('/api/feedback/:id/training', async request => {
    const { id } = Id.parse(request.params);
    return setFeedbackTraining(db, await actor(request), id, FeedbackTrainingSchema.parse(request.body).allowed);
  });

  app.post('/api/feedback/policies/:id/clear', async request => {
    return clearFeedbackPolicy(db, await actor(request), Id.parse(request.params).id);
  });

  app.get('/api/feedback/regression', async (request, reply) => {
    const { mode } = ExportQuery.parse(request.query);
    const exportJson = await exportFeedbackRegression(db, await actor(request), mode);
    return reply.type('application/json').send(exportJson);
  });
}
