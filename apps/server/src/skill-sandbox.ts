import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SkillSandboxDiagnosticSchema, SkillSandboxGateIdSchema, SkillSandboxReadinessSchema, type SkillSandboxReadiness } from '@mohassan/contracts';

export interface SkillSandboxRoutesOptions {
  owner(request: any): Promise<{ id: string }>;
  sandbox: {executableReadiness?: () => Promise<unknown>};
}

function unavailable(reason: string): SkillSandboxReadiness {
  return {
    provider: 'unavailable', enabled: false, baselineVerified: false,
    gates: SkillSandboxGateIdSchema.options.map(id => ({ id, name: id, required: true, status: 'blocked', reason, evidence: [] })),
  };
}

/** Reads the configured runner's diagnostic snapshot. Neither request data nor
 * a readiness report grants permission or starts executable skills. */
export async function registerSkillSandboxRoutes(app: FastifyInstance, { owner, sandbox }: SkillSandboxRoutesOptions) {
  app.get('/api/skills/sandbox', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    await owner(request);
    z.object({}).strict().parse(request.query ?? {});
    z.undefined().parse(request.body);
    let readiness = unavailable('لا يقدم مزود العزل تقرير جاهزية موثوقًا؛ جميع البوابات مغلقة.');
    if (typeof sandbox.executableReadiness === 'function') {
      try {
        const parsed = SkillSandboxReadinessSchema.safeParse(await sandbox.executableReadiness());
        readiness = parsed.success ? parsed.data : unavailable('تقرير بوابات العزل غير مكتمل أو غير صالح؛ التنفيذ محجوب.');
      } catch {
        readiness = unavailable('تعذر قراءة دليل بوابات العزل؛ التنفيذ محجوب.');
      }
    }
    reply.header('cache-control', 'private, no-store');
    return SkillSandboxDiagnosticSchema.parse({ readiness, executionAllowed: false });
  });
}
