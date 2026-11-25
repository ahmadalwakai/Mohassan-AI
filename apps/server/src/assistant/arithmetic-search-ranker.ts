import type { SearchCandidate } from './arithmetic-search-candidates.js';
import modelArtifact from './arithmetic-search-model.json' with { type: 'json' };

export type SearchFeatures = Readonly<Record<string, number>>;

interface SearchModel {
  readonly rank: SearchFeatures;
  readonly confidence: SearchFeatures;
  readonly minimumConfidence: number | null;
}

export interface RankedSearchCandidate {
  readonly candidate: SearchCandidate;
  readonly score: number;
  readonly margin: number | null;
  readonly candidateCount: number;
  readonly answerCount: number;
  readonly agreement: number;
}

const model: SearchModel = modelArtifact;

export function boundedFeature(value: number): number {
  return Math.max(-12, Math.min(12, value));
}

export function scoreArithmeticFeatures(features: SearchFeatures, weights: SearchFeatures): number {
  let score = 0;
  for (const [key, value] of Object.entries(features)) {
    score += boundedFeature(value) * (weights[key] ?? 0);
  }
  return score;
}

export function rankArithmeticCandidates(candidates: readonly SearchCandidate[], weights: SearchFeatures): RankedSearchCandidate | null {
  const scored = candidates.map(candidate => ({ candidate, score: scoreArithmeticFeatures(candidate.features, weights) }));
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (!winner) return null;
  // Alternative derivations of the winning value cannot make it ambiguous.
  const other = scored.find(item => item.candidate.value !== winner.candidate.value);
  const agreement = scored.slice(0, 5).filter(item => item.candidate.value === winner.candidate.value).length / Math.min(5, scored.length);
  return {
    ...winner,
    margin: other ? winner.score - other.score : null,
    candidateCount: scored.length,
    answerCount: new Set(scored.map(item => item.candidate.value)).size,
    agreement,
  };
}

export function arithmeticConfidenceFeatures(ranked: RankedSearchCandidate): SearchFeatures {
  const selected = ranked.candidate.features;
  const features: Record<string, number> = {
    ...selected,
    'confidence:bias': 1,
    'confidence:score': ranked.score,
    'confidence:margin': ranked.margin ?? 0,
    'confidence:log-margin': Math.log1p(ranked.margin ?? 0),
    'confidence:one-answer': Number(ranked.margin === null),
    'confidence:answer-count': Math.log1p(ranked.answerCount),
    'confidence:candidate-count': Math.log1p(ranked.candidateCount),
    'confidence:agreement': ranked.agreement,
  };
  const root = Object.keys(selected).find(key => key.startsWith('root:'));
  const intent = Object.keys(selected).find(key => key.startsWith('intent:'));
  if (root && intent) {
    features[`confidence:shape:${root}:${intent}:${selected.operations}`] = 1;
    features[`confidence:grounded:${root}:${intent}`] = Number(selected.inferred === 0 && selected.matched > 0);
    features[`confidence:all-quantities:${root}:${intent}`] = Number(selected.omitted === 0);
  }
  for (const [key, value] of Object.entries(selected)) {
    if (value) features[`confidence:margin:${key}`] = boundedFeature(value) * Math.log1p(ranked.margin ?? 0);
  }
  return features;
}

export function selectArithmeticCandidate(candidates: readonly SearchCandidate[], fitted: SearchModel = model): SearchCandidate | null {
  if (fitted.minimumConfidence === null) return null;
  const ranked = rankArithmeticCandidates(candidates, fitted.rank);
  if (!ranked || ranked.margin === 0) return null;
  const confidence = scoreArithmeticFeatures(arithmeticConfidenceFeatures(ranked), fitted.confidence);
  return confidence >= fitted.minimumConfidence ? ranked.candidate : null;
}
