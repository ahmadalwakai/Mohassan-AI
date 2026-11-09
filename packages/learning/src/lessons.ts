import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { redactCredentialText } from '@mohassan/cognitive';
import { redactSecrets } from '@mohassan/providers';
import { evaluateCase, evaluationCases, EVALUATION_SUITE_VERSION, type EvaluationCase, type EvaluationObservation } from './evaluation.ts';

export class LearningContentError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'LearningContentError'; }
}
export const learningHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const normalizeLearningText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\u0640\u064b-\u065f\u0670\p{Cf}]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/\s+/g, ' ').trim();
export function cleanLearningText(value: string, max = 4000, redact?: (value: string) => string) {
  return redactCredentialText(redactSecrets(redact ? redact(value) : value))
    .replace(/\b(?:ghp_|github_pat_|xox[baprs]-|AIza|npg_)[a-z0-9_-]{12,}/gi, '[اعتماد محجوب]')
    .replace(/\bBearer[ \t]+[a-z0-9._~+/=-]+/gi, 'Bearer [محجوب]')
    .replace(/\b(password|passwd|pin|secret|authorization|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*(?:[:=]|\bis\b)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[محجوب]')
    .replace(/(كلمة المرور\s*(?:هي|[:=])\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s،؛]+)/gu, '$1[محجوب]')
    .replace(/(?<!\p{Decimal_Number})(?:\p{Decimal_Number}[ -]?){12,}\p{Decimal_Number}(?!\p{Decimal_Number})/gu, '[رقم محجوب]')
    .replace(/((?:\b(?:otp|one[- ]time (?:code|password)|verification code|cvv|cvc)\b|رمز التحقق|رمز الأمان)\s*(?:is|هو|[:=])?\s*)[\p{Decimal_Number} -]{3,12}/giu, '$1[محجوب]')
    .replace(/(?:https?|ftp):\/\/[^\s"'<>]+/gi, raw => { try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; } catch { return '[رابط محجوب]'; } })
    .replace(/data:[^,\s]+,[^\s"'<>]+/gi, '[محتوى محجوب]').replaceAll('\u0000', '').slice(0, max);
}

const category = z.enum(['conversation', 'research', 'browser', 'coding', 'computer']);
export const LessonScopeSchema = z.object({
  category, site: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(), tool: z.string().max(80).regex(/^[a-z][a-z0-9_.-]*$/i).optional(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
}).strict();
export type LessonScope = z.infer<typeof LessonScopeSchema>;
const referenceSchema = z.object({ sourceKind: z.enum(['chat_run', 'runtime_task']), sourceId: z.string().min(1).max(200), attempt: z.number().int().nonnegative() }).strict();
export type LessonExperienceReference = z.infer<typeof referenceSchema>;
export const LessonCandidateSchema = z.object({
  text: z.string().trim().min(8).max(4000), scope: LessonScopeSchema,
  success: referenceSchema, failure: referenceSchema.optional(), correctionId: z.uuid().optional(),
  replacesId: z.uuid().optional(), expiresAt: z.iso.datetime().optional(),
}).strict().refine(input => Boolean(input.failure) !== Boolean(input.correctionId), 'يلزم إخفاق سابق أو تصحيح مالك واحد.');
export type LessonCandidateInput = z.infer<typeof LessonCandidateSchema>;
export interface LearningEvaluationSubject { kind: 'lesson' | 'knowledge'; id: string; ownerId: string; hash: string; text: string; scope?: LessonScope; source?: string; title?: string; sourceHash?: string; supportingGoal?: string; evidenceHashes?: readonly string[]; }
/** Only installed by trusted server code. HTTP input must never supply cases, observations or a verdict. */
export interface LearningEvaluationComparison {
  suiteId: string; suiteHash: string; model: string;
  contextPolicy?: string;
  cases: readonly { test: EvaluationCase; baseline: EvaluationObservation; candidate: EvaluationObservation }[];
}
export type LearningContentEvaluator = (subject: Readonly<LearningEvaluationSubject>) => Promise<LearningEvaluationComparison>;
/** Connect an isolated execution harness once on the server. The subject is absent from baseline runs. */
export function createL2ContentEvaluator(options: {
  model: string;
  run: (test: Readonly<EvaluationCase>, context: { variant: 'baseline' | 'candidate'; subject?: Readonly<LearningEvaluationSubject> }) => Promise<EvaluationObservation>;
  cases?: readonly EvaluationCase[];
  suiteId?: string;
  contextPolicy?: string;
}): LearningContentEvaluator {
  const cases: EvaluationCase[] = structuredClone((options.cases ?? evaluationCases).filter(test => test.split === 'holdout'));
  const suiteHash = learningHash(JSON.stringify(cases));
  return async subject => {
    const results: LearningEvaluationComparison['cases'][number][] = [];
    for (const original of cases) {
      const baseline = await options.run(structuredClone(original), { variant: 'baseline' });
      const candidate = await options.run(structuredClone(original), { variant: 'candidate', subject: structuredClone(subject) });
      results.push({ test: structuredClone(original), baseline, candidate });
    }
    return { suiteId: options.suiteId ?? `${EVALUATION_SUITE_VERSION}-content`, suiteHash, model: options.model, ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}), cases: results };
  };
}
export interface LearningEvaluationReport { passed: boolean; improved: number; regressions: number; safetyPassed: boolean; caseCount: number; suiteId: string; suiteHash: string; model: string; contextPolicy?: string; results: { caseId: string; baseline: boolean; candidate: boolean; safety: boolean; failures: readonly string[] }[]; }

/** Computes verdicts with the independent L2 oracle, rather than accepting caller-provided passed flags. */
export function assessLearningComparison(comparison: LearningEvaluationComparison, requireImprovement: boolean): LearningEvaluationReport {
  if (!comparison || !/^[a-f0-9]{64}$/i.test(comparison.suiteHash) || !comparison.suiteId?.trim() || !comparison.model?.trim() || !Array.isArray(comparison.cases) || comparison.cases.length < 2 || comparison.cases.length > 200) throw new LearningContentError('LEARNING_EVALUATION_INVALID', 'نتيجة التقييم المستقل غير مكتملة.', 409);
  const ids = new Set<string>();
  for (const entry of comparison.cases) {
    if (!entry.test || ids.has(entry.test.id) || entry.test.split !== 'holdout' || !entry.baseline || !entry.candidate) throw new LearningContentError('LEARNING_EVALUATION_INVALID', 'حالات التقييم غير ثابتة أو مكررة.', 409);
    ids.add(entry.test.id);
  }
  if (learningHash(JSON.stringify(comparison.cases.map(c => c.test))) !== comparison.suiteHash) throw new LearningContentError('LEARNING_SUITE_CHANGED', 'بصمة مجموعة التقييم غير مطابقة.', 409);
  const results = comparison.cases.map(({ test, baseline, candidate }) => ({ caseId: test.id, baseline: evaluateCase(test, baseline).passed, candidate: evaluateCase(test, candidate).passed, safety: test.safety, failures: evaluateCase(test, candidate).failures }));
  const improved = results.filter(r => !r.baseline && r.candidate && !r.safety).length;
  const regressions = results.filter(r => r.baseline && !r.candidate).length;
  const safety = results.filter(r => r.safety);
  const safetyPassed = safety.length > 0 && safety.every(r => r.candidate);
  return { passed: safetyPassed && regressions === 0 && (!requireImprovement || improved > 0) && results.some(r => !r.safety), improved, regressions, safetyPassed, caseCount: results.length, suiteId: comparison.suiteId.slice(0, 160), suiteHash: comparison.suiteHash, model: comparison.model.slice(0, 160), ...(comparison.contextPolicy ? { contextPolicy: comparison.contextPolicy.slice(0, 128) } : {}), results };
}

export async function lessonMigration(db: Kysely<any>) {
  const apply = async (tx: Kysely<any>) => {
    await sql`SELECT pg_advisory_xact_lock(7240392)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS learning_content_owners (owner_id text PRIMARY KEY)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS learning_content_evaluations (
      id text PRIMARY KEY, owner_id text NOT NULL, subject_kind text NOT NULL CHECK(subject_kind IN ('lesson','knowledge')),
      subject_id text NOT NULL, subject_hash text NOT NULL, status text NOT NULL CHECK(status IN ('running','passed','failed','unknown')),
      report jsonb, created_at timestamptz NOT NULL, completed_at timestamptz
    )`.execute(tx);
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS learning_content_one_running_evaluation ON learning_content_evaluations(owner_id,subject_kind,subject_id) WHERE status='running'`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS learning_lessons (
      id text PRIMARY KEY, owner_id text NOT NULL, root_id text NOT NULL, version integer NOT NULL,
      status text NOT NULL CHECK(status IN ('candidate','verified','active','retired')), text text NOT NULL,
      scope jsonb NOT NULL, content_hash text NOT NULL, sources jsonb NOT NULL, evaluation_id text,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE(owner_id,root_id,version)
    )`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS learning_lessons_owner_status ON learning_lessons(owner_id,status)`.execute(tx);
  };
  return db.isTransaction ? apply(db) : db.transaction().execute(apply);
}
export async function lockLearningOwner(tx: Kysely<any>, ownerId: string) {
  if (!ownerId.trim() || ownerId.length > 200) throw new LearningContentError('LEARNING_OWNER_INVALID', 'يلزم مالك صالح.', 401);
  await tx.insertInto('learning_content_owners').values({ owner_id: ownerId }).onConflict(c => c.column('owner_id').doNothing()).execute();
  await tx.selectFrom('learning_content_owners').select('owner_id').where('owner_id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
}
export async function evaluateLearningSubject(db: Kysely<any>, subject: LearningEvaluationSubject, evaluator: LearningContentEvaluator | undefined, requireImprovement: boolean, now: () => Date, onStarted?: (receiptId: string) => void) {
  if (!evaluator) throw new LearningContentError('LEARNING_EVALUATOR_UNAVAILABLE', 'يلزم تجهيز فاحص L2 مستقل قبل تفعيل هذا المحتوى.', 409);
  const id = randomUUID();
  const claim = async (tx: Kysely<any>) => {
    await lockLearningOwner(tx, subject.ownerId);
    await tx.updateTable('learning_content_evaluations').set({ status: 'unknown', completed_at: now() }).where('owner_id', '=', subject.ownerId).where('subject_kind', '=', subject.kind).where('subject_id', '=', subject.id).where('status', '=', 'running').where('created_at', '<', new Date(now().getTime() - 3600000)).execute();
    if (await tx.selectFrom('learning_content_evaluations').select('id').where('owner_id', '=', subject.ownerId).where('subject_kind', '=', subject.kind).where('subject_id', '=', subject.id).where('status', '=', 'running').executeTakeFirst()) throw new LearningContentError('LEARNING_EVALUATION_RUNNING', 'يوجد تقييم جارٍ لهذه النسخة؛ انتظر نتيجته.', 409);
    await tx.insertInto('learning_content_evaluations').values({ id, owner_id: subject.ownerId, subject_kind: subject.kind, subject_id: subject.id, subject_hash: subject.hash, status: 'running', report: null, created_at: now() }).execute();
  };
  if (db.isTransaction) await claim(db); else await db.transaction().execute(claim);
  let report: LearningEvaluationReport;
  try {
    onStarted?.(id);
    const comparison = await evaluator(Object.freeze({ ...subject }));
    report = assessLearningComparison(comparison, requireImprovement);
    if (subject.kind === 'lesson') {
      // Measure transfer benefit in the lesson's domain. This is not semantic proof of arbitrary prose.
      const evaluatedCategory = subject.scope?.category === 'conversation' ? 'chat' : subject.scope?.category;
      const supportingImprovement = comparison.cases.some(({ test, baseline, candidate }) => !test.safety && test.category === evaluatedCategory && !evaluateCase(test, baseline).passed && evaluateCase(test, candidate).passed);
      if (!supportingImprovement) report = { ...report, passed: false };
    }
  }
  catch (error) {
    await db.updateTable('learning_content_evaluations').set({ status: 'unknown', completed_at: now() }).where('id', '=', id).where('owner_id', '=', subject.ownerId).where('status', '=', 'running').execute();
    if (error instanceof LearningContentError) throw error;
    throw new LearningContentError('LEARNING_EVALUATION_FAILED', 'لم يكتمل التقييم المستقل؛ لم يُفعّل المحتوى.', 502);
  }
  const settled = await db.updateTable('learning_content_evaluations').set({ status: report.passed ? 'passed' : 'failed', report: JSON.stringify(report), completed_at: now() }).where('id', '=', id).where('owner_id', '=', subject.ownerId).where('status', '=', 'running').returning('id').executeTakeFirst();
  if (!settled) throw new LearningContentError('LEARNING_EVALUATION_EXPIRED', 'انتهت ملكية التقييم؛ لم تعتمد النتيجة المتأخرة.', 409);
  return { id, report };
}
export async function requireLearningEvaluation(db: Kysely<any>, ownerId: string, row: any, kind: 'lesson' | 'knowledge', now: Date, contextPolicy?: string) {
  const receipt = row.evaluation_id && await db.selectFrom('learning_content_evaluations').selectAll().where('id', '=', row.evaluation_id).where('owner_id', '=', ownerId).where('subject_kind', '=', kind).where('subject_id', '=', row.id).where('subject_hash', '=', row.content_hash).where('status', '=', 'passed').executeTakeFirst();
  if (!receipt || !receipt.completed_at || now.getTime() - new Date(receipt.completed_at).getTime() > 7 * 86400000 || contextPolicy && receipt.report?.contextPolicy !== contextPolicy) throw new LearningContentError('LEARNING_EVALUATION_REQUIRED', 'يلزم تقييم ناجح حديث لهذه النسخة وبسياسة الاسترجاع الحالية.', 409);
}

function evidenceFingerprint(row: any) { return learningHash(JSON.stringify([row.source_kind, row.source_id, row.attempt, row.goal, row.category, row.outcome, row.evidence_kind, row.evidence])); }
function scopesOverlap(a: LessonScope, b: LessonScope) { return a.category === b.category && (!a.site || !b.site || a.site === b.site) && (!a.tool || !b.tool || a.tool === b.tool) && (!a.keywords.length || !b.keywords.length || a.keywords.some(k => b.keywords.includes(k))); }

export function createLessonControl(db: Kysely<any>, options: { evaluate?: LearningContentEvaluator; now?: () => Date; redact?: (value: string) => string } = {}) {
  const now = () => options.now?.() ?? new Date();
  const transaction = <T>(action: (tx: Kysely<any>) => Promise<T>) => db.isTransaction ? action(db) : db.transaction().execute(action);
  async function owned(connection: Kysely<any>, ownerId: string, id: string) {
    const row = await connection.selectFrom('learning_lessons').selectAll().where('id', '=', id).where('owner_id', '=', ownerId).executeTakeFirst();
    if (!row) throw new LearningContentError('LESSON_NOT_FOUND', 'لم يُعثر على الدرس.', 404); return row;
  }
  async function experience(connection: Kysely<any>, ownerId: string, ref: LessonExperienceReference, outcome: string) {
    const row = await connection.selectFrom('experiences').selectAll().where('owner_id', '=', ownerId).where('source_kind', '=', ref.sourceKind).where('source_id', '=', ref.sourceId).where('attempt', '=', ref.attempt).executeTakeFirst();
    if (!row || row.outcome !== outcome || !row.evidence || row.evidence_kind === 'none') throw new LearningContentError('LESSON_EVIDENCE_UNAVAILABLE', 'التجربة غير متاحة أو نتيجتها غير مثبتة.', 409); return row;
  }
  async function validSources(connection: Kysely<any>, ownerId: string, row: any) {
    for (const source of row.sources) {
      const saved = await experience(connection, ownerId, source, source.outcome);
      if (evidenceFingerprint(saved) !== source.fingerprint) throw new LearningContentError('LESSON_EVIDENCE_CHANGED', 'تغيّر دليل الدرس؛ يلزم ترشيح وتقييم نسخة جديدة.', 409);
      if (source.correctionId && !await connection.selectFrom('experience_feedback').select('id').where('id', '=', source.correctionId).where('owner_id', '=', ownerId).where('source_kind', '=', source.sourceKind).where('source_id', '=', source.sourceId).where('attempt', '=', source.attempt).where('confirmed', '=', 'success').executeTakeFirst()) throw new LearningContentError('LESSON_CORRECTION_UNAVAILABLE', 'تصحيح المالك غير متاح.', 409);
    }
    if (new Date(row.expires_at) <= now()) throw new LearningContentError('LESSON_EXPIRED', 'انتهت صلاحية الدرس.', 409);
  }
  async function candidate(ownerId: string, raw: LessonCandidateInput) {
    const parsed = LessonCandidateSchema.safeParse(raw); if (!parsed.success) throw new LearningContentError('LESSON_INVALID', 'بيانات الدرس غير صالحة.');
    const input = parsed.data;
    return transaction(async tx => {
      await lockLearningOwner(tx, ownerId);
      const success = await experience(tx, ownerId, input.success, 'verified_success');
      if (success.category !== input.scope.category) throw new LearningContentError('LESSON_SCOPE_MISMATCH', 'مجال الدرس لا يطابق تجربة الدليل.', 409);
      const sources: any[] = [{ ...input.success, outcome: success.outcome, fingerprint: evidenceFingerprint(success) }];
      if (input.failure) {
        const failure = await experience(tx, ownerId, input.failure, 'verified_failure');
        if (normalizeLearningText(failure.goal) !== normalizeLearningText(success.goal) || failure.category !== success.category || failure.evidence?.targetHash !== success.evidence?.targetHash || failure.evidence?.expectedHash !== success.evidence?.expectedHash || !failure.evidence?.targetHash || new Date(failure.created_at) > new Date(success.created_at)) throw new LearningContentError('LESSON_UNRELATED_EVIDENCE', 'يجب أن يسبق الإخفاق نجاحًا مثبتًا للهدف نفسه.', 409);
        sources.push({ ...input.failure, outcome: failure.outcome, fingerprint: evidenceFingerprint(failure) });
      } else {
        const correction = await tx.selectFrom('experience_feedback').select('id').where('id', '=', input.correctionId!).where('owner_id', '=', ownerId).where('source_kind', '=', input.success.sourceKind).where('source_id', '=', input.success.sourceId).where('attempt', '=', input.success.attempt).where('confirmed', '=', 'success').executeTakeFirst();
        if (!correction) throw new LearningContentError('LESSON_CORRECTION_UNAVAILABLE', 'يلزم تصحيح مالك مرتبط بهذه التجربة المثبتة.', 409);
        sources[0].correctionId = correction.id;
      }
      const previous = input.replacesId ? await owned(tx, ownerId, input.replacesId) : null;
      const id = randomUUID(), text = cleanLearningText(input.text, 4000, options.redact);
      const scope = { ...input.scope, site: input.scope.site?.toLowerCase(), keywords: [...new Set(input.scope.keywords.map(k => normalizeLearningText(cleanLearningText(k, 80, options.redact))))].sort() };
      const expires = input.expiresAt ? new Date(input.expiresAt) : new Date(now().getTime() + 90 * 86400000);
      if (expires <= now() || expires.getTime() > now().getTime() + 365 * 86400000) throw new LearningContentError('LESSON_EXPIRY_INVALID', 'مدة الدرس بين الآن وسنة واحدة.');
      const latest = previous ? await tx.selectFrom('learning_lessons').select('version').where('owner_id', '=', ownerId).where('root_id', '=', previous.root_id).orderBy('version', 'desc').executeTakeFirstOrThrow() : null;
      return tx.insertInto('learning_lessons').values({ id, owner_id: ownerId, root_id: previous?.root_id ?? id, version: (latest?.version ?? 0) + 1, status: 'candidate', text, scope: JSON.stringify(scope), sources: JSON.stringify(sources), content_hash: learningHash(JSON.stringify([text, scope, sources])), evaluation_id: null, expires_at: expires, created_at: now(), updated_at: now() }).returningAll().executeTakeFirstOrThrow();
    });
  }
  async function evaluate(ownerId: string, id: string, onStarted?: (receiptId: string) => void) {
    const row = await owned(db, ownerId, id);
    if (!['candidate', 'verified', 'active'].includes(row.status)) throw new LearningContentError('LESSON_STATE_INVALID', 'لا يمكن تقييم درس مسحوب.', 409);
    await validSources(db, ownerId, row);
    const supporting = await experience(db, ownerId, row.sources[0], 'verified_success');
    const receipt = await evaluateLearningSubject(db, { kind: 'lesson', id, ownerId, hash: row.content_hash, text: row.text, scope: row.scope, supportingGoal: supporting.goal, evidenceHashes: row.sources.map((source: any) => source.fingerprint) }, options.evaluate, true, now, onStarted);
    await transaction(async tx => { await lockLearningOwner(tx, ownerId); const current = await owned(tx, ownerId, id); if (current.status !== row.status || current.content_hash !== row.content_hash) throw new LearningContentError('LESSON_CHANGED', 'تغيّر الدرس أثناء التقييم.', 409); await validSources(tx, ownerId, current); await tx.updateTable('learning_lessons').set({ status: receipt.report.passed ? current.status === 'active' ? 'active' : 'verified' : 'candidate', evaluation_id: receipt.id, updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).execute(); });
    return receipt;
  }
  async function activate(ownerId: string, id: string) {
    return transaction(async tx => {
      await lockLearningOwner(tx, ownerId); const row = await owned(tx, ownerId, id);
      if (row.status !== 'verified') throw new LearningContentError('LESSON_NOT_VERIFIED', 'يلزم تقييم الدرس قبل تفعيله.', 409);
      await validSources(tx, ownerId, row); await requireLearningEvaluation(tx, ownerId, row, 'lesson', now());
      const active = await tx.selectFrom('learning_lessons').selectAll().where('owner_id', '=', ownerId).where('status', '=', 'active').where('expires_at', '>', now()).execute();
      if (active.some(other => other.root_id !== row.root_id && scopesOverlap(other.scope, row.scope) && other.text !== row.text)) throw new LearningContentError('LESSON_CONFLICT', 'يوجد درس نشط في النطاق نفسه؛ اسحبه أو راجع التعارض أولًا.', 409);
      await tx.updateTable('learning_lessons').set({ status: 'retired', updated_at: now() }).where('owner_id', '=', ownerId).where('root_id', '=', row.root_id).where('status', '=', 'active').execute();
      return tx.updateTable('learning_lessons').set({ status: 'active', updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirstOrThrow();
    });
  }
  async function retire(ownerId: string, id: string) { return transaction(async tx => { await lockLearningOwner(tx, ownerId); await owned(tx, ownerId, id); return tx.updateTable('learning_lessons').set({ status: 'retired', updated_at: now() }).where('id', '=', id).where('owner_id', '=', ownerId).returningAll().executeTakeFirstOrThrow(); }); }
  async function retrieve(ownerId: string, query: { category: LessonScope['category']; text: string; site?: string; tool?: string; limit?: number }) {
    const rows = await db.selectFrom('learning_lessons').selectAll().where('owner_id', '=', ownerId).where('status', '=', 'active').where('expires_at', '>', now()).orderBy('updated_at', 'desc').limit(200).execute();
    const text = normalizeLearningText(query.text), results = [];
    for (const row of rows) {
      const scope: LessonScope = row.scope;
      if (scope.category !== query.category || scope.site && scope.site !== query.site?.toLowerCase() || scope.tool && scope.tool !== query.tool || scope.keywords.length && !scope.keywords.some(k => text.includes(k))) continue;
      try { await validSources(db, ownerId, row); await requireLearningEvaluation(db, ownerId, row, 'lesson', now()); } catch (error) { if (error instanceof LearningContentError) continue; throw error; }
      results.push({ id: row.id as string, version: row.version as number, text: row.text as string, hash: row.content_hash as string, trust: 'untrusted' as const, source: `lesson:${row.id}`, scope });
      if (results.length >= Math.min(12, Math.max(1, query.limit ?? 4))) break;
    }
    return results;
  }
  const list = (ownerId: string) => db.selectFrom('learning_lessons').selectAll().where('owner_id', '=', ownerId).orderBy('updated_at', 'desc').limit(200).execute();
  return { candidate, evaluate, activate, retire, retrieve, list };
}
