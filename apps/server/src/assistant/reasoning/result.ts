import type { LocalComputation } from '../local-computation.js';
import type { Evidence, Lang } from '../mind/contract.js';

export type ReasoningResult = LocalComputation & { status: 'completed' | 'blocked' };
export const REASONING_VALUE_ID = 'reasoning-result';

export function reasoned(lang: Lang, text: string, value: string, sources: readonly Evidence[] = []): ReasoningResult {
  const result: Evidence = { id: REASONING_VALUE_ID, source: 'computed', quote: text, value };
  return {
    status: 'completed', lang, text,
    claims: [{ text, support: [result.id, ...sources.map(source => source.id)], status: 'confirmed' }],
    evidence: [result, ...sources],
  };
}

export function reasoningGap(lang: Lang, text: string, sources: readonly Evidence[] = []): ReasoningResult {
  return {
    status: 'blocked', lang, text,
    claims: [{ text, support: sources.map(source => source.id), status: 'not_found' }],
    evidence: [...sources],
  };
}
