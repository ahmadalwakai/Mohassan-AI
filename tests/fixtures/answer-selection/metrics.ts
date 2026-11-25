export const leadOutcomes = ['correct', 'wrong', 'abstained'] as const;
export type Outcome = (typeof leadOutcomes)[number];
export type LeadCounts = Record<Outcome, number>;
export type LeadSummary = Record<Outcome, { count: number; wilson95: readonly [number, number] }>;

export const emptyLeadCounts = (): LeadCounts => ({ correct: 0, wrong: 0, abstained: 0 });

const NORMAL_95 = 1.959963984540054;

/** Pointwise two-sided Wilson score interval for a binomial proportion. With no observations, every rate is possible. */
export function wilson95(successes: number, observations: number): { lower: number; upper: number } {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(observations) || successes < 0 || successes > observations) {
    throw new RangeError('Wilson interval counts must be integers with 0 ≤ successes ≤ observations');
  }
  if (observations === 0) return { lower: 0, upper: 1 };

  const proportion = successes / observations;
  const adjustment = NORMAL_95 ** 2 / observations;
  const denominator = 1 + adjustment;
  const center = (proportion + adjustment / 2) / denominator;
  const radius = NORMAL_95 * Math.sqrt((proportion * (1 - proportion) + adjustment / 4) / observations) / denominator;
  return {
    lower: successes === 0 ? 0 : Math.max(0, center - radius),
    upper: successes === observations ? 1 : Math.min(1, center + radius),
  };
}

/** All fractions use the total replay count, including cases where the chooser abstained. */
export function leadSummary(counts: Readonly<LeadCounts>): LeadSummary {
  const observations = leadOutcomes.reduce((total, outcome) => total + counts[outcome], 0);
  const estimate = (outcome: Outcome): LeadSummary[Outcome] => {
    const count = counts[outcome];
    const { lower, upper } = wilson95(count, observations);
    return { count, wilson95: [lower, upper] };
  };
  return { correct: estimate('correct'), wrong: estimate('wrong'), abstained: estimate('abstained') };
}
