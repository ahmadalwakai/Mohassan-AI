import { BrowserError } from '@mohassan/browser';
import { FeedbackReviewSchema, type FeedbackQueue } from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { listFeedback, reviewFeedback } from './feedback-store.js';
import type { WorkspaceRole } from './members.js';

const PAGE_SIZE = 30;
const ListQuery = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).default(0),
}).strict();

export function registerFeedbackRoutes(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner(request: FastifyRequest): Promise<{ id: string }>;
  role(request: FastifyRequest): Promise<WorkspaceRole>;
  enabled: boolean;
}) {
  async function requireOwner(request: FastifyRequest) {
    const { id } = await options.owner(request);
    if (await options.role(request) !== 'owner') {
      throw new BrowserError('FEEDBACK_OWNER_REQUIRED', 'مراجعة تقييمات الإجابات متاحة للمالك فقط.', 403);
    }
    if (!options.enabled) throw new BrowserError('FEEDBACK_DISABLED', 'مراجعة تقييمات الإجابات غير مفعّلة.', 404);
    return { id, role: 'owner' as const };
  }

  app.get('/api/feedback', async (request): Promise<FeedbackQueue> => {
    const actor = await requireOwner(request);
    const { status, offset } = ListQuery.parse(request.query);
    const items = await listFeedback(options.db, actor, { pendingOnly: status === 'pending', offset, limit: PAGE_SIZE + 1 });
    return { items: items.slice(0, PAGE_SIZE), nextOffset: items.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
  });

  app.post<{ Params: { id: string } }>('/api/feedback/:id/review', async request => {
    const actor = await requireOwner(request);
    return reviewFeedback(options.db, actor, z.uuid().parse(request.params.id), FeedbackReviewSchema.parse(request.body));
  });
}
