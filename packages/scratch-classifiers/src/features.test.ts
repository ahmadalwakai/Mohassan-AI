import { describe, expect, it } from 'vitest';
import { featureIndices, featureSets, normalize } from './features.js';

describe('scratch classifier normalization', () => {
  it('folds Arabic presentation forms, letters, marks, digits and punctuation', () => {
    expect(normalize('أَخْبَارُ ﻣِـصْرَ ٢٠٢٦؟')).toBe('اخبار مصر 2026 ?');
    expect(normalize('أإآٱ ىیئ ةؤک ۰۱۲۳۴۵۶۷۸۹')).toBe('اااا ييي هوك 0123456789');
    expect(normalize('٣٫٥٪')).toBe('3 . 5 %');
  });

  it('folds numeral-based Arabizi and preserves ordinary numbers and short identifiers', () => {
    expect(normalize('3ayez ma3lesh 7abibi 6’areef')).toBe('عايز معلش حبيبي ظريف');
    expect(normalize('H2O B2B v2beta 3pm 12:30 ٢٠٢٦')).toBe('h2o b2b v2beta 3pm 12 : 30 2026');
    expect(featureIndices('7abibi', 32768)).toEqual(featureIndices('حبيبي', 32768));
  });

  it('bounds raw input and normalized output by Unicode code point', () => {
    // Deseret letters occupy two UTF-16 code units and lowercase to supplementary letters.
    expect(normalize('𐐀'.repeat(513))).toBe('𐐨'.repeat(512));
    expect(normalize('🙂'.repeat(2048) + 'hello')).toBe('');
    expect(normalize('🙂'.repeat(2047) + 'a')).toBe('a');
  });
});

describe('scratch classifier features', () => {
  // Validate the namespaces and grammar with independent, explicit n-gram lists.
  function featureId(namespace: number, gram: string): number {
    let hash = Math.imul(0x811c9dc5 ^ namespace, 0x01000193);
    for (const character of gram) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193);
    return hash >>> 0;
  }

  it('emits character 2–5 grams and word 1–2 grams as binary features', () => {
    const charGrams = ['^a', '^a ', '^a b', '^a b$', 'a ', 'a b', 'a b$', ' b', ' b$', 'b$'];
    const wordGrams = ['a', 'b', 'a b'];
    expect(featureIndices('A b', 2 ** 32)).toEqual([
      ...charGrams.map(gram => featureId(1, gram)),
      ...wordGrams.map(gram => featureId(2, gram)),
    ]);
    expect(featureIndices('aaa aaa', 1)).toEqual([0]);
  });

  it('adds separate conversation features only when prior text is available', () => {
    const size = 2 ** 32;
    const current = featureIndices('a b c', size);
    const history = featureIndices('a b c', size, 'a d e');
    expect(featureSets('a b c', size, 'a d e')).toEqual({ current, withContext: history });
    expect(history.slice(0, current.length)).toEqual(current);
    expect(history).toContain(featureId(3, '^a'));
    expect(history).toContain(featureId(4, 'a d'));
    expect(history.at(-1)).toBe(featureId(5, '\u0001'));
    expect(featureIndices('a b c', size, '🙂')).toEqual(current);
    expect(featureIndices('🙂', size, 'a b c')).toEqual([]);
  });
});
