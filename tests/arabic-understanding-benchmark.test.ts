import { describe, expect, it } from 'vitest';
import { isReasonQuestion } from '../apps/server/src/assistant/answer-check.js';
import { explainedQuestion } from '../apps/server/src/assistant/hands.js';
import type { AnswerType } from '../apps/server/src/assistant/mind/contract.js';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';
import { splitReplyDirective } from '../apps/server/src/assistant/reply-directive.js';
import { requestActionText } from '../apps/server/src/assistant/request-context.js';
import { assessRequestScope, requestScopeActionText } from '../apps/server/src/assistant/request-scope.js';
import { understandRequest, type QuestionShape } from '../apps/server/src/assistant/understanding/index.js';
import { developmentQuestions, type QuestionGroup } from './fixtures/arabic-understanding-development.js';
import { documentedRequests } from './fixtures/arabic-understanding-documented.js';

type ExpectedAnswer = QuestionShape['answerType'];
const legacyAnswerTypes: Record<AnswerType, ExpectedAnswer | null> = {
  date: 'time',
  number: 'quantity',
  money: 'quantity',
  name: 'person',
  place: 'place',
  yes_no: 'yes/no',
  definition: 'definition',
  list: 'list',
  steps: 'method',
  text: null,
};

function legacyPrediction(text: string) {
  const action = requestActionText(requestScopeActionText(text));
  const frame = buildFrame(action);
  const scope = assessRequestScope(text);
  const framed = splitReplyDirective(action);
  const body = framed.directive ? framed.body : action;
  const explained = explainedQuestion(body);
  // Count the old frame's punctuation fallback and the scope parser's known question leads.
  // The old code exposes no structured question word.
  const isQuestion = frame.matched.some(({ rule }) => rule === 'question-shape' || rule === 'question-with-address')
    || scope.reasons.includes('public_subject') || explained !== body;
  const answerType = isReasonQuestion(explained) ? 'reason' : frame.answerType && legacyAnswerTypes[frame.answerType];
  return { isQuestion, answerType };
}

describe('Arabic understanding agent-written development cases', () => {
  it.each(developmentQuestions)('$group · $text', ({ text, questionWord, answerType }) => {
    const understanding = understandRequest(text);
    expect(understanding.displayText).toBe(text);
    const question = understanding.question;
    if (answerType === null) {
      expect(question).toBeNull();
      return;
    }
    expect(question).toMatchObject({ questionWord, answerType });
    expect(question?.corePhrase.trim()).not.toBe('');
  });

  it('reports comparable question detection and answer-type scores by group', () => {
    expect(new Set(developmentQuestions.map(({ text }) => text)).size).toBe(developmentQuestions.length);
    expect(developmentQuestions.filter(row => row.answerType !== null)).toHaveLength(432);
    const groups = [...new Set(developmentQuestions.map(({ group }) => group))];
    expect(groups).toHaveLength(8);
    const percent = (correct: number, total: number) => `${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`;
    const stats = (group: QuestionGroup) => {
      const rows = developmentQuestions.filter(row => row.group === group);
      let legacyShape = 0, newShape = 0, legacyAnswer = 0, newAnswer = 0, newWord = 0, questions = 0;
      for (const row of rows) {
        const prior = legacyPrediction(row.text);
        const next = understandRequest(row.text).question;
        const isQuestion = row.answerType !== null;
        if (prior.isQuestion === isQuestion) legacyShape++;
        if ((next !== null) === isQuestion) newShape++;
        if (!isQuestion) continue;
        questions++;
        if (prior.answerType === row.answerType) legacyAnswer++;
        if (next?.answerType === row.answerType) newAnswer++;
        if (next?.questionWord === row.questionWord) newWord++;
      }
      expect(questions).toBeGreaterThanOrEqual(50);
      return {
        group,
        'legacy question detection': percent(legacyShape, rows.length),
        'new question detection': percent(newShape, rows.length),
        'legacy answer type': percent(legacyAnswer, questions),
        'new answer type': percent(newAnswer, questions),
        'new question word': percent(newWord, questions),
      };
    };
    console.table(groups.map(stats));
  });
});

describe('requests quoted in the November 22 and 23 reports', () => {
  it.each(documentedRequests)('$source · $text', ({ text, expected }) => {
    const understanding = understandRequest(text);
    expect(understanding.displayText).toBe(text);
    expect(understanding.matchText).not.toBe('');
    // Source failures also include downstream retrieval, answer selection, printing, and planning.
    // Where an expected question is annotated, this check covers the understanding step.
    if (expected === null) expect(understanding.question).toBeNull();
    else if (expected) expect(understanding.question).toMatchObject(expected);
  });
});
