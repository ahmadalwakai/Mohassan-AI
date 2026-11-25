import { describe, expect, it } from 'vitest';
import { rewriteFollowUpQuestion } from '../apps/server/src/assistant/question-rewriter.js';

describe('standalone question rewriting', () => {
  it('uses the article subject for a personal pronoun and keeps the rest of the question', () => {
    expect(rewriteFollowUpQuestion('Where did he learn bookbinding?', {
      articleTitle: 'Owen Pike (bookbinder)',
      sectionTitle: 'Workshop training',
      turns: [{ question: 'Did he work in a shop?' }],
    })).toBe('Where did Owen Pike learn bookbinding?');
  });

  it('introduces a possessive antecedent once and keeps its later local pronoun', () => {
    expect(rewriteFollowUpQuestion('Did her sister teach her glassblowing?', {
      articleTitle: 'Rowan Keene', turns: [],
    })).toBe("Did Rowan Keene's sister teach her glassblowing?");
    expect(rewriteFollowUpQuestion('Did Rowan Keene meet her apprentice?', {
      articleTitle: 'Rowan Keene', turns: [],
    })).toBe('Did Rowan Keene meet her apprentice?');
  });

  it('finds a newly introduced person and a coordinated group in earlier questions', () => {
    expect(rewriteFollowUpQuestion('What instruments did she make?', {
      articleTitle: 'Sea Lantern Orchestra',
      turns: [{ question: 'Who was Amira Vale?' }],
    })).toBe('What instruments did Amira Vale make?');
    expect(rewriteFollowUpQuestion('What did they teach?', {
      turns: [{ question: 'Where did Noura and Alvin volunteer?' }],
    })).toBe('What did Noura and Alvin teach?');
  });

  it('copies a named entity from an earlier answer', () => {
    expect(rewriteFollowUpQuestion('When was it renovated?', {
      articleTitle: 'Riverfront planning',
      turns: [{ question: 'Which building did the committee visit?', answer: 'Linden Hall.' }],
    })).toBe('When was Linden Hall renovated?');
  });

  it('resolves a demonstrative to the section topic while preserving other wording', () => {
    expect(rewriteFollowUpQuestion('How did that start?', {
      articleTitle: 'Northbank', sectionTitle: 'The Lantern Exchange', turns: [],
    })).toBe('How did the Lantern Exchange start?');
  });

  it('restores an omitted question clause, object, motive and event', () => {
    expect(rewriteFollowUpQuestion('And what else?', {
      articleTitle: 'Rosa Linwood',
      turns: [{ question: 'What did she build at the observatory?' }],
    })).toBe('What else did Rosa Linwood build at the observatory?');
    expect(rewriteFollowUpQuestion('How?', {
      turns: [{ question: 'Which material did Elin carve?', answer: 'soapstone' }],
    })).toBe('How did Elin carve soapstone?');
    expect(rewriteFollowUpQuestion('Why?', {
      turns: [{ question: 'Did Kian delay the gallery opening?', answer: 'Yes.' }],
    })).toBe('Why did Kian delay the gallery opening?');
    expect(rewriteFollowUpQuestion('And after that?', {
      turns: [{ question: 'What happened before the rehearsal?', answer: 'a lighting drill' }],
    })).toBe('What happened after a lighting drill?');
  });

  it('keeps quoted words, complementizers, complete questions and unresolved references', () => {
    const history = { articleTitle: 'Dahlia Grey', turns: [] };
    expect(rewriteFollowUpQuestion('Who wrote "It"?', history)).toBe('Who wrote "It"?');
    expect(rewriteFollowUpQuestion('Did the reviewer say that the plot worked?', history))
      .toBe('Did the reviewer say that the plot worked?');
    expect(rewriteFollowUpQuestion('What is galena made of?', history)).toBe('What is galena made of?');
    expect(rewriteFollowUpQuestion('Who did she invite?', { turns: [] })).toBe('Who did she invite?');
    expect(rewriteFollowUpQuestion('Where is it? Can I go?', history)).toBe('Where is it? Can I go?');
  });
});

describe('standalone Arabic questions with hand-written examples', () => {
  const libraryHistory = { turns: [{ question: 'أين تقع مكتبة السرو؟' }] };

  it('resolves a possessive clitic, a direct object clitic and a prepositional clitic', () => {
    expect(rewriteFollowUpQuestion('وكم مساحتها؟', libraryHistory)).toBe('كم مساحة مكتبة السرو؟');
    expect(rewriteFollowUpQuestion('من أسسها؟', libraryHistory)).toBe('من أسس مكتبة السرو؟');
    expect(rewriteFollowUpQuestion('ماذا يوجد فيها؟', libraryHistory)).toBe('ماذا يوجد في مكتبة السرو؟');
  });

  it('uses a recently supplied answer as the referent and fills an omitted subject', () => {
    expect(rewriteFollowUpQuestion('وكم طوله؟', {
      turns: [{ question: 'ما أطول ممر في الحديقة؟', answer: 'ممر الأقحوان' }],
    })).toBe('كم طول ممر الأقحوان؟');
    expect(rewriteFollowUpQuestion('متى افتتحت؟', libraryHistory)).toBe('متى افتتحت مكتبة السرو؟');
  });

  it('fills an omitted clause and resolves a standalone demonstrative', () => {
    expect(rewriteFollowUpQuestion('ولماذا؟', {
      turns: [{ question: 'هل سافرت ليان إلى الميناء؟', answer: 'نعم' }],
    })).toBe('لماذا سافرت ليان إلى الميناء؟');
    expect(rewriteFollowUpQuestion('ماذا حدث بعد ذلك؟', {
      sectionTitle: 'افتتاح المعرض', turns: [],
    })).toBe('ماذا حدث بعد افتتاح المعرض؟');
  });

  it('preserves a complete question and avoids inventing an antecedent', () => {
    expect(rewriteFollowUpQuestion('ما هي مكتبة السرو؟', libraryHistory)).toBe('ما هي مكتبة السرو؟');
    expect(rewriteFollowUpQuestion('كم طوله؟', { turns: [] })).toBe('كم طوله؟');
  });
});
