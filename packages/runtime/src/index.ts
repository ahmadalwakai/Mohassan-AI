import { createHash, randomUUID } from "node:crypto";
import { Kysely, sql, type Selectable, type Transaction } from "kysely";
import { z } from "zod";
import {
  CreateTaskSchema,
  BrowserTaskInputSchema,BrowserOpenResultSchema,detectBrowserOpenIntent,type BrowserTaskInput,type BrowserOpenResult,
  type Capability,
  type CreateTaskInput,
  type Task,
  type TaskDetail,
  type TaskEvent,
  type PlanningResult,
  CodingResultSchema,type CodingResult,StudioTaskInputSchema,StudioChangeResultSchema,type StudioTaskInput,type StudioChangeResult,
  SkillRunInputSchema, SkillNodeBindingSchema, SkillNodeInputSchema, TOOL_SIDE_EFFECTS, type SkillRunInput, type SkillNodeBinding, type SkillToolId,
  SkillRollbackInputSchema,SkillRollbackReviewSchema,type SkillRollbackInput,type SkillRollbackReview,
} from "@mohassan/contracts";
import { verifyPlanningResult } from "@mohassan/cognitive";
import { recordExperience, type ExperienceInput } from "@mohassan/learning";
import type { RuntimeDatabase, TaskRecord, TaskEventRecord } from "@mohassan/database";

type TaskRow = Selectable<TaskRecord>;
type Tx = Transaction<RuntimeDatabase>;

export type SkillWorkflowAuthority = Pick<TaskRow,'id'|'owner_id'|'capability_id'|'capability_version'|'status'|'input_hash'|'workflow_token'|'cancellation_requested'>;
/** Shared read-only workflow policy. The caller owns any required parent lock;
 * this helper never locks a parent, child, run, node or approval row. */
export async function hasActiveSkillWorkflowApproval(tx:Kysely<any>,parent:SkillWorkflowAuthority|null|undefined):Promise<boolean>{
  if(!parent||parent.capability_id!=='skill.run'||!parent.workflow_token||parent.cancellation_requested||!['running','paused','queued','verifying'].includes(parent.status))return false;
  const approval=await tx.selectFrom('approvals').select('id').where('task_id','=',parent.id).where('owner_id','=',parent.owner_id)
    .where('capability_id','=','skill.run').where('capability_version','=',parent.capability_version).where('input_hash','=',parent.input_hash)
    .where('scope','=',`skill.run:${parent.input_hash}`).where('consumed_lease_token','=',parent.workflow_token).where('consumed_at','is not',null)
    .where('revoked_at','is',null).where('expires_at','>',sql<Date>`CURRENT_TIMESTAMP`).executeTakeFirst();
  return Boolean(approval);
}

export class DomainError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const capabilities: readonly Capability[] = Object.freeze([
  {id:'skill.rollback',name:'استعادة ملف موثقة',version:'1.0.0',risk:'high',status:'needs_configuration',description:'إعادة ملف إلى صورته السابقة بعد موافقة مستقلة وفحص البصمة والصلاحيات الحالية.',requiredScopes:['file:write']},
  {
    id: 'skill.run', name: 'تشغيل مخطط مهارات', version: '1.0.0', risk: 'high', status: 'needs_configuration',
    description: 'تشغيل مخطط مثبت عبر مهام فرعية مستقلة، مع موافقاتها والتحقق من أدلتها دون منح صلاحيات تلقائية.', requiredScopes: ['skill:run'],
  },
  {
    id: "system.diagnostic", name: "تشخيص مساحة العمل", version: "1.0.0", risk: "low", status: "active",
    description: "فحص الاتصال بالتخزين وسجل القدرات، ثم التحقق من الأدلة دون تغيير ملفاتك.",
    requiredScopes: ["diagnostic:read"],
  },
  {
    id: "plan.draft", name: "تخطيط ذكي", version: "1.0.0", risk: "medium", status: "needs_configuration",
    description: "إرسال الهدف إلى النموذج لإنتاج خطة نصية موثقة؛ قد يستهلك توكنات ولا ينفذ خطوات الخطة.", requiredScopes: ["model:generate"],
  },
  {
    id: "coding.change", name: "محرك البرمجة المعزول", version: "1.0.0", risk: "high", status: "needs_configuration",
    description: "تعديل ملفات مصرح بها داخل Git Worktree، واختبارها في عزل نظامي، ثم إعداد التغييرات للمراجعة دون دمج.", requiredScopes: ["code:read", "code:write", "code:run", "model:generate"],
  },
  {
    id:"studio.change",name:"تعديل الاستوديو بالذكاء",version:"1.0.0",risk:"high",status:"needs_configuration",description:"طلب تعديل نصي أو من صورة بعد موافقة محددة، مع فرع واختبار ومعاينة ومراجعة قبل تطبيق منفصل.",requiredScopes:["code:read","code:write","code:run","model:generate"],
  },
  {
    id: "studio.visual", name: "استوديو التطوير البصري", version: "0.1.0", risk: "high", status: "planned",
    description: "معاينة المشاريع واختيار العناصر ومراجعة تغييراتها من واجهة الاستوديو عند توصيل وحدتها.", requiredScopes: ["code:write"],
  },
  {
    id: 'browser.open',name:'فتح موقع في المتصفح',version:'1.0.0',risk:'low',status:'needs_configuration',description:'فتح رابط HTTPS محدد في جلسة مستقلة للقراءة فقط، ثم حفظ الصفحة ولقطتها والتحقق من أدلتهما دون إرسال نماذج.',requiredScopes:['browser:read'],
  },
  {
    id: "browser.research", name: "المتصفح والبحث", version: "0.1.0", risk: "medium", status: "planned",
    description: "بحث بمراجع وجلسات متصفح منفصلة من واجهتها، مع موافقات محددة للإجراءات الحساسة.", requiredScopes: ["browser:read"],
  },
  {
    id: "memory.skills", name: "الذاكرة والمهارات", version: "0.1.0", risk: "medium", status: "planned",
    description: "ذاكرة بمصادر ومدة صلاحية وتصحيحات، ومهارات تُختبر وتُقاس قبل الموافقة على تفعيلها.", requiredScopes: ["memory:write"],
  },
  {
    id: "device.remote", name: "التحكم بالكمبيوتر", version: "0.1.0", risk: "high", status: "planned",
    description: "واجهة جهاز Windows ومشغّل محلي؛ يلزم ربط جهاز موثوق ومنح مشاهدة أو تحكم محدود المدة.", requiredScopes: ["device:view", "device:control"],
  },
  {
    id: "ads.audit", name: "خبير Google Ads", version: "0.1.0", risk: "high", status: "needs_configuration",
    description: "قراءة أداء الحساب وفحص المسودات عبر Google Ads API. يعمل من قسم Google Ads بعد ربط الحساب، والنشر بموافقة المالك.", requiredScopes: ["ads:read"],
  },
]);

/** Module presence alone never grants Runtime dispatch; browser.open also requires execution and verification callbacks. */
export interface CapabilityModules {studioVisual?:boolean;browser?:boolean;memory?:boolean;windows?:boolean}
export function createCapabilities(planningConfigured = false,codingConfigured=false,studioConfigured=false,modules:CapabilityModules={},browserConfigured=false,skillConfigured=false,rollbackConfigured=false): Capability[] {
  return capabilities.map((capability) => ({
    ...capability, requiredScopes: [...capability.requiredScopes],
    ...(capability.id === 'skill.run' && skillConfigured ? { status: 'active' as const } : {}),
    ...(capability.id === 'skill.rollback' && rollbackConfigured ? { status: 'active' as const } : {}),
    ...(capability.id === "plan.draft" && planningConfigured ? { status: "active" as const } : {}),
    ...(capability.id === "coding.change" && codingConfigured ? { status: "active" as const } : {}),
    ...(capability.id === "studio.change" && studioConfigured ? {status:"active" as const}:{}),
    ...(capability.id === 'browser.open' && modules.browser && browserConfigured ? {status:'active' as const}:{}),
    ...(capability.id === "studio.visual" && modules.studioVisual ? {status:"active" as const,description:"معاينة المشاريع واختيار عناصرها وتعديل نسخة المراجعة من واجهة الاستوديو؛ طلب الذكاء يستخدم مهمة وموافقة مستقلتين."}:{}),
    ...(capability.id === "browser.research" && modules.browser ? {status:"active" as const,description:"بحث موثق وجلسات متصفح معزولة متاحة من واجهة المتصفح؛ الإرسال والتغييرات يتطلبان موافقاتهما المحددة."}:{}),
    ...(capability.id === "memory.skills" && modules.memory ? {status:"active" as const,description:"استرجاع ذاكرة مرتبطة بالمصدر والصلاحية، وتصحيح خبرات ومهارات مقاسة بموافقة صريحة عبر واجهة الذاكرة."}:{}),
    ...(capability.id === "device.remote" && modules.windows ? {status:"needs_configuration" as const,description:"وحدة Windows متصلة بالتطبيق؛ لبدء المشاهدة أو التحكم اربط جهازك وامنح صلاحية محددة المدة من واجهته."}:{}),
  }));
}

const checkNames = ["database", "capability_registry", "permission_scope"] as const;
const DiagnosticSchema = z.object({
  kind: z.literal("diagnostic"),
  summary: z.string().min(1),
  observedAt: z.iso.datetime(),
  checks: z.array(z.object({
    name: z.enum(checkNames),
    passed: z.boolean(),
    evidence: z.string().min(1).max(500),
  }).strict()).length(3),
}).strict();
export type DiagnosticResult = z.infer<typeof DiagnosticSchema>;

const ShadowSchema = z.object({
  kind: z.literal("shadow"),
  summary: z.string(),
  executed: z.literal(false),
  proposedChecks: z.array(z.enum(checkNames)).length(3),
}).strict();

const PlanningShadowSchema = z.object({
  kind: z.literal("shadow"), capabilityId: z.literal("plan.draft"),
  summary: z.string(), executed: z.literal(false),
  proposedStages: z.array(z.string()).min(1),
}).strict();

