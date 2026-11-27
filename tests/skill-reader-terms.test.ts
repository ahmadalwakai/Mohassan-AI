import { describe, expect, it } from 'vitest';
import { readerEvidenceTerms } from '../packages/skills/src/reader-terms.ts';
import { arabicBase, arabicStem, englishStem, foldText, requestTerms } from '../packages/skills/src/stems.ts';

describe('skill reader normalization', () => {
  // Apache Lucene character and word cases, retrieved 2026-11-27.
  // https://raw.githubusercontent.com/apache/lucene/main/lucene/analysis/common/src/test/org/apache/lucene/analysis/ar/TestArabicNormalizationFilter.java
  it.each([
    ['alef with madda', 'آجن', 'اجن'],
    ['alef with hamza above', 'أحمد', 'احمد'],
    ['alef with hamza below', 'إعاذ', 'اعاذ'],
    ['alef maqsura', 'بنى', 'بني'],
    ['taa marbuta', 'فاطمة', 'فاطمه'],
    ['tatweel', 'روبرـــــت', 'روبرت'],
  ])('folds %s', (_rule, input, expected) => {
    expect(foldText(input)).toBe(expected);
    expect(foldText(input.normalize('NFD'))).toBe(expected);
  });

  // CAMeL Tools alef wasla and Lucene Farsi yeh, retrieved 2026-11-27.
  // https://raw.githubusercontent.com/CAMeL-Lab/camel_tools/master/camel_tools/utils/normalize.py
  // https://raw.githubusercontent.com/apache/lucene/main/lucene/analysis/common/src/java/org/apache/lucene/analysis/fa/PersianNormalizer.java
  it.each([['ٱ', 'ا'], ['ی', 'ي']])('folds %s to %s', (input, expected) => {
    expect(foldText(input)).toBe(expected);
  });

  // Arabic vowel signs, annotations and decimal digits from the Unicode code chart, retrieved 2026-11-27.
  // https://www.unicode.org/Public/18.0.0/charts/nameslist/0600/
  it.each([
    ['Arabic honorifics and small marks', 0x0610, 0x061a],
    ['harakat and extended marks', 0x064b, 0x065f],
    ['superscript alef', 0x0670, 0x0670],
    ['Quranic annotations', 0x06d6, 0x06ed],
  ] as const)('removes %s', (_rule, first, last) => {
    const word = 'روبرت';
    for (let codePoint = first; codePoint <= last; codePoint++) {
      const input = word.slice(0, 1) + String.fromCodePoint(codePoint) + word.slice(1);
      expect(foldText(input), `U+${codePoint.toString(16)}`).toBe(word);
    }
  });

  it.each([0x0660, 0x06f0])('folds decimal digits starting at code point %i', first => {
    for (let digit = 0; digit < 10; digit++) {
      expect(foldText(String.fromCodePoint(first + digit))).toBe(String(digit));
    }
  });

  // Unicode compatibility mapping FF21 → 0041 and the Basic Latin case pair, retrieved 2026-11-27.
  // https://www.unicode.org/Public/18.0.0/charts/nameslist/ff00/
  // https://www.unicode.org/Public/18.0.0/charts/nameslist/0000/
  it.each(['A', 'Ａ'])('folds Latin %s to lowercase ASCII', input => {
    expect(foldText(input)).toBe('a');
  });
});

