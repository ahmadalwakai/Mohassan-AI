import { z } from 'zod';

export const MemoryLayerSchema=z.enum(['working','episodic','semantic','procedural','failure','preference']);
export type MemoryLayer=z.infer<typeof MemoryLayerSchema>;
const SafeText=z.string().trim().min(1).max(4000);
export const MemoryCreateSchema=z.object({title:z.string().trim().min(2).max(120),content:SafeText,layer:MemoryLayerSchema,taskId:z.string().min(1).max(100).optional(),evidenceIds:z.array(z.uuid()).max(8).default([]),expiresAt:z.iso.datetime().optional()}).strict();
export const MemoryCorrectionSchema=MemoryCreateSchema.omit({taskId:true}).extend({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(3).max(500)}).strict();
export const MemorySearchSchema=z.object({query:z.string().trim().max(500).default(''),layers:z.array(MemoryLayerSchema).max(6).optional(),limit:z.number().int().min(1).max(30).default(10),taskId:z.string().min(1).max(100).optional()}).strict();
export const MemoryMutationSchema=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(3).max(500)}).strict();
export const MemoryFeedbackSchema=z.object({taskId:z.string().min(1).max(100),kind:z.enum(['task_correction','preference','benchmark_evidence']),comment:SafeText,rating:z.number().int().min(1).max(5).optional(),persistPreference:z.boolean().default(false),submissionKey:z.string().min(8).max(100)}).strict().refine(value=>value.kind==='preference'||!value.persistPreference,'حفظ التفضيل متاح لنوع التفضيل فقط.');
export const MemoryProvenanceSchema=z.object({id:z.uuid(),kind:z.enum(['manual','task','task_result','task_error','feedback']),description:z.string(),taskId:z.string().nullable(),eventId:z.string().nullable(),contentHash:z.string(),observedAt:z.string(),expiresAt:z.string().nullable(),trust:z.enum(['manual','observed']),status:z.enum(['active','revoked'])});
export type MemoryProvenance=z.infer<typeof MemoryProvenanceSchema>;
export const MemoryItemSchema=z.object({id:z.uuid(),rootId:z.uuid(),version:z.number().int().positive(),title:z.string(),content:z.string(),layer:MemoryLayerSchema,status:z.enum(['active','superseded','revoked','expired']),confidence:z.number().min(0).max(1),confidenceKind:z.enum(['user_asserted','task_observed']),taskId:z.string().nullable(),expiresAt:z.string(),createdAt:z.string(),updatedAt:z.string(),provenance:z.array(MemoryProvenanceSchema)});
export type MemoryItem=z.infer<typeof MemoryItemSchema>;
export const ChecklistCategorySchema=z.enum(['diagnostic','plan','coding','research']);
export const ChecklistCheckSchema=z.enum(['scope','evidence','approval','verification','rollback']);
const RuleOutput=z.object({category:ChecklistCategorySchema,checks:z.array(ChecklistCheckSchema).min(1).max(5)}).strict();
export const DeclarativeSkillSchema=z.object({kind:z.literal('checklist-router'),rules:z.array(RuleOutput.extend({terms:z.array(z.string().trim().min(2).max(60)).min(1).max(10)}).strict()).min(1).max(12),fallback:RuleOutput}).strict();
export type DeclarativeSkill=z.infer<typeof DeclarativeSkillSchema>;
export const SkillCreateSchema=z.object({name:z.string().trim().min(3).max(100),description:z.string().trim().min(5).max(1000),manifest:DeclarativeSkillSchema,evidenceIds:z.array(z.uuid()).max(8).default([]),parentSkillId:z.uuid().optional()}).strict();
export const SkillActionSchema=z.object({expectedRevision:z.number().int().positive()}).strict();
export const SkillActivationSchema=SkillActionSchema.extend({evaluationId:z.uuid(),approve:z.literal(true)}).strict();
export const SkillRevokeSchema=SkillActionSchema.extend({reason:z.string().trim().min(3).max(500)}).strict();
export const SkillRunSchema=z.object({input:z.string().trim().min(3).max(1000)}).strict();
export const SkillEvaluationSchema=z.object({id:z.uuid(),kind:z.enum(['sandbox','benchmark']),suite:z.string(),manifestHash:z.string(),passed:z.boolean(),baselineScore:z.number(),candidateScore:z.number(),holdoutScore:z.number(),safetyScore:z.number(),regressions:z.number().int().nonnegative(),caseCount:z.number().int().positive(),durationMs:z.number().nonnegative(),results:z.array(z.object({caseId:z.string(),split:z.enum(['training','holdout']),passed:z.boolean(),categoryCorrect:z.boolean(),safetyCorrect:z.boolean()})),createdAt:z.string()});
export type SkillEvaluation=z.infer<typeof SkillEvaluationSchema>;
export const SkillSchema=z.object({id:z.uuid(),familyId:z.uuid(),version:z.number().int().positive(),revision:z.number().int().positive(),name:z.string(),description:z.string(),manifest:DeclarativeSkillSchema,manifestHash:z.string(),status:z.enum(['candidate','sandbox_tested','benchmarked','active','revoked']),activeVersionId:z.string().nullable(),createdAt:z.string(),updatedAt:z.string(),evidenceIds:z.array(z.string()),evaluations:z.array(SkillEvaluationSchema)});
export type MemorySkill=z.infer<typeof SkillSchema>;
export const MemoryWorkspaceSchema=z.object({items:z.array(MemoryItemSchema),skills:z.array(SkillSchema),feedback:z.array(z.object({id:z.string(),taskId:z.string(),kind:z.string(),comment:z.string(),rating:z.number().nullable(),persistedPreference:z.boolean(),createdAt:z.string()})),metrics:z.object({terminalTasks:z.number(),completed:z.number(),failed:z.number(),knownInputTokens:z.number(),knownOutputTokens:z.number(),unknownUsageRuns:z.number()}),method:z.literal('lexical-v1'),expiredCount:z.number()});
export type MemoryWorkspace=z.infer<typeof MemoryWorkspaceSchema>;

export const exampleSkill:DeclarativeSkill={kind:'checklist-router',rules:[
  {terms:['تشخيص','جاهزية','diagnostic','health'],category:'diagnostic',checks:['scope','evidence','verification']},
  {terms:['إصلاح','كود','برمجة','bug','code'],category:'coding',checks:['scope','approval','verification','rollback']},
  {terms:['بحث','مصادر','research','sources'],category:'research',checks:['scope','evidence','verification']},
],fallback:{category:'plan',checks:['scope','evidence','verification']}};
