import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SkillQualityInput, SkillQualityObservation } from '../../contracts/src/skill-quality.ts';
import { compareSkillQuality, scoreSkillMeasurements, scoreSkillEvaluation } from './quality.ts';
import type { SkillBenchmarkEvaluation } from '../../contracts/src/skill-benchmarks.ts';

const observation = (changes: Partial<SkillQualityObservation> = {}): SkillQualityObservation => ({ outcome: 'passed', verification: 'passed', safety: 'passed', recovery: 'not_applicable', durationMs: 12.5, inputTokens: 0, outputTokens: 0, ...changes });
function input(): SkillQualityInput {
  return { evaluationId: randomUUID(), evaluationStatus: 'completed', suiteId: 'controlled-local-suite', suiteHash: 'a'.repeat(64), configHash: 'b'.repeat(64), verifierVersion: 'local-v1', scope: 'instruction_context',
    baselineContentHash: 'c'.repeat(64), candidateContentHash: 'd'.repeat(64), independentHoldout: true, createdAt: '2026-01-01T00:00:00.000Z', evidenceScope: 'isolated_experiment',
    measuredScope: 'Controlled instruction transport only.', limitations: ['No model semantic quality measurement.'],
    cases: [{ caseId: 'train', split: 'training', baseline: observation(), candidate: observation() }, { caseId: 'holdout', split: 'holdout', baseline: observation(), candidate: observation() }] };
}
describe('measured skill quality arithmetic', () => {
  it('reports scoped case evidence without inventing semantic quality, recovery success, pricing or promotion', () => {
    const result = scoreSkillMeasurements(input());
    expect(result).toMatchObject({ scope: 'instruction_context', reviewReady: true, semanticQuality: null, automaticPromotion: false, caseCount: 2, holdoutCount: 1 });
    expect(result.candidate.success).toMatchObject({ numerator: 2, denominator: 2, unknown: 0, observedRate: 1, lowerBound: 1 });
    expect(result.candidate.recovery).toMatchObject({ denominator: 0, eligible: 0, notApplicable: 2, observedRate: null });
    expect(result.candidate.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, monetaryCost: null, currency: null, costReason: 'pricing_unavailable' });
  });
  it('keeps unknown and skipped outcomes visible outside the observed denominator and inside the lower bound', () => {
    const raw = input(); raw.cases[1].candidate = observation({ outcome: 'unknown', verification: 'unknown', inputTokens: null, outputTokens: null });
    raw.cases.push({ caseId: 'skipped', split: 'holdout', baseline: observation(), candidate: observation({ outcome: 'skipped', durationMs: null }) });
    const result = scoreSkillMeasurements(raw);
    expect(result.candidate.success).toMatchObject({ passed: 1, failed: 0, unknown: 2, denominator: 1, eligible: 3, observedRate: 1, lowerBound: 1 / 3 });
    expect(result.regressions).toMatchObject({ count: 0, comparableCases: 1, unknownPairs: 2 });
    expect(result.reviewReady).toBe(false); expect(result.reviewReasons).toContain('incomplete_measurements');
  });
  it('measures holdout regressions separately and refuses a passing training set as a substitute', () => {
    const raw = input(); raw.cases[1].candidate = observation({ outcome: 'failed', safety: 'failed', verification: 'failed' });
    const result = scoreSkillMeasurements(raw);
    expect(result.regressions).toMatchObject({ count: 1, caseIds: ['holdout'] });
    expect(result.candidate.holdout.observedRate).toBe(0); expect(result.reviewReasons).toContain('safety_not_fully_passed');
    expect(result.reviewReasons).toContain('holdout_below_threshold'); expect(result.reviewReady).toBe(false);
  });
  it('requires trusted holdout independence rather than trusting a split label', () => {
    const raw = input(); raw.independentHoldout = false;
    expect(scoreSkillMeasurements(raw).reviewReasons).toContain('holdout_independence_unverified');
    raw.independentHoldout = true; raw.cases[1].split = 'training';
    expect(scoreSkillMeasurements(raw).reviewReasons).toContain('missing_training_or_holdout');
  });
  it('does not convert absent safety checks or unknown usage into perfect safety or zero tokens', () => {
    const raw = input(); raw.cases[0].candidate = observation({ safety: 'not_applicable', inputTokens: 12, outputTokens: 4 });
    raw.cases[1].candidate = observation({ safety: 'not_applicable', inputTokens: null, outputTokens: null });
    const result = scoreSkillMeasurements(raw);
    expect(result.reviewReasons).toContain('safety_not_fully_passed');
    expect(result.candidate.usage).toMatchObject({ samples: 1, unknown: 1, inputTokens: null, outputTokens: null, knownInputTokens: 12, knownOutputTokens: 4 });
  });
  it('does not pass an applicable failed recovery check', () => {
    const raw = input(); raw.cases[1].candidate.recovery = 'failed';
    const result = scoreSkillMeasurements(raw); expect(result.reviewReasons).toContain('recovery_not_fully_passed'); expect(result.reviewReady).toBe(false);
  });
  it('reports latency samples and percentiles from supplied measurements and no total when a duration is absent', () => {
    const raw = input(); raw.cases[0].candidate.durationMs = 10; raw.cases[1].candidate.durationMs = 30;
    let result = scoreSkillMeasurements(raw); expect(result.candidate.latency).toEqual({ samples: 2, unknown: 0, totalMs: 40, meanMs: 20, p50Ms: 10, p95Ms: 30 });
    raw.cases[1].candidate.durationMs = null; result = scoreSkillMeasurements(raw);
    expect(result.candidate.latency).toEqual({ samples: 1, unknown: 1, totalMs: null, meanMs: 10, p50Ms: 10, p95Ms: 10 });
  });
  it('empty measurements are unknown rather than a zero-work pass', () => {
    const raw = input(); raw.cases = []; const result = scoreSkillMeasurements(raw);
    expect(result.reviewReady).toBe(false); expect(result.candidate.success.observedRate).toBeNull(); expect(result.candidate.usage.inputTokens).toBeNull();
  });
  it('rejects duplicate case identities and invalid negative measurements', () => {
    const raw = input(); raw.cases[1].caseId = 'train'; expect(() => scoreSkillMeasurements(raw)).toThrow();
    const invalid = input(); invalid.cases[1].candidate.durationMs = -1; expect(() => scoreSkillMeasurements(invalid)).toThrow();
  });
});

