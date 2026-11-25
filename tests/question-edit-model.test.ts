import { describe, expect, it } from 'vitest';
import { QUESTION_EDIT_DIMENSIONS, questionEditCandidates } from '../apps/server/src/assistant/question-edit-candidates.ts';
import { predictQuestionEdit, rankQuestionEdits } from '../apps/server/src/assistant/question-edit-model.ts';

const history = {
  articleTitle: 'Mina Faraday',
  sectionTitle: 'Southgarden Observatory',
  turns: [{
    question: 'What expedition was proposed by Saul Northbridge?',
    answer: 'Mina Faraday proposed the Copper Valley Survey.',
  }],
};

describe('learned question edits', () => {
  it('offers a no-edit candidate, a title copy, and a name copied from an earlier question', () => {
    const question = 'In which district did she place the telescope lens?';
    const candidates = questionEditCandidates(question, history);
    expect(candidates[0]?.text).toBe(question);
    expect(candidates.map(candidate => candidate.text)).toContain('In which district did Mina Faraday place the telescope lens?');
    expect(candidates.map(candidate => candidate.text)).toContain('In which district did Saul Northbridge place the telescope lens?');
  });

  it('offers a possessive copy from the section title without rewriting words inside a quotation', () => {
    const question = 'Does its telescope handbook cite "Their Study of Clear Glass"?';
    const candidates = questionEditCandidates(question, history);
    expect(candidates.map(candidate => candidate.text)).toContain('Does Southgarden Observatory\'s telescope handbook cite "Their Study of Clear Glass"?');
    expect(candidates.every(candidate => candidate.text.includes('"Their Study of Clear Glass"'))).toBe(true);
  });

  it('keeps quoted references unchanged when a candidate replaces repeated pronouns', () => {
    const candidates = questionEditCandidates('Which notebooks did she cite when her paper quoted "Her October Ledger"?', history);
    expect(candidates.map(candidate => candidate.text)).toContain('Which notebooks did Mina Faraday cite when Mina Faraday\'s paper quoted "Her October Ledger"?');
    expect(candidates.every(candidate => candidate.text.includes('"Her October Ledger"'))).toBe(true);
  });

  it('keeps parentheses balanced when copying the full article title', () => {
    const candidates = questionEditCandidates('Who first restored it to working order?', { ...history, articleTitle: 'Northgate (telescope)' });
    expect(candidates.map(candidate => candidate.text)).toContain('Who first restored Northgate (telescope) to working order?');
  });

  it('ranks tied candidates deterministically in generation order and abstains on an unchanged winner', () => {
    const question = 'How long did she operate the mountain transit telescope?';
    const weights = new Float64Array(QUESTION_EDIT_DIMENSIONS);
    expect(rankQuestionEdits(questionEditCandidates(question, history), weights)).toEqual({ text: question, margin: 0 });
    expect(predictQuestionEdit(question, history, weights)).toBeNull();
  });

  it('leaves Arabic and multi-question input to the existing paths', () => {
    expect(predictQuestionEdit('أين عرضت مرآتها الفلكية؟', history)).toBeNull();
    expect(predictQuestionEdit('Did she list any star charts? Which atlases were available?', history)).toBeNull();
  });
});
