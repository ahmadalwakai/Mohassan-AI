import { z } from 'zod';
import type { Kysely } from 'kysely';
import { isBoundedSkillJson, type SkillToolId, type SkillNodeBinding, type SkillStep } from '@mohassan/contracts';
import { SkillError } from './errors.ts';
import { sha256 } from './hash.ts';
import { canonicalSkillEvidenceJson, hashSkillData, type SkillNodeClaim, type SkillNodeOutcome, type SkillNodeResult } from './evidence.ts';
import { readSkillExecutionAuthority } from './execution-authority.ts';
import { SkillScriptError, type SkillScriptExecutor } from './executor.ts';
import { ProviderError, classifyProviderFallback } from '@mohassan/providers';
import { createSkillCircuit, type SkillCircuitTicket } from './circuit.ts';
import { SkillFailureProofSchema, type SkillFailureProof } from './fallback.ts';

export interface SkillFilePreimage {
  root: string;
  path: string;
  before: string | null;
  beforeHash: string | null;
  afterHash: string;
}

/** Only the Runtime supplies this context. assertActive checks the exact approved
 * task, lease, workflow authority, pinned content and current grants. */
export interface SkillToolContext {
  ownerId: string;
  runId: string;
  nodeId: string;
  taskId: string;
  leaseToken: string;
  versionId: string;
  contentHash: string;
  signal: AbortSignal;
  idempotencyKey: string;
  grantRoots: readonly string[];
  declaredPaths: readonly string[];
  assertActive(): Promise<void>;
  acquireResource(resourceKey: string): Promise<void>;
  savePreimage(value: SkillFilePreimage): Promise<void>;
  recordUsage(value: {model: string; inputTokens?: number; outputTokens?: number; usageKnown: boolean; errorCode?: string; httpStatus?: number; retryAfterMs?: number; retryAfterInvalid?: boolean}): Promise<void>;
}

export interface SkillToolAdapter {
  id: SkillToolId;
  input: z.ZodType<any>;
  output: z.ZodType<any>;
  execute(input: Record<string, unknown>, context: SkillToolContext): Promise<Record<string, unknown>>;
  /** Re-read the real resource or independently persisted receipt. */
  verify(input: Record<string, unknown>, output: Record<string, unknown>, context: SkillToolContext): Promise<boolean>;
}

export interface SkillGatewayResult {
  evidenceId: string;
  runId: string;
  nodeId: string;
  inputsHash: string;
  outputHash: string;
  output: Record<string, unknown>;
}

export interface SkillGatewayContext {
  ownerId: string; taskId: string; leaseToken: string; binding: SkillNodeBinding;
  signal: AbortSignal; assertActive(): Promise<void>;
  verificationOnly?: true;
  receiptLeaseToken?: string;
}
export interface SkillModelAdapter {
  execute(inputs: Record<string, unknown>, fields: SkillStep['outputs'], context: SkillToolContext): Promise<Record<string, unknown>>;
}
interface SchedulerEvidence {
  claimNode(binding: SkillNodeBinding, context: {ownerId: string; taskId: string; leaseToken: string}): Promise<SkillNodeClaim>;
  recordNodeResult(claim: SkillNodeClaim, outcome: SkillNodeOutcome): Promise<SkillNodeResult | null>;
  verifyNodeResult(ownerId: string, binding: SkillNodeBinding, taskId: string): Promise<SkillNodeResult | null>;
  saveNodePreimage(claim: SkillNodeClaim, preimage: SkillFilePreimage): Promise<void>;
  acquireNodeResource(claim: SkillNodeClaim, resourceKey: string): Promise<void>;
  appendEvidence(claim: SkillNodeClaim, entry: {kind: string; data: unknown}): Promise<void>;
  getNodeClaim(ownerId: string, binding: SkillNodeBinding, taskId: string, leaseToken: string): Promise<SkillNodeClaim | null>;
}

