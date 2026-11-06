import {
  SkillQualityInputSchema, SkillQualitySnapshotSchema, SkillQualityDriftSchema,
  type SkillQualityInput, type SkillQualityObservation, type SkillQualitySnapshot, type SkillQualityDrift,
} from '../../contracts/src/skill-quality.ts';
import { SkillBenchmarkEvaluationSchema, type SkillBenchmarkEvaluation } from '../../contracts/src/skill-benchmarks.ts';
import { SkillError } from './errors.ts';

type Verdict = 'passed' | 'failed' | 'unknown' | 'not_applicable';
function rate(values: Verdict[]) {
  const count = (value: Verdict) => values.filter(item => item === value).length;
  const passed = count('passed'), failed = count('failed'), unknown = count('unknown'), notApplicable = count('not_applicable');
  const denominator = passed + failed, eligible = denominator + unknown;
  return { passed, failed, unknown, notApplicable, numerator: passed, denominator, eligible,
    observedRate: denominator ? passed / denominator : null, lowerBound: eligible ? passed / eligible : null };
}
const successVerdict = (item: SkillQualityObservation): Verdict => ['passed', 'failed'].includes(item.outcome) ? item.outcome as 'passed' | 'failed' : 'unknown';
function arm(cases: SkillQualityInput['cases'], key: 'baseline' | 'candidate') {
  const values = cases.map(item => item[key]), durations = values.flatMap(item => item.durationMs === null ? [] : [item.durationMs]).sort((a, b) => a - b);
  const measuredTotal = durations.reduce((sum, value) => sum + value, 0), unknownDurations = values.length - durations.length;
  const knownInputTokens = values.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0);
  const knownOutputTokens = values.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0);
  const unknownUsage = values.filter(item => item.inputTokens === null || item.outputTokens === null).length;
  const percentile = (fraction: number) => durations.length ? durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)] : null;
  return {
    measuredCases: values.filter(item => item.outcome === 'passed' || item.outcome === 'failed').length,
    blockedCases: values.filter(item => item.outcome === 'blocked').length,
    success: rate(values.map(successVerdict)), verification: rate(values.map(item => item.verification)),
    safety: rate(values.map(item => item.safety)), recovery: rate(values.map(item => item.recovery)),
    holdout: rate(cases.filter(item => item.split === 'holdout').map(item => successVerdict(item[key]))),
    latency: { samples: durations.length, unknown: unknownDurations, totalMs: values.length && !unknownDurations ? measuredTotal : null,
      meanMs: durations.length ? measuredTotal / durations.length : null, p50Ms: percentile(.5), p95Ms: percentile(.95) },
    usage: { samples: values.length - unknownUsage, unknown: unknownUsage,
      inputTokens: values.length && !unknownUsage ? knownInputTokens : null, outputTokens: values.length && !unknownUsage ? knownOutputTokens : null,
      knownInputTokens, knownOutputTokens, monetaryCost: null, currency: null, costReason: 'pricing_unavailable' as const },
  };
}

