import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { readSkillPortfolio, readSkillQuality } from '@mohassan/skills';

/** Saved measurements only; a read never seeds skills, runs a case or promotes a candidate. */
export async function registerSkillPortfolioRoutes(app: FastifyInstance, { db, owner }: { db: Kysely<any>; owner(request: any): Promise<{ id: string }> }) {
  app.get('/api/skills/portfolio', async (request, reply) => {
    const user = await owner(request);
    reply.header('cache-control', 'private, no-store');
    return readSkillPortfolio(db, user.id, request.query);
  });
  app.get<{ Params: { id: string } }>('/api/skills/:id/quality', async (request, reply) => {
    const user = await owner(request), id = z.uuid().parse(request.params.id);
    z.object({}).strict().parse(request.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return readSkillQuality(db, user.id, id);
  });
}
