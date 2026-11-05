import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { createSkillControl, skillsMigration, type SkillEnvironment } from '@mohassan/skills';

export async function registerSkillRoutes(app: FastifyInstance, { db, owner, allowedRoots, environment }: { db: Kysely<any>; owner: (request: any) => Promise<{ id: string }>; allowedRoots: readonly string[]; environment: () => SkillEnvironment }) {
  await skillsMigration(db);
  const skills = createSkillControl(db, { allowedRoots, environment });
  const write = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  type Skill = { Params: { id: string } };
  const id = (value: string) => z.uuid().parse(value);
  app.get('/api/skills', async (request) => skills.list((await owner(request)).id, request.query));
  app.post('/api/skills/import', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => skills.importLocal((await owner(request)).id, request.body));
  app.post('/api/skills/compose/validate', write, async (request) => skills.validateComposition((await owner(request)).id, request.body));
  app.get<Skill>('/api/skills/:id', async (request) => skills.detail((await owner(request)).id, id(request.params.id)));
  app.post<Skill>('/api/skills/:id/inspect', write, async (request) => skills.inspect((await owner(request)).id, id(request.params.id), request.body));
  app.post<Skill>('/api/skills/:id/activate', write, async (request) => skills.activate((await owner(request)).id, id(request.params.id), request.body));
  app.post<Skill>('/api/skills/:id/revoke', write, async (request) => skills.revoke((await owner(request)).id, id(request.params.id), request.body));
  app.post<Skill>('/api/skills/:id/rollback', write, async (request) => skills.rollback((await owner(request)).id, id(request.params.id), request.body));
  app.post<Skill>('/api/skills/:id/grants', write, async (request) => skills.createGrant((await owner(request)).id, id(request.params.id), request.body));
  app.post<{ Params: { id: string; grantId: string } }>('/api/skills/:id/grants/:grantId/revoke', write, async (request) => {
    await skills.revokeGrant((await owner(request)).id, id(request.params.id), id(request.params.grantId), request.body);
    return { ok: true };
  });
  return skills;
}
