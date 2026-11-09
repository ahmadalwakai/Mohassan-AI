import { sql, type Kysely } from 'kysely';
import { evaluationCases, safetyHoldoutV2Cases, safetyHoldoutV3Cases } from './evaluation.ts';
import { safetyHoldoutV4Cases } from './safety-v4.ts';
import { safetyHoldoutV5Cases } from './safety-v5.ts';
import { memoryTrainingCases } from './memory-training.ts';
import { readTrainingCases } from './read-training.ts';
import { cleanLearningText, learningHash, normalizeLearningText } from './lessons.ts';

export const TRAINING_MINIMUM_UNIQUE_EXPERIENCES = 500;
export const ROUTING_TRAINING_DATASET_VERSION = 'verified-category-routing-v1';
export const ROUTING_TRAINING_EXPORT_LIMIT = 2_000;
const excludedCases = [...evaluationCases, ...safetyHoldoutV2Cases, ...safetyHoldoutV3Cases, ...safetyHoldoutV4Cases, ...safetyHoldoutV5Cases, ...memoryTrainingCases, ...readTrainingCases];
const evaluationPrompts = new Set(excludedCases.map(test => normalizeLearningText(test.prompt)));
const evaluationIds = new Set(excludedCases.map(test => test.id));
const credibleEvidenceKinds = new Set(['test_result', 'page_observation', 'api_readback']);
const routingCategories = new Set(['conversation', 'research', 'browser', 'coding', 'computer']);
const hashPattern = /^[a-f0-9]{64}$/i;
export interface TrainingReadinessOptions { excludedSourceIds?: ReadonlySet<string>; redact?: (value: string) => string; }

type EligibleRoutingExample = { goal: string; category: string; createdAt: string; sourceHash: string; evidenceHash: string };

async function scanTrainingReadiness(db: Kysely<any>, ownerId: string, options: TrainingReadinessOptions) {
  const counts = await db.selectFrom('experiences').select([
    sql<string>`count(*)`.as('total'),
    sql<string>`count(*) filter (where outcome='verified_success')`.as('verifiedSuccess'),
    sql<string>`count(*) filter (where outcome='verified_failure')`.as('verifiedFailure'),
    sql<string>`count(*) filter (where outcome='unverified')`.as('unverified'),
  ]).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
  // Bound memory use. If a very large owner history exceeds the scan, readiness stays blocked explicitly.
  const rows = await db.selectFrom('experiences as e').leftJoin('experiences as parent', join => join
    .onRef('parent.owner_id', '=', 'e.owner_id').on('parent.source_kind', '=', 'chat_run').onRef('parent.source_id', '=', 'e.parent_run_id'))
    .select(['e.source_kind', 'e.source_id', 'e.parent_run_id', 'e.attempt', 'e.terminal_status', 'e.goal', 'e.category', 'e.evidence_kind', 'e.evidence', 'e.created_at', 'parent.goal as parentGoal'])
    .where('e.owner_id', '=', ownerId).where('e.outcome', '=', 'verified_success').orderBy('e.created_at', 'asc').orderBy('e.source_kind', 'asc').orderBy('e.source_id', 'asc').limit(50_001).execute();
  const complete = rows.length <= 50_000;
  const exclusions = { evaluation: 0, secrets: 0, incompleteEvidence: 0, emptyGoal: 0, duplicates: 0, nonCompleted: 0, invalidCategory: 0, conflictingLabels: 0 };
  const unique = new Map<string, EligibleRoutingExample>(), conflicted = new Set<string>();
  const reservedSource = (value: unknown) => typeof value === 'string' && (options.excludedSourceIds?.has(value) || evaluationIds.has(value) || /^(?:eval(?:uation)?|holdout|benchmark)[:_-]/i.test(value));
  for (const row of rows.slice(0, 50_000)) {
    const goal = String(row.goal ?? ''), normalized = normalizeLearningText(goal);
    if (reservedSource(row.source_id) || reservedSource(row.parent_run_id) || evaluationPrompts.has(normalized) || evaluationPrompts.has(normalizeLearningText(String(row.parentGoal ?? '')))) { exclusions.evaluation++; continue; }
    if (!normalized) { exclusions.emptyGoal++; continue; }
    if (cleanLearningText(goal, 100_000, options.redact) !== goal || /\[(?:[^\]]*محجوب|redacted)[^\]]*\]/i.test(goal)) { exclusions.secrets++; continue; }
    if (row.terminal_status !== 'completed') { exclusions.nonCompleted++; continue; }
    if (!routingCategories.has(row.category)) { exclusions.invalidCategory++; continue; }
    if (!credibleEvidenceKinds.has(row.evidence_kind) || !row.evidence || !['targetHash', 'expectedHash', 'observedHash', 'referenceHash'].every(key => hashPattern.test(String(row.evidence[key] ?? ''))) || row.evidence.expectedHash !== row.evidence.observedHash) { exclusions.incompleteEvidence++; continue; }
    const key = learningHash(normalized), previous = unique.get(key);
    if (conflicted.has(key)) { exclusions.conflictingLabels++; continue; }
    if (previous && previous.category !== row.category) { unique.delete(key); conflicted.add(key); exclusions.conflictingLabels += 2; continue; }
    if (previous) { exclusions.duplicates++; continue; }
    unique.set(key, { goal, category: row.category, createdAt: new Date(row.created_at).toISOString(), sourceHash: learningHash(JSON.stringify([row.source_kind, row.source_id, row.attempt])), evidenceHash: learningHash(JSON.stringify([row.evidence_kind, row.evidence.targetHash, row.evidence.expectedHash, row.evidence.observedHash, row.evidence.referenceHash])) });
  }
  const ready = complete && unique.size >= TRAINING_MINIMUM_UNIQUE_EXPERIENCES;
  const report = {
    requiredUnique: TRAINING_MINIMUM_UNIQUE_EXPERIENCES, complete,
    counts: { total: Number(counts.total), verifiedSuccess: Number(counts.verifiedSuccess), verifiedFailure: Number(counts.verifiedFailure), unverified: Number(counts.unverified), scannedSuccesses: Math.min(rows.length, 50_000) },
    exclusions,
    roles: {
      routing: { eligibleUnique: unique.size, ready, reason: !complete ? 'SCAN_LIMIT' : ready ? 'DATA_THRESHOLD_MET_REQUIRES_TRAINING_ENVIRONMENT_AND_EVALUATION' : 'INSUFFICIENT_VERIFIED_UNIQUE_EXPERIENCES' },
      tool_call: { eligibleUnique: 0, ready: false, reason: 'VERIFIED_TOOL_ARGUMENT_TARGETS_NOT_RECORDED' },
      arabic_style: { eligibleUnique: 0, ready: false, reason: 'VERIFIED_FINAL_ANSWER_TARGETS_NOT_RECORDED' },
    },
    trainingStarted: false,
    trainingBlockedReasons: ['TRAINING_ENVIRONMENT_NOT_VERIFIED', 'BASE_MODEL_NOT_SELECTED', 'HOLDOUT_COMPARISON_NOT_RUN'],
  };
  return { report, examples: [...unique.values()] };
}

