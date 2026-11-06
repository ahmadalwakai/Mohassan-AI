import { z } from 'zod';
import { SkillContractSchema } from './skills';
import { SkillBenchmarkPinSchema } from './skill-benchmarks';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/).max(64);
export const SkillForgeRequestSchema = z.object({
  goal: z.string().trim().min(10).max(4000), baselineId: z.uuid(), baselineRevision: z.number().int().positive(),
  targetSlug: Slug.optional(), failureRunId: z.uuid().optional(), approve: z.literal(true),
}).strict();
/** Generated files are untrusted text. This schema never authorizes execution. */
export const SkillForgeGeneratedSchema = z.object({ contract: SkillContractSchema,
  files: z.array(z.object({ path: z.string().min(1).max(180), content: z.string().max(64000) }).strict()).min(1).max(40),
}).strict();
export const SkillForgeFailureAnalysisSchema = z.object({ runId: z.uuid(),
  issues: z.array(z.object({ nodeId: z.string().max(100), status: z.enum(['failed', 'unknown']), code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/).nullable() }).strict()).max(144),
  truncated: z.boolean(), evidenceOnly: z.literal(true),
}).strict();
export const SkillForgeGenerationSchema = z.object({
  id: z.uuid(), status: z.enum(['running', 'succeeded', 'failed', 'unknown']), mode: z.enum(['mutate', 'fork']), baseline: SkillBenchmarkPinSchema,
  targetSlug: Slug, targetVersion: z.string().max(32), targetFamilyId: z.uuid().nullable(), candidateId: z.uuid().nullable(), candidateContentHash: Hash.nullable(),
  requestHash: Hash, promptHash: Hash, responseHash: Hash.nullable(), model: z.string().min(1).max(100).nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(), retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).nullable(), failureAnalysis: SkillForgeFailureAnalysisSchema.nullable(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), automaticActivation: z.literal(false),
}).strict();
export const SkillForgeQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export const SkillForgePageSchema = z.object({ items: z.array(SkillForgeGenerationSchema).max(50), total: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50), offset: z.number().int().nonnegative() }).strict();
export const SkillForgePromoteSchema = z.object({ expectedRevision: z.number().int().positive(), evaluationId: z.uuid(), approve: z.literal(true), acknowledgeFindings: z.boolean().default(false) }).strict();
export const SkillForgeStatusSchema = z.object({ enabled: z.boolean(), modelConfigured: z.boolean(), executablePromotionAllowed: z.literal(false) }).strict();
export const SkillForgeAnalysisSchema = z.object({ generationId: z.uuid(), status: z.enum(['running', 'succeeded', 'failed', 'unknown']), errorCode: z.string().max(96).nullable(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict().nullable(),
  inspection: z.object({ verdict: z.enum(['pass', 'review', 'fail', 'incompatible']), current: z.boolean(), findingCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40) }).strict().nullable(),
  trainingFailures: z.array(z.object({ evaluationId: z.uuid(), caseId: z.string().max(64), status: z.enum(['failed', 'blocked', 'unknown']), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/).nullable() }).strict()).max(40),
  actions: z.array(z.enum(['review_generation_failure', 'inspect_candidate', 'review_inspection', 'run_benchmark', 'review_training_failure'])).max(5),
  truncated: z.boolean(), trainingOnly: z.literal(true), automaticActivation: z.literal(false),
}).strict();
export type SkillForgeRequest = z.infer<typeof SkillForgeRequestSchema>;
export type SkillForgeGenerated = z.infer<typeof SkillForgeGeneratedSchema>;
export type SkillForgeGeneration = z.infer<typeof SkillForgeGenerationSchema>;
export type SkillForgeFailureAnalysis = z.infer<typeof SkillForgeFailureAnalysisSchema>;