export interface SkillChildSpec {
  binding: SkillNodeBinding;
  input: Record<string, unknown>;
  idempotencyKey: string;
  title?: string;
  attempt?: number;
}
export interface SkillExecutionContext {
  ownerId: string; taskId: string; leaseToken: string; signal: AbortSignal;
  assertActive: () => Promise<void>;
}
export interface VerificationRecoveryContext { verificationOnly?:true; receiptLeaseToken?:string; leaseToken?:string; assertActive?:()=>Promise<void> }
/** The recovery flag is an internal request to read evidence, never authority by itself. */
export async function verifyRecoveryAuthority(db:Kysely<any>,context:VerificationRecoveryContext&{taskId:string;ownerId:string}):Promise<boolean>{
  if(!context.verificationOnly)return true;
  if(!context.assertActive||!context.leaseToken||!context.receiptLeaseToken)return false;
  const row=await db.selectFrom('tasks').select(['verification_only','verification_source_lease','lease_token','lease_expires_at','status','cancellation_requested']).where('id','=',context.taskId).where('owner_id','=',context.ownerId).where('lease_expires_at','>',sql<Date>`CURRENT_TIMESTAMP`).executeTakeFirst();
  if(!row?.verification_only||row.verification_source_lease!==context.receiptLeaseToken||row.lease_token!==context.leaseToken||row.status!=='verifying'||row.cancellation_requested)return false;
  await context.assertActive();return true;
}
export interface SkillNodeExecutionContext extends SkillExecutionContext { binding: SkillNodeBinding; verificationOnly?: true; receiptLeaseToken?: string }
export type SkillRecovery = {kind:'confirmed';result:Record<string,unknown>;receiptLeaseToken:string}|{kind:'unknown';code?:string};
export type SkillAdvanceResult = { kind: 'pending'; runId: string; childTaskIds: string[] } | { kind: 'complete'; runId: string; result: Record<string, unknown> };
export interface SkillRuntimeOptions {
  advance: (input: SkillRunInput, context: SkillExecutionContext & { workflowToken: string; dispatchChild: (tx: Kysely<any>, spec: SkillChildSpec) => Promise<{ id: string }> }) => Promise<SkillAdvanceResult>;
  verify: (raw: unknown, context: SkillExecutionContext) => Promise<Record<string, unknown> | null>;
  wakeCandidates: () => Promise<Array<{ ownerId: string; parentTaskId: string }>>;
  cancelRun: (tx: Kysely<any>, ownerId: string, parentTaskId: string) => Promise<void>;
  mapChild: (tool: SkillToolId, input: Record<string, unknown>) => CreateTaskInput | null;
  /** Read-only: callers may already hold the child task lock. Never acquire parent/run locks here. */
  validateBinding: (tx: Kysely<any>, context: { taskId: string; ownerId: string; binding: SkillNodeBinding }) => Promise<boolean>;
  executeNode: (context: SkillNodeExecutionContext) => Promise<unknown>;
  verifyNode: (raw: unknown, context: SkillNodeExecutionContext) => Promise<Record<string, unknown> | null>;
  beforeMappedExecute?: (context: SkillNodeExecutionContext) => Promise<void>;
  recordChildResult?: (raw: Record<string, unknown>, context: SkillNodeExecutionContext) => Promise<void>;
  recordChildFailure?: (error: unknown, context: SkillNodeExecutionContext) => Promise<void>;
  /** Read-only; caller holds the child lock. Never acquire parent/run/node locks here. */
  recoverNode?: (tx:Kysely<any>,context:{ownerId:string;taskId:string;binding:SkillNodeBinding;leaseToken:string})=>Promise<SkillRecovery>;
  verifyRecoveredNode?: (raw:unknown,context:SkillNodeExecutionContext)=>Promise<Record<string,unknown>|null>;
}
export interface SkillRollbackOptions {
  /** Read-only, and must use tx when supplied to avoid nested transactions. */
  prepare:(ownerId:string,input:SkillRollbackInput,tx?:Kysely<any>)=>Promise<{input:SkillRollbackInput;title:string;goal:string;review:SkillRollbackReview}>;
  execute:(input:SkillRollbackInput,context:SkillExecutionContext)=>Promise<unknown>;
  verify:(raw:unknown,input:SkillRollbackInput,context:SkillExecutionContext)=>Promise<Record<string,unknown>|null>;
  recoverExpired?:()=>Promise<unknown>;
}
export interface RuntimeOptions {
  skillRuntime?: SkillRuntimeOptions;
  /** Cancellation remains available when skill execution is disabled. Grants no dispatch capability. */
  cancelSkillRun?: SkillRuntimeOptions['cancelRun'];
  /** Metadata maintenance only; exposing it never enables skill.rollback. */
  recoverSkillRollbacks?:()=>Promise<unknown>;
  rollback?: SkillRollbackOptions;
  moduleAvailability?:CapabilityModules;
  onTaskSettled?:(ownerId:string,taskId:string)=>Promise<void>;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Dependency injection for testing tool failures; never accepted from an API request. */
  executeDiagnostic?: (signal: AbortSignal) => Promise<unknown>;
  plan?: (goal: string, context: {
    signal: AbortSignal;
    taskId: string;
    leaseToken: string;
    onProgress?: (stage: string, message: string) => Promise<void>;
  }) => Promise<PlanningResult>;
  code?: (goal:string,context:{signal:AbortSignal;taskId:string;ownerId:string;projectId:string;leaseToken:string;onProgress?:(stage:string,message:string)=>Promise<void>;onModelReceipt?:(receipt:{model:string;usage:{inputTokens:number;outputTokens:number}})=>Promise<void>})=>Promise<CodingResult>;
  verifyCode?: (raw:unknown,context:{taskId:string;ownerId:string;projectId:string;signal:AbortSignal}&VerificationRecoveryContext)=>Promise<CodingResult|null>;
  studioChange?:(goal:string,context:{signal:AbortSignal;taskId:string;ownerId:string;studioInput:StudioTaskInput;leaseToken:string;onProgress?:(stage:string,message:string)=>Promise<void>;onModelReceipt?:(receipt:{model:string;usage:{inputTokens:number;outputTokens:number}})=>Promise<void>})=>Promise<StudioChangeResult>;
  verifyStudioChange?:(raw:unknown,context:{taskId:string;ownerId:string;studioInput:StudioTaskInput;signal:AbortSignal}&VerificationRecoveryContext)=>Promise<StudioChangeResult|null>;
  openBrowser?:(goal:string,context:{signal:AbortSignal;taskId:string;ownerId:string;browserInput:BrowserTaskInput;leaseToken:string;onProgress?:(stage:string,message:string)=>Promise<void>})=>Promise<BrowserOpenResult>;
  verifyBrowser?:(raw:unknown,context:{taskId:string;ownerId:string;browserInput:BrowserTaskInput;signal:AbortSignal}&VerificationRecoveryContext)=>Promise<BrowserOpenResult|null>;
  onError?: (error: unknown) => void;
}

function iso(value: Date | string): string { return new Date(value).toISOString(); }

type TaskDtoRow=Pick<TaskRow,'id'|'owner_id'|'title'|'goal'|'capability_id'|'status'|'autonomy'|'created_at'|'updated_at'|'attempt'|'max_attempts'|'result'|'error'|'cancellation_requested'|'project_id'|'studio_input'|'browser_input'|'skill_input'|'skill_binding'|'skill_node_input'|'skill_rollback_input'|'skill_rollback_review'>;
function taskDto(row: TaskDtoRow): Task {
  return {
    id: row.id, ownerId: row.owner_id, title: row.title, goal: row.goal,
    capabilityId: row.capability_id, status: row.status, autonomy: row.autonomy,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    attempt: row.attempt, maxAttempts: row.max_attempts,
    result: row.result, error: row.error, cancellationRequested: row.cancellation_requested,
    projectId:row.project_id??null,studioInput:row.studio_input?StudioTaskInputSchema.parse(row.studio_input):null,
    browserInput:row.browser_input?BrowserTaskInputSchema.parse(row.browser_input):null,
    skillInput:row.skill_input?SkillRunInputSchema.parse(row.skill_input):null,
    skillBinding:row.skill_binding?SkillNodeBindingSchema.parse(row.skill_binding):null,
    skillNodeInput:row.skill_node_input?SkillNodeInputSchema.parse(row.skill_node_input):null,
    skillRollbackInput:row.skill_rollback_input?SkillRollbackInputSchema.parse(row.skill_rollback_input):null,
    skillRollbackReview:row.skill_rollback_review?SkillRollbackReviewSchema.parse(row.skill_rollback_review):null,
  };
}

function eventDto(row: Selectable<TaskEventRecord>): TaskEvent {
  return {
    id: row.id, taskId: row.task_id, sequence: row.sequence, type: row.type,
    message: row.message, createdAt: iso(row.created_at), data: row.data,
  };
}

type TaskCreationInput = Omit<CreateTaskInput, 'capabilityId'> & { capabilityId: CreateTaskInput['capabilityId'] | 'skill.node'; skillNodeInput?: Record<string,unknown>; skillRollbackReview?:SkillRollbackReview };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string,unknown>)[key])])) : value;
function hashInput(input: TaskCreationInput, binding?: SkillNodeBinding): string {
  return createHash("sha256").update(JSON.stringify({
    title: input.title, goal: input.goal, capabilityId: input.capabilityId, autonomy: input.autonomy,
    ...(input.projectId?{projectId:input.projectId}:{}),...(input.studioInput?{studioInput:input.studioInput}:{}),
    ...(input.browserInput?{browserInput:input.browserInput}:{}),
    ...(input.skillInput?{skillInput:canonical(input.skillInput)}:{}),
    ...(binding?{skillBinding:canonical(binding)}:{}),
    ...(input.skillNodeInput?{skillNodeInput:canonical(input.skillNodeInput)}:{}),
    ...(input.skillRollbackInput?{skillRollbackInput:canonical(input.skillRollbackInput),skillRollbackReview:canonical(input.skillRollbackReview)}:{}),
  })).digest("hex");
}

async function event(tx: Tx, taskId: string, type: string, message: string, data: Record<string, unknown> = {}) {
  const row = await tx.updateTable("tasks").set({ event_sequence: sql`event_sequence + 1` })
    .where("id", "=", taskId).returning("event_sequence").executeTakeFirstOrThrow();
  await tx.insertInto("task_events").values({
    id: randomUUID(), task_id: taskId, sequence: row.event_sequence,
    type, message, data: JSON.stringify(data),
  }).execute();
}

