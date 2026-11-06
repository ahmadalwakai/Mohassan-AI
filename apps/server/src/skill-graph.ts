import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SkillGraphQuerySchema, SkillGraphRelatedQuerySchema, SkillGraphRelatedSchema } from '@mohassan/contracts';
import { readSkillGraph, rebuildSkillGraph, relatedSkills, SkillError } from '@mohassan/skills';

/** Graph queries expose metadata, never rebuild state or authorize execution. */
export async function registerSkillGraphRoutes(app: FastifyInstance, { db, owner }: { db: Kysely<any>; owner(request: any): Promise<{ id: string }> }) {
  app.get('/api/skills/graph', async (request, reply) => {
    const user = await owner(request);
    SkillGraphQuerySchema.parse(request.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return readSkillGraph(db, user.id);
  });
  // Explicit repair of a metadata cache, including owners predating M10.
  // Neither the request nor the graph can supply grants or verified outcomes.
  app.post('/api/skills/graph/rebuild', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await owner(request);
    SkillGraphQuerySchema.parse(request.query ?? {});
    z.object({}).strict().parse(request.body ?? {});
    reply.header('cache-control', 'private, no-store');
    return rebuildSkillGraph(db, user.id);
  });
  app.get<{ Params: { id: string } }>('/api/skills/:id/related', async (request, reply) => {
    const user = await owner(request), id = z.uuid().parse(request.params.id);
    const query = SkillGraphRelatedQuerySchema.parse(request.query ?? {});
    reply.header('cache-control', 'private, no-store');
    const version = await db.selectFrom('skill_versions').select('id').where('owner_id', '=', user.id).where('id', '=', id).executeTakeFirst();
    if (!version) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على المهارة.', 404);
    return SkillGraphRelatedSchema.parse(await relatedSkills(db, user.id, [id], query));
  });
}
