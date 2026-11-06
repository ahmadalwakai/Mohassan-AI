import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema, SkillNodeBindingSchema, SkillRunInputSchema, type SkillCompositionResult, type SkillContract, type SkillExecutionReceipt, type SkillNodeBinding, type SkillRunInput } from '@mohassan/contracts';
import { assignable, layers } from './composer.ts';
import { SkillError } from './errors.ts';
import { appendSkillEvidence, canonicalSkillEvidenceJson, canonicalSkillJson, hashSkillData, type SkillNodeClaim, type SkillNodeOutcome, type SkillNodePreimage, type SkillNodeResult } from './evidence.ts';
import { sha256, skillContentMatches } from './hash.ts';
import { INSPECTOR_VERSION } from './inspector.ts';
import { decideRecovery } from './fallback.ts';

const json = (value: any): any => typeof value === 'string' ? JSON.parse(value) : value;
const terminal = new Set(['completed', 'failed', 'cancelled']);
type InputBinding = { source: 'input'; field: string } | { source: 'node'; nodeId: string; field: string };
export interface SkillChildSpec { binding: SkillNodeBinding; input: Record<string, unknown>; idempotencyKey: string; title?: string; attempt?: number }
export interface SkillAdvanceContext {
  taskId: string; ownerId: string; leaseToken: string; signal: AbortSignal;
  dispatchChild(tx: Kysely<any>, spec: SkillChildSpec): Promise<{ id: string }>;
}
export interface SkillRunResult extends Record<string, unknown> { kind: 'skill_run'; runId: string; outcome: 'succeeded'; receipts: SkillExecutionReceipt[]; outputs: Record<string, unknown> }
export type SkillAdvanceResult = { kind: 'pending'; runId: string; childTaskIds: string[] } | { kind: 'complete'; runId: string; result: SkillRunResult };
export interface SkillSchedulerOptions {
  /** Absent means closed. Only a sandbox reporting every gate verified may open script nodes. */
  executableReady?: () => Promise<boolean>;
  validateComposition(ownerId: string, input: unknown): Promise<SkillCompositionResult>;
  /** Runtime owns approval policy; absence is a closed execution boundary. */
  validateParentAuthority?: (tx: Kysely<any>, parent: any) => Promise<boolean>;
  /** Metadata update in the same transaction; never invokes a tool or grants authority. */
  rebuildGraph?: (tx: Kysely<any>, ownerId: string) => Promise<void>;
}

function checkValues(schema: SkillContract['inputs'], values: Record<string, unknown>): void {
  canonicalSkillJson(values);
  if (Object.keys(values).some(key => !schema.some(field => field.name === key))) throw new SkillError('SKILL_INPUT_UNKNOWN', 'توجد قيمة غير معلنة في العقد.');
  for (const field of schema) {
    const value = values[field.name];
    if (value === undefined) { if (field.required) throw new SkillError('SKILL_INPUT_REQUIRED', `القيمة ${field.name} مطلوبة.`); continue; }
    const valid = field.type === 'json' || field.type === 'number' && typeof value === 'number' && Number.isFinite(value)
      || field.type === 'boolean' && typeof value === 'boolean' || ['string', 'file'].includes(field.type) && typeof value === 'string'
      || field.type === 'url' && z.url().safeParse(value).success;
    if (!valid) throw new SkillError('SKILL_INPUT_TYPE', `نوع القيمة ${field.name} لا يطابق العقد.`);
  }
}
const bindingFor = (run: any, node: any): SkillNodeBinding => SkillNodeBindingSchema.parse({ parentTaskId: run.parent_task_id, runId: run.id, nodeId: node.node_id, versionId: node.version_id, contentHash: node.content_hash, inputsHash: node.inputs_hash, kind: node.kind, ...(node.tool ? { tool: node.tool } : {}) });
const attemptKey = (node: any): string => node.execution_attempt === 1 ? node.idempotency_key : `${node.idempotency_key}:attempt:${node.execution_attempt}`;

