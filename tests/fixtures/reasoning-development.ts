import type { ReasoningContext } from '../../apps/server/src/assistant/reasoning/index.js';

export type DevelopmentCategory = 'comparison' | 'calendar' | 'currency' | 'word-problem' | 'number-words';

export interface DevelopmentCase {
  id: string;
  category: DevelopmentCategory;
  request: string;
  expected: string | null;
  status?: 'completed' | 'blocked';
  options?: ReasoningContext;
}

/** Fixed UTC clock shared by the deterministic development checks. */
export const developmentNow = new Date('2025-02-20T12:00:00Z');
