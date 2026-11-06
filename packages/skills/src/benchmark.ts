import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema } from '@mohassan/contracts';
import { SkillBenchmarkCaseResultSchema, SkillBenchmarkEvaluationSchema, SkillBenchmarkPageSchema, SkillBenchmarkQuerySchema, SkillBenchmarkRequestSchema, SkillBenchmarkSnapshotSchema, SkillBenchmarkSuiteSchema,
  type SkillBenchmarkCaseResult, type SkillBenchmarkEvaluation, type SkillBenchmarkPin, type SkillBenchmarkSnapshot, type SkillBenchmarkSuite } from '../../contracts/src/skill-benchmarks.js';
import { canonicalSkillEvidenceJson, hashSkillData } from './evidence.ts';
import { SkillError } from './errors.ts';
import { sha256, skillContentMatches } from './hash.ts';
import { classifySkillFile, INSPECTOR_VERSION } from './inspector.ts';

const json = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
const digest = (value: unknown) => sha256(canonicalSkillEvidenceJson(value));
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
export const MAX_SKILL_BENCHMARK_RUNS_PER_OWNER = 500;
export interface SkillBenchmarkRunner {
  execute(input: { benchmarkRunId: string; arm: 'baseline' | 'candidate'; snapshot: SkillBenchmarkSnapshot; suite: SkillBenchmarkSuite; signal: AbortSignal }, onCase: (result: SkillBenchmarkCaseResult) => Promise<void>): Promise<void>;
}
export interface SkillBenchmarkOptions {
  suite(id: SkillBenchmarkSuite['id']): SkillBenchmarkSuite | undefined;
  runner: SkillBenchmarkRunner;
  leaseMs?: number;
  timeoutMs?: number;
  onCompleted?(tx: Kysely<any>, ownerId: string, evaluation: SkillBenchmarkEvaluation): Promise<void>;
}

async function loadSnapshot(db: Kysely<any>, ownerId: string, id: string, revision: number): Promise<SkillBenchmarkSnapshot> {
  const row = await db.selectFrom('skill_versions').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
  if (!row) throw new SkillError('SKILL_NOT_FOUND', 'لم يُعثر على نسخة المهارة لهذا المالك.', 404);
  if (row.revision !== revision) throw new SkillError('SKILL_VERSION_CONFLICT', 'تغيرت مراجعة المهارة قبل القياس.', 409);
  if (!['inspected', 'tested', 'benchmarked', 'active', 'deprecated'].includes(row.status)) throw new SkillError('SKILL_BENCHMARK_STATUS_INVALID', 'يلزم فحص المهارة قبل قياسها.', 409);
  const contract = SkillContractSchema.parse(json(row.contract));
  const files = await db.selectFrom('skill_files').selectAll().where('version_id', '=', id).orderBy('path').limit(201).execute();
  if (files.length > 200 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 256000 || !files.some(file => file.path === 'SKILL.md' && file.kind === 'instructions')
    || files.some(file => classifySkillFile(file.path) !== file.kind || sha256(file.content) !== file.content_hash || Buffer.byteLength(file.content) !== file.size_bytes) || !skillContentMatches(contract, files.map(file => ({ path: String(file.path), content: String(file.content) })), row.content_hash)) throw new SkillError('SKILL_INTEGRITY_FAILED', 'لا تطابق ملفات القياس النسخة المفحوصة.', 409);
  const inspection = await db.selectFrom('skill_inspections').selectAll().where('owner_id', '=', ownerId).where('version_id', '=', id).where('content_hash', '=', row.content_hash).orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  if (!inspection || inspection.inspector_version !== INSPECTOR_VERSION || !['pass', 'review'].includes(inspection.verdict)) throw new SkillError('SKILL_INSPECTION_STALE', 'يلزم فحص حالي صالح قبل القياس.', 409);
  return SkillBenchmarkSnapshotSchema.parse({ pin: { versionId: id, revision, contentHash: row.content_hash, inspectionId: inspection.id, inspectorVersion: inspection.inspector_version }, contract,
    files: files.map(file => ({ path: file.path, kind: file.kind, content: file.content, contentHash: file.content_hash, sizeBytes: file.size_bytes })) });
}
export { loadSnapshot as loadSkillBenchmarkSnapshot };