export function skillOutputSchema(fields: SkillStep['outputs']) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let schema: z.ZodType = field.type === 'number' ? z.number().finite() : field.type === 'boolean' ? z.boolean()
      : field.type === 'url' ? z.url().max(4000) : field.type === 'json' ? z.unknown().refine(isBoundedSkillJson)
      : z.string().max(65536);
    if (!field.required) schema = schema.optional();
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}

/** A thin authorization/evidence boundary. Runtime owns task dispatch and leases;
 * the existing adapters own the actual browser/model/coding/file operation. */
export function createToolGateway(db: Kysely<any>, options: {scheduler: SchedulerEvidence; adapters: readonly SkillToolAdapter[]; model?: SkillModelAdapter; script?: SkillScriptExecutor; mappedOutputs?: Partial<Record<SkillToolId, z.ZodType<any>>>}) {
  const adapters = new Map(options.adapters.map(adapter => [adapter.id, adapter]));
  const circuit = createSkillCircuit(db);
  if (adapters.size !== options.adapters.length) throw new Error('Duplicate skill tool adapter');
  const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
  // Read for every check, so a gate that closes mid-run stops the next step.
  const scriptsReady = async () => options.script ? await options.script.ready().catch(() => false) : false;
  function validateDeclaredOutputs(fields: SkillStep['outputs'], schema: z.ZodType<any>) {
    if (!(schema instanceof z.ZodObject)) throw new SkillError('SKILL_TOOL_SCHEMA_INVALID', 'الأداة تحتاج مخطط ناتج كائن صريح.');
    for (const field of fields) {
      if (!Object.hasOwn(schema.shape, field.name)) throw new SkillError('SKILL_OUTPUT_UNSUPPORTED', `الأداة لا تعلن الناتج ${field.name}.`);
      const typed = z.toJSONSchema(schema.shape[field.name]) as {type?: string | string[]};
      const actual = Array.isArray(typed.type) ? typed.type.filter(type => type !== 'null') : typed.type ? [typed.type] : [];
      const expected = ['file', 'url'].includes(field.type) ? 'string' : field.type;
      if (expected !== 'json' && actual.length && !actual.every(type => type === expected || expected === 'number' && type === 'integer')) throw new SkillError('SKILL_OUTPUT_TYPE', `نوع الناتج ${field.name} لا يطابق الأداة.`);
    }
  }
  function toolContext(context: SkillGatewayContext, authority: Awaited<ReturnType<typeof readSkillExecutionAuthority>>, signal: AbortSignal, claim?: SkillNodeClaim): SkillToolContext {
    return {
      ...context, signal, runId: context.binding.runId, nodeId: context.binding.nodeId,
      versionId: context.binding.versionId, contentHash: context.binding.contentHash,
      idempotencyKey: claim?.idempotencyKey ?? `skill:${context.binding.runId}:${context.binding.nodeId}`,
      grantRoots: authority.roots, declaredPaths: authority.contract.requires.paths,
      async assertActive() {
        signal.throwIfAborted(); await context.assertActive();
        const current = await readSkillExecutionAuthority(db, context.ownerId, context.binding, false, await scriptsReady());
        // Existing context roots must not survive grant replacement or narrowing.
        if (authority.roots.some(root => !current.roots.includes(root))) throw new SkillError('SKILL_ROOT_GRANT_REVOKED', 'انتهى تصريح مجلد الملفات.', 403);
        signal.throwIfAborted();
      },
      async acquireResource(key) { if (!claim) throw new SkillError('SKILL_VERIFY_READ_ONLY', 'التحقق لا يملك حق تنفيذ جديد.'); await options.scheduler.acquireNodeResource(claim, key); },
      async savePreimage(value) { if (!claim) throw new SkillError('SKILL_VERIFY_READ_ONLY', 'التحقق لا يملك حق كتابة.'); await options.scheduler.saveNodePreimage(claim, value); },
      async recordUsage(value) {
        if (!claim) throw new SkillError('SKILL_VERIFY_READ_ONLY', 'التحقق لا يرسل طلب نموذج جديد.');
        const parsed = z.object({model: z.string().min(1).max(100), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), usageKnown: z.boolean(), errorCode: z.string().max(64).optional(), httpStatus: z.number().int().min(100).max(599).optional(), retryAfterMs: z.number().finite().nonnegative().optional(), retryAfterInvalid: z.boolean().optional()}).strict().parse(value);
        await options.scheduler.appendEvidence(claim, {kind: 'model.usage', data: parsed});
      },
    };
  }

  async function executeNode(context: SkillGatewayContext): Promise<SkillGatewayResult> {
    if (context.verificationOnly) throw new SkillError('SKILL_VERIFICATION_ONLY', 'هذه الاستعادة تسمح بالتحقق دون تنفيذ جديد.', 403);
    context.signal.throwIfAborted(); await context.assertActive();
    const authority = await readSkillExecutionAuthority(db, context.ownerId, context.binding, false, await scriptsReady());
    const adapter = context.binding.tool ? adapters.get(context.binding.tool) : undefined;
    if (context.binding.kind === 'tool' && !adapter || context.binding.kind === 'model' && !options.model) throw new SkillError('SKILL_TOOL_UNAVAILABLE', 'لا يوجد محول مهيأ لهذه الخطوة.', 409);
    const claim = await options.scheduler.claimNode(context.binding, context);
    // The native helper owns a script's deadline and reports it; this outer bound only covers its startup.
    const timeout = AbortSignal.timeout((authority.contract.execution?.timeoutMs ?? 20_000) + (context.binding.kind === 'script' ? 30_000 : 0));
    const signal = AbortSignal.any([context.signal, timeout]);
    const tool = toolContext(context, authority, signal, claim);
    let started = false;
    let ticket: SkillCircuitTicket | undefined;
    let removeAbort = () => {};
    try {
      if (hashSkillData(claim.inputs) !== context.binding.inputsHash || claim.step.kind !== context.binding.kind || claim.step.tool !== context.binding.tool) throw new SkillError('SKILL_BINDING_MISMATCH', 'لم تعد مدخلات التنفيذ مطابقة للموافقة.', 409);
      const inputs = adapter ? adapter.input.parse(claim.inputs) : claim.inputs;
      if (adapter) validateDeclaredOutputs(claim.outputSchema, adapter.output);
      await tool.assertActive();
      ticket = await circuit.acquire(context.ownerId, context.binding.versionId, context.binding.contentHash, context.binding.tool ?? (context.binding.kind === 'script' ? 'script:isolated' : 'model:configured-router'));
      await options.scheduler.appendEvidence(claim, {kind: 'circuit.ticket', data: ticket});
      await tool.assertActive();
      // Persisted claim is already 'started'. Cancellation cannot turn an
      // ambiguous effect into a safely retryable failure.
      started = true;
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new SkillError('SKILL_EXECUTION_ABORTED', 'انتهت المهلة أو ألغي التنفيذ؛ يلزم التحقق من الأثر.', 409));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true});
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      });
      const script = context.binding.kind === 'script' ? options.script!.execute({entry: claim.step.entry!, inputs, files: authority.files, signal, ...(authority.contract.execution ? {limits: authority.contract.execution} : {})}) : null;
      const operation = script ?? (adapter ? adapter.execute(inputs, tool) : options.model!.execute(inputs, claim.outputSchema, tool));
      const raw = await Promise.race([operation, aborted]);
      signal.throwIfAborted();
      if (script) await options.scheduler.appendEvidence(claim, {kind: 'script.receipt', data: (raw as Awaited<typeof script>).receipt});
      const actual = adapter ? adapter.output.parse(raw) : skillOutputSchema(claim.outputSchema).parse(script ? (raw as Awaited<typeof script>).outputs : raw);
      if (!isBoundedSkillJson(actual)) throw new SkillError('SKILL_OUTPUT_LIMIT', 'تجاوز ناتج الأداة حدود البيانات.');
      if (adapter && !await adapter.verify(inputs, actual, tool)) throw new SkillError('SKILL_TOOL_VERIFY_FAILED', 'لم يجتز الناتج تحقق الأداة المستقل.', 409);
      await tool.assertActive();
      const projected: Record<string, unknown> = {};
      for (const field of claim.outputSchema) if (Object.hasOwn(actual, field.name)) projected[field.name] = actual[field.name];
      const output = skillOutputSchema(claim.outputSchema).parse(projected);
      await circuit.settle(ticket, 'success');
      const result = await options.scheduler.recordNodeResult(claim, {outcome: 'succeeded', outputs: output, evidence: [{kind: 'gateway.result', data: {inputs, actual, fields: claim.outputSchema, kind: claim.step.kind}}]});
      if (!result) throw new SkillError('SKILL_FENCE_LOST', 'فقد التنفيذ ملكيته قبل حفظ النتيجة.', 409);
      return result;
    } catch (error) {
      const proof = failureProof(error, context, started, signal.aborted);
      if (error instanceof SkillScriptError) await options.scheduler.appendEvidence(claim, {kind: 'script.receipt', data: error.receipt}).catch(() => undefined);
      if (ticket) await circuit.settle(ticket, isServiceFailure(error, proof, signal.aborted) ? 'transient_failure' : 'neutral', {retryAfterMs: proof.retryAfterMs}).catch(() => undefined);
      await options.scheduler.recordNodeResult(claim, {outcome: proof.effect === 'none' ? 'failed' : 'unknown', errorCode: proof.errorCode, evidence: [{kind: 'gateway.failure', data: proof}]});
      throw error;
    } finally { removeAbort(); }
  }

  async function verifyNode(raw: unknown, context: SkillGatewayContext): Promise<Record<string, unknown> | null> {
    try {
      const result = await options.scheduler.verifyNodeResult(context.ownerId, context.binding, context.taskId);
      if (!result || canonicalSkillEvidenceJson(raw) !== canonicalSkillEvidenceJson(result)) return null;
      const authority = await readSkillExecutionAuthority(db, context.ownerId, context.binding, false, await scriptsReady());
      const receipt = await db.selectFrom('skill_evidence').select(['details']).where('id', '=', result.evidenceId).where('owner_id', '=', context.ownerId).where('task_id', '=', context.taskId).executeTakeFirst();
      const details = receipt ? json(receipt.details) : [];
      const entries = details.filter((entry: any) => entry.kind === 'gateway.result');
      if (entries.length !== 1) return null;
      const data = entries[0].data;
      if (hashSkillData(data.inputs) !== context.binding.inputsHash) return null;
      const projected: Record<string, unknown> = {};
      for (const field of data.fields) if (Object.hasOwn(data.actual, field.name)) projected[field.name] = data.actual[field.name];
      if (hashSkillData(projected) !== result.outputHash || !skillOutputSchema(data.fields).safeParse(projected).success) return null;
      if (context.binding.kind === 'model') {
        // This verifies provider accounting + typed output, not the semantic truth
        // of a model's text; later evaluation uses independent benchmarks.
        return details.some((entry: any) => entry.kind === 'model.usage' && entry.data.usageKnown) ? {...result} : null;
      }
      if (context.binding.kind === 'script') return details.some((entry: any) => entry.kind === 'script.receipt' && entry.data.inputsHash === hashSkillData(data.inputs) && entry.data.resultHash === hashSkillData(data.actual) && entry.data.exitCode === 0 && entry.data.timedOut === false) ? {...result} : null;
      const adapter = context.binding.tool ? adapters.get(context.binding.tool) : undefined;
      if (!adapter || !adapter.input.safeParse(data.inputs).success || !adapter.output.safeParse(data.actual).success) return null;
      const receiptContext = context.verificationOnly && context.receiptLeaseToken ? {...context, leaseToken: context.receiptLeaseToken} : context;
      return await adapter.verify(data.inputs, data.actual, toolContext(receiptContext, authority, context.signal)) ? {...result} : null;
    } catch { return null; }
  }
  async function beforeMappedExecute(context: SkillGatewayContext) {
    if (context.verificationOnly) throw new SkillError('SKILL_VERIFICATION_ONLY', 'لا تعيد الاستعادة تنفيذ الأداة.', 403);
    await context.assertActive();
    await readSkillExecutionAuthority(db, context.ownerId, context.binding);
    const claim = await options.scheduler.claimNode(context.binding, context);
    const schema = context.binding.tool ? adapters.get(context.binding.tool)?.output ?? options.mappedOutputs?.[context.binding.tool] : undefined;
    if (!schema) throw new SkillError('SKILL_TOOL_SCHEMA_INVALID', 'لا يوجد مخطط ناتج للأداة المربوطة.');
    validateDeclaredOutputs(claim.outputSchema, schema);
    const ticket = await circuit.acquire(context.ownerId, context.binding.versionId, context.binding.contentHash, context.binding.tool ?? 'model:configured-router');
    await options.scheduler.appendEvidence(claim, {kind: 'circuit.ticket', data: ticket});
    await context.assertActive();
    await readSkillExecutionAuthority(db, context.ownerId, context.binding);
    await options.scheduler.appendEvidence(claim, {kind: 'gateway.dispatch_ready', data: {tool: context.binding.tool ?? context.binding.kind}});
  }
  async function recordChildResult(raw: Record<string, unknown>, context: SkillGatewayContext, nativeResult: Record<string, unknown> = raw) {
    if (context.verificationOnly) throw new SkillError('SKILL_VERIFICATION_ONLY', 'التحقق لا يكتب إيصال تنفيذ جديد.', 403);
    await context.assertActive();
    await readSkillExecutionAuthority(db, context.ownerId, context.binding);
    const claim = await options.scheduler.getNodeClaim(context.ownerId, context.binding, context.taskId, context.leaseToken);
    if (!claim) throw new SkillError('SKILL_FENCE_LOST', 'إيصال المهمة الفرعية غير متاح.', 409);
    const projected: Record<string, unknown> = {};
    for (const field of claim.outputSchema) if (Object.hasOwn(raw, field.name)) projected[field.name] = raw[field.name];
    const outputs = skillOutputSchema(claim.outputSchema).parse(projected);
    const ticket = await persistedTicket(claim);
    if (ticket) await circuit.settle(ticket, 'success');
    const saved = await options.scheduler.recordNodeResult(claim, {outcome: 'succeeded', outputs,
      evidence: [{kind: 'runtime.verified', data: {taskId: context.taskId, tool: context.binding.tool, resultHash: sha256Evidence(nativeResult), rawResult: nativeResult, projectionHash: hashSkillData(outputs)}}]});
    if (!saved) throw new SkillError('SKILL_FENCE_LOST', 'فقدت نتيجة المهمة الفرعية ملكيتها.', 409);
  }
  async function recordChildFailure(error: unknown, context: SkillGatewayContext) {
    if (context.verificationOnly) return;
    const claim = await options.scheduler.getNodeClaim(context.ownerId, context.binding, context.taskId, context.leaseToken);
    if (claim) {
      const receipt = await db.selectFrom('skill_evidence').select('details').where('id', '=', claim.evidenceId).executeTakeFirstOrThrow();
      const started = json(receipt.details).some((entry: any) => entry.kind === 'gateway.dispatch_ready');
      const proof = failureProof(error, context, started, context.signal.aborted), ticket = await persistedTicket(claim);
      if (ticket) await circuit.settle(ticket, isServiceFailure(error, proof, context.signal.aborted) ? 'transient_failure' : 'neutral', {retryAfterMs: proof.retryAfterMs}).catch(() => undefined);
      await options.scheduler.recordNodeResult(claim, {outcome: proof.effect === 'none' ? 'failed' : 'unknown', errorCode: proof.errorCode, evidence: [{kind: 'gateway.failure', data: proof}]});
    }
  }
  async function persistedTicket(claim: SkillNodeClaim): Promise<SkillCircuitTicket | undefined> {
    const receipt = await db.selectFrom('skill_evidence').select('details').where('id', '=', claim.evidenceId).where('owner_id', '=', claim.ownerId).executeTakeFirst();
    const entries = receipt ? json(receipt.details).filter((entry: any) => entry.kind === 'circuit.ticket') : [];
    return entries.length === 1 ? entries[0].data : undefined;
  }
  async function verifyRecoveredMapped(raw: Record<string, unknown>, context: SkillGatewayContext, normalized: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!context.verificationOnly || !context.receiptLeaseToken) return null;
    try {
      await context.assertActive(); await readSkillExecutionAuthority(db, context.ownerId, context.binding);
      const result = await options.scheduler.verifyNodeResult(context.ownerId, context.binding, context.taskId);
      if (!result) return null;
      const receipt = await db.selectFrom('skill_evidence').select('details').where('id', '=', result.evidenceId).where('owner_id', '=', context.ownerId).where('lease_token', '=', context.receiptLeaseToken).executeTakeFirst();
      const entries = receipt ? json(receipt.details).filter((entry: any) => entry.kind === 'runtime.verified') : [];
      if (entries.length !== 1 || entries[0].data.resultHash !== sha256Evidence(raw) || entries[0].data.projectionHash !== result.outputHash) return null;
      const projected = Object.fromEntries(Object.keys(result.output).map(key => [key, normalized[key]]));
      if (hashSkillData(projected) !== result.outputHash) return null;
      return raw;
    } catch { return null; }
  }
  return {executeNode, verifyNode, beforeMappedExecute, recordChildResult, recordChildFailure, verifyRecoveredMapped, circuit, tools: [...adapters.keys()]};
}

