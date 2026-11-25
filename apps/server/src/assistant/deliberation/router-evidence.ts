import { decisionRoutes } from '@mohassan/contracts';
import type { RouterCandidate } from './types.js';

/** Rank the configured B0 head's output. The logits and weights remain in its existing observer. */
export function topRouterCandidates(routes: readonly string[], logits: readonly number[]): RouterCandidate[] {
  if (!logits.length || routes.length !== logits.length || !logits.every(Number.isFinite)) return [];
  const max = Math.max(...logits);
  const weights = logits.map(logit => Math.exp(logit - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return routes.flatMap((name, index) => {
    const route = decisionRoutes.find(value => value === name);
    return route ? [{ route, score: weights[index]! / total }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 4);
}