describe('comparable evaluation drift', () => {
  function pair() { const a = input(), b = input(); b.createdAt = '2026-01-02T00:00:00.000Z'; return { a, b }; }
  it.each(['suiteId', 'suiteHash', 'configHash', 'verifierVersion', 'scope', 'baselineContentHash', 'candidateContentHash'] as const)('rejects comparison when %s changes', key => {
    const { a, b } = pair(); b[key] = key.endsWith('Hash') ? 'e'.repeat(64) : 'different';
    expect(compareSkillQuality(scoreSkillMeasurements(a), scoreSkillMeasurements(b))).toMatchObject({ comparable: false, status: 'incomparable', successDelta: null, reasons: [`${key}_changed`] });
  });
  it('detects an observed regression only within the same suite, pins and configuration', () => {
    const { a, b } = pair(); b.cases[1].candidate.outcome = 'failed'; b.cases[0].candidate.durationMs = 20;
    const drift = compareSkillQuality(scoreSkillMeasurements(a), scoreSkillMeasurements(b));
    expect(drift).toMatchObject({ comparable: true, status: 'regression_observed', successDelta: -.5, holdoutDelta: -1, statisticalSignificance: 'not_estimated' });
    expect(drift.latencyMeanDeltaMs).toBe(3.75);
  });
  it('does not call missing outcomes a drift-free successful repeat', () => {
    const { a, b } = pair(); b.cases[1].candidate.outcome = 'unknown'; b.cases[1].candidate.inputTokens = null;
    expect(compareSkillQuality(scoreSkillMeasurements(a), scoreSkillMeasurements(b))).toMatchObject({ comparable: true, status: 'insufficient_evidence', successDelta: null, holdoutDelta: null, inputTokensDelta: null });
  });
  it('rejects the same evaluation and reverse-time comparisons', () => {
    const a = scoreSkillMeasurements(input()); expect(compareSkillQuality(a, a).reasons).toEqual(['same_evaluation', 'non_chronological']);
  });
});

