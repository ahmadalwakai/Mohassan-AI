import { describe, expect, it } from 'vitest';
import { emptyLeadCounts, leadOutcomes, leadSummary, wilson95 } from './fixtures/answer-selection/metrics.js';

describe('answer selection outcome intervals', () => {
  it('covers the full probability range when no cases were evaluated', () => {
    expect(wilson95(0, 0)).toEqual({ lower: 0, upper: 1 });
    expect(Object.values(leadSummary(emptyLeadCounts()))).toEqual(leadOutcomes.map(() => ({ count: 0, wilson95: [0, 1] })));
  });

  it('keeps exact endpoints and a nonzero interval width at zero or full success', () => {
    const zero = wilson95(0, 10);
    const all = wilson95(10, 10);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeCloseTo(0.2775328, 7);
    expect(all.lower).toBeCloseTo(0.7224672, 7);
    expect(all.upper).toBe(1);
  });

  it('matches the two-sided Wilson interval for 50 of 100 observations', () => {
    const { lower, upper } = wilson95(50, 100);
    expect(lower).toBeCloseTo(0.40383153, 8);
    expect(upper).toBeCloseTo(0.59616847, 8);
  });

  it('uses the same total including abstentions for each outcome', () => {
    const counts = { correct: 5, wrong: 3, abstained: 2 };
    const summary = leadSummary(counts);
    for (const outcome of leadOutcomes) {
      const count = counts[outcome];
      const { lower, upper } = wilson95(count, 10);
      expect(summary[outcome]).toEqual({ count, wilson95: [lower, upper] });
    }
  });

  it.each([[-1, 10], [3, 2], [0, -1], [0.5, 1], [0, Number.NaN]])('rejects impossible counts %s of %s', (count, total) => {
    expect(() => wilson95(count, total)).toThrow(RangeError);
  });
});
