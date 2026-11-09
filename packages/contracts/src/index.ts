import { z } from 'zod';
export * from './skill-sandbox';
export * from './skill-gaps';
export * from './skill-graph';
export * from './skill-quality';
export * from './skill-benchmarks';
export * from './skill-forge';
export * from './skill-run-gaps';
import { SkillRunInputSchema, SkillNodeBindingSchema, isBoundedSkillJson } from './skills';
export * from './command-chat';
export * from './skills';
export * from './google-ads';
export * from './ai-providers';
export { browserReadOrigins, detectBrowserOpenIntent, type BrowserOpenIntent } from './browser-intent';

export const TaskStatusSchema = z.enum(['queued', 'running', 'waiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'paused']);
export const AutonomySchema = z.enum(['assisted', 'scoped', 'shadow']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Autonomy = z.infer<typeof AutonomySchema>;
export const StudioTaskInputSchema=z.object({sessionId:z.uuid(),revision:z.string().regex(/^[a-f0-9]{64}$/),elementId:z.string().regex(/^n[0-9]+$/).optional(),imageId:z.uuid().optional()}).strict();
export type StudioTaskInput=z.infer<typeof StudioTaskInputSchema>;
// This is an input boundary; DNS, redirects and every request are checked again by the browser's network policy.
const BrowserPublicUrlSchema=z.string().trim().min(1).max(2500).transform((value,context)=>{
  try{
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||!host.includes('.')||host.startsWith('[')||/^\d+(?:\.\d+){3}$/.test(host)||host.endsWith('.')||['localhost','local','internal','lan','home','test','invalid','example','onion'].some(suffix=>host===suffix||host.endsWith(`.${suffix}`)))throw new Error('unsafe');
    return url.href;
  }catch{context.addIssue({code:'custom',message:'يلزم رابط HTTPS عام دون بيانات دخول أو عنوان داخلي.'});return z.NEVER;}
});
export const BrowserTaskInputSchema=z.object({url:BrowserPublicUrlSchema,allowedOrigins:z.array(BrowserPublicUrlSchema.transform((value,context)=>{const url=new URL(value);if(url.href!==`${url.origin}/`){context.addIssue({code:'custom',message:'حدد أصل الموقع دون مسار.'});return z.NEVER;}return url.origin;})).min(1).max(6).optional()}).strict().superRefine((input,context)=>{if(input.allowedOrigins&&(new Set(input.allowedOrigins).size!==input.allowedOrigins.length||!input.allowedOrigins.includes(new URL(input.url).origin)))context.addIssue({code:'custom',path:['allowedOrigins'],message:'يجب أن يتضمن النطاق أصل الرابط دون تكرار.'});});
export type BrowserTaskInput=z.infer<typeof BrowserTaskInputSchema>;
export const BrowserOpenResultSchema=z.object({kind:z.literal('browser_open'),outcome:z.literal('opened'),sessionId:z.uuid(),observationId:z.uuid(),url:BrowserPublicUrlSchema,title:z.string().max(1000),observedAt:z.iso.datetime(),documentStatus:z.number().int().min(100).max(599).optional(),summary:z.string().min(1).max(1600),screenshotAvailable:z.boolean(),screenshotUrl:z.string().regex(/^\/api\/browser\/tasks\/[a-f0-9-]{36}\/screenshot$/).nullable(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),screenshotHash:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict().superRefine((result,context)=>{if(result.screenshotAvailable!==(result.screenshotUrl!==null&&result.screenshotHash!==null)||!result.screenshotAvailable&&(result.screenshotUrl!==null||result.screenshotHash!==null))context.addIssue({code:'custom',path:['screenshotAvailable'],message:'دليل لقطة الصفحة غير مكتمل.'});});
export type BrowserOpenResult=z.infer<typeof BrowserOpenResultSchema>;
const SkillRollbackHash=z.string().regex(/^[a-f0-9]{64}$/);
export const SkillRollbackInputSchema=z.object({runId:z.uuid(),preimageId:z.uuid(),sourceReceiptId:z.uuid(),preimageHash:SkillRollbackHash,expectedAfterHash:SkillRollbackHash}).strict();
export type SkillRollbackInput=z.infer<typeof SkillRollbackInputSchema>;
export const SkillRollbackReviewSchema=z.object({root:z.string().min(1).max(1000),path:z.string().min(1).max(1000),beforeHash:SkillRollbackHash.nullable(),afterHash:SkillRollbackHash,deletedOnRestore:z.boolean(),bytes:z.number().int().min(0).max(65536)}).strict();
export type SkillRollbackReview=z.infer<typeof SkillRollbackReviewSchema>;
const CreateTaskBaseSchema = z.object({
  title: z.string().trim().min(3).max(120),
  goal: z.string().trim().min(5).max(4000),
  capabilityId: z.enum(['system.diagnostic', 'plan.draft', 'coding.change','studio.change','browser.open','skill.run','skill.rollback']),
  autonomy: AutonomySchema.default('assisted'),
  projectId:z.uuid().optional(),
  studioInput:StudioTaskInputSchema.optional(),
  browserInput:BrowserTaskInputSchema.optional(),
  skillInput:SkillRunInputSchema.optional(),
  skillRollbackInput:SkillRollbackInputSchema.optional(),
}).strict().superRefine((task,context)=>{if(task.capabilityId==='coding.change'&&!task.projectId)context.addIssue({code:'custom',path:['projectId'],message:'يلزم تحديد مشروع البرمجة.'});if(task.capabilityId!=='coding.change'&&task.projectId)context.addIssue({code:'custom',path:['projectId'],message:'المشروع خاص بمهمة البرمجة.'});if(task.capabilityId==='studio.change'&&!task.studioInput)context.addIssue({code:'custom',path:['studioInput'],message:'يلزم ربط الطلب بإصدار مشروع الاستوديو.'});if(task.capabilityId!=='studio.change'&&task.studioInput)context.addIssue({code:'custom',path:['studioInput'],message:'سياق الاستوديو خاص بتعديلاته.'});if(task.capabilityId==='browser.open'&&!task.browserInput)context.addIssue({code:'custom',path:['browserInput'],message:'يلزم تحديد رابط مهمة المتصفح.'});if(task.capabilityId!=='browser.open'&&task.browserInput)context.addIssue({code:'custom',path:['browserInput'],message:'نطاق المتصفح خاص بمهمة فتح الصفحة.'});});
export const CreateTaskSchema = CreateTaskBaseSchema.superRefine((task, context) => {
  if(task.capabilityId==='skill.rollback'&&(!task.skillRollbackInput||task.autonomy!=='assisted'))context.addIssue({code:'custom',path:['skillRollbackInput'],message:'استعادة الملف تحتاج مدخلات مثبتة وموافقة مستقلة.'});
  if(task.capabilityId!=='skill.rollback'&&task.skillRollbackInput)context.addIssue({code:'custom',path:['skillRollbackInput'],message:'مدخلات الاستعادة تخص مهمة الاستعادة فقط.'});
  if (task.capabilityId === 'skill.run' && !task.skillInput) context.addIssue({ code: 'custom', path: ['skillInput'], message: 'يلزم مخطط مهارات بمدخلات محددة.' });
  if (task.capabilityId !== 'skill.run' && task.skillInput) context.addIssue({ code: 'custom', path: ['skillInput'], message: 'مدخلات المهارات تخص تشغيل المهارات فقط.' });
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
/** Reviewable persisted node input; never accepted by the public task creation schema. */
export const SkillNodeInputSchema = z.record(z.string(),z.unknown()).refine(isBoundedSkillJson,'مدخلات الخطوة ليست JSON محدودة صالحة.');
export const TaskSchema = z.object({
  id: z.string(), ownerId: z.string(), title: z.string(), goal: z.string(), capabilityId: z.string(),
  status: TaskStatusSchema, autonomy: AutonomySchema,
  createdAt: z.string(), updatedAt: z.string(), attempt: z.number().int(), maxAttempts: z.number().int(),
  result: z.record(z.string(), z.unknown()).nullable(), error: z.string().nullable(), cancellationRequested: z.boolean(),
  projectId:z.string().nullable().optional(),
  studioInput:StudioTaskInputSchema.nullable().optional(),
  browserInput:BrowserTaskInputSchema.nullable().optional(),
  skillInput:SkillRunInputSchema.nullable().optional(),
  skillBinding:SkillNodeBindingSchema.nullable().optional(),
  skillNodeInput:SkillNodeInputSchema.nullable().optional(),
  skillRollbackInput:SkillRollbackInputSchema.nullable().optional(),
  skillRollbackReview:SkillRollbackReviewSchema.nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export const TaskEventSchema = z.object({
  id: z.string(), taskId: z.string(), sequence: z.number().int(), type: z.string(), message: z.string(),
  createdAt: z.string(), data: z.record(z.string(), z.unknown()),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export const CapabilitySchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), version: z.string(),
  risk: z.enum(['low', 'medium', 'high']), status: z.enum(['active', 'planned', 'needs_configuration']),
  requiredScopes: z.array(z.string()),
});
export type Capability = z.infer<typeof CapabilitySchema>;
export const IntegrationSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), status: z.enum(['connected', 'needs_configuration', 'planned']), detail: z.string(),
});
export type Integration = z.infer<typeof IntegrationSchema>;
export const AIStatusSchema = z.object({
  configured:z.boolean(),status:z.enum(['unconfigured','configured','verified','error']),
  model:z.string().nullable(),verifiedAt:z.string().nullable(),message:z.string(),
});
export type AIStatus=z.infer<typeof AIStatusSchema>;
export const SandboxStatusSchema=z.object({available:z.boolean(),provider:z.string().nullable(),message:z.string()});
export type SandboxStatus=z.infer<typeof SandboxStatusSchema>;
export const ProjectSchema=z.object({
  id:z.uuid(),ownerId:z.string(),name:z.string().min(2).max(100),path:z.string(),baseCommit:z.string(),
  allowedPaths:z.array(z.string()).min(1).max(5),testProfile:z.literal('node-test'),createdAt:z.string(),
});
export type Project=z.infer<typeof ProjectSchema>;
export const RegisterProjectSchema=z.object({name:z.string().trim().min(2).max(100),path:z.string().min(3).max(500),allowedPaths:z.array(z.string().min(1).max(180)).min(1).max(5)}).strict();
export const CodingWorkspaceSchema=z.object({projects:z.array(ProjectSchema),sandbox:SandboxStatusSchema});
export type CodingWorkspace=z.infer<typeof CodingWorkspaceSchema>;
export const WorkspaceSnapshotSchema = z.object({
  apiVersion: z.literal('1'), user: z.object({id: z.string(), name: z.string(), email: z.string()}),
  tasks: z.array(TaskSchema), capabilities: z.array(CapabilitySchema), integrations: z.array(IntegrationSchema),
  storage: z.object({mode: z.enum(['embedded', 'postgres']), healthy: z.boolean()}),
  ai: AIStatusSchema.optional(),
  coding:CodingWorkspaceSchema.optional(),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export const SetupSchema = z.object({name: z.string().trim().min(2).max(80), email: z.email(), password: z.string().min(12).max(128), setupToken: z.string().min(32).max(256)}).strict();
const Text = z.string().trim().min(1).max(1200);
const Id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/);
export const GoalDefinitionSchema=z.object({
  objective:Text,
  successCriteria:z.array(z.object({id:Id,description:Text,evidence:Text}).strict()).min(1).max(12),
  constraints:z.array(Text).max(12),assumptions:z.array(Text).max(12),clarifyingQuestions:z.array(Text).max(8),
}).strict();
export const RawPlanStepSchema=z.object({
  id:Id,title:z.string().trim().min(1).max(120),description:Text,
  dependsOn:z.array(Id).max(12),capabilityId:z.string().min(1).max(100).nullable(),
  requiredScopes:z.array(z.string().min(1).max(100)).max(8),requiresApproval:z.boolean(),
  acceptanceCriteria:z.array(Text).min(1).max(8),
}).strict();
export const PlanStepSchema=RawPlanStepSchema.extend({availability:z.enum(['available','unavailable','manual'])});
const PlanFields={
  summary:Text,goal:GoalDefinitionSchema,
  uncertainties:z.array(z.object({description:Text,impact:z.enum(['low','medium','high']),resolution:Text}).strict()).max(10),
  confidence:z.number().min(0).max(1),
};
export const RawCognitivePlanSchema=z.object({...PlanFields,steps:z.array(RawPlanStepSchema).min(1).max(12)}).strict();
export const CognitivePlanSchema=z.object({...PlanFields,steps:z.array(PlanStepSchema).min(1).max(12)}).strict();
export type RawCognitivePlan=z.infer<typeof RawCognitivePlanSchema>;
export type CognitivePlan=z.infer<typeof CognitivePlanSchema>;
export const PlanningResultSchema=z.object({
  kind:z.literal('plan'),summary:Text,plan:CognitivePlanSchema,
  executionBatches:z.array(z.array(Id).min(1)).min(1).max(12),needsClarification:z.boolean(),
  model:z.string().min(1).max(100),provider:z.literal('groq'),routeReason:Text,
  usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}).strict(),
  generatedAt:z.iso.datetime(),verifiedAt:z.iso.datetime(),
  verification:z.object({passed:z.literal(true),scope:z.literal('structure_and_policy'),checks:z.array(Text).min(1).max(12)}).strict(),
  executionAllowed:z.literal(false),
}).strict();
export type PlanningResult=z.infer<typeof PlanningResultSchema>;
export const SandboxTestResultSchema=z.object({
  exitCode:z.number().int().nullable(),stdout:z.string().max(65536),stderr:z.string().max(65536),timedOut:z.boolean(),durationMs:z.number().nonnegative(),
  provider:z.string(),network:z.literal('denied'),isolation:z.enum(['appcontainer','microvm']),isolationVerified:z.boolean(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),
});
export type SandboxTestResult=z.infer<typeof SandboxTestResultSchema>;
export const RawCodingEditsSchema=z.object({summary:z.string().min(1).max(1200),edits:z.array(z.object({path:z.string().min(1).max(180),expectedHash:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().max(64000)}).strict()).min(1).max(5)}).strict();
export const CodingProposalSchema=z.object({summary:RawCodingEditsSchema.shape.summary,edits:z.array(RawCodingEditsSchema.shape.edits.element.omit({expectedHash:true})).min(1).max(5)}).strict();
export const CodingEditsSchema=RawCodingEditsSchema.extend({model:z.string(),usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()})});
export type CodingEdits=z.infer<typeof CodingEditsSchema>;
export const CodingResultSchema=z.object({
  kind:z.literal('coding'),summary:z.string().min(1).max(1600),projectId:z.string(),baseCommit:z.string(),branch:z.string(),checkpoint:z.string().nullable(),worktreeRetained:z.boolean(),
  diff:z.string().max(131072),diffHash:z.string().regex(/^[a-f0-9]{64}$/),changes:z.array(z.object({path:z.string(),beforeHash:z.string(),afterHash:z.string()})).max(5),
  baselineTests:SandboxTestResultSchema.nullable(),tests:SandboxTestResultSchema,
  review:z.object({passed:z.boolean(),checks:z.array(z.object({id:z.string(),passed:z.boolean(),message:z.string()})).min(1).max(20)}),
  outcome:z.enum(['ready_for_review','tests_failed','review_failed']),model:z.string(),usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}),
  sourceUnchanged:z.boolean(),merged:z.literal(false),verifiedAt:z.iso.datetime(),
});
export type CodingResult=z.infer<typeof CodingResultSchema>;
export const PlannedStepRecordSchema=z.object({
  id:z.string(),taskId:z.string(),stepId:z.string(),title:z.string(),dependsOn:z.array(z.string()),
  status:z.literal('planned'),capabilityId:z.string().nullable(),availability:z.enum(['available','unavailable','manual']),
  description:z.string().optional(),requiredScopes:z.array(z.string()).optional(),requiresApproval:z.boolean().optional(),
});
export const ModelRunSchema=z.object({
  id:z.string(),taskId:z.string(),attempt:z.number().int(),status:z.enum(['started','succeeded','failed','unknown']),
  model:z.string().nullable(),inputTokens:z.number().int().nullable(),outputTokens:z.number().int().nullable(),
  startedAt:z.string(),finishedAt:z.string().nullable(),resultCommitted:z.boolean(),
  provider:z.string().min(1).max(100).optional(),usageKnown:z.boolean().optional(),
});
export type PlannedStepRecord=z.infer<typeof PlannedStepRecordSchema>;
export type ModelRun=z.infer<typeof ModelRunSchema>;
export const TaskDetailSchema = z.object({task: TaskSchema, events: z.array(TaskEventSchema),steps:z.array(PlannedStepRecordSchema).optional(),modelRuns:z.array(ModelRunSchema).optional()});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