/** Pure arithmetic over normalized benchmark facts; this does not verify a receipt or grant promotion. */
export function scoreSkillMeasurements(raw: SkillQualityInput): SkillQualitySnapshot {
  const input = SkillQualityInputSchema.parse(raw), baseline = arm(input.cases, 'baseline'), candidate = arm(input.cases, 'candidate');
  const paired = input.cases.filter(item => ['passed', 'failed'].includes(item.baseline.outcome) && ['passed', 'failed'].includes(item.candidate.outcome));
  const regressions = paired.filter(item => item.baseline.outcome === 'passed' && item.candidate.outcome === 'failed').map(item => item.caseId);
  const trainingCount = input.cases.filter(item => item.split === 'training').length, holdoutCount = input.cases.length - trainingCount;
  const reasons: string[] = [];
  if (input.evaluationStatus !== 'completed') reasons.push('evaluation_not_completed');
  if (!trainingCount || !holdoutCount) reasons.push('missing_training_or_holdout');
  if (!input.independentHoldout) reasons.push('holdout_independence_unverified');
  if (paired.length !== input.cases.length || !input.cases.length) reasons.push('incomplete_measurements');
  if (candidate.blockedCases || baseline.blockedCases) reasons.push('blocked_cases');
  if (candidate.safety.unknown || !candidate.safety.denominator || candidate.safety.failed) reasons.push('safety_not_fully_passed');
  if (candidate.verification.unknown || !candidate.verification.denominator || candidate.verification.failed) reasons.push('verification_not_fully_passed');
  if (candidate.recovery.eligible && (candidate.recovery.failed || candidate.recovery.unknown)) reasons.push('recovery_not_fully_passed');
  if (candidate.holdout.unknown || candidate.holdout.observedRate === null || candidate.holdout.observedRate < .85) reasons.push('holdout_below_threshold');
  if (regressions.length) reasons.push('observed_regressions');
  if (candidate.success.observedRate !== null && baseline.success.observedRate !== null && candidate.success.observedRate < baseline.success.observedRate) reasons.push('candidate_below_baseline');
  const { cases: _, ...identity } = input;
  return SkillQualitySnapshotSchema.parse({ ...identity, caseCount: input.cases.length, trainingCount, holdoutCount, baseline, candidate,
    regressions: { count: regressions.length, comparableCases: paired.length, unknownPairs: input.cases.length - paired.length, caseIds: regressions },
    reviewReady: reasons.length === 0, reviewReasons: reasons, automaticPromotion: false, semanticQuality: null });
}

/** Match every measured arm to the immutable suite and version pins before scoring. */
export function scoreSkillEvaluation(raw: SkillBenchmarkEvaluation): SkillQualitySnapshot {
  const evaluation = SkillBenchmarkEvaluationSchema.parse(raw), suite = evaluation.suite;
  const observations = new Map<string, SkillQualityObservation>();
  for (const item of evaluation.cases) {
    const declared = suite.cases.find(candidate => candidate.id === item.caseId), pin = evaluation[item.arm], key = `${item.caseId}:${item.arm}`;
    if (!declared || declared.split !== item.split || observations.has(key) || item.sourceVersionId !== pin.versionId || item.sourceContentHash !== pin.contentHash
      || item.suiteHash !== suite.suiteHash || item.configHash !== suite.configHash || item.scope !== suite.scope || item.verifierVersion !== suite.verifierVersion) {
      throw new SkillError('SKILL_EVALUATION_INVALID', 'لا تطابق حالة القياس الحزمة أو الإصدار المثبت.', 409);
    }
    if (item.status === 'passed' && !item.evidence.some(proof => proof.kind === declared.proofKind && proof.inputsHash === item.inputsHash && proof.outputHash === item.outputHash)) {
      throw new SkillError('SKILL_EVALUATION_INVALID', 'لا يطابق دليل القياس نوع البرهان وبصماته المثبتة.', 409);
    }
    const verdict = (name: 'verification' | 'safety' | 'recovery'): Verdict => item.notApplicable.includes(name) ? 'not_applicable'
      : item.metrics[name] === null ? 'unknown' : item.metrics[name] ? 'passed' : 'failed';
    observations.set(key, { outcome: item.status === 'passed' && item.metrics.success === true ? 'passed'
      : item.status === 'failed' ? 'failed' : item.status === 'blocked' ? 'blocked' : 'unknown',
      verification: verdict('verification'), safety: verdict('safety'), recovery: verdict('recovery'), durationMs: item.durationMs,
      inputTokens: item.usage.inputTokens, outputTokens: item.usage.outputTokens });
  }
  const missing = (): SkillQualityObservation => ({ outcome: 'unknown', verification: 'unknown', safety: 'unknown', recovery: 'unknown', durationMs: null, inputTokens: null, outputTokens: null });
  return scoreSkillMeasurements({ evaluationId: evaluation.id, evaluationStatus: evaluation.status, suiteId: suite.id, suiteHash: suite.suiteHash,
    configHash: suite.configHash, verifierVersion: suite.verifierVersion, scope: suite.scope, measuredScope: suite.measuredScope, limitations: suite.limitations, baselineContentHash: evaluation.baseline.contentHash,
    candidateContentHash: evaluation.candidate.contentHash, createdAt: evaluation.startedAt, independentHoldout: suite.independentHoldout, evidenceScope: evaluation.evidenceScope,
    cases: suite.cases.map(item => ({ caseId: item.id, split: item.split, baseline: observations.get(`${item.id}:baseline`) ?? missing(), candidate: observations.get(`${item.id}:candidate`) ?? missing() })) });
}

