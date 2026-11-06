import { z } from 'zod';
import { SkillToolIdSchema } from './skills';

export const SkillGapCategorySchema = z.enum(['missing_skill', 'missing_tool', 'missing_permission', 'model_limitation', 'invalid_plan', 'stale_data', 'environment_failure', 'sandbox_restriction']);
export const SkillGapSignalSchema = z.object({
  source: z.enum(['planner', 'tool', 'model', 'environment', 'workflow']),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,95}$/),
  tool: SkillToolIdSchema.optional(), taskId: z.uuid().optional(), skillVersionId: z.uuid().optional(),
}).strict();
export type SkillGapSignal = z.infer<typeof SkillGapSignalSchema>;
export const SkillGapOutcomeSchema = z.enum(['partial', 'blocked', 'failed']);
export const SkillGapObservationSchema = z.object({ ownerId: z.string().min(1).max(200), chatRunId: z.uuid(), outcome: SkillGapOutcomeSchema, signal: SkillGapSignalSchema.nullable() }).strict();
export type SkillGapObservation = z.infer<typeof SkillGapObservationSchema>;
export const SkillGapActionSchema = z.object({
  kind: z.enum(['review_skill_library', 'configure_tool', 'review_permission', 'simplify_task', 'revise_plan', 'refresh_data', 'review_environment', 'review_sandbox', 'inspect_evidence']),
  label: z.string().min(1).max(240), automatic: z.literal(false), requiresApproval: z.boolean(),
}).strict();
export const SkillGapClassificationSchema = z.object({ category: SkillGapCategorySchema.nullable(), reason: z.string().min(1).max(96), signal: SkillGapSignalSchema.nullable(), action: SkillGapActionSchema }).strict();
export type SkillGapClassification = z.infer<typeof SkillGapClassificationSchema>;
export const SkillGapSchema = SkillGapClassificationSchema.extend({ id: z.uuid(), chatRunId: z.uuid(), outcome: SkillGapOutcomeSchema, createdAt: z.iso.datetime() }).strict();
export const SkillGapQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0), category: SkillGapCategorySchema.optional() }).strict();
export const SkillGapPageSchema = z.object({ items: z.array(SkillGapSchema).max(50), total: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50), offset: z.number().int().nonnegative() }).strict();
