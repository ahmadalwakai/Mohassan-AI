import type { CodeKnowledge } from './answer.js';
import type { CodeAnswer } from './types.js';

export interface CodeKnowledgeShadowEvent {
  caseId?: string;
  answer: CodeAnswer;
}

export function createCodeKnowledgeShadow(
  answerer: CodeKnowledge | undefined,
  log: (event: CodeKnowledgeShadowEvent) => void,
) {
  return {
    observe(question: string, context: { caseId?: string } = {}): CodeAnswer | undefined {
      if (!answerer) return undefined;
      const answer = answerer.answer(question);
      // The event contains source excerpts and an optional opaque replay ID.
      // Raw questions and pasted stack traces never enter the shadow record.
      log({ caseId: context.caseId, answer });
      return answer;
    },
  };
}