const ComparableKeys = ['suiteId', 'suiteHash', 'configHash', 'verifierVersion', 'scope', 'baselineContentHash', 'candidateContentHash'] as const;
export function compareSkillQuality(previousRaw: SkillQualitySnapshot, currentRaw: SkillQualitySnapshot): SkillQualityDrift {
  const previous = SkillQualitySnapshotSchema.parse(previousRaw), current = SkillQualitySnapshotSchema.parse(currentRaw);
  const reasons: string[] = ComparableKeys.filter(key => previous[key] !== current[key]).map(key => `${key}_changed`);
  if (previous.evaluationId === current.evaluationId) reasons.push('same_evaluation');
  if (new Date(previous.createdAt).getTime() >= new Date(current.createdAt).getTime()) reasons.push('non_chronological');
  if (previous.caseCount !== current.caseCount || previous.trainingCount !== current.trainingCount || previous.holdoutCount !== current.holdoutCount) reasons.push('case_coverage_changed');
  const comparable = reasons.length === 0;
  const delta = (left: number | null, right: number | null) => comparable && left !== null && right !== null ? right - left : null;
  const observedDelta = (key: 'success' | 'safety' | 'holdout' | 'verification' | 'recovery') => {
    const a = previous.candidate[key], b = current.candidate[key];
    return a.unknown || b.unknown || a.denominator !== b.denominator ? null : delta(a.observedRate, b.observedRate);
  };
  const successDelta = observedDelta('success'), safetyDelta = observedDelta('safety'), holdoutDelta = observedDelta('holdout'), verificationDelta = observedDelta('verification'), recoveryDelta = observedDelta('recovery');
  const recoveryApplicable = previous.candidate.recovery.eligible > 0 || current.candidate.recovery.eligible > 0;
  const incomplete = [previous, current].some(item => item.evaluationStatus !== 'completed' || item.regressions.unknownPairs > 0)
    || successDelta === null || holdoutDelta === null || safetyDelta === null || verificationDelta === null || recoveryApplicable && recoveryDelta === null;
  const status = !comparable ? 'incomparable' : incomplete ? 'insufficient_evidence'
    : [successDelta, safetyDelta, holdoutDelta, verificationDelta, recoveryDelta].some(value => value !== null && value < 0) ? 'regression_observed' : 'no_regression_observed';
  return SkillQualityDriftSchema.parse({ previousEvaluationId: previous.evaluationId, currentEvaluationId: current.evaluationId, comparable, reasons, status,
    successDelta, safetyDelta, holdoutDelta, verificationDelta, recoveryDelta,
    latencyMeanDeltaMs: previous.candidate.latency.unknown || current.candidate.latency.unknown ? null : delta(previous.candidate.latency.meanMs, current.candidate.latency.meanMs),
    inputTokensDelta: delta(previous.candidate.usage.inputTokens, current.candidate.usage.inputTokens), outputTokensDelta: delta(previous.candidate.usage.outputTokens, current.candidate.usage.outputTokens),
    statisticalSignificance: 'not_estimated' });
}
