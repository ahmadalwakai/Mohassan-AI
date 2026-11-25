import { describe, expect, it } from 'vitest';
import { formatNumberWords, parseNumberWords, reasonNumberWords } from '../apps/server/src/assistant/reasoning/number-words.js';

describe('deterministic number words', () => {
  it.each(['ar', 'en'] as const)('round trips every three-digit group in %s', lang => {
    for (let value = 0; value < 1000; value++) {
      const integer = String(value);
      const words = formatNumberWords(integer, lang);
      expect(words).not.toBeNull();
      expect(parseNumberWords(words!, lang)).toBe(integer);
    }
  });

  it.each(['ar', 'en'] as const)('preserves exact grouped decimal digits in %s', lang => {
    const words = formatNumberWords('−999٬999٬999٬999٬999٫123456789101112', lang);
    expect(words).not.toBeNull();
    expect(parseNumberWords(words!, lang)).toBe('-999999999999999.123456789101112');
  });

  it.each(['1,00', '1000,001', '1,000٬001', '1e5', '1.0000000000000001', '1000000000000000'])('rejects invalid or unsupported digits %s', value => {
    expect(formatNumberWords(value, 'en')).toBeNull();
  });

  it.each(['one one', 'twenty ten', 'one zero hundred', 'one thousand million', 'one hundred and', 'one point ten'])('rejects invalid words %s', value => {
    expect(parseNumberWords(value, 'en')).toBeNull();
  });

  it.each(['واحد واحد', 'ألف ألفان', 'مليونين مليون', 'ثلاثة مليونان', 'خمسمائة و', 'واحد فاصلة مليون'])('rejects invalid words %s', value => {
    expect(parseNumberWords(value, 'ar')).toBeNull();
  });

  it('declares a gap for a malformed explicit request and leaves unrelated text alone', () => {
    const result = reasonNumberWords('Write 1,00 in words', 'en');
    expect(result?.status).toBe('blocked');
    expect(result?.claims[0]?.status).toBe('not_found');
    expect(reasonNumberWords('one', 'en')).toBeNull();
    expect(reasonNumberWords('ممكن تساعدني؟', 'ar')).toBeNull();
    expect(reasonNumberWords('quote “write 21 in words”', 'en')).toBeNull();
  });
});
