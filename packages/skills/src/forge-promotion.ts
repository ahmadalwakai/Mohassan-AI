import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SkillContractSchema } from '@mohassan/contracts';
import { SkillBenchmarkSuiteSchema } from '../../contracts/src/skill-benchmarks.ts';
import { benchmarkPinsCurrent, readBenchmarkEvaluation } from './benchmark.ts';
import { skillBenchmarkDefinition, skillBenchmarkSuite, skillBenchmarkSupport } from './benchmark-suites.ts';
import { scoreSkillEvaluation } from './quality.ts';
import { canonicalSkillEvidenceJson } from './evidence.ts';
import { SkillError } from './errors.ts';
import { readSkillForgeGeneration } from './forge.ts';

const json = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
export interface ForgePromotionProof {
  generationId: string; evaluationId: string; baselineVersionId: string; baselineContentHash: string; candidateContentHash: string;
  suiteId: string; suiteHash: string; configHash: string; verifierVersion: string; scope: string; measuredScope: string; limitations: string[];
  approved: true; automaticPromotion: false;
}
export interface ForgePromotionContext {
  ownerId: string;
  family: { id: string; owner_id: string; slug: string; active_version_id: string | null };
  version: { id: string; owner_id: string; family_id: string; origin: string; level: string; content_hash: string; contract: unknown; sequence: number };
  action: 'activate' | 'rollback'; evaluationId?: string; approved: boolean;
}
const denied = (code: string, message: string): never => { throw new SkillError(code, message, 409); };

/** Mandatory activation gate. The caller already owns the owner's lifecycle
 * lock followed by the target family/version locks. No generation-row lock,
 * tool grant, model call or execution is performed here. */
