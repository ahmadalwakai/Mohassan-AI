import { z } from 'zod';

export const SKILL_LIMITS = Object.freeze({ timeoutMs: 20_000, memoryMb: 512, outputMaxBytes: 1_048_576, maxAttempts: 3 });

export const SkillCategorySchema = z.enum(['reasoning', 'coding', 'browser', 'computer', 'design', 'creativity', 'documents', 'languages', 'business', 'marketing', 'research', 'security', 'analytics', 'media']);
export type SkillCategory = z.infer<typeof SkillCategorySchema>;

/** The level states what a skill really does. A prompt can never be reported as execution. */
export const SkillLevelSchema = z.enum(['instruction', 'tool', 'executable']);
export type SkillLevel = z.infer<typeof SkillLevelSchema>;
export const SkillOriginSchema = z.enum(['builtin', 'custom', 'local_import', 'forge']);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;
export const SkillStatusSchema = z.enum(['quarantined', 'inspected', 'tested', 'benchmarked', 'active', 'deprecated', 'revoked', 'rejected', 'incompatible', 'stale']);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;
export const SkillSideEffectSchema = z.enum(['none', 'read', 'write_local', 'external', 'financial']);
export type SkillSideEffect = z.infer<typeof SkillSideEffectSchema>;

export const SkillToolIdSchema = z.enum(['browser.open', 'browser.interact', 'browser.submit', 'research.run', 'vision.inspect', 'coding.change', 'studio.change', 'computer.view', 'computer.act', 'memory.search', 'file.read', 'file.write']);
export type SkillToolId = z.infer<typeof SkillToolIdSchema>;

/** The least a tool does. A contract may declare more, never less. */
export const TOOL_SIDE_EFFECTS: Readonly<Record<SkillToolId, SkillSideEffect>> = Object.freeze({
  'browser.open': 'read', 'browser.interact': 'write_local', 'browser.submit': 'external', 'research.run': 'read', 'vision.inspect': 'read',
  'coding.change': 'write_local', 'studio.change': 'write_local', 'computer.view': 'read', 'computer.act': 'external',
  'memory.search': 'read', 'file.read': 'read', 'file.write': 'write_local',
});

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/).max(64);
const Version = z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})$/);
const FieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
const StepId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const RelativeFile = z.string().min(1).max(180).regex(/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u).refine((path) => !path.split('/').some((part) => part === '.' || part === '..'), 'مسار غير صالح.');

export const SkillFieldSchema = z.object({
  name: FieldName, type: z.enum(['string', 'number', 'boolean', 'url', 'file', 'json']), required: z.boolean().default(true), description: z.string().trim().min(1).max(300),
}).strict();

export const SkillStepSchema = z.object({
  id: StepId, kind: z.enum(['tool', 'model', 'script']), title: z.string().trim().min(1).max(120),
  tool: SkillToolIdSchema.optional(), entry: RelativeFile.optional(),
  dependsOn: z.array(StepId).max(12).default([]),
  // Each value names `input.<field>` or `<stepId>.<output>`; a literal never becomes an instruction.
  inputs: z.record(FieldName, z.string().min(1).max(120)).default({}),
  outputs: z.array(SkillFieldSchema).max(12).default([]),
}).strict().superRefine((step, context) => {
  if (new Set(step.outputs.map(field => field.name)).size !== step.outputs.length) context.addIssue({ code: 'custom', path: ['outputs'], message: 'أسماء نواتج الخطوة يجب أن تكون فريدة.' });
  if (step.kind === 'tool' && !step.tool) context.addIssue({ code: 'custom', path: ['tool'], message: 'خطوة الأداة تحتاج أداة محددة.' });
  if (step.kind === 'script' && !step.entry) context.addIssue({ code: 'custom', path: ['entry'], message: 'خطوة السكربت تحتاج ملف دخول.' });
  if (step.kind !== 'tool' && step.tool) context.addIssue({ code: 'custom', path: ['tool'], message: 'الأداة تخص خطوة الأداة فقط.' });
  if (step.kind !== 'script' && step.entry) context.addIssue({ code: 'custom', path: ['entry'], message: 'ملف الدخول يخص خطوة السكربت فقط.' });
});
export type SkillStep = z.infer<typeof SkillStepSchema>;

