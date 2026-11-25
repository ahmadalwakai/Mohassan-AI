import type { EvidenceSpan } from '../evidence.js';
import type { ExtractiveWritingTask } from '../request.js';

export function usesAlignedEvidence(task: ExtractiveWritingTask): boolean {
  return Boolean(task.intent || task.kind === 'comparison' && task.subjects);
}

export interface Claim {
  kind: 'causal' | 'mechanism' | 'definition' | 'contrast' | 'example' | 'limit' | 'attribute';
  span: EvidenceSpan;
  subject?: string;
  cause?: string;
  effect?: string;
  attribute?: string;
  value?: string;
  contrasted?: string;
  step?: number;
  negated?: boolean;
  predicate?: string;
  conditioned?: boolean;
}

export interface ClaimGroup {
  claims: Claim[];
  support: number;
}

export interface ClaimConflict {
  left: Claim;
  right: Claim;
}
