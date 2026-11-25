import type { DevelopmentCase } from './reasoning-development.js';

const category = 'comparison' as const;
const endpoint = 'https://example.org/observations';

const arabicDigits = (value: number) => String(value).replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]!);

// Development-only. Enumerates natural-number offsets and computes the oracle
// from the construction (n < n + 1 < n + 2 < n + 3). No model or API creates
// the cases or answers. This fixture is never included in training data.
const constructed: DevelopmentCase[] = Array.from({ length: 12 }, (_, n) => n + 2).flatMap(n => [
  { id: `comparison-larger-${n}`, category, request: `Which is larger: first = ${n} or second = ${n + 1}?`, expected: 'second' },
  { id: `comparison-gulf-${n}`, category, request: `مين فيهم أكبر: الأول ${arabicDigits(n + 1)} أم الثاني ${arabicDigits(n)}؟`, expected: 'الأول' },
  { id: `comparison-arabic-top-${n}`, category, request: `أطول ثلاث: ألف ${n} م؛ باء ${n + 1} م؛ جيم ${n + 3} م؛ دال ${n + 2} م`, expected: 'جيم → دال → باء' },
  { id: `comparison-smallest-${n}`, category, request: `Bottom two: A ${n + 2}; B ${n}; C ${n + 3}; D ${n + 1}`, expected: 'B → D' },
  { id: `comparison-older-${n}`, category, request: `Which is older: Sam ${n} years or Lee ${n + 1} years?`, expected: 'Lee' },
]);

const sourced: DevelopmentCase[] = [
  { id: 'comparison-sourced-pair', category, request: 'Which is longer on the page: Pine or Birch?', expected: 'Birch',
    options: { pages: [{ url: endpoint, title: 'Trees', text: 'Pine: Length: 12 m. Birch: Length: 16 m. Ash: Length: 5 m.' }] } },
  { id: 'comparison-sourced-arabic', category, request: 'أطول ثلاث في هذي الصفحة', expected: 'جيم → دال → باء',
    options: { pages: [{ url: endpoint, title: 'الأطوال', text: 'الاسم | الطول (م)\nألف | 6\nباء | 7\nجيم | 9\nدال | 8' }] } },
  { id: 'comparison-table-units', category, request: 'Rank by length from the table', expected: 'Ida → Val',
    options: { pages: [{ url: endpoint, title: 'Survey', text: 'Name | Length (m) | Score\nIda | 5 | 3\nVal | 4 | 7' }] } },
  { id: 'comparison-structured-values', category, request: 'Which is older: Iris or Alex?', expected: 'Iris',
    options: { evidence: [
      { id: 'alex', source: 'knowledge', title: 'Alex', quote: 'Date of birth: 1990-03-04', value: '1990-03-04', sourceRef: 'Roster' },
      { id: 'iris', source: 'knowledge', title: 'Iris', quote: 'Date of birth: 1989-12-01', value: '1989-12-01', sourceRef: 'Roster' },
    ] } },
  { id: 'comparison-inline-birthdates', category, request: 'Which is older: Alex (born 1990-03-04) or Iris (born 1989-12-01)?', expected: 'Iris' },
  { id: 'comparison-tie-at-cutoff', category, request: 'Top two: A = 3; B = 2; C = 2; D = 1', expected: 'A → B = C' },
  { id: 'comparison-convert-units', category, request: 'Rank by length ascending: Birch 2 m; Pine 10 cm', expected: 'Pine → Birch' },
  { id: 'comparison-quantity-tie', category, request: 'Which is longer: Maple 120 cm or Alder 1.2 m?', expected: 'Maple = Alder' },
  { id: 'comparison-arabic-floor', category, request: 'وش أصغر: أول = −٢٫٥ أم ثاني = ١٫٥؟', expected: 'أول' },
  { id: 'comparison-missing', category, request: 'أيهما أكبر: الأول ٥ أم الثاني؟', expected: null, status: 'blocked' },
  { id: 'comparison-mixed-units', category, request: 'Which is larger: A: 7 kg or B: 5 m?', expected: null, status: 'blocked' },
  { id: 'comparison-unavailable-page-value', category, request: 'Which is longer from that page: Pine or Birch?', expected: null, status: 'blocked',
    options: { pages: [{ url: endpoint, title: 'Trees', text: 'Pine: Length: 12 m.' }] } },
  { id: 'comparison-conflict', category, request: 'Which is longer on this page: Pine or Birch?', expected: null, status: 'blocked',
    options: { pages: [{ url: endpoint, title: 'Trees', text: 'Pine: Length: 12 m. Pine: Length: 18 m. Birch: Length: 16 m.' }] } },
  { id: 'comparison-too-few', category, request: 'Top three from the table: A = 5; B = 3', expected: null, status: 'blocked' },
];

export const comparisonCases: readonly DevelopmentCase[] = [...constructed, ...sourced];
