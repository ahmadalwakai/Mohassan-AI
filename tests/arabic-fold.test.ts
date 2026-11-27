import { describe, expect, it } from 'vitest';
import { foldArabicForMatch, preserveArabicForDisplay } from '../apps/server/src/assistant/arabic-fold.js';

// Character properties and decompositions come from UnicodeData, retrieved 2026-11-27.
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
describe('Arabic folding', () => {
  it.each([
    ['alef variants', 'أ إ آ ٱ', 'ا ا ا ا'],
    ['canonical Arabic decompositions', 'ا\u0653 ا\u0654 ا\u0655 و\u0654 ي\u0654', 'ا ا ا و ي'],
    ['waw and yeh with hamza', 'مُؤسِّس سُئِل ء', 'موسس سيل ء'],
    ['Persian yeh and kaf', 'یکی', 'يكي'],
    ['word-final teh marbuta and alef maksura', 'الجمعة،على', 'الجمعه،علي'],
    ['teh marbuta and alef maksura inside a word', 'ةب ىب', 'ةب ىب'],
    ['tatweel and marks in multiple Arabic blocks', 'سَـلَام\u0610\u065F\u06ED\u08F0', 'سلام'],
    ['canonical Latin composition', 'Cafe\u0301', 'Café'],
    ['compatibility distinctions', '② m²', '② m²'],
  ])('folds %s for matching', (_label, text, expected) => {
    expect(foldArabicForMatch(text)).toBe(expected);
  });

  it.each([
    '٠١٢٣٤٥٦٧٨٩',
    '۰۱۲۳۴۵۶۷۸۹',
    '٢٬٥٠٠٫٧٥٪',
    '\u066D\u066E\u066F\u06DD\u06DE',
  ])('preserves digits, punctuation and other non-marks in %s', text => {
    expect(foldArabicForMatch(text)).toBe(text);
  });

  it('preserves the original code points for display', () => {
    const text = ' عِيَار ٢١: ٢٬٥٠٠٫٧٥٪ ـ ا\u0654على کُرْسِی Café\u0300 ';
    expect(preserveArabicForDisplay(text)).toBe(text);
  });
});