function sha256Evidence(value: unknown) { return sha256(canonicalSkillEvidenceJson(value)); }
function isServiceFailure(error: unknown, proof: SkillFailureProof, aborted: boolean) {
  if (aborted) return false;
  if (proof.retryable) return true;
  if (error instanceof ProviderError) return ['NETWORK_ERROR', 'UPSTREAM_ERROR', 'RATE_LIMITED'].includes(error.code);
  return [502, 503, 504].includes(Number((error as {statusCode?: unknown})?.statusCode));
}

function failureProof(error: unknown, context: SkillGatewayContext, started: boolean, aborted: boolean): SkillFailureProof {
  const candidate = z.string().regex(/^[A-Z0-9_]{1,64}$/).safeParse((error as {code?: unknown})?.code);
  const errorCode = aborted ? 'SKILL_EXECUTION_ABORTED' : candidate.success ? candidate.data : 'SKILL_ADAPTER_FAILED';
  if (!started) return SkillFailureProofSchema.parse({source: 'pre_dispatch', effect: 'none', retryable: false, errorCode, ...(context.binding.tool ? {tool: context.binding.tool} : {})});
  if (!aborted && error instanceof ProviderError && (context.binding.kind === 'model' || context.binding.tool === 'vision.inspect')) {
    const classified = classifyProviderFallback(error), safe = classified.allowed || classified.reason === 'retry_budget_exceeded';
    const proof = SkillFailureProofSchema.safeParse({source: 'provider_rejection', effect: safe ? 'none' : 'unknown', retryable: safe, errorCode: error.code,
      ...(context.binding.tool ? {tool: context.binding.tool} : {}), ...(error.httpStatus === undefined ? {} : {httpStatus: error.httpStatus}),
      ...(error.usage === undefined ? {} : {usage: error.usage}), ...(error.retryAfterMs === undefined ? {} : {retryAfterMs: error.retryAfterMs}), ...(error.retryAfterInvalid === undefined ? {} : {retryAfterInvalid: error.retryAfterInvalid})});
    return proof.success ? proof.data : {source: 'provider_rejection', effect: 'unknown', retryable: false, errorCode, retryAfterInvalid: true};
  }
  // Nothing a script does leaves the sandbox, so its failure can never be an unknown host effect.
  if (context.binding.kind === 'script') return SkillFailureProofSchema.parse({source: 'adapter', effect: 'none', retryable: false, errorCode});
  const safeRead = !aborted && context.binding.tool === 'file.read';
  return SkillFailureProofSchema.parse({source: 'adapter', effect: safeRead ? 'none' : 'unknown', retryable: safeRead && ['EBUSY', 'EAGAIN', 'ETIMEDOUT'].includes(errorCode), errorCode, ...(context.binding.tool ? {tool: context.binding.tool} : {})});
}