describe('skill reader light stemming', () => {
  // Arabic affixes are from the repository's original rules, retrieved 2026-11-27.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/packages/skills/src/stems.ts
  // The stems حسن and ساهد are Apache Lucene test words, retrieved 2026-11-27.
  // https://raw.githubusercontent.com/apache/lucene/main/lucene/analysis/common/src/test/org/apache/lucene/analysis/ar/TestArabicStemFilter.java
  it.each(['وبال', 'فبال', 'وكال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ال'])('strips the Arabic article %s', article => {
    const stem = 'حسن';
    expect(arabicBase(article + stem)).toBe(stem);
    expect(arabicStem(article + stem)).toBe(stem);

    const shortWord = article + stem.slice(0, 2);
    expect(arabicBase(shortWord)).toBe(shortWord);
    expect(arabicStem(shortWord)).toBe(shortWord);
  });

  it.each(['يات', 'ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'هن', 'كم', 'نا', 'يه', 'ي', 'ه'])('strips the Arabic suffix %s', suffix => {
    const stem = 'ساهد';
    const word = stem + suffix;
    expect(arabicBase(word)).toBe(word);
    expect(arabicStem(word)).toBe(stem);
  });

  it('keeps a short word intact and strips at most one suffix', () => {
    const stem = 'ساهد';
    const shortWord = stem.slice(0, 2) + 'ون';
    expect(arabicStem(shortWord)).toBe(shortWord);
    expect(arabicStem(stem + 'ه' + 'ات')).toBe(stem + 'ه');
  });

  it.each(['و', 'ف', 'ب', 'ل', 'ك'])('tries the Arabic clitic %s both ways', clitic => {
    const stem = 'حسن';
    const word = clitic + stem;
    expect(requestTerms(word)).toEqual([{ word, variants: [word, stem] }]);
  });

  // English word forms are from Snowball's vocabulary and examples, retrieved 2026-11-27.
  // https://raw.githubusercontent.com/snowballstem/snowball-data/master/english/voc.txt
  // https://raw.githubusercontent.com/snowballstem/snowball-data/master/english/output.txt
  // https://snowballstem.org/algorithms/english/stemmer.html
  it.each([
    ['possessive', 'abandon' + "'s", 'abandon'],
    ['-ies plural', 'abilities', 'ability'],
    ['-es after a sibilant', 'churches', 'church'],
    ['-s plural', 'abandons', 'abandon'],
    ['-ing', 'abandoning', 'abandon'],
    ['-ed', 'abandoned', 'abandon'],
    ['doubled consonant after -ing', 'abetting', 'abet'],
    ['final -e on a longer word', 'abode', 'abod'],
    ['short word ending in -s', 'gas', 'gas'],
    ['short doubled consonant', 'add', 'add'],
  ])('handles English %s', (_rule, input, expected) => {
    expect(englishStem(input)).toBe(expected);
  });
});

describe('terms used as reader evidence', () => {
  // PyArabic's tasheel example supplies the hamza-bearing words, retrieved 2026-11-27.
  // https://github.com/linuxscout/pyarabic/blob/master/pyarabic/araby.py#L827-L851
  it.each([['سؤال', 'سوال'], ['الأئمة', 'الايمه'], ['جاء', 'جاء']])('handles the hamza forms in %s', (input, expected) => {
    for (const spelling of [input, input.normalize('NFD')]) {
      expect(readerEvidenceTerms(spelling)).toEqual([expect.objectContaining({ word: expected })]);
    }
  });

  // Unicode documents U+2019 and U+0027 as apostrophe forms, retrieved 2026-11-27.
  // https://www.unicode.org/Public/18.0.0/charts/nameslist/2000/
  it.each(["'", '’'])('removes possessive %ss before tokenization', apostrophe => {
    const word = 'abandon';
    expect(readerEvidenceTerms(`${word}${apostrophe}s`)).toEqual([{ word, variants: [word] }]);
  });

  it('keeps the Arabic inflected form, article-stripped form, and stem', () => {
    const base = 'ساهدات';
    const word = 'ال' + base;
    expect(readerEvidenceTerms(word)).toEqual([{
      word,
      variants: expect.arrayContaining([word, base, 'ساهد']),
    }]);
  });

  it('keeps the normalized English surface form alongside its stem', () => {
    const word = 'abandoning';
    expect(readerEvidenceTerms(word.toUpperCase())).toEqual([{
      word,
      variants: expect.arrayContaining([word, 'abandon']),
    }]);
  });
});
