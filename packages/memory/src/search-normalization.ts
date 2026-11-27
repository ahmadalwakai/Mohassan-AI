import { sql, type RawBuilder } from 'kysely';

// Arabic spelling folds for retrieval. Stored text and exact-write payloads keep their original bytes.
const arabicLetterFolds = new Map([
  // Alef with hamza above/below or madda to bare alef (Xu et al., Spelling Normalization).
  // https://www.cis.uni-muenchen.de/~fraser/pubs/fraser_sigir2002.pdf (retrieved 2026-11-27)
  ['أ', 'ا'], ['إ', 'ا'], ['آ', 'ا'],
  // Alef maqsura and yeh are used interchangeably word-finally (Eskander et al., §3).
  // https://aclanthology.org/N13-1066.pdf (retrieved 2026-11-27)
  ['ى', 'ي'],
  // Taa marbuta is also written with heh in informal orthography (Eskander et al., §3).
  // https://aclanthology.org/N13-1066.pdf (retrieved 2026-11-27)
  ['ة', 'ه'],
]);
const variantLetters = [...arabicLetterFolds.keys()].join('');
const foldedLetters = [...arabicLetterFolds.values()].join('');
const variantPattern = new RegExp(`[${variantLetters}]`, 'g');

// Preserve the existing Arabic mark range and strip tatweel (U+0640), a joining extender.
// https://www.unicode.org/charts/PDF/U0600.pdf (retrieved 2026-11-27)
const ignoredArabicCharacters = '[\u0640\u064b-\u065f\u0670]';
const ignoredArabicPattern = new RegExp(ignoredArabicCharacters, 'g');

// Common function words selected from Jacques Savoy's Arabic stopword list as published by Lucene.
// https://github.com/apache/lucene/blob/releases/lucene/9.12.2/lucene/analysis/common/src/resources/org/apache/lucene/analysis/ar/stopwords.txt (retrieved 2026-11-27)
const arabicStopwords = new Set([
  'ما', 'في', 'هو', 'هي', 'هى', 'من', 'عن', 'مع', 'على', 'إلى', 'الى', 'لا',
  'لم', 'لن', 'أو', 'او', 'ثم', 'هذا', 'هذه', 'الذي', 'الذى', 'التي', 'التى', 'و', 'ف',
]);

function stripSearchMarks(value: string): string {
  // Unicode compatibility composition (NFKC), UAX #15 §1.2.
  // https://www.unicode.org/reports/tr15/#Norm_Forms (retrieved 2026-11-27)
  return value.normalize('NFKC').toLowerCase().replace(ignoredArabicPattern, '');
}

function foldArabicLetters(value: string): string {
  return value.replace(variantPattern, letter => arabicLetterFolds.get(letter) ?? letter);
}

export function normalizeMemoryText(value: string): string {
  return foldArabicLetters(stripSearchMarks(value));
}

export function normalizeMemoryTextSql(value: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`translate(regexp_replace(lower(normalize(${value},NFKC)),${ignoredArabicCharacters},'','g'),${variantLetters},${foldedLetters})`;
}

export function memoryQueryTerms(value: string): { terms: string[]; stopwordsOnly: boolean } {
  const words = stripSearchMarks(value).split(/[^\p{L}\p{N}]+/u);
  // Identify stopwords before folding letters so a name such as علي can still be searched.
  const meaningful = words.filter(word => word.length > 1 && !arabicStopwords.has(word));
  const terms = [...new Set(meaningful.map(foldArabicLetters))].slice(0, 20);
  return { terms, stopwordsOnly: !terms.length && words.some(word => arabicStopwords.has(word)) };
}
