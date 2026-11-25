import { describe, expect, it } from 'vitest';
import { lemmaKeys, requestTerms, skillStems } from '../packages/skills/src/stems.ts';

// Agent-written development cases for deterministic regressions. Never used as training data.
describe('Arabic lemma keys', () => {
  it.each([
    ['استقلّت، استقلالها والاستقلال', ['استقلال']],
    ['استقلوا فنستقل وباستقلالهم', ['استقلال']],
    ['استخدمت وتستخدمون لاستخدامكما', ['استخدام']],
    ['الإعلان أعلنت وإعلاناته', ['اعلان']],
    ['مقالة، مقالاتها والمقالات مقالك', ['مقال']],
    ['اللّغة لغتي ولغاتهم', ['لغه']],
    ['عاصمة عاصمتها والعواصم', ['عاصمه']],
    ['لا، كيف؟ Bookings and BOOK ۱۲', ['bookings', 'book', '12']],
    ['وصف مُستقلّة استقرارها', ['وصف', 'مستقل', 'استقرار']],
  ])('reads the content keys in %s', (text, expected) => {
    expect(lemmaKeys(text)).toEqual(expected);
  });

  it('leaves the skill reader and router on the light stemming rules', () => {
    expect(skillStems('استقلت واستقلالها')).toEqual(['استقلت', 'واستقلال']);
    expect(requestTerms('استقلت واستقلالها')).toEqual([
      { word: 'استقلت', variants: ['استقلت'] },
      { word: 'واستقلالها', variants: ['واستقلال', 'استقلال'] },
    ]);
  });
});
