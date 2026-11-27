import { isDisambiguationPage, isMetaLine } from './answer-check.js';
import { inspectEventDateLine, type EventDateQuestion } from './event-date.js';
import { passageSentences } from './factual-evidence.js';
import { isOwnArticle, topicWords } from './hands.js';
import type { JudgeEvidence } from './judge.js';

/** Find a dated event in the read pages that explains an abstention, unless a bound date was also read. */
export function wrongEventDateEvidence(question: EventDateQuestion, evidence: readonly JudgeEvidence[] = []): string | undefined {
  const subject = topicWords(question.subject);
  let wrong: string | undefined;
  for (const item of evidence) {
    if (item.kind !== 'page' || isDisambiguationPage({ title: item.title ?? '', text: item.text })) continue;
    const titled = item.title ? isOwnArticle(item.title, subject) : false;
    for (const sentence of passageSentences(item.text)) {
      if (isMetaLine(sentence) || /[?؟]$/u.test(sentence)) continue;
      const { date, hasDate, hasEvent, hasSubject } = inspectEventDateLine(question, sentence, item.title);
      if (date) return;
      if (!wrong && hasDate && hasEvent && (hasSubject || titled)) wrong = sentence;
    }
  }
  return wrong;
}
