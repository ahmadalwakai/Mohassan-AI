import { setImmediate } from 'node:timers/promises';
import { createKnowledgeQa } from './qa.ts';
import type { KnowledgeAnswer, KnowledgeSnapshot } from './qa-types.ts';
import type { Language } from './types.ts';

export interface KnowledgeQaObservation {
  /** Supply a factual question approved for the caller's log. */
  question: string;
  /** Supply the current answer, redacted if needed for that log. */
  answer: string;
  runId?: string;
  language?: Language;
}

export interface KnowledgeQaShadowReport extends KnowledgeQaObservation {
  at: string;
  snapshot: KnowledgeSnapshot;
  result: KnowledgeAnswer | { status: 'error' };
}

/** Explicit, read-only comparison. Neither an evaluation nor a log failure affects the current answer. */
export function createKnowledgeQaShadow(options: {
  knowledge: Parameters<typeof createKnowledgeQa>[0];
  log: (report: KnowledgeQaShadowReport) => void | Promise<void>;
  now?: () => Date;
}): { observe(input: KnowledgeQaObservation): void; flush(): Promise<void> } {
  const { knowledge, log } = options;
  const qa = createKnowledgeQa(knowledge);
  const now = options.now ?? (() => new Date());
  const { dataset, source: dumpSource, dumpDate, fingerprint, license } = knowledge.card;
  const snapshot = { dataset, dumpSource, dumpDate, fingerprint, license };
  let queue = Promise.resolve();
  return {
    observe(input) {
      let at: string;
      try { at = now().toISOString(); } catch { return; }
      const observation = { ...input };
      queue = queue.then(async () => {
        await setImmediate();
        let result: KnowledgeQaShadowReport['result'];
        try {
          result = qa.answer(observation.question, { language: observation.language });
        } catch {
          result = { status: 'error' };
        }
        await log({ ...observation, at, snapshot, result });
      }).catch(() => { /* The caller's log sink is independent from the answer path. */ });
    },
    flush: () => queue,
  };
}