export function createSkillScheduler(db: Kysely<any>, options: SkillSchedulerOptions) {
  async function verifiedContract(tx: Kysely<any>, ownerId: string, id: string) {
    const row = await tx.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').select(['v.id', 'v.contract', 'v.content_hash', 'v.status', 'f.active_version_id']).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId).where('v.id', '=', id).executeTakeFirst();
    if (!row || row.status !== 'active' || row.active_version_id !== id) throw new SkillError('SKILL_NOT_ACTIVE', 'المهارة غير مفعّلة لهذا المالك.', 409);
    const contract = SkillContractSchema.parse(json(row.contract));
    const files = await tx.selectFrom('skill_files').select(['path', 'content']).where('version_id', '=', id).execute();
    if (!skillContentMatches(contract, files, row.content_hash)) throw new SkillError('SKILL_INTEGRITY_FAILED', 'تغير محتوى المهارة المفحوص.', 409);
    const inspection = await tx.selectFrom('skill_inspections').selectAll().where('owner_id', '=', ownerId).where('version_id', '=', id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (!inspection || inspection.inspector_version !== INSPECTOR_VERSION || !['pass', 'review'].includes(inspection.verdict)) throw new SkillError('SKILL_INSPECTION_STALE', 'لا يوجد فحص أمان حالي ناجح.', 409);
    return { contract, contentHash: row.content_hash as string };
  }

  async function initialize(tx: Kysely<any>, input: SkillRunInput, context: SkillAdvanceContext) {
    checkValues(input.plan.inputs, input.values);
    const contracts = new Map<string, { contract: SkillContract; contentHash: string; versionId: string }>();
    for (const node of input.plan.nodes) contracts.set(node.id, { ...await verifiedContract(tx, context.ownerId, node.skillId), versionId: node.skillId });
    if ([...contracts.values()].some(({ contract }) => contract.level === 'executable' || contract.steps.some(step => step.kind === 'script')) && !await options.executableReady?.()) throw new SkillError('SKILL_EXECUTABLE_GATES_CLOSED', 'بوابات المهارات التنفيذية غير مثبتة؛ لم يُشغّل أي سكربت.', 409);
    if (![...contracts.values()].some(item => item.contract.level !== 'instruction')) throw new SkillError('SKILL_INSTRUCTION_ONLY', 'مهارات التعليمات تُحمّل عبر load_skill ولا تُبلّغ كتنفيذ.', 409);
    const producers = new Map<string, string>();
    for (const [id, { contract }] of contracts) {
      if (contract.steps.some(step => step.kind === 'model') && !contract.requires.scopes.includes('model:generate')) throw new SkillError('SKILL_MODEL_SCOPE_REQUIRED', 'خطوة النموذج تحتاج model:generate صريحة في العقد والمنحة.', 403);
      if (contract.level === 'instruction') continue;
      for (const field of contract.outputs) {
        const matches = contract.steps.filter(step => step.outputs.some(output => output.name === field.name));
        if (matches.length !== 1 || !assignable(matches[0].outputs.find(output => output.name === field.name)!.type, field.type)) throw new SkillError('SKILL_OUTPUT_PRODUCER_INVALID', `الناتج ${id}.${field.name} يحتاج منتجًا واحدًا معلنًا ومتوافقًا.`);
        producers.set(`${id}.${field.name}`, `${id}.${matches[0].id}`);
      }
    }
    const runId = randomUUID(), nodes: any[] = [];
    const resolveExternal = (value: string): InputBinding => {
      const [source, field] = value.split('.');
      if (source === 'input') return { source: 'input', field };
      const nodeId = producers.get(value);
      if (!nodeId) throw new SkillError('SKILL_OUTPUT_MISSING', 'لا يوجد ناتج تنفيذي معلن لهذا الربط.');
      return { source: 'node', nodeId, field };
    };
    const executableDependencies = (id: string, seen = new Set<string>()): string[] => {
      if (seen.has(id)) return []; seen.add(id);
      const item = input.plan.nodes.find(node => node.id === id)!;
      const contract = contracts.get(id)!.contract;
      if (contract.level !== 'instruction') return contract.steps.map(step => `${id}.${step.id}`);
      return item.dependsOn.flatMap(dependency => executableDependencies(dependency, seen));
    };
    for (const planNode of input.plan.nodes) {
      const { contract, contentHash, versionId } = contracts.get(planNode.id)!;
      const external = new Set([...planNode.dependsOn, ...Object.values(planNode.inputs).map(value => value.split('.')[0]).filter(id => id !== 'input')]);
      for (const step of contract.steps) {
        const bindings: Record<string, InputBinding> = {};
        const dependencies = new Set([...external].flatMap(id => executableDependencies(id)));
        step.dependsOn.forEach(id => dependencies.add(`${planNode.id}.${id}`));
        for (const [name, value] of Object.entries(step.inputs)) {
          const [source, field] = value.split('.');
          if (source === 'input') {
            const mapping = planNode.inputs[field];
            if (!mapping) throw new SkillError('SKILL_INPUT_REQUIRED', `لا يوجد ربط للمدخل ${field}.`);
            bindings[name] = resolveExternal(mapping);
          } else bindings[name] = { source: 'node', nodeId: `${planNode.id}.${source}`, field };
          if (bindings[name].source === 'node') dependencies.add(bindings[name].nodeId);
        }
        const nodeId = `${planNode.id}.${step.id}`;
        nodes.push({ run_id: runId, node_id: nodeId, owner_id: context.ownerId, version_id: versionId, content_hash: contentHash, composition_node_id: planNode.id, step_id: step.id, kind: step.kind, tool: step.tool ?? null, contract: JSON.stringify(contract), step: JSON.stringify(step), dependencies: JSON.stringify([...dependencies].sort()), input_bindings: JSON.stringify(bindings), output_schema: JSON.stringify(step.outputs), idempotency_key: `skill:${runId}:${nodeId}`, status: 'pending' });
      }
    }
    const graph = layers(nodes.map(node => node.node_id), new Map(nodes.map(node => [node.node_id, new Set<string>(json(node.dependencies))])));
    if (graph.cyclic.length || nodes.some(node => json(node.dependencies).some((id: string) => !nodes.some(candidate => candidate.node_id === id)))) throw new SkillError('SKILL_GRAPH_INVALID', 'اعتماديات التنفيذ غير صالحة.');
    await tx.insertInto('skill_runs').values({ id: runId, owner_id: context.ownerId, parent_task_id: context.taskId, input_hash: hashSkillData(input), plan: JSON.stringify(input.plan), input_values: canonicalSkillJson(input.values), pinned_versions: JSON.stringify([...contracts].map(([id, item]) => ({ id, versionId: item.versionId, contentHash: item.contentHash, contract: item.contract }))), status: 'running' }).execute();
    if (nodes.length) await tx.insertInto('skill_run_nodes').values(nodes).execute();
    return tx.selectFrom('skill_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
  }

  async function readNode(tx: Kysely<any>, ownerId: string, runId: string, nodeId: string) {
    const run = await tx.selectFrom('skill_runs').selectAll().where('id', '=', runId).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!run) return null;
    const node = await tx.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', runId).where('node_id', '=', nodeId).where('owner_id', '=', ownerId).executeTakeFirst();
    return node ? { run, node, binding: node.inputs_hash ? bindingFor(run, node) : null } : null;
  }

  async function runSkillGraph(raw: unknown, context: SkillAdvanceContext): Promise<SkillAdvanceResult> {
    context.signal.throwIfAborted();
    const input = SkillRunInputSchema.parse(raw), validation = await options.validateComposition(context.ownerId, input.plan);
    if (!validation.valid) throw new SkillError('SKILL_COMPOSITION_INVALID', validation.issues.find(issue => issue.severity === 'error')?.message ?? 'خطة المهارة غير صالحة.', 409);
    const advanced = await db.transaction().execute(async tx => {
      const parent = await tx.selectFrom('tasks').selectAll().where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).where('lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`).where('status', '=', 'running').forUpdate().executeTakeFirst();
      if (!parent || parent.cancellation_requested) throw new SkillError('SKILL_FENCE_LOST', 'انتهى تفويض المهمة الأم.', 409);
      let run = await tx.selectFrom('skill_runs').selectAll().where('parent_task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).forUpdate().executeTakeFirst();
      run ??= await initialize(tx, input, context);
      if (run.input_hash !== hashSkillData(input)) throw new SkillError('SKILL_INPUT_CHANGED', 'تغيرت خطة التنفيذ المثبتة.', 409);
      if (['failed', 'cancelled', 'unknown'].includes(run.status)) throw new SkillError('SKILL_RUN_STOPPED', 'توقف التشغيل ويحتاج مراجعة قبل أي إجراء جديد.', 409);
      const clock = (await sql<{ now: Date }>`SELECT CURRENT_TIMESTAMP AS now`.execute(tx)).rows[0].now;
      const nodes = await tx.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', run.id).orderBy('node_id').forUpdate().execute();
      for (const node of nodes.filter(node => node.child_task_id && ['queued', 'running', 'failed', 'unknown'].includes(node.status))) {
        const child = await tx.selectFrom('tasks').selectAll().where('id', '=', node.child_task_id).where('owner_id', '=', context.ownerId).executeTakeFirst();
        if (!child || !terminal.has(child.status)) continue;
        const evidence = await tx.selectFrom('skill_evidence').selectAll().where('run_id', '=', run.id).where('node_id', '=', node.node_id).where('task_id', '=', child.id).where('attempt', '=', node.execution_attempt).executeTakeFirst();
        if (child.status !== 'completed') {
          if (evidence?.status === 'started') {
            evidence.status = 'unknown';
            await tx.updateTable('skill_evidence').set({ status: 'unknown', error_code: 'SKILL_WORKER_LOST', finished_at: clock }).where('id', '=', evidence.id).where('status', '=', 'started').execute();
          }
          const decision = decideRecovery({ contract: SkillContractSchema.parse(json(node.contract)), step: json(node.step), attempt: node.execution_attempt,
            receipt: evidence ? { status: evidence.status, finishedAt: evidence.finished_at, details: json(evidence.details) } : null });
          if (child.status !== 'cancelled' && decision.action === 'retry') {
            const next = { status: 'pending', execution_attempt: decision.attempt, retry_not_before: decision.notBefore, recovery_reason: decision.reason, child_task_id: null, lease_token: null, lease_expires_at: null, error_code: null, finished_at: null };
            Object.assign(node, next);
            await tx.updateTable('skill_run_nodes').set(next).where('run_id', '=', run.id).where('node_id', '=', node.node_id).execute();
            // Only independently classified, completed no-effect attempts can release their own lock.
            await tx.deleteFrom('skill_resource_locks').where('receipt_id', '=', evidence!.id).execute();
            await tx.insertInto('skill_audit').values({ id: randomUUID(), owner_id: context.ownerId, target_id: run.id, event: 'skill.retry_scheduled', detail: JSON.stringify({ nodeId: node.node_id, attempt: decision.attempt, evidenceId: evidence!.id, notBefore: decision.notBefore.toISOString() }) }).execute();
            continue;
          }
          node.status = child.status === 'cancelled' ? 'cancelled' : decision.action === 'stop' ? decision.status : 'failed';
          await tx.updateTable('skill_run_nodes').set({ status: node.status, recovery_reason: decision.action === 'verify_only' ? 'independent_verification_required' : decision.reason, finished_at: clock }).where('run_id', '=', run.id).where('node_id', '=', node.node_id).execute();
        } else {
          if (!evidence || evidence.status !== 'succeeded' || !evidence.output_hash || hashSkillData(json(evidence.output)) !== evidence.output_hash) throw new SkillError('SKILL_EVIDENCE_MISSING', 'لا يوجد دليل مستقل لناتج المهمة الفرعية.', 409);
          node.status = 'succeeded'; node.outputs = json(evidence.output); node.output_hash = evidence.output_hash;
          await tx.updateTable('skill_run_nodes').set({ status: 'succeeded', outputs: canonicalSkillJson(node.outputs), output_hash: node.output_hash, finished_at: new Date() }).where('run_id', '=', run.id).where('node_id', '=', node.node_id).execute();
        }
      }
      if (nodes.some(node => ['failed', 'cancelled', 'unknown'].includes(node.status))) {
        await tx.updateTable('skill_runs').set({ status: nodes.some(node => node.status === 'unknown') ? 'unknown' : 'failed', error_code: 'SKILL_CHILD_FAILED', finished_at: new Date(), updated_at: new Date() }).where('id', '=', run.id).execute();
        await options.rebuildGraph?.(tx, context.ownerId);
        return { kind: 'failed' as const, runId: run.id };
      }
      if (nodes.every(node => node.status === 'succeeded')) {
        const outputs: Record<string, unknown> = {}, receipts: SkillExecutionReceipt[] = [];
        for (const pin of json(run.pinned_versions)) {
          const contract = SkillContractSchema.parse(pin.contract);
          if (contract.level === 'instruction') continue;
          const matching = nodes.filter(node => node.composition_node_id === pin.id);
          const exported: Record<string, unknown> = {};
          for (const field of contract.outputs) {
            const producer = matching.find(node => json(node.output_schema).some((output: any) => output.name === field.name));
            if (producer && Object.hasOwn(json(producer.outputs), field.name)) exported[field.name] = json(producer.outputs)[field.name];
          }
          checkValues(contract.outputs, exported); outputs[pin.id] = exported;
          const evidence = await tx.selectFrom('skill_evidence').select(['id', 'created_at', 'finished_at', 'details']).where('run_id', '=', run.id).where('node_id', 'in', matching.map(node => node.node_id)).orderBy('created_at').orderBy('id').execute();
          const scripted = evidence.flatMap(item => json(item.details)).find((entry: any) => entry.kind === 'script.receipt')?.data;
          if (contract.level === 'executable' && !scripted) throw new SkillError('SKILL_RECEIPT_MISSING', 'لا يوجد إيصال تنفيذ معزول لهذه المهارة.', 409);
          receipts.push({ runId: run.id, skillVersionId: pin.versionId, contentHash: pin.contentHash, startedAt: new Date(run.created_at).toISOString(), finishedAt: new Date().toISOString(), outcome: 'succeeded', evidenceIds: evidence.map(item => item.id), ...(contract.level === 'executable' ? { level: 'executable' as const, execution: 'isolated_script' as const, isolation: { provider: String(scripted.provider).slice(0, 64), verified: true as const, sharesHostKernel: true, network: 'denied' as const } } : { level: 'tool', execution: 'tool_gateway', tools: [...new Set(matching.map(node => node.tool).filter(Boolean))] as any }) });
        }
        const result: SkillRunResult = { kind: 'skill_run', runId: run.id, outcome: 'succeeded', receipts, outputs };
        await tx.updateTable('skill_runs').set({ status: 'succeeded', result: canonicalSkillEvidenceJson(result), finished_at: new Date(), updated_at: new Date() }).where('id', '=', run.id).execute();
        await options.rebuildGraph?.(tx, context.ownerId);
        return { kind: 'complete' as const, runId: run.id, result };
      }
      const byId = new Map(nodes.map(node => [node.node_id, node]));
      for (const node of nodes.filter(node => node.status === 'pending' && (!node.retry_not_before || new Date(node.retry_not_before).getTime() <= new Date(clock).getTime()) && json(node.dependencies).every((id: string) => byId.get(id)?.status === 'succeeded')).slice(0, 8)) {
        const inputs: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(json(node.input_bindings)) as [string, InputBinding][]) {
          const source = value.source === 'input' ? json(run.input_values) : json(byId.get(value.nodeId)?.outputs);
          if (!source || !Object.hasOwn(source, value.field)) throw new SkillError('SKILL_OUTPUT_MISSING', 'لم ينتج الاعتماد القيمة المطلوبة.');
          inputs[name] = source[value.field];
        }
        if (node.inputs_hash && hashSkillData(inputs) !== node.inputs_hash) throw new SkillError('SKILL_INPUT_CHANGED', 'تغيرت المدخلات المثبتة قبل إعادة المحاولة.', 409);
        node.inputs = inputs; node.inputs_hash = hashSkillData(inputs);
        await tx.updateTable('skill_run_nodes').set({ inputs: canonicalSkillJson(inputs), inputs_hash: node.inputs_hash }).where('run_id', '=', run.id).where('node_id', '=', node.node_id).execute();
        context.signal.throwIfAborted();
        const child = await context.dispatchChild(tx, { binding: bindingFor(run, node), input: inputs, idempotencyKey: attemptKey(node), title: json(node.step).title, attempt: node.execution_attempt });
        node.child_task_id = child.id; node.status = 'queued';
        await tx.updateTable('skill_run_nodes').set({ child_task_id: child.id, status: 'queued' }).where('run_id', '=', run.id).where('node_id', '=', node.node_id).execute();
      }
      await tx.updateTable('skill_runs').set({ status: 'waiting_children', updated_at: new Date() }).where('id', '=', run.id).execute();
      return { kind: 'pending' as const, runId: run.id, childTaskIds: nodes.filter(node => node.child_task_id && node.status !== 'succeeded').map(node => node.child_task_id) };
    });
    if (advanced.kind === 'failed') throw new SkillError('SKILL_CHILD_FAILED', 'فشلت مهمة فرعية؛ توقف مخطط المهارة دون تكرار الأثر.', 409);
    return advanced;
  }

  async function lockedClaim(tx: Kysely<any>, binding: SkillNodeBinding, context: { ownerId: string; taskId: string; leaseToken: string; workflowToken?: string }, nodeLeaseToken?: string) {
    const parent = await tx.selectFrom('tasks').selectAll().where('id', '=', binding.parentTaskId).where('owner_id', '=', context.ownerId).forUpdate().executeTakeFirst();
    if (!parent || parent.cancellation_requested || !['running', 'paused', 'queued'].includes(parent.status) || !parent.workflow_token || context.workflowToken && context.workflowToken !== parent.workflow_token || !await options.validateParentAuthority?.(tx, parent)) throw new SkillError('SKILL_PARENT_INACTIVE', 'المهمة الأم لا تسمح بخطوة جديدة.', 409);
    const run = await tx.selectFrom('skill_runs').selectAll().where('id', '=', binding.runId).where('owner_id', '=', context.ownerId).where('parent_task_id', '=', parent.id).forUpdate().executeTakeFirst();
    const node = await tx.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).where('owner_id', '=', context.ownerId).forUpdate().skipLocked().executeTakeFirst();
    const child = await tx.selectFrom('tasks').selectAll().where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.leaseToken).where('lease_expires_at', '>', sql<Date>`CURRENT_TIMESTAMP`).where('status', 'in', ['running', 'verifying']).forUpdate().executeTakeFirst();
    if (!run || !['running', 'waiting_children'].includes(run.status) || !node || node.child_task_id !== context.taskId || !child || child.cancellation_requested || hashSkillData(bindingFor(run, node)) !== hashSkillData(binding) || hashSkillData(json(node.inputs)) !== node.inputs_hash || nodeLeaseToken && node.lease_token !== nodeLeaseToken) throw new SkillError('SKILL_FENCE_LOST', 'تغير ربط العقدة أو انتهى تفويض المحاولة.', 409);
    return { run, node, child, parent };
  }

  async function claimNode(raw: SkillNodeBinding, context: { ownerId: string; taskId: string; leaseToken: string }): Promise<SkillNodeClaim> {
    const binding = SkillNodeBindingSchema.parse(raw);
    return db.transaction().execute(async tx => {
      const { node, child, parent } = await lockedClaim(tx, binding, context);
      if (node.status !== 'queued' || await tx.selectFrom('skill_evidence').select('id').where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).where('attempt', '=', node.execution_attempt).executeTakeFirst()) throw new SkillError('SKILL_NODE_ALREADY_STARTED', 'بدأت هذه المحاولة سابقًا؛ لا تعاد آليًا.', 409);
      const current = await verifiedContract(tx, context.ownerId, binding.versionId);
      const step = current.contract.steps.find(item => item.id === node.step_id);
      if (current.contentHash !== binding.contentHash || !step || hashSkillData(current.contract) !== hashSkillData(json(node.contract)) || hashSkillData(step) !== hashSkillData(json(node.step)) || hashSkillData(step.outputs) !== hashSkillData(json(node.output_schema))) throw new SkillError('SKILL_NODE_INTEGRITY_FAILED', 'تغيرت الخطوة المثبتة أو مخطط ناتجها عن العقد المفحوص.', 409);
      const nodeLeaseToken = randomUUID(), evidenceId = randomUUID();
      await tx.updateTable('skill_run_nodes').set({ status: 'running', lease_token: nodeLeaseToken, lease_expires_at: child.lease_expires_at, attempt: node.attempt + 1, started_at: new Date() }).where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).execute();
      await tx.insertInto('skill_evidence').values({ id: evidenceId, owner_id: context.ownerId, run_id: binding.runId, node_id: binding.nodeId, task_id: context.taskId, version_id: binding.versionId, content_hash: binding.contentHash, inputs_hash: binding.inputsHash, lease_token: context.leaseToken, node_lease_token: nodeLeaseToken, workflow_token: parent.workflow_token, attempt: node.execution_attempt, status: 'started' }).execute();
      return { binding, ...context, nodeLeaseToken, workflowToken: parent.workflow_token, evidenceId, idempotencyKey: attemptKey(node), contract: SkillContractSchema.parse(json(node.contract)), step: json(node.step), inputs: json(node.inputs), outputSchema: json(node.output_schema) };
    });
  }

  async function recordNodeResult(claim: SkillNodeClaim, outcome: SkillNodeOutcome): Promise<SkillNodeResult | null> {
    for (const entry of outcome.evidence ?? []) await appendSkillEvidence(db, claim, entry);
    if (outcome.outcome === 'succeeded') checkValues(claim.outputSchema, outcome.outputs ?? {});
    return db.transaction().execute(async tx => {
      let fenced = true;
      try { await lockedClaim(tx, claim.binding, claim, claim.nodeLeaseToken); } catch (error) { if (!(error instanceof SkillError)) throw error; fenced = false; }
      const receipt = await tx.selectFrom('skill_evidence').selectAll().where('id', '=', claim.evidenceId).where('owner_id', '=', claim.ownerId).where('node_lease_token', '=', claim.nodeLeaseToken).where('lease_token', '=', claim.leaseToken).where('workflow_token', '=', claim.workflowToken).forUpdate().executeTakeFirst();
      if (!receipt || receipt.status !== 'started') return null;
      const status = fenced ? outcome.outcome : 'unknown', output = outcome.outputs ?? {}, outputHash = hashSkillData(output);
      await tx.updateTable('skill_evidence').set({ status, output: status === 'succeeded' ? canonicalSkillJson(output) : null, output_hash: status === 'succeeded' ? outputHash : null, error_code: outcome.errorCode?.slice(0, 100) ?? (fenced ? null : 'SKILL_FENCE_LOST'), finished_at: new Date() }).where('id', '=', claim.evidenceId).execute();
      // Runtime must independently verify and commit the child task before the graph consumes this output.
      if (status !== 'succeeded') await tx.updateTable('skill_run_nodes').set({ status, error_code: outcome.errorCode?.slice(0, 100) ?? null, finished_at: new Date() }).where('run_id', '=', claim.binding.runId).where('node_id', '=', claim.binding.nodeId).where('lease_token', '=', claim.nodeLeaseToken).execute();
      if (status === 'succeeded') await tx.deleteFrom('skill_resource_locks').where('receipt_id', '=', claim.evidenceId).execute();
      return status === 'succeeded' ? { evidenceId: claim.evidenceId, runId: claim.binding.runId, nodeId: claim.binding.nodeId, inputsHash: claim.binding.inputsHash, outputHash, output } : null;
    });
  }

  async function verifyNodeResult(ownerId: string, raw: SkillNodeBinding, taskId: string): Promise<SkillNodeResult | null> {
    const binding = SkillNodeBindingSchema.parse(raw), stored = await readNode(db, ownerId, binding.runId, binding.nodeId);
    if (!stored?.binding || stored.node.child_task_id !== taskId || hashSkillData(stored.binding) !== hashSkillData(binding)) return null;
    const receipt = await db.selectFrom('skill_evidence').selectAll().where('owner_id', '=', ownerId).where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).where('task_id', '=', taskId).where('status', '=', 'succeeded').executeTakeFirst();
    if (!receipt || receipt.inputs_hash !== binding.inputsHash || receipt.content_hash !== binding.contentHash || hashSkillData(json(receipt.output)) !== receipt.output_hash) return null;
    try { checkValues(json(stored.node.output_schema), json(receipt.output)); } catch { return null; }
    return { evidenceId: receipt.id, runId: binding.runId, nodeId: binding.nodeId, inputsHash: receipt.inputs_hash, outputHash: receipt.output_hash, output: json(receipt.output) };
  }

  /** Read-only under Runtime's child lock. This can only recover verification, never dispatch. */
  async function recoverNode(tx: Kysely<any>, context: { ownerId: string; taskId: string; binding: SkillNodeBinding; leaseToken: string }): Promise<{ kind: 'confirmed'; result: Record<string, unknown>; receiptLeaseToken: string } | { kind: 'unknown'; code: string }> {
    const unknown = () => ({ kind: 'unknown' as const, code: 'SKILL_EFFECT_UNKNOWN' });
    try {
      const binding = SkillNodeBindingSchema.parse(context.binding), stored = await readNode(tx, context.ownerId, binding.runId, binding.nodeId);
      if (!stored?.binding || !['running', 'waiting_children'].includes(stored.run.status) || stored.node.child_task_id !== context.taskId || hashSkillData(stored.binding) !== hashSkillData(binding)) return unknown();
      const child = await tx.selectFrom('tasks').select(['capability_id', 'lease_token', 'cancellation_requested', 'verification_only', 'verification_source_lease']).where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).executeTakeFirst();
      if (!child || child.cancellation_requested || child.lease_token !== context.leaseToken) return unknown();
      const sourceLease = child.verification_only ? child.verification_source_lease : context.leaseToken;
      if (!sourceLease) return unknown();
      const receipt = await tx.selectFrom('skill_evidence').selectAll().where('owner_id', '=', context.ownerId).where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).where('task_id', '=', context.taskId).where('attempt', '=', stored.node.execution_attempt).where('lease_token', '=', sourceLease).where('status', '=', 'succeeded').executeTakeFirst();
      if (!receipt || receipt.node_lease_token !== stored.node.lease_token || receipt.content_hash !== binding.contentHash || receipt.inputs_hash !== binding.inputsHash || hashSkillData(json(receipt.output)) !== receipt.output_hash) return unknown();
      checkValues(json(stored.node.output_schema), json(receipt.output));
      const result: Record<string, unknown> = { evidenceId: receipt.id, runId: binding.runId, nodeId: binding.nodeId, inputsHash: receipt.inputs_hash, outputHash: receipt.output_hash, output: json(receipt.output) };
      if (child.capability_id === 'skill.node') return { kind: 'confirmed', result, receiptLeaseToken: receipt.lease_token };
      const entries = json(receipt.details).filter((entry: any) => entry.kind === 'runtime.verified');
      if (entries.length !== 1) return unknown();
      const data = entries[0].data;
      if (!data.rawResult || data.taskId !== context.taskId || data.tool !== binding.tool || data.projectionHash !== receipt.output_hash || sha256(canonicalSkillEvidenceJson(data.rawResult)) !== data.resultHash) return unknown();
      return { kind: 'confirmed', result: data.rawResult, receiptLeaseToken: receipt.lease_token };
    } catch { return unknown(); }
  }

  async function getNodeClaim(ownerId: string, binding: SkillNodeBinding, taskId: string, leaseToken: string): Promise<SkillNodeClaim | null> {
    const stored = await readNode(db, ownerId, binding.runId, binding.nodeId);
    if (!stored?.binding || stored.node.child_task_id !== taskId || hashSkillData(stored.binding) !== hashSkillData(binding)) return null;
    const receipt = await db.selectFrom('skill_evidence').selectAll().where('owner_id', '=', ownerId).where('run_id', '=', binding.runId).where('node_id', '=', binding.nodeId).where('task_id', '=', taskId).where('lease_token', '=', leaseToken).where('status', '=', 'started').executeTakeFirst();
    if (!receipt || receipt.node_lease_token !== stored.node.lease_token || stored.node.status !== 'running') return null;
    return { binding, ownerId, taskId, leaseToken, nodeLeaseToken: receipt.node_lease_token, workflowToken: receipt.workflow_token, evidenceId: receipt.id, idempotencyKey: attemptKey(stored.node), contract: SkillContractSchema.parse(json(stored.node.contract)), step: json(stored.node.step), inputs: json(stored.node.inputs), outputSchema: json(stored.node.output_schema) };
  }

  async function verifyRunResult(raw: unknown, context: { ownerId: string; taskId: string }): Promise<Record<string, unknown> | null> {
    try {
      const run = await db.selectFrom('skill_runs').selectAll().where('parent_task_id', '=', context.taskId).where('owner_id', '=', context.ownerId).where('status', '=', 'succeeded').executeTakeFirst();
      if (!run?.result || sha256(canonicalSkillEvidenceJson(raw)) !== sha256(canonicalSkillEvidenceJson(json(run.result)))) return null;
      const parent = await db.selectFrom('tasks').select(['skill_input']).where('id', '=', context.taskId).where('owner_id', '=', context.ownerId).executeTakeFirst();
      if (!parent?.skill_input || hashSkillData(SkillRunInputSchema.parse(json(parent.skill_input))) !== run.input_hash) return null;
      const nodes = await db.selectFrom('skill_run_nodes').selectAll().where('run_id', '=', run.id).execute();
      if (!nodes.length || nodes.some(node => node.status !== 'succeeded')) return null;
      for (const node of nodes) {
        const child = await db.selectFrom('tasks').select(['status']).where('id', '=', node.child_task_id).where('owner_id', '=', context.ownerId).executeTakeFirst();
        const result = await verifyNodeResult(context.ownerId, bindingFor(run, node), node.child_task_id);
        if (child?.status !== 'completed' || !result || result.outputHash !== node.output_hash || hashSkillData(json(node.outputs)) !== result.outputHash) return null;
      }
      return json(run.result);
    } catch { return null; }
  }

  async function acquireNodeResource(claim: SkillNodeClaim, resourceKey: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(resourceKey)) throw new SkillError('SKILL_RESOURCE_INVALID', 'مفتاح المورد غير صالح.');
    await db.transaction().execute(async tx => {
      await lockedClaim(tx, claim.binding, claim, claim.nodeLeaseToken);
      await tx.insertInto('skill_resource_locks').values({ resource_key: resourceKey, receipt_id: claim.evidenceId, run_id: claim.binding.runId, node_id: claim.binding.nodeId, owner_id: claim.ownerId }).onConflict(conflict => conflict.column('resource_key').doNothing()).execute();
      const lock = await tx.selectFrom('skill_resource_locks').select('receipt_id').where('resource_key', '=', resourceKey).executeTakeFirstOrThrow();
      if (lock.receipt_id !== claim.evidenceId) throw new SkillError('SKILL_RESOURCE_BUSY', 'المورد مرتبط بمحاولة أخرى تحتاج اكتمالًا أو مراجعة.', 409);
    });
  }

  async function saveNodePreimage(claim: SkillNodeClaim, data: SkillNodePreimage): Promise<void> {
    if (typeof data.root !== 'string' || data.root.length > 1000 || typeof data.path !== 'string' || data.path.length > 1000 || data.before !== null && (typeof data.before !== 'string' || Buffer.byteLength(data.before) > 65536) || (data.before === null ? data.beforeHash !== null : sha256(data.before) !== data.beforeHash) || !/^[a-f0-9]{64}$/.test(data.afterHash)) throw new SkillError('SKILL_PREIMAGE_INVALID', 'الصورة السابقة أو بصمتها غير صالحة.');
    await db.transaction().execute(async tx => {
      await lockedClaim(tx, claim.binding, claim, claim.nodeLeaseToken);
      const existing = await tx.selectFrom('skill_preimages').selectAll().where('receipt_id', '=', claim.evidenceId).where('root', '=', data.root).where('path', '=', data.path).executeTakeFirst();
      if (existing) { if (existing.before_hash !== data.beforeHash || existing.after_hash !== data.afterHash) throw new SkillError('SKILL_PREIMAGE_CONFLICT', 'تغيرت الصورة المثبتة للمحاولة.', 409); return; }
      await tx.insertInto('skill_preimages').values({ id: randomUUID(), receipt_id: claim.evidenceId, owner_id: claim.ownerId, root: data.root, path: data.path, before_text: data.before, before_hash: data.beforeHash, after_hash: data.afterHash }).execute();
    });
  }

  async function wakeCandidates(): Promise<{ ownerId: string; parentTaskId: string }[]> {
    // Reserve capacity for both classes: a stream of completions cannot starve due retries.
    const [completed, due] = await Promise.all([
      db.selectFrom('skill_runs as r').innerJoin('tasks as p', 'p.id', 'r.parent_task_id').innerJoin('skill_run_nodes as n', 'n.run_id', 'r.id').innerJoin('tasks as c', 'c.id', 'n.child_task_id')
        .select(['r.owner_id', 'r.parent_task_id', 'r.created_at']).where('p.status', '=', 'paused').where('r.status', 'in', ['running', 'waiting_children']).where('n.status', 'in', ['queued', 'running', 'failed', 'unknown', 'cancelled']).where('c.status', 'in', [...terminal]).distinct().orderBy('r.created_at').orderBy('r.parent_task_id').limit(25).execute(),
      db.selectFrom('skill_runs as r').innerJoin('tasks as p', 'p.id', 'r.parent_task_id').innerJoin('skill_run_nodes as n', 'n.run_id', 'r.id')
        .select(['r.owner_id', 'r.parent_task_id']).select(eb => eb.fn.min('n.retry_not_before').as('due')).where('p.status', '=', 'paused').where('r.status', 'in', ['running', 'waiting_children']).where('n.status', '=', 'pending').where('n.retry_not_before', '<=', sql<Date>`CURRENT_TIMESTAMP`).groupBy(['r.owner_id', 'r.parent_task_id']).orderBy('due').orderBy('r.parent_task_id').limit(25).execute(),
    ]);
    return [...new Map([...completed, ...due].map(row => [row.parent_task_id, { ownerId: row.owner_id as string, parentTaskId: row.parent_task_id as string }])).values()];
  }
  async function cancelRun(tx: Kysely<any>, ownerId: string, parentTaskId: string): Promise<void> {
    const run = await tx.selectFrom('skill_runs').selectAll().where('owner_id', '=', ownerId).where('parent_task_id', '=', parentTaskId).forUpdate().executeTakeFirst();
    if (!run || ['succeeded', 'cancelled'].includes(run.status)) return;
    await tx.updateTable('skill_runs').set({ status: 'cancelled', finished_at: new Date(), updated_at: new Date() }).where('id', '=', run.id).execute();
    await tx.updateTable('skill_run_nodes').set({ status: 'cancelled', finished_at: new Date() }).where('run_id', '=', run.id).where('status', 'in', ['pending', 'queued']).execute();
    await tx.updateTable('skill_run_nodes').set({ status: 'unknown', finished_at: new Date() }).where('run_id', '=', run.id).where('status', '=', 'running').execute();
    await tx.updateTable('skill_evidence').set({ status: 'unknown', error_code: 'SKILL_CANCELLED', finished_at: new Date() }).where('run_id', '=', run.id).where('status', '=', 'started').execute();
  }
  return { runSkillGraph, readNode, claimNode, getNodeClaim, recordNodeResult, verifyNodeResult, recoverNode, verifyRunResult, acquireNodeResource, saveNodePreimage, wakeCandidates, cancelRun, appendEvidence: (claim: SkillNodeClaim, entry: { kind: string; data: unknown }) => appendSkillEvidence(db, claim, entry) };
}