const notFound = () => new DomainError(404, "TASK_NOT_FOUND", "لم يُعثر على المهمة.");
const isTerminal = (status: Task["status"]) => ["completed", "failed", "cancelled"].includes(status);

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class Runtime {
  private readonly db: Kysely<RuntimeDatabase>;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly workerId: string;
  private readonly registry: Capability[];
  private readonly planningLeaseMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<Task | null> | null = null;
  private readonly controllers = new Map<string, AbortController>();

  constructor(db: Kysely<any>, private readonly options: RuntimeOptions = {}) {
    this.db = db;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
    this.pollMs = Math.max(20, options.pollMs ?? 750);
    this.maxAttempts = Math.max(1, Math.min(10, options.maxAttempts ?? 3));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
    this.workerId = options.workerId ?? randomUUID();
    // The local model needs up to 300 s per plan (measured 218 s on the owner's PC); keep a margin.
    this.planningLeaseMs = Math.max(1_000, options.leaseMs ?? 360_000);
    this.registry = createCapabilities(Boolean(options.plan),Boolean(options.code&&options.verifyCode),Boolean(options.studioChange&&options.verifyStudioChange),options.moduleAvailability,Boolean(options.openBrowser&&options.verifyBrowser),Boolean(options.skillRuntime),Boolean(options.rollback));
    if(options.skillRuntime)this.registry.push({id:'skill.node',name:'خطوة مهارة داخلية',version:'1.0.0',risk:'high',status:'active',description:'تنفيذ خطوة مثبتة في مخطط مصرح به.',requiredScopes:['skill:node']});
  }

  getCapabilities(): Capability[] {
    return this.registry.filter(capability=>capability.id!=='skill.node').map((capability) => ({ ...capability, requiredScopes: [...capability.requiredScopes] }));
  }

  private scope(task: Pick<TaskRow, "capability_id"> & Partial<Pick<TaskRow,'browser_input'|'input_hash'>>): string {
    if(['skill.run','skill.node','skill.rollback'].includes(task.capability_id))return `${task.capability_id}:${task.input_hash}`;
    if(task.capability_id==='browser.open')return `browser:read:${createHash('sha256').update(JSON.stringify(BrowserTaskInputSchema.parse(task.browser_input))).digest('hex')}`;
    return task.capability_id==='studio.change'?'studio:change':task.capability_id==='coding.change'?'coding:change':task.capability_id === "plan.draft" ? "model:generate" : "diagnostic:read";
  }

  private executableCapability(task: Pick<TaskRow, "capability_id" | "capability_version">): Capability | undefined {
    if (!["system.diagnostic", "plan.draft",'coding.change','studio.change','browser.open','skill.run','skill.node','skill.rollback'].includes(task.capability_id)) return undefined;
    return this.registry.find((capability) => capability.id === task.capability_id
      && capability.version === task.capability_version && capability.status === "active");
  }

  private taskLeaseMs(task: Pick<TaskRow, "capability_id">): number {
    // Up to 180 s of local generation plus isolated tests and review.
    if(['coding.change','studio.change'].includes(task.capability_id))return this.options.leaseMs??420000;
    return task.capability_id === "plan.draft" ? this.planningLeaseMs : this.leaseMs;
  }

  async snapshot(ownerId: string): Promise<{ tasks: Task[]; capabilities: Capability[] }> {
    const rows = await this.db.selectFrom("tasks").select(['id','owner_id','title','goal','capability_id','status','autonomy','created_at','updated_at','attempt','max_attempts','error','cancellation_requested','project_id','studio_input','browser_input','skill_input','skill_binding','skill_node_input','skill_rollback_input','skill_rollback_review'])
      .where("owner_id", "=", ownerId).orderBy("created_at", "desc").limit(200).execute();
    return { tasks: rows.map(row=>taskDto({...row,result:null})), capabilities: this.getCapabilities() };
  }

  async detail(ownerId: string, id: string): Promise<TaskDetail> {
    return this.db.transaction().execute(async (tx) => {
      // Lock the parent while reading its events so the two views agree.
      const task = await tx.selectFrom("tasks").selectAll().where("id", "=", id)
        .where("owner_id", "=", ownerId).forShare().executeTakeFirst();
      if (!task) throw notFound();
      const events = await tx.selectFrom("task_events").selectAll()
        .where("task_id", "=", id).orderBy("sequence", "asc").execute();
      const steps = await tx.selectFrom("task_plan_steps").selectAll().where("task_id", "=", id).orderBy("position", "asc").execute();
      const dependencies = await tx.selectFrom("task_plan_dependencies").selectAll().where("task_id", "=", id).execute();
      const runs = await tx.selectFrom("model_runs").selectAll().where("task_id", "=", id).orderBy("attempt", "asc").execute();
      return {
        task: taskDto(task), events: events.map(eventDto),
        steps: steps.map((step) => ({
          id: `${step.task_id}:${step.step_id}`, taskId: step.task_id, stepId: step.step_id,
          title: step.title, description: step.description,
          dependsOn: dependencies.filter((dependency) => dependency.step_id === step.step_id).map((dependency) => dependency.depends_on_step_id),
          capabilityId: step.capability_id, requiredScopes: step.required_scopes,
          requiresApproval: step.requires_approval, availability: (step.availability ?? "manual") as "available" | "unavailable" | "manual", status: step.status,
        })),
        modelRuns: runs.map((run) => ({
          id: run.id, taskId: run.task_id, attempt: run.attempt, provider: run.provider, model: run.model,
          status: run.status, startedAt: iso(run.started_at), finishedAt: run.finished_at ? iso(run.finished_at) : null,
          inputTokens: run.input_tokens, outputTokens: run.output_tokens,
          usageKnown: run.usage_known, resultCommitted: run.result_committed,
        })),
      };
    });
  }

  async createTask(ownerId: string, rawInput: CreateTaskInput, idempotencyKey: string, parentRunId?: string): Promise<Task> {
    const parsed = CreateTaskSchema.safeParse(rawInput);
    if (!parsed.success) throw new DomainError(400, "INVALID_INPUT", "بيانات المهمة غير صالحة.");
    if (!ownerId || typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError(400, "IDEMPOTENCY_KEY_REQUIRED", "يلزم مفتاح طلب صالح لإنشاء المهمة.");
    }
    let input:TaskCreationInput = parsed.data;
    if(input.capabilityId==='system.diagnostic'&&detectBrowserOpenIntent(input.goal))throw new DomainError(400,'CAPABILITY_GOAL_MISMATCH','هذا الطلب لفتح موقع؛ استخدم مهمة المتصفح بدل فحص الجاهزية.');
    const capability = this.registry.find((item) => item.id === input.capabilityId);
    if (!capability || capability.status !== "active" || !["system.diagnostic", "plan.draft",'coding.change','studio.change','browser.open','skill.run','skill.rollback'].includes(capability.id)) {
      throw new DomainError(403, "CAPABILITY_UNAVAILABLE", "هذه القدرة غير متاحة للتنفيذ.");
    }
    if(input.capabilityId==='skill.rollback'){
      const prepared=await this.options.rollback!.prepare(ownerId,input.skillRollbackInput!);
      input={...input,title:prepared.title,goal:prepared.goal,autonomy:'assisted',skillRollbackInput:SkillRollbackInputSchema.parse(prepared.input),skillRollbackReview:SkillRollbackReviewSchema.parse(prepared.review)};
      const {skillRollbackReview,...publicInput}=input;CreateTaskSchema.parse(publicInput);
    }
    return this.db.transaction().execute(tx=>this.createTaskRecord(tx,ownerId,input,idempotencyKey,undefined,parentRunId));
  }

  private async createTaskRecord(tx: Tx, ownerId: string, input: TaskCreationInput, idempotencyKey: string, binding?: SkillNodeBinding, parentRunId?: string): Promise<Task> {
      const capability=this.registry.find(item=>item.id===input.capabilityId&&item.status==='active');
      if(!capability)throw new DomainError(403,'CAPABILITY_UNAVAILABLE','هذه القدرة غير متاحة للتنفيذ.');
      const inputHash = hashInput(input,binding);
      if(input.capabilityId==='coding.change'){
        const project=await tx.selectFrom('coding_projects').select('id').where('id','=',input.projectId!).where('owner_id','=',ownerId).executeTakeFirst();
        if(!project)throw new DomainError(404,'PROJECT_NOT_FOUND','لم يُعثر على المشروع.');
      }
      if(input.capabilityId==='studio.change'){const studioInput=input.studioInput!;const session=await tx.selectFrom('studio_sessions').select(['id','revision']).where('id','=',studioInput.sessionId).where('owner_id','=',ownerId).executeTakeFirst();if(!session)throw new DomainError(404,'STUDIO_NOT_FOUND','لم يُعثر على مشروع الاستوديو.');if(session.revision!==studioInput.revision)throw new DomainError(409,'STUDIO_REVISION_CONFLICT','تغير إصدار المشروع؛ حدّثه قبل إنشاء المهمة.');if(studioInput.imageId){const image=await tx.selectFrom('studio_images').select('id').where('id','=',studioInput.imageId).where('owner_id','=',ownerId).where('expires_at','>',sql<Date>`CURRENT_TIMESTAMP`).executeTakeFirst();if(!image)throw new DomainError(404,'STUDIO_IMAGE_NOT_FOUND','الصورة غير متاحة لهذا الطلب.');}}
      const approvalRequired=input.autonomy!=='shadow'&&(input.autonomy==='assisted'||['coding.change','studio.change','skill.run','skill.node'].includes(input.capabilityId)||Boolean(binding));
      const id = randomUUID();
      const inserted = await tx.insertInto("tasks").values({
        id, owner_id: ownerId, title: input.title, goal: input.goal, capability_id: input.capabilityId,
        capability_version: capability.version, autonomy: input.autonomy,
        status: approvalRequired ? "waiting_approval" : "queued",
        input_hash: inputHash, idempotency_key: idempotencyKey,
        attempt: 0, max_attempts: binding||input.capabilityId==='skill.rollback'?1:this.maxAttempts, lease_token: null, lease_expires_at: null,
        cancellation_requested: false, approval_required: approvalRequired, event_sequence: 0, result: null, error: null,project_id:input.projectId??null,studio_input:input.studioInput?JSON.stringify(input.studioInput):null,browser_input:input.browserInput?JSON.stringify(input.browserInput):null,
        skill_input:input.skillInput?JSON.stringify(input.skillInput):null,skill_binding:binding?JSON.stringify(binding):null,skill_node_input:input.skillNodeInput?JSON.stringify(input.skillNodeInput):null,workflow_token:null,
        skill_rollback_input:input.skillRollbackInput?JSON.stringify(input.skillRollbackInput):null,skill_rollback_review:input.skillRollbackReview?JSON.stringify(input.skillRollbackReview):null,
        experience_parent_run_id: parentRunId ?? null,
      }).onConflict((conflict) => conflict.columns(["owner_id", "idempotency_key"]).doNothing())
        .returningAll().executeTakeFirst();
      if (!inserted) {
        const existing = await tx.selectFrom("tasks").selectAll()
          .where("owner_id", "=", ownerId).where("idempotency_key", "=", idempotencyKey).executeTakeFirstOrThrow();
        if (existing.input_hash !== inputHash || existing.experience_parent_run_id && existing.experience_parent_run_id !== parentRunId) {
          throw new DomainError(409, "IDEMPOTENCY_CONFLICT", "استُخدم مفتاح الطلب نفسه مع بيانات مختلفة.");
        }
        return taskDto(existing);
      }
      await event(tx, id, "task_created", "حُفظت المهمة ومعايير تنفيذها.", { capabilityId: capability.id, autonomy: input.autonomy });
      if (approvalRequired) await event(tx, id, "approval_required", input.capabilityId==='skill.rollback'?`تحتاج استعادة الملف ${input.skillRollbackReview!.path} موافقة مستقلة. البصمة الحالية ${input.skillRollbackReview!.afterHash}؛ ${input.skillRollbackReview!.deletedOnRestore?'سيُحذف الملف الذي أنشأته المهارة':`سيعاد إلى البصمة ${input.skillRollbackReview!.beforeHash}`}. راجع المجلد والصورة السابقة قبل الموافقة.`:binding?this.skillApprovalMessage(binding,input.skillNodeInput??{}):input.capabilityId==='skill.run'?'تنتظر المهمة موافقتك على المخطط ومدخلاته المثبتة في تفاصيل المهمة. كل خطوة تنفيذ تحتاج موافقة مستقلة؛ لا تمنح هذه الموافقة صلاحيات أدوات.':input.capabilityId==='browser.open'?`تنتظر المهمة موافقتك على فتح ${input.browserInput!.url} للقراءة فقط وحفظ لقطة الصفحة دون إرسال نماذج.`:input.capabilityId==='studio.change'?'تنتظر المهمة موافقتك على إرسال السياق والصورة المحددة إن وجدت إلى النموذج، وتعديل نسخة Git واختبارها؛ تطبيق النتيجة إجراء مستقل بعد المراجعة.':input.capabilityId==='coding.change'
        ? 'تنتظر المهمة موافقتك على قراءة الملفات المحددة وإرسال سياقها للنموذج وتعديل نسخة معزولة وتشغيل اختباراتها؛ لا دمج أو نشر.'
        : input.capabilityId === "plan.draft"
        ? "تنتظر المهمة موافقتك على إرسال الهدف إلى النموذج وإنشاء خطة نصية بتكلفة توكنات محتملة."
        : "تنتظر المهمة موافقتك على فحص القراءة فقط.");
      return taskDto(inserted);
  }

  private skillApprovalMessage(binding:SkillNodeBinding,input:Record<string,unknown>):string {
    const effect=binding.tool?TOOL_SIDE_EFFECTS[binding.tool]:'none';
    const purpose=binding.kind==='model'?'إرسال المدخلات المحددة إلى نموذج؛ قد يستهلك الطلب توكنات مدفوعة':binding.kind==='script'?'تشغيل كود ضمن حدود العزل المعتمدة':effect==='external'||effect==='financial'?'إحداث تغيير أو إرسال إلى خدمة خارجية':effect==='write_local'?'تغيير بيانات أو ملفات محلية':'قراءة البيانات المحددة وحفظ دليل النتيجة';
    const target=[input.path,input.url,input.sessionId].find(value=>typeof value==='string');
    const content=typeof input.content==='string'?` محتوى الكتابة: ${Buffer.byteLength(input.content,'utf8')} بايت، SHA-256 ${createHash('sha256').update(input.content).digest('hex')}.`:'';
    return `تحتاج الخطوة ${binding.tool??binding.kind} موافقتك على ${purpose}.${target?` الهدف: ${String(target).slice(0,500)}.`:''}${content} راجع المدخلات الكاملة المثبتة في تفاصيل المهمة؛ لا تشمل الموافقة أي مدخلات أخرى.`;
  }

  /** Only the scheduler receives this closure; no API accepts an internal node or binding. */
  private async createSkillChild(tx: Kysely<any>, parent: TaskRow, spec: SkillChildSpec): Promise<{ id: string }> {
    const binding=SkillNodeBindingSchema.parse(spec.binding);
    if(!this.options.skillRuntime||binding.parentTaskId!==parent.id||!Number.isInteger(spec.attempt??1)||(spec.attempt??1)<1||(spec.attempt??1)>3||spec.idempotencyKey!==`skill:${binding.runId}:${binding.nodeId}${(spec.attempt??1)>1?`:attempt:${spec.attempt}`:''}`)throw new DomainError(403,'SKILL_BINDING_INVALID','ربط خطوة المهارة غير صالح.');
    const current=await this.lockedLease(tx as Tx,parent);
    if(!current||current.cancellation_requested||!(await this.validApproval(tx as Tx,current)))throw new DomainError(409,'SKILL_AUTHORIZATION_LOST','انتهى تفويض مخطط المهارات.');
    const nodeInput=SkillNodeInputSchema.parse(spec.input);
    if(createHash('sha256').update(JSON.stringify(canonical(nodeInput))).digest('hex')!==binding.inputsHash)throw new DomainError(409,'SKILL_INPUT_HASH_MISMATCH','لا تطابق المدخلات بصمة الخطوة المثبتة.');
    const mapped=binding.kind==='tool'&&binding.tool?this.options.skillRuntime.mapChild(binding.tool,nodeInput):null;
    if(mapped&&(!this.options.skillRuntime.beforeMappedExecute||!this.options.skillRuntime.recordChildResult))throw new DomainError(403,'SKILL_GATEWAY_UNAVAILABLE','بوابة توثيق الأداة غير متاحة.');
    const input:TaskCreationInput=mapped?CreateTaskSchema.parse({...mapped,autonomy:'assisted'}):{title:(spec.title??`خطوة ${binding.tool??binding.kind}`).slice(0,120),goal:this.skillApprovalMessage(binding,nodeInput),capabilityId:'skill.node',autonomy:'assisted'};
    input.skillNodeInput=nodeInput;
    if(!['browser.open','coding.change','studio.change','skill.node'].includes(input.capabilityId))throw new DomainError(403,'SKILL_CHILD_CAPABILITY_INVALID','قدرة الخطوة غير معتمدة.');
    const task=await this.createTaskRecord(tx as Tx,parent.owner_id,input,spec.idempotencyKey,binding);
    return {id:task.id};
  }

  async approve(ownerId: string, id: string): Promise<Task> {
    return this.db.transaction().execute(async (tx) => {
      const task = await tx.selectFrom("tasks").selectAll().where("id", "=", id)
        .where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!task) throw notFound();
      if (task.status !== "waiting_approval" || task.cancellation_requested) {
        throw new DomainError(409, "APPROVAL_STATE_CONFLICT", "المهمة لا تنتظر موافقة حاليًا.");
      }
      const capability = this.executableCapability(task);
      if (!capability) {
        throw new DomainError(403, "CAPABILITY_UNAVAILABLE", "هذه القدرة غير متاحة للموافقة.");
      }
      if(task.capability_id==='browser.open'&&!this.browserInput(task))throw new DomainError(409,'BROWSER_SCOPE_INVALID','تغير رابط مهمة المتصفح أو نطاقها؛ أنشئ مهمة جديدة.');
      if((task.skill_binding||task.capability_id==='skill.run')&&!await this.validSkillTask(tx,task))throw new DomainError(409,'SKILL_BINDING_INVALID','تغير مخطط المهارة أو فقد تفويضه.');
      if(task.capability_id==='skill.rollback'&&!await this.validRollback(tx,task))throw new DomainError(409,'SKILL_ROLLBACK_CHANGED','تغيرت بيانات الاستعادة أو صلاحياتها.');
      if(task.capability_id==='skill.run'&&task.attempt>0)await this.invalidateChildApprovals(tx,task.id);
      // Revoke older approval records before issuing a grant for this exact input.
      await tx.updateTable("approvals").set({ revoked_at: new Date() })
        .where("task_id", "=", id).where("revoked_at", "is", null).execute();
      await tx.insertInto("approvals").values({
        id: randomUUID(), task_id: id, owner_id: ownerId,
        capability_id: task.capability_id, capability_version: task.capability_version,
        input_hash: task.input_hash, scope: this.scope(task),
        expires_at: sql`CURRENT_TIMESTAMP + interval '10 minutes'`, consumed_at: null, consumed_lease_token: null, revoked_at: null,
      }).execute();
      const updated = await tx.updateTable("tasks").set({ status: "queued", approval_required: true, updated_at: new Date(), available_at: new Date(), error: null,...(task.capability_id==='skill.run'?{workflow_token:null}:{}) })
        .where("id", "=", id).returningAll().executeTakeFirstOrThrow();
      await event(tx, id, "task_approved", "مُنحت موافقة محدودة لهذه المهمة، وتنتهي خلال عشر دقائق.");
      return taskDto(updated);
    });
  }

  async cancel(ownerId: string, id: string): Promise<Task> {
    const childIds:string[]=[];
    const result = await this.db.transaction().execute(async (tx) => {
      const task = await tx.selectFrom("tasks").selectAll().where("id", "=", id)
        .where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
      if (!task) throw notFound();
      if (isTerminal(task.status) || task.cancellation_requested) return taskDto(task);
      if(task.capability_id==='skill.run'){
        await (this.options.skillRuntime?.cancelRun??this.options.cancelSkillRun)?.(tx,ownerId,id);
        const children=await tx.selectFrom('tasks').selectAll().where('owner_id','=',ownerId).where(sql<string>`skill_binding->>'parentTaskId'`,'=',id).where('status','not in',['completed','failed','cancelled']).orderBy('id').forUpdate().execute();
        for(const child of children){
          const immediateChild=['queued','waiting_approval','paused'].includes(child.status);
          await tx.updateTable('tasks').set({cancellation_requested:true,status:immediateChild?'cancelled':child.status,updated_at:new Date(),...(immediateChild?{lease_token:null,lease_expires_at:null}:{})}).where('id','=',child.id).execute();
          await tx.updateTable('approvals').set({revoked_at:new Date()}).where('task_id','=',child.id).where('revoked_at','is',null).execute();
          await event(tx,child.id,'parent_cancelled','أوقف مخطط المهارات هذه الخطوة.');childIds.push(child.id);
        }
      }
      const immediate = ["queued", "waiting_approval", "paused"].includes(task.status);
      const updated = await tx.updateTable("tasks").set({
        cancellation_requested: true,
        status: immediate ? "cancelled" : task.status,
        updated_at: new Date(),
        ...(immediate ? { lease_token: null, lease_expires_at: null } : {}),
      }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
      await tx.updateTable("approvals").set({ revoked_at: new Date() })
        .where("task_id", "=", id).where("revoked_at", "is", null).execute();
      await event(tx, id, immediate ? "task_cancelled" : "cancellation_requested",
        immediate ? "أُلغيت المهمة قبل بدء خطوة جديدة." : "سُجل طلب الإلغاء، ويجري إيقاف الفحص الجاري.");
      if (immediate) await this.recordTerminalTask(tx, updated, 'cancelled');
      return taskDto(updated);
    });
    this.controllers.get(id)?.abort(new Error("TASK_CANCELLED"));
    for(const childId of childIds)this.controllers.get(childId)?.abort(new Error('SKILL_PARENT_CANCELLED'));
    return result;
  }

  start(): void {
    if (this.timer) return;
    const run = () => { void this.tick().catch((error) => this.options.onError?.(error)); };
    this.timer = setInterval(run, this.pollMs);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Finish the bounded read-only operation rather than abandon its lease.
    await this.activeTick;
  }

  tick(): Promise<Task | null> {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.runTick().finally(() => { this.activeTick = null; });
    return this.activeTick;
  }

  private async recoverExpired(): Promise<void> {
    // One task lock per transaction: a batch can otherwise lock a child before
    // its parent while the scheduler holds the parent and waits for that child.
    const candidates=await this.db.selectFrom('tasks').select('id').where('status','in',['running','verifying']).where('lease_expires_at','<',sql<Date>`CURRENT_TIMESTAMP`).orderBy('lease_expires_at').limit(25).execute();
    for(const candidate of candidates)await this.db.transaction().execute(async (tx) => {
      const task = await tx.selectFrom("tasks").selectAll().where('id','=',candidate.id)
        .where("status", "in", ["running", "verifying"])
        .where("lease_expires_at", "<", sql<Date>`CURRENT_TIMESTAMP`)
        .forUpdate().skipLocked().executeTakeFirst();
      if(!task)return;
        if(task.skill_binding&&this.options.skillRuntime?.recoverNode&&!task.cancellation_requested){
          const recovery=await this.options.skillRuntime.recoverNode(tx,{ownerId:task.owner_id,taskId:task.id,binding:SkillNodeBindingSchema.parse(task.skill_binding),leaseToken:task.lease_token!});
          if(recovery.kind==='confirmed'&&await this.validApproval(tx,task)){
            await tx.updateTable('tasks').set({status:'queued',verification_only:true,verification_source_lease:recovery.receiptLeaseToken,recovery_result:JSON.stringify(recovery.result),lease_token:null,lease_expires_at:null,available_at:new Date(),updated_at:new Date(),error:null}).where('id','=',task.id).execute();
            await event(tx,task.id,'verification_recovered','حُفظ إيصال ناجح قبل توقف العامل؛ ستعاد قراءة الأدلة فقط دون تكرار الأداة.');
            return;
          }
        }
        if(task.capability_id==='skill.run'&&!task.cancellation_requested&&await this.validApproval(tx,task)){
          await tx.updateTable('tasks').set({status:'queued',lease_token:null,lease_expires_at:null,available_at:new Date(),updated_at:new Date(),error:null}).where('id','=',task.id).execute();
          await event(tx,task.id,'skill_workflow_recovered','استؤنف منسق المخطط من سجلات الخطوات المحفوظة دون إعادة تنفيذ الأثر.');return;
        }
        const safe = (task.capability_id === "system.diagnostic" && task.capability_version === "1.0.0")
          || (['plan.draft','coding.change','studio.change','browser.open'].includes(task.capability_id) && task.autonomy === "shadow");
        const planning = ['plan.draft','coding.change','studio.change'].includes(task.capability_id) && task.autonomy !== "shadow";
        const browser = task.capability_id==='browser.open'&&task.autonomy!=='shadow';
        const status = task.cancellation_requested ? "cancelled"
          : task.attempt >= task.max_attempts ? "failed"
          : !safe || task.approval_required ? "waiting_approval" : "queued";
        await tx.updateTable("tasks").set({
          status, lease_token: null, lease_expires_at: null, available_at: new Date(), updated_at: new Date(),
          ...(task.capability_id==='skill.run'?{workflow_token:null}:{}),
          approval_required: task.approval_required || planning || browser,
          error: status === "failed" ? "انتهت محاولات التعافي من توقف العامل."
            : browser ? 'انقطعت جلسة المتصفح؛ راجع أثرها قبل الموافقة على محاولة جديدة.' : planning ? "انقطع طلب النموذج؛ قد تكون له تكلفة غير محسومة. يلزم تفويض جديد قبل أي طلب آخر." : null,
        }).where("id", "=", task.id).execute();
        if (planning && task.lease_token) {
          await tx.updateTable("model_runs").set({ status: "unknown", error_code: "WORKER_LEASE_EXPIRED", finished_at: new Date() })
            .where("task_id", "=", task.id).where("lease_token", "=", task.lease_token).where("status", "=", "started").execute();
          if(task.capability_id==='coding.change')await tx.updateTable('coding_runs').set({status:'unknown',error_code:'WORKER_LEASE_EXPIRED',finished_at:new Date()}).where('task_id','=',task.id).where('lease_token','=',task.lease_token).where('status','=','started').execute();
        }
        await event(tx, task.id, "lease_recovered", status === "queued"
          ? "انتهت مهلة العامل السابق؛ أُعيدت جدولة الفحص الآمن."
          : "عولج توقف العامل وفق حالة الإلغاء وسياسة إعادة التنفيذ.", { nextStatus: status });
        if (status === 'cancelled' || status === 'failed') await this.recordTerminalTask(tx, task, status);
    });
  }

  private async validApproval(tx: Tx, task: TaskRow, continuingAttempt = true): Promise<boolean> {
    if(task.capability_id==='skill.rollback'&&!await this.validRollback(tx,task))return false;
    if(task.capability_id==='browser.open'&&!this.browserInput(task))return false;
    if((task.skill_binding||task.capability_id==='skill.run'||task.capability_id==='skill.node')&&!await this.validSkillTask(tx,task))return false;
    if (!task.approval_required) return true;
    let query = tx.selectFrom("approvals").select("id")
      .where("task_id", "=", task.id).where("owner_id", "=", task.owner_id)
      .where("capability_id", "=", task.capability_id).where("capability_version", "=", task.capability_version)
      .where("input_hash", "=", task.input_hash).where("scope", "=", this.scope(task))
      .where("revoked_at", "is", null).where("expires_at", ">", sql<Date>`CURRENT_TIMESTAMP`);
    query = continuingAttempt
      ? query.where("consumed_at", "is not", null).where("consumed_lease_token", "=", task.capability_id==='skill.run'?task.workflow_token:task.verification_only?task.verification_source_lease:task.lease_token)
      : query.where("consumed_at", "is", null);
    const approval = await query.forShare().executeTakeFirst();
    return Boolean(approval);
  }

  private skillInputIntegrity(task:TaskRow):boolean {
    const binding=task.skill_binding?SkillNodeBindingSchema.safeParse(task.skill_binding):null;
    if(binding&&!binding.success)return false;
    const input:TaskCreationInput={title:task.title,goal:task.goal,capabilityId:task.capability_id as TaskCreationInput['capabilityId'],autonomy:task.autonomy,
      ...(task.project_id?{projectId:task.project_id}:{}),...(task.studio_input?{studioInput:StudioTaskInputSchema.parse(task.studio_input)}:{}),...(task.browser_input?{browserInput:BrowserTaskInputSchema.parse(task.browser_input)}:{}),
      ...(task.skill_input?{skillInput:SkillRunInputSchema.parse(task.skill_input)}:{}),...(task.skill_node_input?{skillNodeInput:SkillNodeInputSchema.parse(task.skill_node_input)}:{}),
      ...(task.skill_rollback_input?{skillRollbackInput:SkillRollbackInputSchema.parse(task.skill_rollback_input),skillRollbackReview:SkillRollbackReviewSchema.parse(task.skill_rollback_review)}:{})};
    const {skillNodeInput,skillRollbackReview,...publicInput}=input;
    if(task.capability_id!=='skill.node'&&!CreateTaskSchema.safeParse(publicInput).success)return false;
    return hashInput(input,binding?.success?binding.data:undefined)===task.input_hash;
  }

  private async validRollback(tx:Tx,task:TaskRow):Promise<boolean>{
    try{
      if(!this.options.rollback||task.skill_binding||task.autonomy!=='assisted'||!this.skillInputIntegrity(task))return false;
      const prepared=await this.options.rollback.prepare(task.owner_id,SkillRollbackInputSchema.parse(task.skill_rollback_input),tx);
      return JSON.stringify(canonical(prepared.input))===JSON.stringify(canonical(task.skill_rollback_input))
        &&JSON.stringify(canonical(prepared.review))===JSON.stringify(canonical(task.skill_rollback_review))
        &&prepared.title===task.title&&prepared.goal===task.goal;
    }catch{return false;}
  }

  /** This guard performs reads only, preserving parent -> run/node -> child lock order. */
  private async validSkillTask(tx:Tx,task:TaskRow):Promise<boolean> {
    try {
      if(!this.options.skillRuntime||!this.skillInputIntegrity(task))return false;
      if(task.capability_id==='skill.run')return !task.skill_binding&&Boolean(task.skill_input);
      const parsed=SkillNodeBindingSchema.safeParse(task.skill_binding);if(!parsed.success)return false;
      const parent=await tx.selectFrom('tasks').selectAll().where('id','=',parsed.data.parentTaskId).where('owner_id','=',task.owner_id).executeTakeFirst();
      if(!parent||!this.skillInputIntegrity(parent)||!await hasActiveSkillWorkflowApproval(tx,parent))return false;
      return await this.options.skillRuntime.validateBinding(tx,{taskId:task.id,ownerId:task.owner_id,binding:parsed.data});
    } catch { return false; }
  }

  private async claim(): Promise<TaskRow | null> {
    return this.db.transaction().execute(async (tx) => {
      const task = await tx.selectFrom("tasks").selectAll().where("status", "=", "queued")
        .where("available_at", "<=", sql<Date>`CURRENT_TIMESTAMP`)
        .orderBy("created_at", "asc").forUpdate().skipLocked().limit(1).executeTakeFirst();
      if (!task) return null;
      if (task.cancellation_requested) {
        await tx.updateTable("tasks").set({ status: "cancelled", updated_at: new Date() }).where("id", "=", task.id).execute();
        await event(tx, task.id, "task_cancelled", "أُلغيت المهمة قبل التنفيذ.");
        await this.recordTerminalTask(tx, task, 'cancelled');
        return null;
      }
      // The registry, rather than a user-supplied autonomy label, defines what can run.
      if (!this.executableCapability(task)) {
        await tx.updateTable("tasks").set({ status: "failed", error: "القدرة غير مصرح بتنفيذها.", updated_at: new Date() }).where("id", "=", task.id).execute();
        await event(tx, task.id, "permission_denied", "منع سجل القدرات تشغيل أداة غير معتمدة.");
        await this.recordTerminalTask(tx, task, 'failed');
        return null;
      }
      const continuingWorkflow=task.capability_id==='skill.run'&&Boolean(task.workflow_token);
      const verificationOnly=task.verification_only&&Boolean(task.skill_binding&&task.verification_source_lease&&task.recovery_result);
      if(task.verification_only&&!verificationOnly){await tx.updateTable('tasks').set({status:'failed',error:'بيانات استعادة التحقق غير صالحة.'}).where('id','=',task.id).execute();await this.recordTerminalTask(tx, task, 'failed');return null;}
      if (!(await this.validApproval(tx, task, continuingWorkflow||verificationOnly))) {
        await tx.updateTable("tasks").set({ status: verificationOnly?'failed':"waiting_approval", updated_at: new Date() }).where("id", "=", task.id).execute();
        await event(tx, task.id, "approval_expired", "يلزم تجديد الموافقة قبل بدء الفحص.");
        if (verificationOnly) await this.recordTerminalTask(tx, task, 'failed');
        return null;
      }
      if (!continuingWorkflow&&!verificationOnly&&task.attempt >= task.max_attempts) {
        await tx.updateTable("tasks").set({ status: "failed", error: "بلغت المهمة الحد الأقصى للمحاولات.", updated_at: new Date() }).where("id", "=", task.id).execute();
        await event(tx, task.id, "attempts_exhausted", "توقفت إعادة المحاولة عند الحد المسموح.");
        await this.recordTerminalTask(tx, task, 'failed');
        return null;
      }
      const row = await tx.updateTable("tasks").set({
        status: verificationOnly?'verifying':"running", attempt: task.attempt + (continuingWorkflow||verificationOnly?0:1), lease_token: randomUUID(),
        ...(task.capability_id==='skill.run'?{workflow_token:task.workflow_token??randomUUID()}:{}),
        lease_expires_at: sql`CURRENT_TIMESTAMP + ${this.taskLeaseMs(task)} * interval '1 millisecond'`, updated_at: new Date(), error: null,
      }).where("id", "=", task.id).returningAll().executeTakeFirstOrThrow();
      await tx.updateTable("approvals").set({ consumed_at: new Date(), consumed_lease_token: row.capability_id==='skill.run'?row.workflow_token:row.lease_token })
        .where("task_id", "=", task.id).where("owner_id", "=", task.owner_id)
        .where("input_hash", "=", task.input_hash).where("capability_id", "=", task.capability_id)
        .where("capability_version", "=", task.capability_version).where("scope", "=", this.scope(task))
        .where("expires_at", ">", sql<Date>`CURRENT_TIMESTAMP`)
        .where("revoked_at", "is", null).where("consumed_at", "is", null).execute();
      await event(tx, task.id, "execution_started", task.capability_id === "plan.draft"
        ? "بدأ إعداد الخطة ضمن صلاحية توليد النص؛ خطواتها لن تُنفذ."
        : "بدأ العامل الفحص ضمن الصلاحية المحددة.", { attempt: row.attempt, workerId: this.workerId });
      return row;
    });
  }

  private async lockedLease(tx: Tx, task: TaskRow): Promise<TaskRow | null> {
    return await tx.selectFrom("tasks").selectAll().where("id", "=", task.id)
      .where("lease_token", "=", task.lease_token)
      .where("lease_expires_at", ">", sql<Date>`CURRENT_TIMESTAMP`)
      .where("status", "in", ["running", "verifying"]).forUpdate().executeTakeFirst() ?? null;
  }

  private skillExecutionContext(task:TaskRow,signal:AbortSignal):SkillExecutionContext {
    return {ownerId:task.owner_id,taskId:task.id,leaseToken:task.lease_token!,signal,assertActive:async()=>{
      signal.throwIfAborted();
      const allowed=await this.db.transaction().execute(async tx=>{const current=await this.lockedLease(tx,task);return Boolean(current&&!current.cancellation_requested&&await this.validApproval(tx,current));});
      if(!allowed)throw new DomainError(409,'SKILL_AUTHORIZATION_LOST','لم يعد تفويض خطوة المهارة صالحًا.');
      signal.throwIfAborted();
    }};
  }

  private skillNodeContext(task:TaskRow,signal:AbortSignal):SkillNodeExecutionContext{
    return {...this.skillExecutionContext(task,signal),binding:SkillNodeBindingSchema.parse(task.skill_binding),...(task.verification_only?{verificationOnly:true as const,receiptLeaseToken:task.verification_source_lease!}:{})};
  }

  private recoveryVerificationContext(task:TaskRow,signal:AbortSignal):VerificationRecoveryContext{
    return task.verification_only?{verificationOnly:true,receiptLeaseToken:task.verification_source_lease!,leaseToken:task.lease_token!,assertActive:this.skillExecutionContext(task,signal).assertActive}:{};
  }

  private async recoverVerifiedTask(task:TaskRow,signal:AbortSignal):Promise<void>{
    const context=this.skillNodeContext(task,signal);await context.assertActive();
    const raw=task.recovery_result;
    let result=await this.verify(raw,false,task.capability_id,task,signal);
    if(result&&task.capability_id!=='skill.node')result=await this.options.skillRuntime?.verifyRecoveredNode?.(result,context)??null;
    signal.throwIfAborted();await context.assertActive();await this.finish(task,result);
  }

  private async invalidateChildApprovals(tx:Tx,parentId:string):Promise<void>{
    const children=await tx.selectFrom('tasks').selectAll().where(sql<string>`skill_binding->>'parentTaskId'`,'=',parentId).where('status','not in',['completed','failed','cancelled']).orderBy('id').forUpdate().execute();
    for(const child of children){
      await tx.updateTable('approvals').set({revoked_at:new Date()}).where('task_id','=',child.id).where('revoked_at','is',null).execute();
      if(['queued','paused'].includes(child.status))await tx.updateTable('tasks').set({status:'waiting_approval',lease_token:null,lease_expires_at:null,updated_at:new Date()}).where('id','=',child.id).execute();
    }
  }

  private async wakeSkillParents():Promise<void> {
    const skills=this.options.skillRuntime;if(!skills)return;
    // Expired paused workflows must be approvable even while a child awaits its own approval.
    await this.db.transaction().execute(async tx=>{
      const expired=await tx.selectFrom('tasks').selectAll().where('capability_id','=','skill.run').where('status','=','paused')
        .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=tasks.id AND a.owner_id=tasks.owner_id AND a.capability_id=tasks.capability_id AND a.capability_version=tasks.capability_version AND a.input_hash=tasks.input_hash AND a.scope=concat('skill.run:',tasks.input_hash) AND a.consumed_lease_token=tasks.workflow_token AND a.consumed_at IS NOT NULL AND a.revoked_at IS NULL AND a.expires_at>CURRENT_TIMESTAMP)`)
        .forUpdate().skipLocked().limit(25).execute();
      for(const task of expired){
        await this.invalidateChildApprovals(tx,task.id);
        await tx.updateTable('tasks').set({status:'waiting_approval',workflow_token:null,updated_at:new Date(),error:'انتهى تفويض المخطط؛ يلزم تجديد موافقته قبل متابعة الخطوات.'}).where('id','=',task.id).execute();
        await event(tx,task.id,'approval_expired','انتهت موافقة مخطط المهارات أثناء انتظار خطوة فرعية.');
      }
    });
    for(const candidate of (await skills.wakeCandidates()).slice(0,50))await this.db.transaction().execute(async tx=>{
      const task=await tx.selectFrom('tasks').selectAll().where('id','=',candidate.parentTaskId).where('owner_id','=',candidate.ownerId).where('capability_id','=','skill.run').where('status','=','paused').forUpdate().skipLocked().executeTakeFirst();
      if(!task||task.cancellation_requested)return;
      const allowed=await this.validApproval(tx,task);
      await tx.updateTable('tasks').set({status:allowed?'queued':'waiting_approval',available_at:new Date(),updated_at:new Date(),...(allowed?{}:{workflow_token:null})}).where('id','=',task.id).execute();
      await event(tx,task.id,allowed?'skill_workflow_ready':'approval_expired',allowed?'وصلت نتيجة خطوة فرعية؛ استؤنفت متابعة المخطط.':'يلزم تجديد تفويض المخطط.');
    });
  }

  private async pauseSkillParent(task:TaskRow,pending:Extract<SkillAdvanceResult,{kind:'pending'}>):Promise<void>{
    await this.db.transaction().execute(async tx=>{
      const current=await this.lockedLease(tx,task);if(!current)return;
      if(current.cancellation_requested){await this.cancelClaim(tx,current);return;}
      if(!await this.validApproval(tx,current)){
        await tx.updateTable('tasks').set({status:'waiting_approval',workflow_token:null,lease_token:null,lease_expires_at:null,updated_at:new Date()}).where('id','=',task.id).execute();return;
      }
      await tx.updateTable('tasks').set({status:'paused',lease_token:null,lease_expires_at:null,result:JSON.stringify({kind:'skill_pending',runId:pending.runId,childTaskIds:pending.childTaskIds.slice(0,144)}),updated_at:new Date()}).where('id','=',task.id).execute();
      await event(tx,task.id,'skill_workflow_waiting','ينتظر المخطط نتائج المهام الفرعية وموافقاتها المستقلة.',{runId:pending.runId,childTaskIds:pending.childTaskIds.slice(0,144)});
    });
  }

  private async runDiagnostic(signal: AbortSignal): Promise<DiagnosticResult> {
    signal.throwIfAborted();
    const query = await sql<{ reachable: number }>`SELECT 1 AS reachable`.execute(this.db);
    signal.throwIfAborted();
    return {
      kind: "diagnostic", summary: "اكتمل فحص الاتصال وسجل القدرات ونطاق القراءة.", observedAt: new Date().toISOString(),
      checks: [
        { name: "database", passed: query.rows[0]?.reachable === 1, evidence: "SELECT 1 returned 1" },
        { name: "capability_registry", passed: this.registry.some((item) => item.id === "system.diagnostic" && item.status === "active"), evidence: "system.diagnostic@1.0.0 is registered and active" },
        { name: "permission_scope", passed: true, evidence: "Only diagnostic:read was selected for this invocation; no other capability was executed" },
      ],
    };
  }

  private async modelProgress(task: TaskRow, stage: string): Promise<void> {
    const messages: Record<string, string> = {
      goal_compiled: "حُولت صياغة الهدف إلى سياق تخطيط محدود.",
      model_selected: "اختير نموذج نصي ضمن حدود الطلب.",
      model_requested: "يجري طلب خطة نصية من مزود النموذج.",
      fallback_selected: "اختير البديل بعد رفض معروف؛ لا إعادة تلقائية لطلب ذي أثر غير محسوم.",
      response_received: "وصل رد النموذج؛ يجري فحص البنية والسياسة.",
      plan_verified: "اجتازت الخطة تحقق المحرك؛ يلزم تحقق مستقل قبل اعتمادها.",
      project_inspected:'فُحص المشروع ونطاق الملفات والمرجع المثبت.',worktree_created:'أُنشئت نسخة Git معزولة لهذه المهمة.',
      baseline_tested:'سُجلت نتيجة الاختبارات قبل التعديل داخل بيئة العزل.',edits_requested:'يجري طلب تعديل محدود من النموذج.',
      edits_validated:'اجتازت مسارات التعديل وبصماتها فحص النطاق.',edits_applied:'طُبقت التغييرات في نسخة المهمة فقط.',
      tests_started:'بدأت الاختبارات داخل بيئة العزل.',tests_finished:'حُفظت نتائج الاختبارات المعزولة.',
      review_finished:'اكتمل فحص التغييرات والنطاق ونتائج الاختبارات.',checkpoint_created:'حُفظت نقطة مراجعة في فرع المهمة دون دمج.',
    };
    if (!messages[stage]) return;
    await this.db.transaction().execute(async (tx) => {
      const current = await this.lockedLease(tx, task);
      if (!current || current.cancellation_requested || !(await this.validApproval(tx, current))) {
        throw new DomainError(409, "PLANNING_AUTHORIZATION_LOST", "توقف التخطيط لأن التفويض لم يعد صالحًا.");
      }
      await event(tx, task.id, stage, messages[stage]!);
    });
  }

  private async startModelRun(task: TaskRow): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const current = await this.lockedLease(tx, task);
      if (!current || current.cancellation_requested || !(await this.validApproval(tx, current))) return false;
      await tx.insertInto("model_runs").values({
        id: randomUUID(), task_id: task.id, attempt: task.attempt, lease_token: task.lease_token!,
        provider: "ollama", model: null, status: "started", input_tokens: null, output_tokens: null,
        usage_known: false, result_committed: false, output_hash: null, error_code: null, finished_at: null,
      }).execute();
      await event(tx, task.id, "model_run_started", "سُجلت محاولة طلب النموذج قبل الاتصال؛ لا إعادة تلقائية إذا تعذر حسم نتيجتها.", { attempt: task.attempt });
      return true;
    });
  }

  private async recordModelOutcome(task: TaskRow, raw: unknown, error = false): Promise<void> {
    const metadata = z.object({
      model: z.string().min(1).max(100).optional(),
      usage: z.object({
        inputTokens: z.number().int().nonnegative().max(2_147_483_647),
        outputTokens: z.number().int().nonnegative().max(2_147_483_647),
      }).optional(),
      httpStatus: z.number().int().optional(),
    }).passthrough().safeParse(raw);
    const data = metadata.success ? metadata.data : undefined;
    const knownUsage = Boolean(data?.usage);
    const rejected = error && (data?.httpStatus === 429 || data?.httpStatus === 503);
    await this.db.updateTable("model_runs").set({
      status: knownUsage ? error ? "failed" : "succeeded" : sql`CASE WHEN usage_known THEN ${error?'failed':'succeeded'} ELSE ${rejected?'failed':'unknown'} END`,
      ...(data?.model ? { model: data.model } : {}),
      input_tokens: data?.usage?.inputTokens ?? sql`input_tokens`, output_tokens: data?.usage?.outputTokens ?? sql`output_tokens`,
      usage_known: knownUsage?true:sql`usage_known`, finished_at: new Date(),
      output_hash: !error ? createHash("sha256").update(JSON.stringify(raw) ?? "null").digest("hex") : null,
      error_code: error ? knownUsage ? "OUTPUT_REJECTED" : rejected ? "PROVIDER_REJECTED" : "MODEL_OUTCOME_UNKNOWN"
        : knownUsage ? null : "MODEL_USAGE_UNKNOWN",
    }).where("task_id", "=", task.id).where("lease_token", "=", task.lease_token!)
      .where("status", "in", ["started", "unknown",'succeeded','failed']).execute();
  }

  private async runPlanning(task: TaskRow, signal: AbortSignal): Promise<unknown> {
    if (!this.options.plan || !task.lease_token) throw new DomainError(403, "CAPABILITY_UNAVAILABLE", "التخطيط غير مهيأ.");
    if (!(await this.startModelRun(task))) throw new DomainError(409, "PLANNING_AUTHORIZATION_LOST", "لم يعد التفويض صالحًا لبدء طلب النموذج.");
    signal.throwIfAborted();
    const response = this.options.plan(task.goal, {
      signal, taskId: task.id, leaseToken: task.lease_token,
      onProgress: (stage) => this.modelProgress(task, stage),
    }).then(async (result) => {
      // Keep the actual response receipt even if cancellation/fencing prevents
      // task completion. The receipt never gives a stale worker write access to the task.
      await this.recordModelOutcome(task, result);
      return result;
    }, async (error: unknown) => {
      await this.recordModelOutcome(task, error, true);
      throw error;
    });
    return abortable(() => response, signal);
  }

  private async runCoding(task:TaskRow,signal:AbortSignal):Promise<unknown>{
    if(!this.options.code||!task.lease_token||!task.project_id)throw new DomainError(403,'CAPABILITY_UNAVAILABLE','محرك البرمجة غير مهيأ.');
    await this.db.transaction().execute(async tx=>{
      const current=await this.lockedLease(tx,task);
      if(!current||current.cancellation_requested||!(await this.validApproval(tx,current)))throw new DomainError(409,'CODING_AUTHORIZATION_LOST','لم يعد التفويض صالحًا.');
      await tx.insertInto('coding_runs').values({id:randomUUID(),task_id:task.id,project_id:task.project_id!,attempt:task.attempt,lease_token:task.lease_token!,status:'started',result:null,result_committed:false,error_code:null,finished_at:null}).execute();
    });
    let modelStarted=false;
    const response=this.options.code(task.goal,{signal,taskId:task.id,ownerId:task.owner_id,projectId:task.project_id,leaseToken:task.lease_token,onModelReceipt:async receipt=>{if(!modelStarted)throw new DomainError(409,'MODEL_RECEIPT_WITHOUT_REQUEST','لم يبدأ طلب النموذج.');await this.recordModelOutcome(task,receipt);},onProgress:async(stage)=>{
      if(stage==='edits_requested'&&!modelStarted){if(!(await this.startModelRun(task)))throw new DomainError(409,'CODING_AUTHORIZATION_LOST','لم يعد تفويض النموذج صالحًا.');modelStarted=true;}
      await this.modelProgress(task,stage);
    }}).then(async result=>{
      if(modelStarted)await this.recordModelOutcome(task,result);
      const parsed=CodingResultSchema.safeParse(result);
      await this.db.updateTable('coding_runs').set({status:parsed.success?(parsed.data.outcome==='ready_for_review'?'succeeded':'failed'):'failed',result:parsed.success?JSON.stringify(parsed.data):null,error_code:parsed.success?null:'INVALID_CODING_RESULT',finished_at:new Date()}).where('task_id','=',task.id).where('lease_token','=',task.lease_token!).execute();
      return result;
    },async(error:unknown)=>{
      if(modelStarted)await this.recordModelOutcome(task,error,true);
      const code=typeof(error as any)?.code==='string'&&/^[A-Z][A-Z0-9_]{1,60}$/.test((error as any).code)?(error as any).code:'CODING_FAILED';
      await this.db.updateTable('coding_runs').set({status:'failed',error_code:code,finished_at:new Date()}).where('task_id','=',task.id).where('lease_token','=',task.lease_token!).execute();throw error;
    });
    return abortable(()=>response,signal);
  }

  private async runStudioChange(task:TaskRow,signal:AbortSignal):Promise<unknown>{
    if(!this.options.studioChange||!task.lease_token||!task.studio_input)throw new DomainError(403,'CAPABILITY_UNAVAILABLE','تعديل الاستوديو غير مهيأ.');
    const studioInput=StudioTaskInputSchema.parse(task.studio_input);let modelStarted=false;
    const response=this.options.studioChange(task.goal,{signal,taskId:task.id,ownerId:task.owner_id,studioInput,leaseToken:task.lease_token,onModelReceipt:async receipt=>{if(!modelStarted)throw new DomainError(409,'MODEL_RECEIPT_WITHOUT_REQUEST','لم يبدأ طلب النموذج.');await this.recordModelOutcome(task,receipt);},onProgress:async stage=>{if(stage==='edits_requested'&&!modelStarted){if(!(await this.startModelRun(task)))throw new DomainError(409,'STUDIO_AUTHORIZATION_LOST','لم يعد تفويض التعديل صالحًا.');modelStarted=true;}await this.modelProgress(task,stage);}}).then(async result=>{if(modelStarted)await this.recordModelOutcome(task,result);return result;},async error=>{if(modelStarted)await this.recordModelOutcome(task,error,true);throw error;});
    return abortable(()=>response,signal);
  }

  /** Reconstruct the creation hash so a URL/scope change cannot inherit a queued task's authority. */
  private browserInput(task:TaskRow):BrowserTaskInput|null{
    const parsed=BrowserTaskInputSchema.safeParse(task.browser_input);
    if(!parsed.success)return null;
    const input:TaskCreationInput={title:task.title,goal:task.goal,capabilityId:'browser.open',autonomy:task.autonomy,browserInput:parsed.data,...(task.skill_node_input?{skillNodeInput:SkillNodeInputSchema.parse(task.skill_node_input)}:{})};
    const binding=task.skill_binding?SkillNodeBindingSchema.safeParse(task.skill_binding):null;
    if(binding&&!binding.success)return null;
    return hashInput(input,binding?.success?binding.data:undefined)===task.input_hash?parsed.data:null;
  }

  private async runBrowser(task:TaskRow,signal:AbortSignal):Promise<unknown>{
    const browserInput=this.browserInput(task);
    if(!this.options.openBrowser||!task.lease_token||!browserInput)throw new DomainError(403,'BROWSER_SCOPE_INVALID','رابط المتصفح أو نطاقه غير صالح.');
    signal.throwIfAborted();
    const messages:Record<string,string>={browser_session_created:'أُنشئت جلسة متصفح مستقلة ضمن نطاق الرابط.',browser_loading:'يجري تحميل الصفحة للقراءة فقط.',browser_observed:'حُفظت ملاحظة الصفحة ودليل لقطة المتصفح.',browser_opened:'حُمّلت الصفحة وحُفظت أدلتها.',browser_verified:'اجتازت أدلة الصفحة فحص المتصفح.'};
    return abortable(()=>this.options.openBrowser!(task.goal,{signal,taskId:task.id,ownerId:task.owner_id,browserInput,leaseToken:task.lease_token!,onProgress:async stage=>{
      signal.throwIfAborted();
      await this.db.transaction().execute(async tx=>{
        const current=await this.lockedLease(tx,task);
        if(!current||current.cancellation_requested||!(await this.validApproval(tx,current)))throw new DomainError(409,'BROWSER_AUTHORIZATION_LOST','توقف المتصفح لأن التفويض لم يعد صالحًا.');
        if(messages[stage])await event(tx,task.id,stage,messages[stage]!);
      });
    }}),signal);
  }

  private async runSkill(task:TaskRow,signal:AbortSignal):Promise<SkillAdvanceResult>{
    if(!this.options.skillRuntime||!task.workflow_token)throw new DomainError(403,'SKILL_UNAVAILABLE','تشغيل المهارات غير متاح.');
    const context=this.skillExecutionContext(task,signal);await context.assertActive();
    return abortable(()=>this.options.skillRuntime!.advance(SkillRunInputSchema.parse(task.skill_input),{...context,workflowToken:task.workflow_token!,dispatchChild:(tx,spec)=>this.createSkillChild(tx,task,spec)}),signal);
  }

  private async runSkillNode(task:TaskRow,signal:AbortSignal):Promise<unknown>{
    if(!this.options.skillRuntime)throw new DomainError(403,'SKILL_UNAVAILABLE','تشغيل المهارات غير متاح.');
    if(task.verification_only)throw new DomainError(409,'SKILL_VERIFY_READ_ONLY','استعادة التحقق لا تسمح بتنفيذ جديد.');
    const context={...this.skillExecutionContext(task,signal),binding:SkillNodeBindingSchema.parse(task.skill_binding)};
    await context.assertActive();return abortable(()=>this.options.skillRuntime!.executeNode(context),signal);
  }

  /** Independently checks output, required evidence, observation time, and database reachability. */
  private async verify(raw: unknown, shadow: boolean, capabilityId = "system.diagnostic",task?:TaskRow,signal?:AbortSignal): Promise<Record<string, unknown> | null> {
    if(capabilityId==='skill.rollback'){
      if(!task||!signal||shadow||!this.options.rollback)return null;
      const context=this.skillExecutionContext(task,signal);await context.assertActive();
      return this.options.rollback.verify(raw,SkillRollbackInputSchema.parse(task.skill_rollback_input),context);
    }
    if(capabilityId==='skill.run'||capabilityId==='skill.node'){
      if(shadow){const parsed=z.object({kind:z.literal('shadow'),capabilityId:z.literal('skill.run'),summary:z.string(),executed:z.literal(false),proposedStages:z.array(z.string())}).strict().safeParse(raw);return parsed.success?{...parsed.data,verifiedAt:new Date().toISOString()}:null;}
      if(!task||!signal||!this.options.skillRuntime)return null;
      const context=this.skillExecutionContext(task,signal);await context.assertActive();
      return capabilityId==='skill.run'?this.options.skillRuntime.verify(raw,context):this.options.skillRuntime.verifyNode(raw,this.skillNodeContext(task,signal));
    }
    if(capabilityId==='browser.open'){
      if(shadow){const parsed=z.object({kind:z.literal('shadow'),capabilityId:z.literal('browser.open'),summary:z.string(),executed:z.literal(false),proposedStages:z.array(z.string()).min(1)}).strict().safeParse(raw);return parsed.success?{...parsed.data,verifiedAt:new Date().toISOString()}:null;}
      if(!task||!this.options.verifyBrowser||!signal)return null;
      const browserInput=this.browserInput(task);if(!browserInput)return null;
      const verified=await this.options.verifyBrowser(raw,{taskId:task.id,ownerId:task.owner_id,browserInput,signal,...this.recoveryVerificationContext(task,signal)}),parsed=BrowserOpenResultSchema.safeParse(verified);
      if(!parsed.success)return null;
      const result=parsed.data,allowedOrigins=browserInput.allowedOrigins??[new URL(browserInput.url).origin];
      if(/لقطة|screenshot|screen\s*shot/i.test(task.goal)&&!result.screenshotAvailable)return null;
      if(!allowedOrigins.includes(new URL(result.url).origin)||result.screenshotUrl!==null&&result.screenshotUrl!==`/api/browser/tasks/${task.id}/screenshot`)return null;
      const age=Date.now()-new Date(result.observedAt).getTime();
      if(age < -1000||age>(task.verification_only?86400000:this.taskLeaseMs(task)))return null;
      return {...result};
    }
    if(capabilityId==='studio.change'){
      if(shadow){const parsed=z.object({kind:z.literal('shadow'),capabilityId:z.literal('studio.change'),summary:z.string(),executed:z.literal(false),proposedStages:z.array(z.string()).min(1)}).strict().safeParse(raw);return parsed.success?{...parsed.data,verifiedAt:new Date().toISOString()}:null;}
      if(!task?.studio_input||!this.options.verifyStudioChange||!signal)return null;
      const input=StudioTaskInputSchema.parse(task.studio_input),verified=await this.options.verifyStudioChange(raw,{taskId:task.id,ownerId:task.owner_id,studioInput:input,signal,...this.recoveryVerificationContext(task,signal)}),parsed=StudioChangeResultSchema.safeParse(verified);
      if(!parsed.success||parsed.data.sessionId!==input.sessionId||parsed.data.baseRevision!==input.revision||createHash('sha256').update(parsed.data.diff).digest('hex')!==parsed.data.diffHash)return null;
      if(parsed.data.outcome==='ready_for_review'&&(!parsed.data.review.passed||parsed.data.review.checks.some(check=>!check.passed)||!parsed.data.verification.passed||!parsed.data.checkpoint))return null;
      return {...parsed.data};
    }
    if(capabilityId==='coding.change'){
      if(shadow){const parsed=z.object({kind:z.literal('shadow'),capabilityId:z.literal('coding.change'),summary:z.string(),executed:z.literal(false),proposedStages:z.array(z.string()).min(1)}).strict().safeParse(raw);return parsed.success?{...parsed.data,verifiedAt:new Date().toISOString()}:null;}
      if(!task?.project_id||!this.options.verifyCode||!signal)return null;
      const verified=await this.options.verifyCode(raw,{taskId:task.id,ownerId:task.owner_id,projectId:task.project_id,signal,...this.recoveryVerificationContext(task,signal)});
      const parsed=CodingResultSchema.safeParse(verified);if(!parsed.success||parsed.data.projectId!==task.project_id||!parsed.data.sourceUnchanged||parsed.data.merged)return null;
      const result=parsed.data;
      if(result.outcome==='ready_for_review'&&(!result.review.passed||result.review.checks.some(check=>!check.passed)||result.tests.exitCode!==0||result.tests.timedOut||!result.tests.isolationVerified||!result.checkpoint))return null;
      if(createHash('sha256').update(result.diff).digest('hex')!==result.diffHash)return null;
      return {...result};
    }
    if (capabilityId === "plan.draft") {
      if (shadow) {
        const parsed = PlanningShadowSchema.safeParse(raw);
        return parsed.success ? { ...parsed.data, verifiedAt: new Date().toISOString() } : null;
      }
      const result = verifyPlanningResult(raw, this.getCapabilities());
      if (!result) return null;
      const live = await sql<{ reachable: number }>`SELECT 1 AS reachable`.execute(this.db);
      return live.rows[0]?.reachable === 1 ? { ...result } : null;
    }
    if (shadow) {
      const parsed = ShadowSchema.safeParse(raw);
      if (!parsed.success || new Set(parsed.data.proposedChecks).size !== checkNames.length) return null;
      return { ...parsed.data, verifiedAt: new Date().toISOString() };
    }
    const parsed = DiagnosticSchema.safeParse(raw);
    if (!parsed.success) return null;
    const result = parsed.data;
    if (new Set(result.checks.map((check) => check.name)).size !== checkNames.length || result.checks.some((check) => !check.passed)) return null;
    const age = Date.now() - new Date(result.observedAt).getTime();
    if (age < -1_000 || age > this.leaseMs) return null;
    const live = await sql<{ reachable: number }>`SELECT 1 AS reachable`.execute(this.db);
    if (live.rows[0]?.reachable !== 1) return null;
    if (!this.registry.some((item) => item.id === "system.diagnostic" && item.requiredScopes.length === 1 && item.requiredScopes[0] === "diagnostic:read")) return null;
    return { ...result, verifiedAt: new Date().toISOString() };
  }

  private async transitionToVerification(task: TaskRow): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const current = await this.lockedLease(tx, task);
      if (!current) return false;
      if (current.cancellation_requested) {
        await this.cancelClaim(tx, current);
        return false;
      }
      // Grants are checked again at the boundary, including expiry/revocation.
      if (!(await this.validApproval(tx, current))) {
        await tx.updateTable("tasks").set({ status: "waiting_approval", lease_token: null, lease_expires_at: null, updated_at: new Date() })
          .where("id", "=", task.id).execute();
        await event(tx, task.id, "approval_expired", "انتهت الموافقة قبل اعتماد النتيجة؛ يلزم تفويض جديد.");
        return false;
      }
      await tx.updateTable("tasks").set({ status: "verifying", updated_at: new Date() }).where("id", "=", task.id).execute();
      await event(tx, task.id, "verification_started", "يجري تحقق مستقل من بنية النتيجة والأدلة واتصال التخزين.");
      return true;
    });
  }

  private async recordTerminalTask(tx: Tx, task: TaskRow, status: 'completed' | 'failed' | 'cancelled', result?: Record<string, unknown> | null) {
    // The workflow already owns its skill nodes. A chat child retains its own
    // verified result and is linked to the parent so it cannot be counted twice.
    if (task.skill_binding) return;
    const browser = task.capability_id === 'browser.open';
    const coding = ['coding.change', 'studio.change'].includes(task.capability_id);
    const models = await tx.selectFrom('model_runs')
      .select(['model', 'input_tokens as inputTokens', 'output_tokens as outputTokens', 'usage_known as usageKnown'])
      .where('task_id', '=', task.id).orderBy('attempt').execute();
    const plan = await tx.selectFrom('task_plan_steps').select('title').where('task_id', '=', task.id).orderBy('position').execute();
    const input: ExperienceInput = {
      ownerId: task.owner_id, sourceKind: 'runtime_task', sourceId: task.id, attempt: task.attempt,
      parentRunId: task.experience_parent_run_id,
      goal: task.goal, category: browser ? 'browser' : coding ? 'coding' : 'conversation', terminalStatus: status,
      plan: plan.map(step => step.title), models: models.flatMap(({model, ...receipt}) => model === null ? [] : [{...receipt, model}]),
      trail: task.attempt && task.autonomy !== 'shadow' ? [{step: task.attempt, action: task.capability_id}] : [],
    };
    // `result` reaches this method only through the independently verified finish path.
    if (task.autonomy !== 'shadow' && result) {
      if (browser) {
        const observed = BrowserOpenResultSchema.safeParse(result);
        const requested = this.browserInput(task);
        const status = observed.success ? observed.data.documentStatus : undefined;
        if (observed.success && requested && status !== undefined && status >= 200 && (status < 300 || status >= 400) && new URL(requested.url).href === observed.data.url) {
          const captureRequired = /لقطة|screenshot|screen\s*shot/i.test(task.goal);
          const target = captureRequired ? 'requested_page_captured' : 'requested_page_opened';
          const pageLoaded = status < 300;
          input.expected = {kind: 'page_observation', target, value: true};
          input.observation = {kind: 'page_observation', target, value: pageLoaded && (!captureRequired || observed.data.screenshotAvailable), reference: observed.data.observationId};
          input.artifactHashes = [observed.data.contentHash, ...(observed.data.screenshotHash ? [observed.data.screenshotHash] : [])];
        }
      } else if (coding && (result.kind === 'coding' || result.kind === 'studio_change') && typeof result.diffHash === 'string') {
        input.expected = {kind: 'test_result', target: 'ready_for_review', value: true};
        input.observation = {kind: 'test_result', target: 'ready_for_review', value: result.outcome === 'ready_for_review', reference: result.diffHash};
        input.artifactHashes = [result.diffHash];
      } else if (task.capability_id === 'system.diagnostic' && result.kind === 'diagnostic') {
        input.expected = {kind: 'test_result', target: 'diagnostic_checks_passed', value: true};
        input.observation = {kind: 'test_result', target: 'diagnostic_checks_passed', value: true, reference: task.id};
      }
    }
    await recordExperience(tx, input);
  }

  private async cancelClaim(tx: Tx, current: TaskRow): Promise<void> {
    await tx.updateTable("tasks").set({
      status: "cancelled", lease_token: null, lease_expires_at: null, result: null, error: null, updated_at: new Date(),
    }).where("id", "=", current.id).execute();
    await event(tx, current.id, "task_cancelled", "توقف الفحص استجابة لطلب الإلغاء.");
    await this.recordTerminalTask(tx, current, 'cancelled');
  }

  private async finish(task: TaskRow, result: Record<string, unknown> | null): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const current = await this.lockedLease(tx, task);
      if (!current) return;
      if (current.cancellation_requested) { await this.cancelClaim(tx, current); return; }
      // Verification is asynchronous. Re-check the exact attempt's grant under
      // the task lock before committing any completion event or result.
      if (!(await this.validApproval(tx, current))) {
        await tx.updateTable("tasks").set({
          status: "waiting_approval", result: null, error: null, approval_required: true,
          lease_token: null, lease_expires_at: null, updated_at: new Date(),
        }).where("id", "=", task.id).execute();
        await event(tx, task.id, "approval_expired", "لم تُعتمد النتيجة لأن التفويض انتهى أو أُلغي أثناء التحقق؛ يلزم تفويض جديد.");
        return;
      }
      if (result && task.capability_id === "plan.draft" && task.autonomy !== "shadow") {
        const plan = verifyPlanningResult(result, this.getCapabilities());
        if (!plan) throw new DomainError(409, "PLAN_VERIFICATION_FAILED", "لم تجتز الخطة التحقق المستقل.");
        await tx.deleteFrom("task_plan_steps").where("task_id", "=", task.id).execute();
        for (const [position, step] of plan.plan.steps.entries()) {
          await tx.insertInto("task_plan_steps").values({
            task_id: task.id, step_id: step.id, position, title: step.title, description: step.description,
            capability_id: step.capabilityId, required_scopes: JSON.stringify(step.requiredScopes),
            requires_approval: step.requiresApproval, acceptance_criteria: JSON.stringify(step.acceptanceCriteria),
            availability: step.availability, status: "planned",
          }).execute();
        }
        for (const step of plan.plan.steps) for (const dependency of step.dependsOn) {
          await tx.insertInto("task_plan_dependencies").values({ task_id: task.id, step_id: step.id, depends_on_step_id: dependency }).execute();
        }
        await tx.updateTable("model_runs").set({ result_committed: true })
          .where("task_id", "=", task.id).where("lease_token", "=", task.lease_token!).where("status", "=", "succeeded").execute();
      }
      const codingFailed=Boolean(result&&['coding.change','studio.change'].includes(task.capability_id)&&task.autonomy!=='shadow'&&result.outcome!=='ready_for_review');
      if(result&&['coding.change','studio.change'].includes(task.capability_id)&&task.autonomy!=='shadow'){
        if(task.capability_id==='coding.change')await tx.updateTable('coding_runs').set({result_committed:true}).where('task_id','=',task.id).where('lease_token','=',task.verification_source_lease??task.lease_token!).execute();
        await tx.updateTable('model_runs').set({result_committed:true}).where('task_id','=',task.id).where('lease_token','=',task.verification_source_lease??task.lease_token!).where('status','=','succeeded').execute();
      }
      await tx.updateTable("tasks").set({
        status: result&&!codingFailed ? "completed" : "failed", result: result ? JSON.stringify(result) : null,
        error: codingFailed?'لم تجتز التغييرات الاختبارات أو المراجعة؛ النسخة معزولة ومحفوظة للفحص.':result ? null : "لم تجتز النتيجة التحقق المستقل.",
        lease_token: null, lease_expires_at: null, updated_at: new Date(),
      }).where("id", "=", task.id).execute();
      await event(tx, task.id, result&&!codingFailed ? "verification_passed" : "verification_failed",
        result ? (task.autonomy === "shadow" ? "تم التحقق من خطة المحاكاة؛ لم تُنفذ الأداة ولم يُطلب نموذج."
          : task.capability_id==='coding.change'?codingFailed?'لم تنجح الاختبارات أو المراجعة؛ حُفظ الفرق والنتائج دون دمج.':'اجتازت التغييرات الاختبارات والمراجعة، وحُفظت نقطة مراجعة دون تغيير الفرع الأصلي.'
          : task.capability_id === "plan.draft" ? "اجتازت الخطة التحقق المستقل وحُفظت خطواتها واعتمادياتها؛ لم تُنفذ الخطوات."
          : "اجتازت النتيجة التحقق المستقل، واكتملت المهمة.")
          : "رُفضت النتيجة لأن الأدلة لا تحقق معايير القبول.");
      await this.recordTerminalTask(tx, current, result && !codingFailed ? 'completed' : 'failed', result);
    });
  }

  private async executionFailed(task: TaskRow,failure?:unknown): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const current = await this.lockedLease(tx, task);
      if (!current) return;
      if (current.cancellation_requested) { await this.cancelClaim(tx, current); return; }
      const coding=['coding.change','studio.change'].includes(current.capability_id);
      const failureCode=typeof(failure as any)?.code==='string'?(failure as any).code:'';
      const terminalCoding=coding&&['RUN_ALREADY_EXISTS','PROJECT_HEAD_CHANGED','UNSAFE_EDIT_SCOPE','PROJECT_FORBIDDEN','SENSITIVE_SOURCE_REJECTED','STUDIO_REVISION_CONFLICT','STUDIO_PROPOSAL_EXISTS'].includes(failureCode);
      const retry = !terminalCoding&&current.attempt < current.max_attempts;
      const paidPlanning = ['plan.draft','coding.change','studio.change'].includes(current.capability_id) && current.autonomy !== "shadow";
      const browser=current.capability_id==='browser.open'&&current.autonomy!=='shadow';
      const needsApproval = retry && (current.approval_required || paidPlanning || browser);
      await tx.updateTable("tasks").set({
        status: retry ? needsApproval ? "waiting_approval" : "queued" : "failed", lease_token: null, lease_expires_at: null,
        ...(current.capability_id==='skill.run'?{workflow_token:null}:{}),
        approval_required: current.approval_required || paidPlanning || browser,
        available_at: sql`CURRENT_TIMESTAMP + ${this.retryDelayMs * 2 ** (current.attempt - 1)} * interval '1 millisecond'`,
        error: browser?'تعذر حسم فتح الصفحة؛ لن تعاد جلسة المتصفح تلقائيًا. راجع السجل قبل محاولة جديدة.':terminalCoding?'حُفظت بيئة هذه المهمة أو تغير نطاقها؛ راجع الأثر وأنشئ مهمة جديدة دون الكتابة فوق النسخة السابقة.':paidPlanning ? retry
          ? coding?'لم تُحسم مهمة البرمجة أو تكلفتها؛ لن تعاد دون موافقة جديدة.':"لم تُحسم نتيجة التخطيط أو تكلفته؛ لن يُعاد الطلب دون موافقة جديدة."
          : "توقف التخطيط بعد الحد الأقصى للمحاولات؛ راجع سجل استخدام النموذج."
          : retry ? "تعذر الفحص؛ حُددت إعادة محاولة آمنة." : "تعذر الفحص بعد الحد الأقصى للمحاولات.", updated_at: new Date(),
      }).where("id", "=", task.id).execute();
      await event(tx, task.id, retry ? browser ? 'browser_approval_required' : paidPlanning ? "planning_approval_required" : "retry_scheduled" : "task_failed",
        browser?'لن يُكرر فتح المتصفح تلقائيًا؛ يلزم تفويض صريح لمحاولة جديدة.':retry ? paidPlanning ? "لن يُكرر طلب النموذج تلقائيًا؛ قد تكون له تكلفة. يلزم تفويض صريح لمحاولة جديدة."
          : needsApproval ? "تحتاج إعادة المحاولة موافقة جديدة؛ استُهلكت الموافقة السابقة." : "حُددت إعادة محاولة للفحص الآمن ضمن الحد المسموح."
          : "توقفت المهمة بعد استنفاد محاولات الفحص.", { attempt: current.attempt });
      if (!retry) await this.recordTerminalTask(tx, current, 'failed');
    });
  }

  private async runTick(): Promise<Task | null> {
    await this.recoverExpired();
    await (this.options.rollback?.recoverExpired??this.options.recoverSkillRollbacks)?.();
    await this.wakeSkillParents();
    const task = await this.claim();
    if (!task) return null;
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    // Built-in tools finish well within the lease. An unresponsive custom tool
    // cannot commit after expiry; the next worker recovers only this read-only tool.
    const timeout = setTimeout(() => controller.abort(new Error("TASK_TIMEOUT")), Math.max(500, this.taskLeaseMs(task) - 500));
    let authorizationWatch:Promise<void>|null=null;
    // A long navigation must stop when its exact task authority expires, is revoked, or is fenced by another worker.
    const authorizationTimer=(task.capability_id==='browser.open'||task.capability_id==='skill.run'||task.capability_id==='skill.rollback'||Boolean(task.skill_binding))&&task.autonomy!=='shadow'?setInterval(()=>{
      if(authorizationWatch||controller.signal.aborted)return;
      authorizationWatch=this.db.transaction().execute(async tx=>{
        const current=await this.lockedLease(tx,task);
        if(!current||current.cancellation_requested||!(await this.validApproval(tx,current)))controller.abort(new Error('BROWSER_AUTHORIZATION_LOST'));
      }).catch(()=>{controller.abort(new Error('BROWSER_AUTHORIZATION_LOST'));}).finally(()=>{authorizationWatch=null;});
    },500):null;
    try {
      const allowed = await this.db.transaction().execute(async (tx) => {
        const current = await this.lockedLease(tx, task);
        if (!current) return false;
        if (current.cancellation_requested) { await this.cancelClaim(tx, current); return false; }
        if (!(await this.validApproval(tx, current))) {
          await tx.updateTable("tasks").set({ status: "waiting_approval", lease_token: null, lease_expires_at: null, updated_at: new Date() }).where("id", "=", task.id).execute();
          await event(tx, task.id, "approval_expired", "أوقفت الأداة لأن تفويض المهمة لم يعد صالحًا.");
          return false;
        }
        return true;
      });
      if (allowed) {
        if(task.verification_only){await this.recoverVerifiedTask(task,controller.signal);}
        else {
        if(task.skill_binding&&task.capability_id!=='skill.node'&&task.autonomy!=='shadow'){
          const context={...this.skillExecutionContext(task,controller.signal),binding:SkillNodeBindingSchema.parse(task.skill_binding)};
          if(!this.options.skillRuntime?.beforeMappedExecute||!this.options.skillRuntime.recordChildResult)throw new DomainError(403,'SKILL_GATEWAY_UNAVAILABLE','بوابة توثيق الأداة غير متاحة.');
          await context.assertActive();await this.options.skillRuntime.beforeMappedExecute(context);await context.assertActive();
        }
        const raw = task.autonomy === "shadow"
          ? task.capability_id==='skill.run'
            ? {kind:'shadow',capabilityId:'skill.run',summary:'محاكاة المخطط فقط؛ لم تُنشأ مهام فرعية ولم تُنفذ أدوات.',executed:false,proposedStages:['validate_graph','dispatch_children','verify_evidence']}
          : task.capability_id==='browser.open'
            ? {kind:'shadow',capabilityId:'browser.open',summary:'محاكاة فتح الرابط للقراءة فقط؛ لم تُنشأ جلسة متصفح ولم تُحمّل صفحة أو لقطة.',executed:false,proposedStages:['browser_session_created','browser_loading','browser_observed']}
          : task.capability_id==='studio.change'
            ? {kind:'shadow',capabilityId:'studio.change',summary:'اقتراح محلي لمسار التعديل؛ لم يُرسل سياق أو صورة إلى نموذج ولم تُنشأ نسخة أو معاينة.',executed:false,proposedStages:['project_inspected','edits_requested','tests_finished','review_finished']}
          : task.capability_id==='coding.change'
            ? {kind:'shadow',capabilityId:'coding.change',summary:'اقتراح لمسار البرمجة فقط؛ لم يُطلب نموذج ولم يُنشأ Worktree أو يُشغل كود.',executed:false,proposedStages:['project_inspected','worktree_created','tests_finished','review_finished']}
          : task.capability_id === "plan.draft"
            ? { kind: "shadow", capabilityId: "plan.draft", summary: "محاكاة محلية لمسار التخطيط فقط؛ لم يُرسل الهدف إلى مزود نموذج ولم تُستهلك توكنات.", executed: false, proposedStages: ["goal_compiled", "model_selected", "plan_verified"] }
            : { kind: "shadow", summary: "خطة محاكاة لفحص التخزين والقدرات والصلاحية؛ لم تنفذ الأداة.", executed: false, proposedChecks: [...checkNames] }
          : task.capability_id==='skill.rollback'?await abortable(()=>this.options.rollback!.execute(SkillRollbackInputSchema.parse(task.skill_rollback_input),this.skillExecutionContext(task,controller.signal)),controller.signal)
          : task.capability_id==='skill.run'?await this.runSkill(task,controller.signal)
          : task.capability_id==='skill.node'?await this.runSkillNode(task,controller.signal)
          : task.capability_id==='browser.open'?await this.runBrowser(task,controller.signal)
          : task.capability_id==='studio.change'?await this.runStudioChange(task,controller.signal)
          : task.capability_id==='coding.change'?await this.runCoding(task,controller.signal)
          : task.capability_id === "plan.draft" ? await this.runPlanning(task, controller.signal)
            : await abortable(() => this.options.executeDiagnostic?.(controller.signal) ?? this.runDiagnostic(controller.signal), controller.signal);
        controller.signal.throwIfAborted();
        const skillAdvance=task.capability_id==='skill.run'&&task.autonomy!=='shadow'?raw as SkillAdvanceResult:null;
        if(skillAdvance?.kind==='pending')await this.pauseSkillParent(task,skillAdvance);
        else if (await this.transitionToVerification(task)) {
          const verify=()=>this.verify(skillAdvance?.kind==='complete'?skillAdvance.result:raw, task.autonomy === "shadow", task.capability_id,task,controller.signal);
          const result = task.capability_id==='browser.open'?await abortable(verify,controller.signal):await verify();
          controller.signal.throwIfAborted();
          if(task.skill_binding&&task.capability_id!=='skill.node'&&task.autonomy!=='shadow'){
            const context={...this.skillExecutionContext(task,controller.signal),binding:SkillNodeBindingSchema.parse(task.skill_binding)};
            if(result)await this.options.skillRuntime!.recordChildResult!(result,context);
            else await this.options.skillRuntime?.recordChildFailure?.(new Error('SKILL_CHILD_VERIFICATION_FAILED'),context);
          }
          await this.finish(task, result);
        }
        }
      }
    } catch (failure) {
      if(task.skill_binding&&task.capability_id!=='skill.node'&&task.autonomy!=='shadow'&&!task.verification_only){
        try{await this.options.skillRuntime?.recordChildFailure?.(failure,{...this.skillExecutionContext(task,controller.signal),binding:SkillNodeBindingSchema.parse(task.skill_binding)});}catch{this.options.onError?.(new Error('SKILL_EVIDENCE_FINALIZATION_FAILED'));}
      }
      // Tool exceptions can contain provider credentials or SQL details. Persist only a safe error.
      if (['plan.draft','coding.change','studio.change'].includes(task.capability_id) && task.autonomy !== "shadow") {
        await this.db.updateTable("model_runs").set({ status: "unknown", finished_at: new Date(), error_code: "MODEL_OUTCOME_UNKNOWN" })
          .where("task_id", "=", task.id).where("lease_token", "=", task.lease_token!).where("status", "=", "started").execute();
        if(task.capability_id==='coding.change')await this.db.updateTable('coding_runs').set({status:'unknown',finished_at:new Date(),error_code:'CODING_OUTCOME_UNKNOWN'}).where('task_id','=',task.id).where('lease_token','=',task.lease_token!).where('status','=','started').execute();
      }
      await this.executionFailed(task,failure);
    } finally {
      clearTimeout(timeout);
      if(authorizationTimer)clearInterval(authorizationTimer);
      await authorizationWatch;
      this.controllers.delete(task.id);
    }
    const row = await this.db.selectFrom("tasks").selectAll().where("id", "=", task.id).executeTakeFirstOrThrow();
    if(['completed','failed','cancelled'].includes(row.status)&&this.options.onTaskSettled){try{await this.options.onTaskSettled(row.owner_id,row.id);}catch{this.options.onError?.(new Error('MEMORY_SYNC_FAILED'));}}
    return taskDto(row);
  }
}
