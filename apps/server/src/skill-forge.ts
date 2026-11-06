import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SkillForgePromoteSchema, SkillForgeStatusSchema } from '@mohassan/contracts';
import { SkillError, type SkillControl, type createSkillForgeControl } from '@mohassan/skills';

export async function registerSkillForgeRoutes(app: FastifyInstance, options: {
  control: ReturnType<typeof createSkillForgeControl>; skills: SkillControl; enabled: boolean; modelConfigured: boolean;
  owner(request: any): Promise<{ id: string }>;
}) {
  const { control, skills, enabled, modelConfigured, owner } = options, empty = z.object({}).strict();
  app.get('/api/skills/forge/status', async (request, reply) => {
    await owner(request); empty.parse(request.query ?? {}); reply.header('cache-control', 'private, no-store');
    return SkillForgeStatusSchema.parse({ enabled, modelConfigured, executablePromotionAllowed: false });
  });
  app.get('/api/skills/forge/generations', async (request, reply) => {
    const user = await owner(request); reply.header('cache-control', 'private, no-store');
    return control.list(user.id, request.query);
  });
  app.get<{ Params: { id: string } }>('/api/skills/forge/generations/:id', async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {}); reply.header('cache-control', 'private, no-store');
    return control.get(user.id, z.uuid().parse(request.params.id));
  });
  app.get<{ Params: { id: string } }>('/api/skills/forge/generations/:id/analysis', async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {}); reply.header('cache-control', 'private, no-store');
    return control.analyze(user.id, z.uuid().parse(request.params.id));
  });
  app.post('/api/skills/forge/generations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {});
    if (!enabled) throw new SkillError('SKILL_ENGINE_DISABLED', 'توليد المهارات غير مفعّل.', 403);
    if (!modelConfigured) throw new SkillError('SKILL_FORGE_MODEL_UNAVAILABLE', 'لم يُضبط نموذج معتمد لتوليد المرشحين.', 409);
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    reply.header('cache-control', 'private, no-store');
    return control.start(user.id, request.body, key);
  });
  app.post<{ Params: { id: string } }>('/api/skills/forge/generations/:id/promote', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {});
    if (!enabled) throw new SkillError('SKILL_ENGINE_DISABLED', 'ترقية المهارات غير مفعّلة.', 403);
    const body = SkillForgePromoteSchema.parse(request.body), generation = await control.get(user.id, z.uuid().parse(request.params.id));
    if (generation.status !== 'succeeded' || !generation.candidateId) throw new SkillError('SKILL_FORGE_CANDIDATE_UNAVAILABLE', 'لا يوجد مرشح مكتمل قابل للمراجعة.', 409);
    reply.header('cache-control', 'private, no-store');
    // The shared lifecycle rechecks lineage, hashes, benchmark evidence and ownership atomically.
    return skills.activate(user.id, generation.candidateId, body);
  });
}