function validateCases(evaluation: SkillBenchmarkEvaluation): void {
  const keys = new Set<string>();
  for (const result of evaluation.cases) {
    const pin = evaluation[result.arm], expected = evaluation.suite.cases.find(item => item.id === result.caseId), key = `${result.arm}:${result.caseId}`;
    if (!expected || keys.has(key) || result.split !== expected.split || result.scope !== evaluation.suite.scope || result.sourceVersionId !== pin.versionId || result.sourceContentHash !== pin.contentHash
      || result.suiteHash !== evaluation.suite.suiteHash || result.configHash !== evaluation.suite.configHash || result.verifierVersion !== evaluation.suite.verifierVersion) throw new SkillError('SKILL_BENCHMARK_INTEGRITY_FAILED', 'نتيجة القياس لا تطابق الحالة والنسخة المثبتتين.', 409);
    if (result.status === 'passed' && !result.evidence.some(proof => proof.kind === expected.proofKind && proof.inputsHash === result.inputsHash && proof.outputHash === result.outputHash)) throw new SkillError('SKILL_BENCHMARK_PROOF_INVALID', 'لا يطابق دليل الحالة نوع البرهان وبصماته المثبتة.', 409);
    keys.add(key);
  }
  if (evaluation.status === 'completed' && keys.size !== evaluation.suite.cases.length * 2) throw new SkillError('SKILL_BENCHMARK_RESULTS_INCOMPLETE', 'القياس المقارن غير مكتمل.', 409);
}
function evaluationDto(row: any): SkillBenchmarkEvaluation {
  const baseline = json(row.baseline_pin), candidate = json(row.candidate_pin), suite = json(row.suite_snapshot), cases = json(row.results);
  if (digest({ baseline, candidate, suite }) !== row.pins_hash || digest(cases) !== row.results_hash || digest(suite) !== row.benchmark_id || suite.suiteHash !== row.suite_hash || baseline.versionId !== row.baseline_id || candidate.versionId !== row.candidate_id) throw new SkillError('SKILL_BENCHMARK_INTEGRITY_FAILED', 'تغير سجل القياس المثبت.', 409);
  const expired = row.status === 'running' && new Date(row.lease_expires_at).getTime() <= Date.now();
  const result = SkillBenchmarkEvaluationSchema.parse({ id: row.id, status: expired ? 'unknown' : row.status, baseline, candidate, suite, cases, evidenceScope: 'isolated_experiment', startedAt: iso(row.started_at), finishedAt: row.finished_at ? iso(row.finished_at) : null, errorCode: expired ? 'SKILL_BENCHMARK_LEASE_EXPIRED' : row.error_code ?? null });
  validateCases(result); return result;
}

