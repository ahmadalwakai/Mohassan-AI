import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { listSkillGaps } from '../../../packages/skills/src/gaps.ts';

/** Diagnostic reads never seed, rebuild, grant permissions or execute tools. */
export async function registerSkillGapRoutes(app: FastifyInstance, { db, owner }: { db: Kysely<any>; owner(request: any): Promise<{ id: string }> }) {
  app.get('/api/skills/gaps', async (request, reply) => {
    const user = await owner(request);
    reply.header('cache-control', 'private, no-store');
    return listSkillGaps(db, user.id, request.query);
  });
}