// Static Visual Studio: these contracts grant edits to a private review copy only.
export const StudioFileSchema = z.object({path:z.string().min(1).max(180),content:z.string().max(64000)}).strict();
export const StudioFrameworkSchema = z.enum(['static','react','next']);
export const StudioSnapshotSchema = z.object({framework:StudioFrameworkSchema.optional(),entryPath:z.string().min(1).max(180),files:z.array(StudioFileSchema).min(1).max(40)}).strict();
export type StudioSnapshot = z.infer<typeof StudioSnapshotSchema>;
export const StudioCreateSchema = z.object({name:z.string().trim().min(3).max(100),path:z.string().min(1).max(1000),framework:StudioFrameworkSchema.default('static'),entryPath:z.string().min(1).max(180).optional()}).strict();
const StudioStylesSchema = z.object({color:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),backgroundColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),fontSize:z.number().int().min(8).max(96).optional()}).strict();
export const StudioEditSchema = z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),elementId:z.string().regex(/^n[0-9]+$/),text:z.string().max(4000).optional(),styles:StudioStylesSchema.optional()}).strict().refine(value=>value.text!==undefined || value.styles!==undefined && Object.keys(value.styles).length>0,'اختر تعديلًا لحفظه.');
export type StudioEdit = z.infer<typeof StudioEditSchema>;
export const StudioElementSchema = z.object({id:z.string(),tag:z.string(),file:z.string(),line:z.number().int().positive(),text:z.string().nullable(),styles:z.object({color:z.string(),backgroundColor:z.string(),fontSize:z.string()}),editableText:z.boolean(),editableStyles:z.boolean().optional()}).strict();
export type StudioElement = z.infer<typeof StudioElementSchema>;
export const StudioSessionSummarySchema = z.object({id:z.uuid(),name:z.string(),sourcePath:z.string().nullable(),revision:z.string().regex(/^[a-f0-9]{64}$/),framework:StudioFrameworkSchema.default('static'),entryPath:z.string(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),historyCount:z.number().int().min(0).max(20)}).strict();
export const StudioSessionSchema = StudioSessionSummarySchema.extend({files:z.array(StudioFileSchema).min(1).max(40),baseFiles:z.array(StudioFileSchema).min(1).max(40)}).strict();
export type StudioSession = z.infer<typeof StudioSessionSchema>;
export type StudioSessionSummary = z.infer<typeof StudioSessionSummarySchema>;
export const StudioWorkspaceSchema = z.object({sessions:z.array(StudioSessionSummarySchema).max(20)}).strict();
export type StudioWorkspace = z.infer<typeof StudioWorkspaceSchema>;
export const StudioVerificationSchema = z.object({provider:z.string().min(1).max(100),sourceHash:z.string().regex(/^[a-f0-9]{64}$/),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),network:z.literal('denied'),isolation:z.enum(['appcontainer','microvm']),isolationVerified:z.literal(true),durationMs:z.number().nonnegative()}).strict();
export const StudioPreviewSchema = z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),nonce:z.string().min(16).max(128),document:z.string().max(500000),elements:z.array(StudioElementSchema).max(2000),warnings:z.array(z.string()).max(100),verification:StudioVerificationSchema.optional()}).strict();
export type StudioPreview = z.infer<typeof StudioPreviewSchema>;
export const StudioSelectionMessageSchema = z.object({type:z.literal('mohassan:studio:select'),nonce:z.string().min(16).max(128),revision:z.string().regex(/^[a-f0-9]{64}$/),elementId:z.string().regex(/^n[0-9]+$/),styles:z.object({color:z.string().max(64),backgroundColor:z.string().max(64),fontSize:z.string().max(64)}).strict().optional()}).strict();