const WRITING_EFFECTS: readonly SkillSideEffect[] = ['write_local', 'external', 'financial'];

export const SkillContractSchema = z.object({
  slug: Slug, name: z.string().trim().min(3).max(100), description: z.string().trim().min(10).max(1000), version: Version,
  category: SkillCategorySchema, level: SkillLevelSchema,
  inputs: z.array(SkillFieldSchema).max(16).default([]), outputs: z.array(SkillFieldSchema).max(16).default([]),
  steps: z.array(SkillStepSchema).max(12).default([]),
  requires: z.object({
    tools: z.array(SkillToolIdSchema).max(12).default([]),
    scopes: z.array(z.string().regex(/^[a-z]+:[a-z]+$/)).max(12).default([]),
    paths: z.array(RelativeFile).max(12).default([]),
  }).strict().default({ tools: [], scopes: [], paths: [] }),
  sideEffects: SkillSideEffectSchema.default('none'),
  execution: z.object({
    timeoutMs: z.number().int().min(100).max(SKILL_LIMITS.timeoutMs),
    memoryMb: z.number().int().min(16).max(SKILL_LIMITS.memoryMb),
    outputMaxBytes: z.number().int().min(1).max(SKILL_LIMITS.outputMaxBytes),
  }).strict().optional(),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(SKILL_LIMITS.maxAttempts) }).strict().default({ maxAttempts: 1 }),
  idempotent: z.boolean().default(false),
  rollback: z.object({ mode: z.enum(['none', 'restore_preimage', 'manual']), note: z.string().trim().min(1).max(300).optional() }).strict().default({ mode: 'none' }),
  verification: z.string().trim().min(5).max(500).optional(),
  conflicts: z.array(Slug).max(12).default([]), dependsOn: z.array(Slug).max(12).default([]),
}).strict().superRefine((contract, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  for (const field of ['inputs', 'outputs'] as const) if (new Set(contract[field].map(value => value.name)).size !== contract[field].length) issue(field, 'أسماء الحقول يجب أن تكون فريدة.');
  const ids = new Set(contract.steps.map((step) => step.id));
  if (ids.size !== contract.steps.length) issue('steps', 'معرفات الخطوات يجب أن تكون فريدة.');
  for (const step of contract.steps) for (const dependency of step.dependsOn) if (!ids.has(dependency) || dependency === step.id) issue('steps', `اعتماد غير صالح: ${dependency}`);
  for (const step of contract.steps) if (step.tool && !contract.requires.tools.includes(step.tool)) issue('steps', `الأداة ${step.tool} غير مصرح بها في العقد.`);
  if (contract.level === 'instruction') {
    if (contract.steps.length) issue('steps', 'مهارة التعليمات لا تحتوي خطوات تنفيذ.');
    if (contract.execution) issue('execution', 'مهارة التعليمات لا تحتوي إعداد تشغيل.');
  }
  if (contract.level === 'tool') {
    if (!contract.steps.some((step) => step.kind === 'tool')) issue('steps', 'المهارة المتكاملة تحتاج خطوة أداة واحدة على الأقل.');
    if (contract.steps.some((step) => step.kind === 'script')) issue('steps', 'خطوات السكربت تخص المهارات التنفيذية فقط.');
  }
  if (contract.level === 'executable') {
    if (!contract.steps.some((step) => step.kind === 'script')) issue('steps', 'المهارة التنفيذية تحتاج خطوة سكربت.');
    if (!contract.execution) issue('execution', 'المهارة التنفيذية تحتاج حدود تشغيل صريحة.');
  }
  if (contract.level !== 'instruction' && !contract.verification) issue('verification', 'التنفيذ يحتاج شرط تحقق مستقل.');
  if (!contract.idempotent && contract.retry.maxAttempts > 1) issue('retry', 'إعادة المحاولة تحتاج مهارة idempotent.');
  if (WRITING_EFFECTS.includes(contract.sideEffects) && contract.rollback.mode === 'none') issue('rollback', 'الأثر الجانبي يحتاج وصف تراجع.');
  if (contract.rollback.mode === 'manual' && !contract.rollback.note) issue('rollback', 'التراجع اليدوي يحتاج وصفاً.');
  if (contract.conflicts.includes(contract.slug) || contract.dependsOn.includes(contract.slug)) issue('conflicts', 'لا يمكن للمهارة الإشارة إلى نفسها.');
});
export type SkillContract = z.infer<typeof SkillContractSchema>;

