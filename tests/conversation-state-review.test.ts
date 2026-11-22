import { describe, expect, it } from 'vitest';
import { mcnemarExact, parseAnswers, parseSheet, parseVerdict, sameQuery, scoreReview } from '../scripts/conversation-state/review-format.js';

// The owner's verdicts are the only independent measure of conversation state v2, so the reader of those verdicts is tested.
describe('conversation state review: reading the owner\'s verdicts', () => {
  it('reads the four verdict words and nothing else', () => {
    expect(parseVerdict('v2')).toBe('v2');
    expect(parseVerdict(' V1 ')).toBe('v1');
    expect(parseVerdict('كلاهما')).toBe('both');
    expect(parseVerdict('لا أحد')).toBe('neither');
    expect(parseVerdict('الجديد')).toBe('v2');
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict('ربما')).toBeNull();
    expect(parseVerdict('v1 v2')).toBeNull();
  });

  it('reads «الحكم:» lines under their numbered headings and skips the empty ones', () => {
    const sheet = ['# مراجعة', '', '### 1', '**رسالتك:** «تابع»', 'الحكم: [v2]', '', '### 2', 'الحكم: [ ]', '', '### 3', 'الحكم: كلاهما', '',
      '### 4', 'الحكم: [لا أحد]'].join('\n');
    expect([...parseSheet(sheet)]).toEqual([[1, 'v2'], [3, 'both'], [4, 'neither']]);
    expect(parseSheet('### 1\r\nالحكم: [v1]\r\n').get(1)).toBe('v1');
  });

  it('reads verdicts sent in chat, with Arabic digits and either comma', () => {
    const answers = parseAnswers('1 v2، 2 كلاهما، ٣: v1; 4 لا أحد\n5 ربما');
    expect([...answers]).toEqual([[1, 'v2'], [2, 'both'], [3, 'v1'], [4, 'neither']]);
  });

  it('scores the verdicts and tests the discordant ones exactly', () => {
    const verdicts = parseAnswers('1 v2، 2 v2، 3 v2، 4 v2، 5 v2، 6 كلاهما');
    const score = scoreReview(10, verdicts);
    expect(score).toMatchObject({ items: 10, answered: 6, v2Right: 6, v1Right: 1, mcnemar: { b: 5, c: 0 } });
    expect(score.mcnemar.p).toBeCloseTo(0.0625, 6);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it('compares search queries after folding and punctuation', () => {
    expect(sameQuery('ما عاصمة اليابان؟', 'ما عاصمة اليابان')).toBe(true);
    expect(sameQuery(null, null)).toBe(true);
    expect(sameQuery('x', null)).toBe(false);
    expect(sameQuery('عدد سكان طوكيو', 'عدد سكان اليابان')).toBe(false);
  });
});