export async function assertForgePromotion(tx: Kysely<any>, context: ForgePromotionContext): Promise<ForgePromotionProof | null> {
  const { ownerId, family, version } = context;
  if (version.origin !== 'forge') return null;
  if (!tx.isTransaction) return denied('SKILL_FORGE_TRANSACTION_REQUIRED', 'ترقية Forge تحتاج معاملة دورة الحياة المحمية.');
  if (!context.approved || !context.evaluationId) return denied('SKILL_FORGE_EVALUATION_REQUIRED', 'اختر قياسًا محفوظًا ووافق عليه صراحة قبل تفعيل مرشح Forge.');
  z.uuid().parse(context.evaluationId);
  if (version.owner_id !== ownerId || family.owner_id !== ownerId || version.family_id !== family.id) return denied('SKILL_FORGE_LINEAGE_INVALID', 'لا تطابق ملكية المرشح سجل دورة الحياة.');
  if (version.level === 'executable') return denied('SKILL_FORGE_EXECUTABLE_BLOCKED', 'بوابات العزل والقياس التنفيذي لم تكتمل؛ لا يمكن ترقية مهارة تنفيذية مولدة.');
  const rows = await tx.selectFrom('skill_forge_generations').select('id')
    .where('owner_id', '=', ownerId).where('candidate_id', '=', version.id).limit(2).execute();
  if (rows.length !== 1) return denied('SKILL_FORGE_LINEAGE_INVALID', 'لا يوجد سجل توليد وحيد لهذا المرشح.');
  const lineage = await readSkillForgeGeneration(tx, ownerId, rows[0].id);
  if (lineage.status !== 'succeeded' || lineage.candidateId !== version.id || lineage.candidateContentHash !== version.content_hash || lineage.targetFamilyId !== family.id || lineage.targetSlug !== family.slug) {
    return denied('SKILL_FORGE_LINEAGE_INVALID', 'لا يوجد سجل توليد ناجح يثبت هذا المرشح ومحتواه.');
  }
  const contract = SkillContractSchema.parse(json(version.contract)), generationBaseline = lineage.baseline;
  if (contract.slug !== family.slug || contract.version !== lineage.targetVersion || generationBaseline.versionId === version.id) return denied('SKILL_FORGE_LINEAGE_INVALID', 'لا تطابق النسخة نسب التوليد المثبت.');
  const baseline = await tx.selectFrom('skill_versions as v').innerJoin('skill_families as f', 'f.id', 'v.family_id').leftJoin('skill_sources as s', 's.version_id', 'v.id')
    .select(['v.id', 'v.family_id', 'v.content_hash', 'v.sequence', 's.kind as source_kind']).where('v.id', '=', generationBaseline.versionId).where('v.owner_id', '=', ownerId).where('f.owner_id', '=', ownerId).executeTakeFirst();
  if (!baseline || baseline.content_hash !== generationBaseline.contentHash) return denied('SKILL_FORGE_BASELINE_CHANGED', 'تغيرت نسخة الأساس التي أنشئ منها المرشح.');
  if (lineage.mode === 'mutate') {
    if (baseline.family_id !== family.id || version.sequence <= baseline.sequence || baseline.source_kind === 'builtin') return denied('SKILL_FORGE_LINEAGE_INVALID', 'تحتاج الطفرة إلى نسخة أحدث من أساس غير مدمج في العائلة نفسها.');
    if (context.action === 'activate' && family.active_version_id && family.active_version_id !== baseline.id) return denied('SKILL_FORGE_ACTIVE_CHANGED', 'تغير الإصدار النشط بعد اختيار الأساس؛ يلزم مرشح ومقارنة مع الإصدار الحالي.');
  } else if (lineage.mode === 'fork') {
    if (baseline.family_id === family.id || version.sequence !== 1) return denied('SKILL_FORGE_LINEAGE_INVALID', 'التفرع الصريح يحتاج أساسًا مملوكًا وعائلة جديدة.');
    if (context.action === 'activate' && family.active_version_id) return denied('SKILL_FORGE_ACTIVE_CHANGED', 'لا يستبدل تفرع Forge عائلة نشطة موجودة.');
  } else return denied('SKILL_FORGE_LINEAGE_INVALID', 'نوع نسب التوليد غير صالح.');

  const evaluation = await readBenchmarkEvaluation(tx, ownerId, context.evaluationId);
  if (evaluation.status !== 'completed' || evaluation.candidate.versionId !== version.id || evaluation.candidate.contentHash !== version.content_hash
    || evaluation.baseline.versionId !== baseline.id || evaluation.baseline.contentHash !== generationBaseline.contentHash) return denied('SKILL_FORGE_EVALUATION_MISMATCH', 'لا يقارن القياس المحفوظ هذا المرشح بأساسه المثبت.');
  const definition = skillBenchmarkDefinition(evaluation.suite.id), trustedSuite = skillBenchmarkSuite(evaluation.suite.id);
  if (!definition || !trustedSuite || canonicalSkillEvidenceJson(SkillBenchmarkSuiteSchema.parse(definition)) !== canonicalSkillEvidenceJson(evaluation.suite)) return denied('SKILL_FORGE_BENCHMARK_STALE', 'تغيرت حزمة القياس أو إعداداتها أو محققها؛ أعد القياس.');
  if (skillBenchmarkSupport(contract, trustedSuite) !== null) return denied('SKILL_FORGE_SCOPE_UNSUPPORTED', 'لا يغطي القياس الموثوق مستوى المرشح ومتطلباته.');
  if (!await benchmarkPinsCurrent(tx, ownerId, evaluation)) return denied('SKILL_FORGE_PINS_STALE', 'تغيرت المحتويات أو الفحوص أو حالة الأساس والمرشح بعد القياس.');
  const quality = scoreSkillEvaluation(evaluation);
  if (!quality.reviewReady) return denied('SKILL_FORGE_QUALITY_REJECTED', 'لم تتحقق شروط السلامة والتحقق والـholdout وعدم التراجع في النطاق المقاس.');
  return { generationId: lineage.id, evaluationId: evaluation.id, baselineVersionId: baseline.id, baselineContentHash: evaluation.baseline.contentHash,
    candidateContentHash: evaluation.candidate.contentHash, suiteId: evaluation.suite.id, suiteHash: evaluation.suite.suiteHash, configHash: evaluation.suite.configHash,
    verifierVersion: evaluation.suite.verifierVersion, scope: evaluation.suite.scope, measuredScope: evaluation.suite.measuredScope, limitations: evaluation.suite.limitations,
    approved: true, automaticPromotion: false };
}
