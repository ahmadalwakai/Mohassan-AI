import { z } from 'zod';
import { SkillLevelSchema, SkillStatusSchema, SkillToolIdSchema } from './skills';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative();
const NullableCount = Count.nullable();
const Measurement = z.number().finite().nonnegative().nullable();
export const SkillQualityVerdictSchema = z.enum(['passed', 'failed', 'unknown', 'not_applicable']);
export const SkillQualityObservationSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'blocked', 'unknown', 'skipped']),
  verification: SkillQualityVerdictSchema, safety: SkillQualityVerdictSchema, recovery: SkillQualityVerdictSchema,
  durationMs: Measurement, inputTokens: NullableCount, outputTokens: NullableCount,
}).strict();
/** Normalized facts supplied by the persisted benchmark reader, never a request body. */
export const SkillQualityInputSchema = z.object({
  evaluationId: z.uuid(), evaluationStatus: z.enum(['running', 'completed', 'failed', 'unknown']), suiteId: z.string().min(1).max(100), suiteHash: Hash, configHash: Hash,
  verifierVersion: z.string().min(1).max(100), scope: z.string().min(1).max(100), measuredScope: z.string().min(1).max(600), limitations: z.array(z.string().min(1).max(600)).max(12),
  baselineContentHash: Hash, candidateContentHash: Hash, createdAt: z.iso.datetime(), independentHoldout: z.boolean(), evidenceScope: z.literal('isolated_experiment'),
  cases: z.array(z.object({ caseId: z.string().min(1).max(100), split: z.enum(['training', 'holdout']),
    baseline: SkillQualityObservationSchema, candidate: SkillQualityObservationSchema }).strict()).max(256),
}).strict().superRefine((value, context) => {
  if (new Set(value.cases.map(item => item.caseId)).size !== value.cases.length) context.addIssue({ code: 'custom', path: ['cases'], message: 'معرفات حالات القياس يجب أن تكون فريدة.' });
});
export type SkillQualityInput = z.infer<typeof SkillQualityInputSchema>;
export type SkillQualityObservation = z.infer<typeof SkillQualityObservationSchema>;

/** observedRate excludes unknowns explicitly; lowerBound includes them. Neither is an unscoped quality score. */
export const SkillQualityRateSchema = z.object({
  passed: Count, failed: Count, unknown: Count, notApplicable: Count, numerator: Count, denominator: Count,
  eligible: Count, observedRate: z.number().min(0).max(1).nullable(), lowerBound: z.number().min(0).max(1).nullable(),
}).strict();
export const SkillQualityTimingSchema = z.object({ samples: Count, unknown: Count, totalMs: Measurement, meanMs: Measurement, p50Ms: Measurement, p95Ms: Measurement }).strict();
export const SkillQualityUsageSchema = z.object({
  samples: Count, unknown: Count, inputTokens: NullableCount, outputTokens: NullableCount,
  knownInputTokens: Count, knownOutputTokens: Count,
  monetaryCost: z.null(), currency: z.null(), costReason: z.literal('pricing_unavailable'),
}).strict();
const Arm = z.object({
  measuredCases: Count, blockedCases: Count,
  success: SkillQualityRateSchema, verification: SkillQualityRateSchema, safety: SkillQualityRateSchema,
  recovery: SkillQualityRateSchema, holdout: SkillQualityRateSchema, latency: SkillQualityTimingSchema, usage: SkillQualityUsageSchema,
}).strict();
export const SkillQualitySnapshotSchema = z.object({
  evaluationId: z.uuid(), evaluationStatus: z.enum(['running', 'completed', 'failed', 'unknown']), suiteId: z.string().min(1).max(100), suiteHash: Hash, configHash: Hash,
  verifierVersion: z.string().min(1).max(100), scope: z.string().min(1).max(100), measuredScope: z.string().min(1).max(600), limitations: z.array(z.string().min(1).max(600)).max(12),
  baselineContentHash: Hash, candidateContentHash: Hash, createdAt: z.iso.datetime(), independentHoldout: z.boolean(), evidenceScope: z.literal('isolated_experiment'),
  caseCount: Count, trainingCount: Count, holdoutCount: Count, baseline: Arm, candidate: Arm,
  regressions: z.object({ count: Count, comparableCases: Count, unknownPairs: Count, caseIds: z.array(z.string().max(100)).max(256) }).strict(),
  reviewReady: z.boolean(), reviewReasons: z.array(z.string().max(64)).max(20),
  automaticPromotion: z.literal(false), semanticQuality: z.null(),
}).strict();
export type SkillQualitySnapshot = z.infer<typeof SkillQualitySnapshotSchema>;
export const SkillQualityDriftSchema = z.object({
  previousEvaluationId: z.uuid(), currentEvaluationId: z.uuid(), comparable: z.boolean(), reasons: z.array(z.string().max(64)).max(20),
  status: z.enum(['incomparable', 'insufficient_evidence', 'regression_observed', 'no_regression_observed']),
  successDelta: z.number().finite().nullable(), holdoutDelta: z.number().finite().nullable(), safetyDelta: z.number().finite().nullable(),
  verificationDelta: z.number().finite().nullable(), recoveryDelta: z.number().finite().nullable(),
  latencyMeanDeltaMs: z.number().finite().nullable(), inputTokensDelta: z.number().finite().nullable(), outputTokensDelta: z.number().finite().nullable(),
  statisticalSignificance: z.literal('not_estimated'),
}).strict();
export type SkillQualityDrift = z.infer<typeof SkillQualityDriftSchema>;

