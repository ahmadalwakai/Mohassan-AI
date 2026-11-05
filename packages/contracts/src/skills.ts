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
export const SkillDetailSchema = z.object({
  skill: SkillVersionSchema, contract: SkillContractSchema, source: SkillSourceSchema.nullable(), files: z.array(SkillFileSummarySchema), versions: z.array(SkillVersionSchema), audit: z.array(SkillAuditEventSchema),
}).strict();
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

const ReceiptBase = { runId: z.uuid(), skillVersionId: z.uuid(), contentHash: Sha256, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']), evidenceIds: z.array(z.uuid()).max(64) };
/** Each level carries different proof, so an instruction run cannot be shaped into an execution receipt. */
export const SkillExecutionReceiptSchema = z.discriminatedUnion('level', [
  z.object({ ...ReceiptBase, level: z.literal('instruction'), execution: z.literal('model_guided') }).strict(),
  z.object({ ...ReceiptBase, level: z.literal('tool'), execution: z.literal('tool_gateway'), tools: z.array(SkillToolIdSchema).min(1).max(12) }).strict(),
  z.object({ ...ReceiptBase, level: z.literal('executable'), execution: z.literal('isolated_script'), isolation: z.object({ provider: z.string().min(1).max(64), verified: z.literal(true), sharesHostKernel: z.boolean(), network: z.literal('denied') }).strict() }).strict(),
]);
export type SkillExecutionReceipt = z.infer<typeof SkillExecutionReceiptSchema>;
