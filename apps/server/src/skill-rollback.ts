import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '@mohassan/runtime';
import { SkillError } from '@mohassan/skills';
import type { createSkillRollbackControl } from '../../../packages/skills/src/rollback.js';

export interface SkillRollbackRoutesOptions {
  owner(request: any): Promise<{ id: string }>;
  runtime: Pick<Runtime, 'createTask'>;
  rollback: ReturnType<typeof createSkillRollbackControl>;
  enabled: boolean;
}

/** Preparing an undo creates an ordinary Runtime approval task. No request
 * handler writes, deletes or restores a user file. */
export async function registerSkillRollbackRoutes(app: FastifyInstance, { owner, runtime, rollback, enabled }: SkillRollbackRoutesOptions) {
  type Route = { Params: { id: string } };
  app.get<Route>('/api/skills/runs/:id/rollback', async request => rollback.preview((await owner(request)).id, z.uuid().parse(request.params.id)));
  app.post<Route>('/api/skills/runs/:id/rollback', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    if (!enabled) throw new SkillError('SKILL_ENGINE_DISABLED', 'استعادة المهارات غير مفعّلة.', 403);
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    const prepared = await rollback.describe(user.id, z.uuid().parse(request.params.id), request.body);
    const task = await runtime.createTask(user.id, { title: prepared.title, goal: prepared.goal, capabilityId: 'skill.rollback', autonomy: 'assisted', skillRollbackInput: prepared.input }, key);
    return { task, review: prepared.review };
  });
}
