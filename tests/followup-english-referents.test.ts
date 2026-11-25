import { describe, expect, it } from 'vitest';
import { rewriteFollowUpQuestion } from '../apps/server/src/assistant/question-rewriter.js';

describe('English follow-ups with an ambiguous referent', () => {
  it('prefers an answer subject that carries the repeated predicate', () => {
    const history = {
      articleTitle: 'Nina Bell',
      turns: [{ question: 'What happened at the workshop?', answer: 'Writer Tom Vale presented a new edition.' }],
    };
    const question = 'When did he present the new edition?';
    expect(rewriteFollowUpQuestion(question, history, true)).toBe('When did Tom Vale present the new edition?');
    expect(rewriteFollowUpQuestion(question, history, false)).toBe('When did Nina Bell present the new edition?');
  });

  it('keeps the relation when the answer introduces a family member', () => {
    const history = {
      articleTitle: 'Lina Reed',
      turns: [{ question: 'Where did she learn to draw?', answer: 'Her brother instructed her at home.' }],
    };
    expect(rewriteFollowUpQuestion('When did he instruct her?', history, true))
      .toBe("When did Lina Reed's brother instruct Lina Reed?");
  });

  it('distinguishes the actor from a group that occurs under the same preposition', () => {
    const history = {
      articleTitle: 'Jon Finch',
      turns: [{ question: 'What did Jon Finch build?', answer: 'He built a sailboat with Ada Cole and Vera Lowe.' }],
    };
    expect(rewriteFollowUpQuestion('Did he race with them?', history, true))
      .toBe('Did Jon Finch race with Ada Cole and Vera Lowe?');

    const other = { ...history, turns: [{ question: 'Where did he work?', answer: 'He worked for the Foxes.' }] };
    expect(rewriteFollowUpQuestion('Did he play for them?', other, true)).toBe('Did Jon Finch play for the Foxes?');
  });

  it('retains two people when the previous exchange describes their relationship', () => {
    const history = { articleTitle: 'Clara Hyde', sectionTitle: 'Dean Hale', turns: [
      { question: 'Who was Dean?', answer: 'Dean Hale was a painter.' },
      { question: 'How long were they together?', answer: 'They dated for three years.' },
    ] };
    expect(rewriteFollowUpQuestion('Did they share a studio?', history, true)).toBe('Did Clara Hyde and Dean Hale share a studio?');
  });

  it('uses a named work after the transcript establishes its type', () => {
    const history = { articleTitle: 'The Birch Company', sectionTitle: 'Glass Hour: First Light', turns: [
      { question: 'What was Glass Hour: First Light?', answer: 'It was a film.' },
      { question: 'Was the film popular?', answer: 'It made a small profit.' },
    ] };
    expect(rewriteFollowUpQuestion('When was it made?', history, true)).toBe('When was Glass Hour: First Light made?');
  });

  it('distinguishes a standalone demonstrative from a cleft or a determiner', () => {
    const history = { articleTitle: 'Oak Hall', turns: [{ question: 'What was Oak Hall?', answer: 'A restored town hall.' }] };
    expect(rewriteFollowUpQuestion('Did that upset visitors?', history, true)).toBe('Did Oak Hall upset visitors?');
    expect(rewriteFollowUpQuestion('What was it about the budget that caught attention?', history, true))
      .toBe('What was it about the budget that caught attention?');
    expect(rewriteFollowUpQuestion('Did that other team win?', history, true)).toBe('Did that other team win?');
  });
});