describe('persisted benchmark normalization', () => {
  function evaluation(): SkillBenchmarkEvaluation {
    const baseline = { versionId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64), inspectionId: randomUUID(), inspectorVersion: 'inspector-v1' };
    const candidate = { ...baseline, versionId: randomUUID(), contentHash: 'b'.repeat(64), inspectionId: randomUUID() };
    const suite: SkillBenchmarkEvaluation['suite'] = { id: 'instruction-delivery-v1', scope: 'instruction_delivery', suiteHash: 'c'.repeat(64), configHash: 'd'.repeat(64), verifierVersion: 'fixture-v1', independentHoldout: true,
      measuredScope: 'Controlled instruction transport only.', limitations: ['No model semantic quality measurement.'],
      cases: [{ id: 'train', split: 'training', fixtureHash: 'e'.repeat(64), proofKind: 'instruction_context' }, { id: 'holdout', split: 'holdout', fixtureHash: 'f'.repeat(64), proofKind: 'instruction_context' }] };
    return { id: randomUUID(), status: 'completed', baseline, candidate, suite, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', errorCode: null, evidenceScope: 'isolated_experiment',
      cases: suite.cases.flatMap(item => (['baseline', 'candidate'] as const).map(arm => ({ caseId: item.id, split: item.split, arm, scope: suite.scope, status: 'passed', reasonCode: null,
        sourceVersionId: arm === 'baseline' ? baseline.versionId : candidate.versionId, sourceContentHash: arm === 'baseline' ? baseline.contentHash : candidate.contentHash,
        suiteHash: suite.suiteHash, configHash: suite.configHash, verifierVersion: suite.verifierVersion, inputsHash: '1'.repeat(64), outputHash: '2'.repeat(64),
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.100Z', durationMs: 100,
        metrics: { success: true, verification: true, safety: true, recovery: null, costUsd: null }, notApplicable: ['recovery', 'costUsd'], usage: { inputTokens: 0, outputTokens: 0 }, evidenceScope: 'isolated_experiment',
        evidence: [{ kind: 'instruction_context', inputsHash: '1'.repeat(64), outputHash: '2'.repeat(64), verifiedAt: '2026-01-01T00:00:00.100Z' }] }))) };
  }
  it('scores baseline and candidate arms against their immutable declared cases', () => {
    const result = scoreSkillEvaluation(evaluation()); expect(result).toMatchObject({ scope: 'instruction_delivery', caseCount: 2, reviewReady: true });
    expect(result.candidate.recovery.notApplicable).toBe(2);
  });
  it('does not let a completed label hide an absent candidate holdout', () => {
    const raw = evaluation(); raw.cases = raw.cases.filter(item => item.arm !== 'candidate' || item.split !== 'holdout');
    const result = scoreSkillEvaluation(raw); expect(result.reviewReady).toBe(false); expect(result.candidate.holdout.unknown).toBe(1);
  });
  it.each(['sourceContentHash', 'configHash', 'suiteHash', 'verifierVersion'] as const)('rejects mismatched per-case %s', key => {
    const raw = evaluation(); raw.cases[0][key] = key === 'verifierVersion' ? 'other' : '9'.repeat(64);
    expect(() => scoreSkillEvaluation(raw)).toThrowError(/لا تطابق/);
  });
  it('rejects duplicate arms rather than averaging a passing case twice', () => {
    const raw = evaluation(); raw.cases.push(raw.cases[0]); expect(() => scoreSkillEvaluation(raw)).toThrowError(/لا تطابق/);
  });
  it('rejects a passing result with the wrong proof kind or mismatched evidence hash', () => {
    const wrongKind = evaluation(); wrongKind.cases[0].evidence[0].kind = 'file_observation';
    expect(() => scoreSkillEvaluation(wrongKind)).toThrow();
    const wrongHash = evaluation(); wrongHash.cases[0].evidence[0].outputHash = '3'.repeat(64);
    expect(() => scoreSkillEvaluation(wrongHash)).toThrow();
  });
  it('does not grant review readiness to an unfinished evaluation with apparent passing cases', () => {
    const raw = evaluation(); raw.status = 'running'; raw.finishedAt = null;
    expect(scoreSkillEvaluation(raw).reviewReasons).toContain('evaluation_not_completed');
  });
  it('keeps a blocked case outside actual measured cases and unknown accounting as null', () => {
    const raw = evaluation(), item = raw.cases.find(item => item.arm === 'candidate' && item.split === 'holdout')!;
    item.status = 'blocked'; item.metrics = { success: false, verification: null, safety: null, recovery: null, costUsd: null }; item.notApplicable = ['recovery', 'costUsd']; item.usage = { inputTokens: null, outputTokens: null };
    const result = scoreSkillEvaluation(raw); expect(result.candidate.blockedCases).toBe(1); expect(result.candidate.measuredCases).toBe(1);
    expect(result.candidate.success.unknown).toBe(1); expect(result.candidate.usage.inputTokens).toBeNull(); expect(result.reviewReady).toBe(false);
  });
});
