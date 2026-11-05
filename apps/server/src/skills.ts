import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createSkillControl, skillsMigration } from '@mohassan/skills';

export async function registerSkillRoutes(app: FastifyInstance, { db, owner }: { db: Kysely<any>; owner: (request: any) => Promise<{ id: string }> }) {
  await skillsMigration(db);
  const skills = createSkillControl(db);
  app.get('/api/skills', async (request) => skills.list((await owner(request)).id, request.query));
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (request) => skills.detail((await owner(request)).id, z.uuid().parse(request.params.id)));
  return skills;
}