export async function readBenchmarkEvaluation(db: Kysely<any>, ownerId: string, id: string): Promise<SkillBenchmarkEvaluation> {
  z.uuid().parse(id);
  const row = await db.selectFrom('skill_benchmark_runs').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
  if (!row) throw new SkillError('SKILL_BENCHMARK_NOT_FOUND', 'لم يُعثر على القياس لهذا المالك.', 404);
  return evaluationDto(row);
}
export async function listBenchmarkEvaluations(db: Kysely<any>, ownerId: string, raw: unknown = {}) {
  const query = SkillBenchmarkQuerySchema.parse(raw);
  const read = async (tx: Kysely<any>) => {
    let selection = tx.selectFrom('skill_benchmark_runs').where('owner_id', '=', ownerId);
    if (query.versionId) selection = selection.where(eb => eb.or([eb('baseline_id', '=', query.versionId!), eb('candidate_id', '=', query.versionId!)]));
    const count = await selection.select(eb => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow();
    const rows = await selection.selectAll().orderBy('started_at', 'desc').orderBy('id').offset(query.offset).limit(query.limit).execute();
    return SkillBenchmarkPageSchema.parse({ items: rows.map(evaluationDto), total: Number(count.total), limit: query.limit, offset: query.offset });
  };
  return db.isTransaction ? read(db) : db.transaction().setIsolationLevel('repeatable read').execute(read);
}

/** Historical results remain readable after lifecycle changes. A promotion
 * caller must check current pins inside its own already-fenced transaction. */
export async function benchmarkPinsCurrent(db: Kysely<any>, ownerId: string, evaluation: SkillBenchmarkEvaluation): Promise<boolean> {
  try {
    for (const pin of [evaluation.baseline, evaluation.candidate]) {
      const row = await db.selectFrom('skill_versions').select('revision').where('owner_id', '=', ownerId).where('id', '=', pin.versionId).executeTakeFirst();
      if (!row) return false;
      const current = await loadSnapshot(db, ownerId, pin.versionId, row.revision);
      // Lifecycle revisions are mutable; immutable content and the exact current
      // inspection are the evidence identity. Activation/rollback fence their
      // own expected revision and status separately.
      if (current.pin.contentHash !== pin.contentHash || current.pin.inspectionId !== pin.inspectionId || current.pin.inspectorVersion !== pin.inspectorVersion) return false;
    }
    return true;
  } catch { return false; }
}

export function createSkillBenchmarkControl(db: Kysely<any>, options: SkillBenchmarkOptions) {
  const leaseMs = z.number().int().min(100).max(300000).parse(options.leaseMs ?? 60000), timeoutMs = z.number().int().min(100).max(1800000).parse(options.timeoutMs ?? 600000);
  const workers = new Map<string, { controller: AbortController; promise: Promise<void> }>(), starts = new Set<Promise<SkillBenchmarkEvaluation>>(); let closing = false;
  async function audit(tx: Kysely<any>, ownerId: string, id: string, event: string, detail: Record<string, unknown>) { await tx.insertInto('skill_audit').values({ id: randomUUID(), owner_id: ownerId, target_id: id, event, detail: JSON.stringify(detail) }).execute(); }
  async function recoverExpired(): Promise<number> {
    return db.transaction().execute(async tx => {
      const rows = await tx.selectFrom('skill_benchmark_runs').select(['id', 'owner_id']).where('status', '=', 'running').where('lease_expires_at', '<=', sql<Date>`CURRENT_TIMESTAMP`).orderBy('started_at').limit(100).forUpdate().skipLocked().execute();
      for (const row of rows) {
        await tx.updateTable('skill_benchmark_runs').set({ status: 'unknown', error_code: 'SKILL_BENCHMARK_LEASE_EXPIRED', run_token: randomUUID(), finished_at: new Date() }).where('id', '=', row.id).execute();
        await audit(tx, row.owner_id, row.id, 'skill.benchmark_unknown', { reason: 'lease_expired' });
      }
      return rows.length;
    });
  }
  async function fenced(tx: Kysely<any>, id: string, ownerId: string, token: string) {
    const row = await tx.selectFrom('skill_benchmark_runs').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).where('status', '=', 'running').where('run_token', '=', token).forUpdate().executeTakeFirst();
    // Evaluate time after acquiring the lock: the lock wait itself may outlive
    // a lease, and CURRENT_TIMESTAMP is frozen at transaction start.
    const active = row && await tx.selectFrom('skill_benchmark_runs').select('id').where('id', '=', id).where('lease_expires_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (!active) throw new SkillError('SKILL_BENCHMARK_FENCE_LOST', 'انتهت ملكية تجربة القياس؛ لن تُقبل نتيجة متأخرة.', 409);
    return row;
  }
  async function executeOwned(ownerId: string, id: string, token: string, baseline: SkillBenchmarkSnapshot, candidate: SkillBenchmarkSnapshot, suite: SkillBenchmarkSuite, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort(new Error('BENCHMARK_TIMEOUT')), timeoutMs); timeout.unref();
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => { heartbeat = heartbeat.then(async () => {
      await db.transaction().execute(async tx => {
        await fenced(tx, id, ownerId, token); controller.signal.throwIfAborted();
        await tx.updateTable('skill_benchmark_runs').set({ lease_expires_at: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'` }).where('id', '=', id).execute();
      });
    }).catch(() => { controller.abort(new Error('BENCHMARK_HEARTBEAT_FAILED')); }); }, Math.max(20, Math.floor(leaseMs / 3))); timer.unref();
    try {
      for (const arm of ['baseline', 'candidate'] as const) {
        controller.signal.throwIfAborted();
        await options.runner.execute({ benchmarkRunId: id, arm, snapshot: structuredClone(arm === 'baseline' ? baseline : candidate), suite: structuredClone(suite), signal: controller.signal }, async raw => {
          controller.signal.throwIfAborted();
          const result = SkillBenchmarkCaseResultSchema.parse(raw);
          if (result.arm !== arm) throw new SkillError('SKILL_BENCHMARK_INTEGRITY_FAILED', 'النتيجة لا تخص جهة المقارنة الحالية.');
          await db.transaction().execute(async tx => {
            const row = await fenced(tx, id, ownerId, token); controller.signal.throwIfAborted();
            const evaluation = evaluationDto(row), previous = evaluation.cases.find(item => item.arm === result.arm && item.caseId === result.caseId);
            if (previous) { if (digest(previous) !== digest(result)) throw new SkillError('SKILL_BENCHMARK_CASE_CONFLICT', 'حالة القياس مثبتة ولا تُستبدل.'); return; }
            evaluation.cases.push(result); validateCases(evaluation);
            await tx.updateTable('skill_benchmark_runs').set({ results: canonicalSkillEvidenceJson(evaluation.cases), results_hash: digest(evaluation.cases) }).where('id', '=', id).execute();
          });
        });
      }
      controller.signal.throwIfAborted();
      await db.transaction().execute(async tx => {
        const row = await fenced(tx, id, ownerId, token); controller.signal.throwIfAborted();
        const evaluation = evaluationDto({ ...row, status: 'completed', finished_at: new Date() }); validateCases(evaluation);
        await options.onCompleted?.(tx, ownerId, evaluation);
        controller.signal.throwIfAborted();
        await audit(tx, ownerId, id, 'skill.benchmark_completed', { cases: evaluation.cases.length, suiteHash: suite.suiteHash, scope: suite.scope });
        controller.signal.throwIfAborted();
        // A callback can outlive the lease while this transaction owns its row
        // lock. Use wall-clock database time, not transaction-start time, and
        // roll back callback writes if ownership expired before publication.
        await fenced(tx, id, ownerId, token);
        controller.signal.throwIfAborted();
        await tx.updateTable('skill_benchmark_runs').set({ status: 'completed', finished_at: new Date() }).where('id', '=', id).execute();
      });
    } catch {
      await db.transaction().execute(async tx => {
        const changed = await tx.updateTable('skill_benchmark_runs').set({ status: 'unknown', error_code: controller.signal.aborted ? 'SKILL_BENCHMARK_ABORTED' : 'SKILL_BENCHMARK_INTERRUPTED', finished_at: new Date() }).where('id', '=', id).where('owner_id', '=', ownerId).where('run_token', '=', token).where('status', '=', 'running').returning('id').executeTakeFirst();
        if (changed) await audit(tx, ownerId, id, 'skill.benchmark_unknown', { reason: controller.signal.aborted ? 'aborted' : 'interrupted' });
      });
    } finally { clearTimeout(timeout); clearInterval(timer); await heartbeat; workers.delete(id); }
  }

  async function startOwned(ownerId: string, raw: unknown, key: string): Promise<SkillBenchmarkEvaluation> {
    if (closing) throw new SkillError('SKILL_BENCHMARK_SHUTTING_DOWN', 'خدمة القياس تتوقف.', 409);
    const request = SkillBenchmarkRequestSchema.parse(raw); z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/).parse(key);
    const requestHash = hashSkillData(request);
    await recoverExpired();
    const created = await db.transaction().execute(async tx => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-benchmark:${ownerId}`}, 0))`.execute(tx);
      const existing = await tx.selectFrom('skill_benchmark_runs').selectAll().where('owner_id', '=', ownerId).where('idempotency_key', '=', key).executeTakeFirst();
      if (existing) { if (existing.request_hash !== requestHash) throw new SkillError('IDEMPOTENCY_CONFLICT', 'المفتاح مرتبط بطلب قياس مختلف.', 409); return { evaluation: evaluationDto(existing) }; }
      const count = await tx.selectFrom('skill_benchmark_runs').select(eb => eb.fn.countAll<string>().as('total')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
      if (Number(count.total) >= MAX_SKILL_BENCHMARK_RUNS_PER_OWNER) throw new SkillError('SKILL_BENCHMARK_QUOTA', 'وصل سجل التجارب إلى الحد؛ لم يُحذف أي تاريخ.', 409);
      if (await tx.selectFrom('skill_benchmark_runs').select('id').where('owner_id', '=', ownerId).where('status', '=', 'running').executeTakeFirst()) throw new SkillError('SKILL_BENCHMARK_BUSY', 'توجد تجربة جارية لهذا المالك.', 409);
      const suite = SkillBenchmarkSuiteSchema.parse(options.suite(request.suiteId));
      if (suite.id !== request.suiteId) throw new SkillError('SKILL_BENCHMARK_SUITE_INVALID', 'تعريف القياس لا يطابق المجموعة المطلوبة.');
      const baseline = await loadSnapshot(tx, ownerId, request.baselineId, request.baselineRevision), candidate = await loadSnapshot(tx, ownerId, request.candidateId, request.candidateRevision);
      const definitionId = digest(suite);
      await tx.insertInto('skill_benchmarks').values({ id: definitionId, suite_id: suite.id, scope: suite.scope, suite_hash: suite.suiteHash, config_hash: suite.configHash, verifier_version: suite.verifierVersion, definition: JSON.stringify(suite) }).onConflict(conflict => conflict.column('id').doNothing()).execute();
      const registered = await tx.selectFrom('skill_benchmarks').select('definition').where('id', '=', definitionId).executeTakeFirstOrThrow();
      if (digest(json(registered.definition)) !== definitionId) throw new SkillError('SKILL_BENCHMARK_INTEGRITY_FAILED', 'تغير تعريف القياس الموثوق.');
      const id = randomUUID(), token = randomUUID();
      const row = await tx.insertInto('skill_benchmark_runs').values({ id, owner_id: ownerId, baseline_id: baseline.pin.versionId, candidate_id: candidate.pin.versionId, baseline_pin: JSON.stringify(baseline.pin), candidate_pin: JSON.stringify(candidate.pin), benchmark_id: definitionId, suite_hash: suite.suiteHash, suite_snapshot: JSON.stringify(suite), pins_hash: digest({ baseline: baseline.pin, candidate: candidate.pin, suite }), status: 'running', results: '[]', results_hash: digest([]), idempotency_key: key, request_hash: requestHash, run_token: token, lease_expires_at: sql`CURRENT_TIMESTAMP + ${leaseMs} * interval '1 millisecond'` }).returningAll().executeTakeFirstOrThrow();
      await audit(tx, ownerId, id, 'skill.benchmark_started', { baselineVersionId: baseline.pin.versionId, candidateVersionId: candidate.pin.versionId, suiteHash: suite.suiteHash, scope: suite.scope });
      return { evaluation: evaluationDto(row), token, baseline, candidate, suite };
    });
    if (created.token && created.baseline && created.candidate && created.suite) {
      if (closing) {
        await db.transaction().execute(async tx => {
          const stopped = await tx.updateTable('skill_benchmark_runs').set({ status: 'unknown', error_code: 'SKILL_BENCHMARK_ABORTED', finished_at: new Date() }).where('id', '=', created.evaluation.id).where('run_token', '=', created.token!).where('status', '=', 'running').returning('id').executeTakeFirst();
          if (stopped) await audit(tx, ownerId, created.evaluation.id, 'skill.benchmark_unknown', { reason: 'shutdown_before_dispatch' });
        });
        return readBenchmarkEvaluation(db, ownerId, created.evaluation.id);
      }
      const controller = new AbortController();
      const promise = executeOwned(ownerId, created.evaluation.id, created.token, created.baseline, created.candidate, created.suite, controller);
      void promise.catch(() => {}); // A background transport failure must not become an unhandled rejection.
      workers.set(created.evaluation.id, { controller, promise });
    }
    return created.evaluation;
  }
  function start(ownerId: string, raw: unknown, key: string): Promise<SkillBenchmarkEvaluation> {
    const pending = startOwned(ownerId, raw, key); starts.add(pending);
    void pending.finally(() => starts.delete(pending)).catch(() => {}); return pending;
  }
  async function execute(ownerId: string, raw: unknown, key: string) { const result = await start(ownerId, raw, key); await workers.get(result.id)?.promise; return readBenchmarkEvaluation(db, ownerId, result.id); }
  async function shutdown() {
    closing = true;
    for (const worker of workers.values()) worker.controller.abort(new Error('BENCHMARK_SHUTDOWN'));
    await Promise.allSettled([...starts]);
    const active = [...workers.values()]; for (const worker of active) worker.controller.abort(new Error('BENCHMARK_SHUTDOWN'));
    await Promise.allSettled(active.map(worker => worker.promise));
  }
  return { start, execute, get: (ownerId: string, id: string) => readBenchmarkEvaluation(db, ownerId, id), list: (ownerId: string, query: unknown = {}) => listBenchmarkEvaluations(db, ownerId, query), recoverExpired, shutdown };
}
