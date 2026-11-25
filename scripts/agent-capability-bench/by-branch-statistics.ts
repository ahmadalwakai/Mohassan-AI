import { type CapabilityScore, wilson95 } from './score.js';

export type CapabilityCaseOutcome = Pick<CapabilityScore, 'id' | 'area' | 'language' | 'passed'>;

interface CaseDelta extends Omit<CapabilityCaseOutcome, 'passed'> {
  delta: -1 | 0 | 1;
}

interface PairedOutcome {
  baselinePassed: boolean;
  caseDelta: CaseDelta;
}

function exactMcNemar(newlyPassing: number, newlyFailing: number) {
  const total = newlyPassing + newlyFailing;
  const smaller = Math.min(newlyPassing, newlyFailing);
  if (smaller >= Math.floor(total / 2)) return { pValue: 1, log10PValue: 0 };

  // Scale the inclusive lower tail by its largest term to avoid underflow in the sum.
  let boundaryLogProbability = -total * Math.LN2;
  for (let count = 1; count <= smaller; count++) {
    boundaryLogProbability += Math.log((total - count + 1) / count);
  }
  let term = 1;
  let scaledTail = 1;
  for (let count = smaller; count > 0; count--) {
    term *= count / (total - count + 1);
    scaledTail += term;
  }
  const logPValue = Math.min(0, Math.LN2 + boundaryLogProbability + Math.log(scaledTail));
  return { pValue: Math.exp(logPValue), log10PValue: logPValue / Math.LN10 };
}

function summarizePairs(pairs: readonly PairedOutcome[]) {
  const total = pairs.length;
  const baselinePassed = pairs.filter(pair => pair.baselinePassed).length;
  const newlyPassing = pairs.filter(pair => pair.caseDelta.delta === 1).length;
  const newlyFailing = pairs.filter(pair => pair.caseDelta.delta === -1).length;
  const deltaCount = newlyPassing - newlyFailing;
  const candidatePassed = baselinePassed + deltaCount;
  return {
    total, baselinePassed, candidatePassed, deltaCount, deltaRate: deltaCount / total, newlyPassing, newlyFailing,
    ...exactMcNemar(newlyPassing, newlyFailing),
    baselineWilson95: wilson95(baselinePassed, total), candidateWilson95: wilson95(candidatePassed, total),
  };
}

function indexOutcomes(outcomes: readonly CapabilityCaseOutcome[], label: string) {
  const indexed = new Map<string, CapabilityCaseOutcome>();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome.id !== 'string' || !outcome.id || typeof outcome.passed !== 'boolean'
      || typeof outcome.area !== 'string' || !outcome.area || typeof outcome.language !== 'string' || !outcome.language) {
      throw new Error(`Invalid case outcome in ${label} receipt.`);
    }
    if (indexed.has(outcome.id)) throw new Error(`Duplicate case ID in ${label} receipt.`);
    indexed.set(outcome.id, outcome);
  }
  return indexed;
}

export function compareCapabilityCases(
  baseline: readonly CapabilityCaseOutcome[], candidate: readonly CapabilityCaseOutcome[],
) {
  if (!baseline.length || baseline.length !== candidate.length) {
    throw new Error('The baseline and candidate receipts must contain the same nonzero number of outcomes.');
  }
  const baselineById = indexOutcomes(baseline, 'baseline');
  const candidateById = indexOutcomes(candidate, 'candidate');
  const pairs = [...baselineById.values()].map(({ id, area, language, passed }): PairedOutcome => {
    const outcome = candidateById.get(id);
    if (!outcome) throw new Error('The candidate receipt is missing a baseline case ID.');
    if (area !== outcome.area || language !== outcome.language) {
      throw new Error('Paired cases must have the same area and language.');
    }
    let delta: CaseDelta['delta'] = 0;
    if (passed !== outcome.passed) delta = outcome.passed ? 1 : -1;
    return { baselinePassed: passed, caseDelta: { id, area, language, delta } };
  });
  const groupBy = (field: 'area' | 'language') => Object.fromEntries(
    [...new Set(pairs.map(({ caseDelta }) => caseDelta[field]))].sort().map(value =>
      [value, summarizePairs(pairs.filter(({ caseDelta }) => caseDelta[field] === value))]),
  );
  return {
    overall: summarizePairs(pairs),
    byArea: groupBy('area'),
    byLanguage: groupBy('language'),
    caseDeltas: pairs.map(pair => pair.caseDelta),
  };
}
