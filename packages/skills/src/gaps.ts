import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  SkillGapClassificationSchema, SkillGapObservationSchema, SkillGapPageSchema, SkillGapQuerySchema, SkillGapSignalSchema,
  type SkillGapClassification, type SkillGapObservation, type SkillGapSignal,
} from '../../contracts/src/skill-gaps.ts';
import { SkillError } from './errors.ts';

type Category = NonNullable<SkillGapClassification['category']>;
type Source = SkillGapSignal['source'];
const known = new Map<string, Category>();
function codes(category: Category, sources: Source[], values: string[]) { for (const source of sources) for (const code of values) known.set(`${source}:${code}`, category); }
codes('missing_skill', ['planner', 'tool'], ['SKILL_NOT_FOUND', 'SKILL_NOT_ACTIVE', 'skill_not_found', 'skill_not_active', 'missing_skill_dependency']);
codes('missing_tool', ['planner', 'tool', 'environment'], ['SKILL_TOOL_UNAVAILABLE', 'tool_unavailable', 'TOOL_UNAVAILABLE', 'TOOL_NOT_CONFIGURED']);
codes('missing_permission', ['planner', 'tool'], ['SKILL_TOOL_PERMISSION_REQUIRED', 'SKILL_SCOPE_REVOKED', 'SKILL_ROOT_GRANT_REVOKED', 'tool_not_granted', 'scope_not_granted', 'AGENT_EFFECT_DENIED', 'CHAT_EFFECT_UNSUPPORTED']);
codes('missing_permission', ['workflow'], ['APPROVAL_REQUIRED', 'APPROVAL_PENDING']);
codes('invalid_plan', ['planner', 'tool'], ['SKILL_COMPOSITION_INVALID', 'SKILL_PLAN_TARGET_MISMATCH', 'SKILL_GRAPH_INVALID', 'SKILL_INPUT_REQUIRED', 'SKILL_INPUT_TYPE', 'SKILL_INPUT_UNKNOWN', 'SKILL_OUTPUT_MISSING', 'SKILL_OUTPUT_PRODUCER_INVALID', 'SKILL_NOT_INSTRUCTION', 'SKILL_INSTRUCTION_ONLY', 'CHAT_SKILL_INPUT', 'CHAT_SKILL_REFERENCE', 'ASSISTANT_INPUT', 'ASSISTANT_REF_UNKNOWN', 'invalid_plan', 'conflict']);
codes('invalid_plan', ['planner', 'tool'], ['SKILL_TOOL_UNDECLARED', 'SKILL_MODEL_SCOPE_REQUIRED', 'SKILL_MODEL_PERMISSION_REQUIRED', 'SKILL_INSPECTION_FAILED', 'skill_inspection_failed', 'step_binding_invalid', 'step_binding_unknown', 'step_cycle', 'duplicate_node', 'duplicate_input', 'reserved_node_id', 'self_dependency', 'unknown_dependency', 'unknown_input', 'unknown_plan_input', 'unknown_output', 'type_mismatch', 'missing_input', 'cycle', 'skill_dependency_unordered', 'declared_conflict', 'resource_conflict']);
codes('stale_data', ['planner', 'tool'], ['SKILL_INSPECTION_STALE', 'SKILL_INTEGRITY_FAILED', 'SKILL_VERSION_CONFLICT', 'SKILL_AUTHORITY_REVOKED', 'skill_inspection_stale', 'skill_integrity_failed', 'AGENT_REF_STALE', 'AGENT_APPROVAL_STALE', 'AGENT_AUTHORITY_STALE', 'CHAT_APPROVAL_STALE', 'CHAT_SECURE_PAGE_CHANGED']);
codes('sandbox_restriction', ['planner', 'tool', 'environment'], ['SKILL_EXECUTABLE_GATES_CLOSED', 'SKILL_SANDBOX_UNVERIFIED', 'SANDBOX_UNAVAILABLE', 'SANDBOX_OUTPUT_REJECTED', 'isolation_gates_closed']);
codes('environment_failure', ['environment'], ['NETWORK_ERROR', 'ABORTED', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'MODEL_UNAVAILABLE', 'NOT_CONFIGURED', 'ASSISTANT_UNCONFIGURED', 'AGENT_BROWSER_UNAVAILABLE']);
codes('environment_failure', ['planner', 'tool'], ['model_unavailable', 'AGENT_CLICK_FAILED', 'AGENT_TYPE_FAILED', 'AGENT_SELECT_FAILED', 'AGENT_PAGE_UNREADABLE', 'BROWSER_FETCH_FAILED', 'BROWSER_DNS_FAILED', 'SKILL_TOOL_VERIFY_FAILED', 'SKILL_RESOURCE_BUSY', 'SKILL_CIRCUIT_OPEN']);
codes('model_limitation', ['model'], ['INCOMPLETE_RESPONSE', 'RESPONSE_TOO_LARGE', 'SCHEMA_TOO_LARGE', 'IMAGE_TOO_LARGE']);