export const StudioChangeEditsSchema=z.object({summary:z.string().min(1).max(1600),edits:z.array(z.object({path:z.string().min(1).max(180),content:z.string().max(64000)}).strict()).min(1).max(5)}).strict();
export const StudioChangeResultSchema=z.object({kind:z.literal('studio_change'),summary:z.string().min(1).max(1600),sessionId:z.uuid(),proposalId:z.uuid(),baseRevision:z.string().regex(/^[a-f0-9]{64}$/),diff:z.string().max(131072),diffHash:z.string().regex(/^[a-f0-9]{64}$/),branch:z.string().max(140),checkpoint:z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),changes:z.array(z.object({path:z.string(),beforeHash:z.string(),afterHash:z.string()})).max(5),review:z.object({passed:z.boolean(),checks:z.array(z.object({id:z.string(),passed:z.boolean(),message:z.string()})).min(1).max(20)}),outcome:z.enum(['ready_for_review','tests_failed','review_failed']),verification:z.object({passed:z.boolean(),provider:z.string().min(1).max(100),sourceHash:z.string().regex(/^[a-f0-9]{64}$/)}),baselineImageId:z.uuid().nullable(),candidateImageId:z.uuid().nullable(),visualDiff:z.object({changedPixels:z.number().int().nonnegative(),totalPixels:z.number().int().positive(),ratio:z.number().min(0).max(1)}).nullable(),model:z.string(),usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}),applied:z.literal(false),verifiedAt:z.iso.datetime()}).strict();
export type StudioChangeResult=z.infer<typeof StudioChangeResultSchema>;