/** Read-only counts: no goals are returned, no model is invoked, and no credentials are read. */
export async function auditTrainingReadiness(db: Kysely<any>, ownerId: string, options: TrainingReadinessOptions = {}) {
  return (await scanTrainingReadiness(db, ownerId, options)).report;
}

/**
 * Explicit, owner-scoped preparation in memory. It neither writes a file nor starts
 * training. Only category routing is supported; tool arguments, skill IDs, and final
 * answers are never reconstructed from hash-only experience trails.
 */
export async function prepareRoutingTrainingDataset(db: Kysely<any>, ownerId: string, options: TrainingReadinessOptions = {}) {
  const { report, examples } = await scanTrainingReadiness(db, ownerId, options);
  if (!report.roles.routing.ready) return { status: 'blocked' as const, readiness: report, dataset: null };
  // Stable time order with source tie-breaking, and no prompt appears in both splits.
  const selected = examples.slice(-ROUTING_TRAINING_EXPORT_LIMIT), boundary = Math.floor(selected.length * 0.8);
  const rows = selected.map((example, index) => ({
    split: index < boundary ? 'training' as const : 'validation' as const,
    input: example.goal, target: example.category,
    sourceHash: example.sourceHash, evidenceHash: example.evidenceHash, createdAt: example.createdAt,
  }));
  const dataset = {
    version: ROUTING_TRAINING_DATASET_VERSION, targetKind: 'experience_category' as const,
    manifest: { count: rows.length, eligibleCount: examples.length, selection: 'most_recent_2000' as const, trainingCount: boundary, validationCount: rows.length - boundary,
      dataHash: learningHash(JSON.stringify(rows)), exclusionPolicyHash: learningHash(JSON.stringify(excludedCases.map(test => [test.id, normalizeLearningText(test.prompt)]))),
      firstCreatedAt: rows[0].createdAt, lastCreatedAt: rows.at(-1)!.createdAt },
    rows,
  };
  return { status: 'prepared' as const, readiness: report, dataset };
}
