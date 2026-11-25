import { setImmediate } from 'node:timers/promises';
import {
  extractStructuredEvidence,
  type StructuredEvidenceOptions,
  type StructuredEvidencePage,
  type StructuredEvidenceResult,
  type StructuredEvidenceTarget,
} from './structured-evidence.js';

export interface StructuredEvidenceShadowInput {
  readonly conversationId?: string;
  readonly runId?: string;
  readonly answer: string;
  readonly target: StructuredEvidenceTarget;
  readonly pages: readonly StructuredEvidencePage[];
  readonly options?: StructuredEvidenceOptions;
}

export interface StructuredEvidenceShadowReport {
  at: string;
  conversationId?: string;
  runId?: string;
  answer: string;
  target: StructuredEvidenceTarget;
  result: StructuredEvidenceResult;
}

export interface StructuredEvidenceShadow {
  /** Queues one comparison for the supplied answer and read pages. */
  observe(input: StructuredEvidenceShadowInput): void;
  /** Waits until the comparisons queued so far have finished. */
  flush(): Promise<void>;
}

export function createStructuredEvidenceShadow(options: {
  log: (report: StructuredEvidenceShadowReport) => void | Promise<void>;
  now?: () => Date;
}): StructuredEvidenceShadow {
  const now = options.now ?? (() => new Date());
  let queue = Promise.resolve();
  return {
    observe(input) {
      try {
        const at = now().toISOString();
        const { conversationId, runId, answer, target, pages, options: extractionOptions } = input;
        queue = queue.then(async () => {
          await setImmediate();
          const result = extractStructuredEvidence(target, pages, { ...extractionOptions, now: extractionOptions?.now ?? at });
          await options.log({ at, conversationId, runId, answer, target, result });
        }).catch(() => { /* Shadow failures stay outside the answer path. */ });
      } catch { /* A broken observation must not affect the answer. */ }
    },
    flush: () => queue,
  };
}
