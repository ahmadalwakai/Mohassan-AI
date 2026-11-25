import { describe, expect, it } from 'vitest';
import {
  type CapabilityCaseOutcome,
  compareCapabilityCases,
} from '../scripts/agent-capability-bench/by-branch-statistics.js';

function outcome(
  id: string, passed: boolean, area: CapabilityCaseOutcome['area'] = 'factual',
  language: CapabilityCaseOutcome['language'] = 'en',
): CapabilityCaseOutcome {
  return { id, passed, area, language };
}

function compareChanges(newlyPassing: number, newlyFailing: number) {
  const changes = Array.from({ length: newlyPassing + newlyFailing }, (_, index) =>
    outcome(`case-${index}`, index >= newlyPassing));
  const unchanged = outcome('unchanged', true);
  return compareCapabilityCases([unchanged, ...changes], [unchanged, ...changes.map(item => ({ ...item, passed: !item.passed }))]);
}

describe('capability branch comparisons', () => {
  it('pairs by ID and computes pass counts, Wilson intervals and deltas overall and for each group', () => {
    const baseline = [
      outcome('alpha', false), outcome('beta', true, 'factual', 'ar'),
      outcome('gamma', false, 'small-talk', 'ar'), outcome('delta', true, 'small-talk'), outcome('epsilon', false),
    ];
    const candidate = baseline.toReversed().map(item =>
      ['alpha', 'beta', 'gamma'].includes(item.id) ? { ...item, passed: !item.passed } : item);
    const result = compareCapabilityCases(baseline, candidate);
    expect(result.overall).toMatchObject({
      total: 5, baselinePassed: 2, candidatePassed: 3, deltaCount: 1, deltaRate: 0.2, newlyPassing: 2, newlyFailing: 1,
    });
    expect(result.overall.baselineWilson95?.[0]).toBeCloseTo(0.1176207742, 9);
    expect(result.overall.baselineWilson95?.[1]).toBeCloseTo(0.7692757187, 9);
    expect(result.overall.candidateWilson95?.[0]).toBeCloseTo(0.2307242813, 9);
    expect(result.overall.candidateWilson95?.[1]).toBeCloseTo(0.8823792258, 9);
    expect(result.byArea).toMatchObject({
      factual: { total: 3, baselinePassed: 1, candidatePassed: 1, newlyPassing: 1, newlyFailing: 1, deltaRate: 0 },
      'small-talk': { total: 2, baselinePassed: 1, candidatePassed: 2, newlyPassing: 1, newlyFailing: 0, deltaRate: 0.5 },
    });
    expect(result.byLanguage).toMatchObject({
      ar: { total: 2, baselinePassed: 1, candidatePassed: 1, newlyPassing: 1, newlyFailing: 1, deltaRate: 0 },
      en: { total: 3, baselinePassed: 1, candidatePassed: 2, newlyPassing: 1, newlyFailing: 0, deltaRate: 1 / 3 },
    });
    expect(result.caseDeltas).toEqual([
      { id: 'alpha', area: 'factual', language: 'en', delta: 1 },
      { id: 'beta', area: 'factual', language: 'ar', delta: -1 },
      { id: 'gamma', area: 'small-talk', language: 'ar', delta: 1 },
      { id: 'delta', area: 'small-talk', language: 'en', delta: 0 },
      { id: 'epsilon', area: 'factual', language: 'en', delta: 0 },
    ]);
  });

  it.each([
    [0, 0, 1], [3, 3, 1], [3, 4, 1], [10, 2, 158 / 4_096], [2, 10, 158 / 4_096], [8, 0, 1 / 128],
  ])('computes the two-sided exact p-value for %i gains and %i losses', (gains, losses, pValue) => {
    const { overall } = compareChanges(gains, losses);
    expect(overall.pValue).toBeCloseTo(pValue, 14);
    expect(overall.log10PValue).toBeCloseTo(Math.log10(pValue), 14);
  });

  it('retains the log p-value when the probability is smaller than a double can represent', () => {
    const { overall } = compareChanges(1_200, 0);
    expect(overall.pValue).toBe(0);
    expect(overall.log10PValue).toBeCloseTo(-1_199 * Math.log10(2), 10);
  });

  it('rejects empty, mismatched and malformed case receipts', () => {
    const baseline = [outcome('alpha', true), outcome('beta', false)];
    expect(() => compareCapabilityCases([], [])).toThrow('same nonzero number');
    expect(() => compareCapabilityCases(baseline, [])).toThrow('same nonzero number');
    expect(() => compareCapabilityCases([baseline[0], baseline[0]], baseline)).toThrow('Duplicate case ID in baseline');
    expect(() => compareCapabilityCases(baseline, [baseline[0], baseline[0]])).toThrow('Duplicate case ID in candidate');
    expect(() => compareCapabilityCases(baseline, [baseline[0], outcome('gamma', true)])).toThrow('missing a baseline case ID');
    expect(() => compareCapabilityCases(baseline, [baseline[0], outcome('beta', true, 'small-talk')])).toThrow('same area and language');
    expect(() => compareCapabilityCases(baseline, [baseline[0], outcome('beta', true, 'factual', 'ar')])).toThrow('same area and language');
    const malformed = { id: 'beta', area: 'factual', language: 'en', passed: 'true' } as unknown as CapabilityCaseOutcome;
    expect(() => compareCapabilityCases(baseline, [baseline[0], malformed])).toThrow('Invalid case outcome in candidate');
  });
});