export const SkillPortfolioQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(25), offset: z.coerce.number().int().min(0).max(10000).default(0) }).strict();
export const SkillQualityDetailSchema = z.object({
  versionId: z.uuid(), contentHash: Hash, evaluations: z.array(SkillQualitySnapshotSchema).max(10), drift: SkillQualityDriftSchema.nullable(),
  coverage: z.enum(['none', 'measured', 'historical_only']), truncated: z.boolean(), invalidEvaluations: Count,
  readOnly: z.literal(true),
}).strict();
export type SkillQualityDetail = z.infer<typeof SkillQualityDetailSchema>;
export const SkillPortfolioSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), familyId: z.uuid(), slug: z.string(), name: z.string(), version: z.string(),
    contentHash: Hash, level: SkillLevelSchema, status: SkillStatusSchema, active: z.boolean(), quality: SkillQualityDetailSchema }).strict()).max(50),
  total: Count, offset: Count, limit: Count, truncated: z.boolean(),
  analysisWindow: z.object({ versions: Count, versionLimit: Count, runs: Count, runLimit: Count, runsTruncated: z.boolean(), filesTruncated: z.boolean() }).strict(),
  suggestions: z.array(z.object({
    kind: z.enum(['duplicate_file_set', 'declared_tools_not_observed', 'declared_dependencies_not_observed']),
    versionIds: z.array(z.uuid()).min(1).max(200), fingerprint: Hash.nullable(), tools: z.array(SkillToolIdSchema).max(12), dependencies: z.array(z.string().max(64)).max(12),
    sampleRuns: Count, reviewOnly: z.literal(true), proofOfUnnecessaryDependency: z.literal(false),
  }).strict()).max(400),
  recentRuns: z.array(z.object({ id: z.uuid(), parentTaskId: z.uuid(), status: z.string().max(32), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
    versionIds: z.array(z.uuid()).max(144), evidenceIds: z.array(z.uuid()).max(64), evidenceTruncated: z.boolean(),
  }).strict()).max(50),
  legacyChecklist: z.object({ scope: z.literal('checklist_structure'), readOnly: z.literal(true), truncated: z.boolean(),
    items: z.array(z.object({ versionId: z.uuid(), name: z.string(), manifestHash: Hash, evaluationId: z.uuid().nullable(), createdAt: z.iso.datetime().nullable(),
      passed: z.boolean().nullable(), caseCount: NullableCount, candidateScore: Measurement, holdoutScore: Measurement, safetyScore: Measurement,
    }).strict()).max(50),
  }).strict(),
  readOnly: z.literal(true), permissionsGranted: z.literal(false),
}).strict();
export type SkillPortfolio = z.infer<typeof SkillPortfolioSchema>;
