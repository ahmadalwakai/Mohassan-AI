import { describe, expect, it } from 'vitest';
import { isFollowUp, refersBack, tidy, webQuestion, withTopic } from '../apps/server/src/assistant/hands.js';

/** Phase 4 (plan §9): a pronoun follow-up asks about the thing the last answer named. */
describe('follow-ups that point back at the last answer', () => {
  it('recognises the pointer forms in both languages', () => {
    for (const text of ['وكم عدد سكانها؟', 'وكم سعره في مصر؟', 'ومن أسسها؟', 'what is its population', 'when was it founded']) {
      expect(isFollowUp(tidy(text)), text).toBe(true);
      expect(refersBack(tidy(text)), text).toBe(true);
    }
    for (const text of ['what about Paris', 'وفي الأردن؟', 'ما عاصمة اليابان؟']) expect(refersBack(tidy(text)), text).toBe(false);
  });

  it('joins the named entity to the pronoun question', () => {
    expect(withTopic(tidy('وكم عدد سكانها؟'), ['طوكيو'])).toBe('كم عدد سكانها طوكيو');
    expect(withTopic(tidy('ومن أسسها؟'), ['جامعة الملك سعود'])).toBe('من أسسها جامعة الملك سعود');
    expect(webQuestion('وكم سعره في مصر؟', ['الذهب'])?.[0]).toMatchObject({ kind: 'search', query: 'كم سعره في مصر الذهب', ask: true });
    // The question-based path still carries the earlier question's topic when no entity is known.
    expect(webQuestion('وكم عدد سكانها؟', ['ما عاصمة اليابان؟'])?.[0]).toMatchObject({ query: 'كم عدد سكانها عاصمة اليابان' });
  });
});
