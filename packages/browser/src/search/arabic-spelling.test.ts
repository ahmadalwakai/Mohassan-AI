import { describe, expect, it } from 'vitest';
import { compileQuery, rankResults } from './ranking.js';

function rank(question: string, title: string, snippet = '') {
  return rankResults(compileQuery(question), [{
    provider: 'fixture', hits: [{ title, snippet, url: 'https://example.org/article' }],
  }], 5);
}

describe('Arabic search spelling', () => {
  it.each([
    ['ما عاصمه استراليا', 'كانبرا هي عاصمة أستراليا'],
    ['ما عاصمة أستراليا', 'كانبرا هي عاصمه استراليا'],
    ['مستشفي', 'مستشفى'],
    ['مستشفى', 'مستشفي'],
  ])('matches %s against %s and returns the original title', (question, title) => {
    expect(rank(question, title)[0]?.title).toBe(title);
    expect(compileQuery(question).retrievalQuestion).toBe(question);
  });

  it.each([
    ['"زيارة مستشفى"', 'زِياره، مستشفي'],
    ['"زياره مستشفي"', 'زِيارة، مستشفى'],
  ])('matches a contiguous quote %s in the original snippet', (question, snippet) => {
    expect(rank(question, 'دليل', snippet)[0]?.snippet).toBe(snippet);
    expect(rank(question, 'دليل', snippet.replace('، ', '، إلى أقرب '))).toEqual([]);
  });

  it('keeps internal letters distinct and folds an ending before an attached number', () => {
    for (const [word, letter, alternate] of [['مهرجان', 'ه', 'ة'], ['مدينة', 'ي', 'ى']] as const) {
      expect(rank(word, word.replace(letter, alternate))).toEqual([]);
    }
    expect(rank('سنه١٩٨٠', 'سنة١٩٨٠')).toHaveLength(1);
  });

  it('keeps the name علي and does not count the preposition على as a name match', () => {
    expect(compileQuery('علي بن أبي طالب').tokens).toContain('علي');
    expect(compileQuery('على الموقع').tokens).toEqual(['موقع']);
    expect(rank('علي بن أبي طالب', 'علي بن أبي طالب')).toHaveLength(1);
    expect(rank('علي طالب', 'معلومات على طالب')).toEqual([]);
  });

  it('recognizes a leading informal متي in a question and keeps quoted names', () => {
    expect(compileQuery('متي تأسس اليوتوب؟').tokens).toEqual(compileQuery('متى تأسس اليوتوب؟').tokens);
    expect(rank('متي تأسس اليوتوب؟', 'تأسس اليوتوب')).toHaveLength(1);
    expect(compileQuery('متي المسكين').tokens).toContain('متي');
    expect(compileQuery('متي المسكين؟').tokens).toContain('متي');
    expect(compileQuery('"متي المسكين" مؤلفاته؟').tokens).toContain('متي');
  });
});
