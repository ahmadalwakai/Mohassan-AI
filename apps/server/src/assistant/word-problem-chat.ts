import type { LocalComputation } from './local-computation.js';

export function blockAbstainedWordProblem(computation: LocalComputation, finish: (text: string, status: 'blocked') => Promise<void>): Promise<void> | null {
  return computation.abstained ? finish(computation.text, 'blocked') : null;
}
