import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SkillBenchmarkCatalogSchema, type SkillBenchmarkSuite } from '@mohassan/contracts';
import { SkillError, type createSkillBenchmarkControl } from '@mohassan/skills';

type Control = ReturnType<typeof createSkillBenchmarkControl>;
export async function registerSkillBenchmarkRoutes(app: FastifyInstance, { control, suites, enabled, owner }: {
  control: Control; suites: readonly SkillBenchmarkSuite[]; enabled: boolean; owner(request: any): Promise<{ id: string }>;
}) {
  const empty = z.object({}).strict();
  app.get('/api/skills/benchmarks/suites', async (request, reply) => {
    await owner(request); empty.parse(request.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return SkillBenchmarkCatalogSchema.parse({ enabled, suites: suites.map(suite => ({
      id: suite.id, scope: suite.scope, suiteHash: suite.suiteHash, configHash: suite.configHash,
      verifierVersion: suite.verifierVersion, independentHoldout: suite.independentHoldout,
      measuredScope: suite.measuredScope, limitations: suite.limitations,
      trainingCases: suite.cases.filter(item => item.split === 'training').length,
      holdoutCases: suite.cases.filter(item => item.split === 'holdout').length, caseCount: suite.cases.length,
    })) });
  });
  app.get('/api/skills/benchmarks', async (request, reply) => {
    const user = await owner(request);
    reply.header('cache-control', 'private, no-store');
    return control.list(user.id, request.query);
  });
  app.get<{ Params: { id: string } }>('/api/skills/benchmarks/:id', async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {});
    reply.header('cache-control', 'private, no-store');
    return control.get(user.id, z.uuid().parse(request.params.id));
  });
  app.post('/api/skills/benchmarks', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await owner(request); empty.parse(request.query ?? {});
    if (!enabled) throw new SkillError('SKILL_ENGINE_DISABLED', 'تشغيل تجارب المهارات غير مفعّل.', 403);
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    reply.header('cache-control', 'private, no-store');
    // The trusted controller validates IDs/revisions and supplies all measurements.
    // The client can request an experiment but cannot submit its evidence or score.
    return control.start(user.id, request.body, key);
  });
}
