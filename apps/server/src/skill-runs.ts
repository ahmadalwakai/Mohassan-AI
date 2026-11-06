import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { SkillEvidencePageSchema, SkillEvidenceQuerySchema, SkillRunInputSchema, SkillRunRequestSchema, SkillRunSummarySchema, SkillRunGapReportSchema, SkillGapSignalSchema, SkillToolIdSchema, type SkillGapSignal } from '@mohassan/contracts';
import { canonicalSkillEvidenceJson, SkillError, classifyGap, SkillFailureProofSchema, type SkillControl } from '@mohassan/skills';
import type { Runtime } from '@mohassan/runtime';

export interface SkillRunRoutesOptions {
  db: Kysely<any>; owner(request: any): Promise<{ id: string }>; skills: SkillControl;
  runtime: Pick<Runtime, 'createTask' | 'cancel'>; enabled: boolean;
}
const iso = (value: unknown): string => new Date(value as Date | string).toISOString();
const nullableDate = (value: unknown) => value ? iso(value) : null;
const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value;

/** Routes request work from Runtime; no route invokes a tool, model or filesystem. */
export async function registerSkillRunRoutes(app: FastifyInstance, { db, owner, skills, runtime, enabled }: SkillRunRoutesOptions) {
  type Route = { Params: { id: string } };
  const write = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  async function ownedRun(ownerId: string, rawId: string) {
    const id = z.uuid().parse(rawId);
    const row = await db.selectFrom('skill_runs').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw new SkillError('SKILL_RUN_NOT_FOUND', 'لم يُعثر على تشغيل المهارة.', 404);
    return row;
  }
  async function summary(row: any) {
    const nodes = await db.selectFrom('skill_run_nodes').select(['node_id', 'version_id', 'content_hash', 'kind', 'tool', 'status', 'child_task_id', 'attempt', 'execution_attempt', 'retry_not_before', 'recovery_reason', 'inputs_hash', 'output_hash', 'error_code', 'started_at', 'finished_at']).where('run_id', '=', row.id).where('owner_id', '=', row.owner_id).orderBy('node_id').limit(145).execute();
    return SkillRunSummarySchema.parse({ id: row.id, parentTaskId: row.parent_task_id, status: row.status, inputHash: row.input_hash, errorCode: row.error_code,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), finishedAt: nullableDate(row.finished_at),
      nodes: nodes.map(node => ({ id: node.node_id, versionId: node.version_id, contentHash: node.content_hash, kind: node.kind, tool: node.tool,
        status: node.status, childTaskId: node.child_task_id, attempt: node.attempt, executionAttempt: node.execution_attempt, retryNotBefore: nullableDate(node.retry_not_before), recoveryReason: node.recovery_reason, inputsHash: node.inputs_hash, outputHash: node.output_hash,
        errorCode: node.error_code, startedAt: nullableDate(node.started_at), finishedAt: nullableDate(node.finished_at) })) });
  }
  app.post<Route>('/api/skills/:id/run', write, async request => {
    const user = await owner(request);
    if (!enabled) throw new SkillError('SKILL_ENGINE_DISABLED', 'تشغيل المهارات غير مفعّل.', 403);
    const id = z.uuid().parse(request.params.id), body = SkillRunRequestSchema.parse(request.body);
    const key = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(request.headers['idempotency-key']);
    const detail = await skills.detail(user.id, id);
    if (detail.skill.revision !== body.expectedRevision) throw new SkillError('SKILL_VERSION_CONFLICT', 'تغير إصدار المهارة؛ حدّث تفاصيلها قبل الطلب.', 409);
    if (!detail.skill.active || detail.skill.status !== 'active') throw new SkillError('SKILL_NOT_ACTIVE', 'المهارة غير مفعّلة.', 409);
    if (detail.contract.level !== 'tool') throw new SkillError(detail.contract.level === 'instruction' ? 'SKILL_INSTRUCTION_ONLY' : 'SKILL_EXECUTABLE_GATES_CLOSED', 'هذه المهارة غير متاحة للتنفيذ عبر الأدوات.', 409);
    const plan = body.plan ?? { inputs: detail.contract.inputs, nodes: [{ id: 'main', skillId: id, inputs: Object.fromEntries(detail.contract.inputs.filter(field => field.required || Object.hasOwn(body.values, field.name)).map(field => [field.name, `input.${field.name}`])) }] };
    if (!plan.nodes.some(node => node.skillId === id)) throw new SkillError('SKILL_PLAN_TARGET_MISMATCH', 'يجب أن تتضمن الخطة المهارة المحددة في الطلب.', 400);
    const input = SkillRunInputSchema.parse({ plan, values: body.values });
    const validation = await skills.validateComposition(user.id, input.plan);
    if (!validation.valid) throw new SkillError('SKILL_COMPOSITION_INVALID', validation.issues.find(issue => issue.severity === 'error')?.message ?? 'خطة المهارة غير صالحة.', 409);
    const task = await runtime.createTask(user.id, { title: `تشغيل ${detail.skill.name}`.slice(0, 120), goal: body.goal ?? `تنفيذ المهارة ${detail.skill.name} وفق العقد والمدخلات المحددة.`, capabilityId: 'skill.run', autonomy: 'assisted', skillInput: input }, key);
    const run = await db.selectFrom('skill_runs').select('id').where('owner_id', '=', user.id).where('parent_task_id', '=', task.id).executeTakeFirst();
    return { task, runId: run?.id ?? null };
  });
  // History and cancellation remain available when creation is disabled.
  app.get<Route>('/api/skills/runs/:id', async request => summary(await ownedRun((await owner(request)).id, request.params.id)));
  app.get<Route>('/api/skills/runs/:id/gaps', async (request, reply) => {
    const user = await owner(request), id = z.uuid().parse(request.params.id);
    reply.header('cache-control', 'private, no-store');
    z.object({}).strict().parse(request.query ?? {});
    return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
      const run = await tx.selectFrom('skill_runs').select(['id', 'status', 'error_code']).where('id', '=', id).where('owner_id', '=', user.id).executeTakeFirst();
      if (!run) throw new SkillError('SKILL_RUN_NOT_FOUND', 'لم يُعثر على تشغيل المهارة.', 404);
      const rows = await tx.selectFrom('skill_run_nodes').select(['node_id', 'status', 'kind', 'tool', 'child_task_id', 'error_code']).where('run_id', '=', id).where('owner_id', '=', user.id).orderBy('node_id').limit(145).execute();
      const nodes = rows.slice(0, 144), taskIds = nodes.map(node => node.child_task_id).filter((value): value is string => typeof value === 'string');
      const tasks = taskIds.length ? await tx.selectFrom('tasks').select(['id', 'status']).where('owner_id', '=', user.id).where('id', 'in', taskIds).execute() : [];
      const byTask = new Map(tasks.map(task => [task.id, task]));
      // Extract only bounded failure proofs in SQL. Full inputs, model replies,
      // page content and exception messages never enter a gap classification.
      const receipts = await tx.selectFrom('skill_evidence as e').innerJoin('skill_run_nodes as n', join => join.onRef('n.run_id', '=', 'e.run_id').onRef('n.node_id', '=', 'e.node_id').onRef('n.execution_attempt', '=', 'e.attempt').onRef('n.child_task_id', '=', 'e.task_id'))
        .select(['e.node_id', 'e.status', sql<string>`left(jsonb_path_query_array(e.details, '$[*] ? (@.kind == "gateway.failure").data')::text, 2048)`.as('proofs')])
        .where('e.owner_id', '=', user.id).where('n.owner_id', '=', user.id).where('e.run_id', '=', id).limit(144).execute();
      const byReceipt = new Map(receipts.map(receipt => [receipt.node_id, receipt]));
      const signalFor = (node: typeof nodes[number], taskId: string | undefined): SkillGapSignal | null => {
        const receipt = byReceipt.get(node.node_id);
        const proofs: Array<ReturnType<typeof SkillFailureProofSchema.parse>> = [];
        let proofCount = 0;
        if (receipt) try {
          const values: unknown = JSON.parse(receipt.proofs);
          if (Array.isArray(values)) { proofCount = values.length; for (const value of values) { const parsed = SkillFailureProofSchema.safeParse(value); if (parsed.success) proofs.push(parsed.data); } }
        } catch { /* Truncated or malformed proof never supplies a cause. */ }
        // An unfinished receipt dominates a later error label. Reviewing a grant
        // alone cannot reconcile an operation whose external effect is unknown.
        if (node.status === 'unknown' || receipt && ['started', 'unknown'].includes(receipt.status) || proofs.some(proof => proof.effect === 'unknown')) return {source: 'workflow', code: 'EFFECT_UNKNOWN', ...(taskId ? {taskId} : {})};
        if (taskId && byTask.get(taskId)?.status === 'waiting_approval' && ['pending', 'queued'].includes(node.status)) return {source: 'workflow', code: 'APPROVAL_PENDING', taskId};
        let source: SkillGapSignal['source'] = 'tool';
        const proof = proofCount === 1 && proofs.length === 1 ? proofs[0] : undefined;
        if (receipt?.status === 'failed' && (node.kind === 'model' || node.tool === 'vision.inspect') && proof?.source === 'provider_rejection' && proof.errorCode === node.error_code && (!proof.tool || proof.tool === node.tool)) source = 'environment';
        const tool = SkillToolIdSchema.safeParse(node.tool);
        const parsed = SkillGapSignalSchema.safeParse({source, code: node.error_code, ...(tool.success ? {tool: tool.data} : {}), ...(taskId ? {taskId} : {})});
        return parsed.success ? parsed.data : null;
      };
      const items = nodes.flatMap(node => {
        const taskId = typeof node.child_task_id === 'string' && byTask.has(node.child_task_id) ? node.child_task_id : undefined;
        if (!['failed', 'unknown'].includes(node.status) && !(taskId && byTask.get(taskId)?.status === 'waiting_approval' && ['pending', 'queued'].includes(node.status))) return [];
        return [{nodeId: node.node_id as string | null, childTaskId: taskId ?? null, classification: classifyGap(signalFor(node, taskId))}];
      });
      if (!items.length && ['failed', 'unknown'].includes(run.status)) {
        const parsed = SkillGapSignalSchema.safeParse({source: run.status === 'unknown' ? 'workflow' : 'tool', code: run.status === 'unknown' ? 'EFFECT_UNKNOWN' : run.error_code});
        items.push({nodeId: null, childTaskId: null, classification: classifyGap(parsed.success ? parsed.data : null)});
      }
      return SkillRunGapReportSchema.parse({runId: id, status: run.status, observedAt: new Date().toISOString(), truncated: rows.length > 144, items});
    });
  });
  app.get<Route>('/api/skills/runs/:id/evidence', async request => {
    const user = await owner(request), run = await ownedRun(user.id, request.params.id), query = SkillEvidenceQuerySchema.parse(request.query);
    const [rows, count] = await Promise.all([
      db.selectFrom('skill_evidence').select(['id', 'node_id', 'task_id', 'version_id', 'content_hash', 'inputs_hash', 'status', 'attempt', 'output_hash', 'error_code', 'created_at', 'finished_at', 'details']).where('owner_id', '=', user.id).where('run_id', '=', run.id).orderBy('created_at').orderBy('id').limit(query.limit).offset(query.offset).execute(),
      db.selectFrom('skill_evidence').select(eb => eb.fn.countAll().as('total')).where('owner_id', '=', user.id).where('run_id', '=', run.id).executeTakeFirstOrThrow(),
    ]);
    return SkillEvidencePageSchema.parse({ runId: run.id, ...query, total: Number(count.total), items: rows.map(row => ({ id: row.id, nodeId: row.node_id, taskId: row.task_id, versionId: row.version_id, contentHash: row.content_hash, inputsHash: row.inputs_hash,
      status: row.status, attempt: row.attempt, outputHash: row.output_hash, errorCode: row.error_code, createdAt: iso(row.created_at), finishedAt: nullableDate(row.finished_at), details: JSON.parse(canonicalSkillEvidenceJson(json(row.details))) })) });
  });
  app.post<Route>('/api/skills/runs/:id/cancel', write, async request => {
    const user = await owner(request); z.object({}).strict().parse(request.body ?? {});
    const run = await ownedRun(user.id, request.params.id), task = await runtime.cancel(user.id, run.parent_task_id);
    return { task, run: await summary(await ownedRun(user.id, run.id)) };
  });
}