export const SkillSourceSchema = z.object({
  kind: z.enum(['builtin', 'local_folder', 'forge', 'memory']), locator: z.string().max(500), observedAt: z.iso.datetime(), fileCount: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
}).strict();
export const SkillVersionSchema = z.object({
  id: z.uuid(), familyId: z.uuid(), slug: Slug, name: z.string(), description: z.string(), category: SkillCategorySchema,
  version: z.string(), revision: z.number().int().positive(), level: SkillLevelSchema, origin: SkillOriginSchema, status: SkillStatusSchema, statusReason: z.string().nullable(),
  contentHash: Sha256, active: z.boolean(), readOnly: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

export const SkillRegistryQuerySchema = z.object({
  q: z.string().trim().max(200).default(''), category: SkillCategorySchema.optional(), level: SkillLevelSchema.optional(), status: SkillStatusSchema.optional(), origin: SkillOriginSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();
export type SkillRegistryQuery = z.infer<typeof SkillRegistryQuerySchema>;
export const SkillRegistryResultSchema = z.object({
  items: z.array(SkillVersionSchema), total: z.number().int().nonnegative(),
  counts: z.object({ category: z.record(z.string(), z.number().int()), level: z.record(z.string(), z.number().int()) }).strict(),
}).strict();
export type SkillRegistryResult = z.infer<typeof SkillRegistryResultSchema>;

export const SkillAuditEventSchema = z.object({ id: z.uuid(), targetId: z.string(), event: z.string().min(1).max(64), detail: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime() }).strict();
export type SkillAuditEvent = z.infer<typeof SkillAuditEventSchema>;
export const SkillFileSummarySchema = z.object({ path: z.string(), kind: z.enum(['instructions', 'script', 'reference', 'data']), contentHash: Sha256, sizeBytes: z.number().int().nonnegative() }).strict();
export const SkillFindingSchema = z.object({
  code: z.string().min(1).max(64), severity: z.enum(['info', 'warn', 'block', 'incompatible']), path: z.string().max(200).nullable(), line: z.number().int().positive().nullable(), message: z.string().min(1).max(300),
}).strict();
export type SkillFinding = z.infer<typeof SkillFindingSchema>;
export const SkillVerdictSchema = z.enum(['pass', 'review', 'fail', 'incompatible']);
export type SkillVerdict = z.infer<typeof SkillVerdictSchema>;
export const SkillInspectionSchema = z.object({ id: z.uuid(), contentHash: Sha256, inspectorVersion: z.string(), verdict: SkillVerdictSchema, findings: z.array(SkillFindingSchema).max(200), createdAt: z.iso.datetime() }).strict();
export type SkillInspection = z.infer<typeof SkillInspectionSchema>;
export const SkillGrantSchema = z.object({ id: z.uuid(), contentHash: Sha256, tools: z.array(SkillToolIdSchema), scopes: z.array(z.string()), roots: z.array(z.string()), expiresAt: z.iso.datetime(), revokedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime() }).strict();
export type SkillGrant = z.infer<typeof SkillGrantSchema>;

export const SkillDetailSchema = z.object({
  skill: SkillVersionSchema, contract: SkillContractSchema, source: SkillSourceSchema.nullable(), files: z.array(SkillFileSummarySchema), versions: z.array(SkillVersionSchema), audit: z.array(SkillAuditEventSchema),
  inspection: SkillInspectionSchema.nullable(), grants: z.array(SkillGrantSchema),
}).strict();
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillImportSchema = z.object({ path: z.string().min(3).max(1000) }).strict();
export const SkillImportResultSchema = z.object({ skill: SkillVersionSchema, deduplicated: z.boolean() }).strict();
export type SkillImportResult = z.infer<typeof SkillImportResultSchema>;
const Expected = { expectedRevision: z.number().int().positive() };
const Reason = z.string().trim().min(3).max(500);
export const SkillInspectRequestSchema = z.object(Expected).strict();
export const SkillActivateSchema = z.object({ ...Expected, approve: z.literal(true), acknowledgeFindings: z.boolean().default(false), evaluationId: z.uuid().optional() }).strict();
export const SkillRevokeSchema = z.object({ ...Expected, reason: Reason }).strict();
export const SkillRollbackSchema = z.object({ ...Expected, approve: z.literal(true), reason: Reason, evaluationId: z.uuid().optional() }).strict();
export const SkillGrantCreateSchema = z.object({
  ...Expected, approve: z.literal(true), tools: z.array(SkillToolIdSchema).max(12).default([]), scopes: z.array(z.string().regex(/^[a-z]+:[a-z]+$/)).max(12).default([]),
  roots: z.array(z.string().min(3).max(1000)).max(4).default([]), durationHours: z.number().int().min(1).max(720),
}).strict();
export const SkillGrantRevokeSchema = z.object({ reason: Reason }).strict();

export const SkillBindingSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}\.[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
export const SkillCompositionNodeSchema = z.object({ id: StepId, skillId: z.uuid(), inputs: z.record(FieldName, SkillBindingSchema).default({}), dependsOn: z.array(StepId).max(12).default([]) }).strict();
export const SkillCompositionRequestSchema = z.object({ nodes: z.array(SkillCompositionNodeSchema).min(1).max(12), inputs: z.array(SkillFieldSchema).max(16).default([]) }).strict();
export type SkillCompositionRequest = z.infer<typeof SkillCompositionRequestSchema>;
export type SkillCompositionNode = z.infer<typeof SkillCompositionNodeSchema>;
/** The categories match the gap detector: a refusal says what is actually missing. */
export const SkillPlanIssueCategorySchema = z.enum(['invalid_plan', 'missing_skill', 'missing_tool', 'missing_permission', 'environment_failure', 'conflict']);
export const SkillPlanIssueSchema = z.object({ code: z.string().min(1).max(64), severity: z.enum(['error', 'warning']), category: SkillPlanIssueCategorySchema, nodeId: z.string().nullable(), message: z.string().min(1).max(300) }).strict();
export type SkillPlanIssue = z.infer<typeof SkillPlanIssueSchema>;
export const SkillCompositionResultSchema = z.object({
  valid: z.boolean(), batches: z.array(z.array(z.string())).max(12), issues: z.array(SkillPlanIssueSchema).max(200),
  nodes: z.array(z.object({ id: z.string(), skillId: z.string(), slug: z.string().nullable(), level: SkillLevelSchema.nullable(), role: z.enum(['context', 'execute']).nullable(), sideEffects: SkillSideEffectSchema.nullable(), requiresApproval: z.boolean() }).strict()).max(12),
}).strict();
export type SkillCompositionResult = z.infer<typeof SkillCompositionResultSchema>;

const ReceiptBase = { runId: z.uuid(), skillVersionId: z.uuid(), contentHash: Sha256, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']), evidenceIds: z.array(z.uuid()).max(64) };
/** Each level carries different proof, so an instruction run cannot be shaped into an execution receipt. */
export const SkillExecutionReceiptSchema = z.discriminatedUnion('level', [
  z.object({ ...ReceiptBase, level: z.literal('instruction'), execution: z.literal('model_guided') }).strict(),
  z.object({ ...ReceiptBase, level: z.literal('tool'), execution: z.literal('tool_gateway'), tools: z.array(SkillToolIdSchema).min(1).max(12) }).strict(),
  z.object({ ...ReceiptBase, level: z.literal('executable'), execution: z.literal('isolated_script'), isolation: z.object({ provider: z.string().min(1).max(64), verified: z.literal(true), sharesHostKernel: z.boolean(), network: z.literal('denied') }).strict() }).strict(),
]);
export type SkillExecutionReceipt = z.infer<typeof SkillExecutionReceiptSchema>;

/** JSON payloads stay bounded before persistence or tool-schema validation. */
export function isBoundedSkillJson(value: unknown): boolean {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 65536;
    if (Array.isArray(item)) return item.length <= 256 && item.every(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    const keys = Object.keys(item);
    return keys.length <= 128 && keys.every(key => key.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(key) && visit((item as Record<string, unknown>)[key], depth + 1));
  };
  if (!visit(value, 0)) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 65536; } catch { return false; }
}
export const SkillRunInputSchema = z.object({ plan: SkillCompositionRequestSchema, values: z.record(FieldName, z.unknown()).refine(isBoundedSkillJson, 'مدخلات المهارة ليست JSON محدودة صالحة.') }).strict();
export type SkillRunInput = z.infer<typeof SkillRunInputSchema>;
export const SkillNodeBindingSchema = z.object({
  parentTaskId: z.uuid(), runId: z.uuid(), nodeId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}\.[a-zA-Z][a-zA-Z0-9_-]{0,47}$/),
  versionId: z.uuid(), contentHash: Sha256, inputsHash: Sha256, kind: z.enum(['tool', 'model', 'script']), tool: SkillToolIdSchema.optional(),
}).strict().superRefine((binding, context) => {
  if ((binding.kind === 'tool') !== Boolean(binding.tool)) context.addIssue({ code: 'custom', path: ['tool'], message: 'الأداة مطلوبة لعقدة الأداة فقط.' });
});
export type SkillNodeBinding = z.infer<typeof SkillNodeBindingSchema>;

export const SkillRunRequestSchema = z.object({
  expectedRevision: Expected.expectedRevision, goal: z.string().trim().min(5).max(4000).optional(),
  values: SkillRunInputSchema.shape.values, plan: SkillCompositionRequestSchema.optional(),
}).strict();
export const SkillRunStatusSchema = z.enum(['running', 'waiting_children', 'succeeded', 'failed', 'cancelled', 'unknown']);
export const SkillNodeStatusSchema = z.enum(['pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']);
export const SkillRunSummarySchema = z.object({
  id: z.uuid(), parentTaskId: z.uuid(), status: SkillRunStatusSchema, inputHash: Sha256, errorCode: z.string().max(100).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  nodes: z.array(z.object({
    id: z.string().max(97), versionId: z.uuid(), contentHash: Sha256, kind: z.enum(['tool', 'model', 'script']), tool: SkillToolIdSchema.nullable(),
    status: SkillNodeStatusSchema, childTaskId: z.uuid().nullable(), attempt: z.number().int().nonnegative(), executionAttempt: z.number().int().min(1).max(3), retryNotBefore: z.iso.datetime().nullable(), recoveryReason: z.string().max(100).nullable(), inputsHash: Sha256.nullable(), outputHash: Sha256.nullable(),
    errorCode: z.string().max(100).nullable(), startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(),
  }).strict()).max(144),
}).strict();
export type SkillRunSummary = z.infer<typeof SkillRunSummarySchema>;
export const SkillEvidenceQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(10).default(5), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
export const SkillEvidencePageSchema = z.object({
  runId: z.uuid(), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(10),
  items: z.array(z.object({
    id: z.uuid(), nodeId: z.string().max(97), taskId: z.uuid(), versionId: z.uuid(), contentHash: Sha256, inputsHash: Sha256, attempt: z.number().int().min(1).max(3),
    status: z.enum(['started', 'succeeded', 'failed', 'unknown']), outputHash: Sha256.nullable(), errorCode: z.string().max(100).nullable(),
    createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
    details: z.array(z.object({ kind: z.string().max(64), data: z.unknown() }).strict()).max(32),
  }).strict()).max(10),
}).strict();

/** Plain-text source review is not an execution or security approval. */
export const SkillFileContentQuerySchema = z.object({ path: RelativeFile }).strict();
export const SkillFileContentSchema = z.object({
  versionId: z.uuid(), versionContentHash: Sha256,
  file: SkillFileSummarySchema.extend({ path: RelativeFile, content: z.string().max(256000), sizeBytes: z.number().int().min(0).max(256000) }).strict(),
  contentVerified: z.literal(true), readOnly: z.literal(true),
}).strict();
export type SkillFileContent = z.infer<typeof SkillFileContentSchema>;