const actions: Record<Category | 'insufficient_evidence', SkillGapClassification['action']> = {
  missing_skill: { kind: 'review_skill_library', label: 'راجع المهارات المتاحة؛ الاستيراد والتفعيل يحتاجان مراجعة مستقلة.', automatic: false, requiresApproval: true },
  missing_tool: { kind: 'configure_tool', label: 'راجع تهيئة الأداة وتوفر محول تنفيذها.', automatic: false, requiresApproval: true },
  missing_permission: { kind: 'review_permission', label: 'راجع نطاق الموافقة أو المنحة المطلوبة قبل المتابعة.', automatic: false, requiresApproval: true },
  model_limitation: { kind: 'simplify_task', label: 'قلّل حجم الطلب أو جزّئه ضمن حدود النموذج المعلنة.', automatic: false, requiresApproval: false },
  invalid_plan: { kind: 'revise_plan', label: 'صحّح مخطط المهمة ومدخلاته ثم أعد التحقق منه.', automatic: false, requiresApproval: false },
  stale_data: { kind: 'refresh_data', label: 'حدّث المشاهدة أو الإصدار وأعد التحقق؛ لا تُعد استخدام الموافقة القديمة.', automatic: false, requiresApproval: false },
  environment_failure: { kind: 'review_environment', label: 'راجع دليل الخطأ وتهيئة الخدمة أو المورد قبل أي إعادة محاولة.', automatic: false, requiresApproval: false },
  sandbox_restriction: { kind: 'review_sandbox', label: 'راجع بوابات العزل؛ تبقى المهارات التنفيذية محجوبة حتى إثباتها.', automatic: false, requiresApproval: false },
  insufficient_evidence: { kind: 'inspect_evidence', label: 'الأدلة غير كافية لتحديد السبب؛ راجع السجل دون افتراض قدرة مفقودة.', automatic: false, requiresApproval: false },
};

/** Exact trusted codes only. Goal, model replies, page text and exception
 * messages are deliberately not inputs to this classifier. */
export function classifyGap(raw: SkillGapSignal | null): SkillGapClassification {
  const parsed = SkillGapSignalSchema.safeParse(raw);
  if (parsed.success && (parsed.data.source === 'workflow' && parsed.data.code === 'EFFECT_UNKNOWN' || parsed.data.source === 'tool' && parsed.data.code === 'AGENT_EFFECT_UNKNOWN')) return SkillGapClassificationSchema.parse({ category: null, reason: parsed.data.code, signal: parsed.data, action: { kind: 'inspect_evidence', label: 'راجع الأثر المجهول يدويًا قبل أي تكرار؛ لم يُثبت سبب الفشل.', automatic: false, requiresApproval: false } });
  const category = parsed.success ? known.get(`${parsed.data.source}:${parsed.data.code}`) ?? null : null;
  const inspectionFailed = category === 'invalid_plan' && parsed.success && ['SKILL_INSPECTION_FAILED', 'skill_inspection_failed'].includes(parsed.data.code);
  return SkillGapClassificationSchema.parse({ category, reason: category && parsed.success ? parsed.data.code : 'insufficient_evidence', signal: category && parsed.success ? parsed.data : null,
    action: inspectionFailed ? { kind: 'review_skill_library', label: 'راجع نتائج فحص محتوى المهارة وأصلح السبب قبل إعادة الفحص والتفعيل.', automatic: false, requiresApproval: true } : actions[category ?? 'insufficient_evidence'] });
}

/** Called after the fenced chat status update, using that same transaction.
 * Module migrations are independent, so chat ownership is checked here rather
 * than introducing a foreign key to a table that may not exist at startup. */
export async function recordSkillGap(tx: Kysely<any>, raw: SkillGapObservation): Promise<void> {
  const input = SkillGapObservationSchema.parse(raw);
  const run = await tx.selectFrom('chat_runs as r').innerJoin('chat_conversations as c', 'c.id', 'r.conversation_id')
    .select('r.id').where('r.id', '=', input.chatRunId).where('r.owner_id', '=', input.ownerId).where('c.owner_id', '=', input.ownerId).where('r.status', '=', input.outcome).executeTakeFirst();
  if (!run) throw new SkillError('SKILL_GAP_RUN_INVALID', 'لا يطابق تشغيل المحادثة المالك أو الحالة المثبتة.', 409);
  let classified = classifyGap(input.signal);
  let signal = classified.signal;
  const task = signal?.taskId ? await tx.selectFrom('tasks').select(['id', 'status']).where('id', '=', signal.taskId).where('owner_id', '=', input.ownerId).executeTakeFirst() : undefined;
  if (signal?.taskId && !task) throw new SkillError('SKILL_GAP_REFERENCE_INVALID', 'مرجع المهمة لا يخص هذا المالك.', 409);
  if (signal?.skillVersionId && !await tx.selectFrom('skill_versions').select('id').where('id', '=', signal.skillVersionId).where('owner_id', '=', input.ownerId).executeTakeFirst()) throw new SkillError('SKILL_GAP_REFERENCE_INVALID', 'مرجع المهارة لا يخص هذا المالك.', 409);
  // A task may have been approved/cancelled since the chat callback returned.
  // Record only current evidence, without blocking an otherwise valid finish.
  if (signal?.source === 'workflow' && ['APPROVAL_REQUIRED', 'APPROVAL_PENDING'].includes(signal.code) && task?.status !== 'waiting_approval') { classified = classifyGap(null); signal = null; }
  const saved = await tx.insertInto('skill_gaps').values({ id: randomUUID(), owner_id: input.ownerId, chat_run_id: input.chatRunId, outcome: input.outcome, category: classified.category, reason: classified.reason, signal: signal ? JSON.stringify(signal) : null })
    .onConflict(conflict => conflict.columns(['owner_id', 'chat_run_id']).doNothing()).returning('id').executeTakeFirst();
  if (saved) await tx.insertInto('skill_audit').values({ id: randomUUID(), owner_id: input.ownerId, target_id: input.chatRunId, event: 'skill.gap_recorded', detail: JSON.stringify({ gapId: saved.id, outcome: input.outcome, category: classified.category, reason: classified.reason }) }).execute();
}

export async function listSkillGaps(db: Kysely<any>, ownerId: string, raw: unknown = {}) {
  const query = SkillGapQuerySchema.parse(raw);
  return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
    let selection = tx.selectFrom('skill_gaps').where('owner_id', '=', ownerId);
    if (query.category) selection = selection.where('category', '=', query.category);
    const count = await selection.select(eb => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const rows = await selection.selectAll().orderBy('created_at', 'desc').orderBy('id').offset(query.offset).limit(query.limit).execute();
    return SkillGapPageSchema.parse({ limit: query.limit, offset: query.offset, total: Number(count.total), items: rows.map(row => {
      const category = row.category as Category | null;
      return { id: row.id, chatRunId: row.chat_run_id, outcome: row.outcome, category, reason: row.reason,
        signal: typeof row.signal === 'string' ? JSON.parse(row.signal) : row.signal, action: classifyGap(typeof row.signal === 'string' ? JSON.parse(row.signal) : row.signal).action, createdAt: new Date(row.created_at).toISOString() };
    }) });
  });
}
