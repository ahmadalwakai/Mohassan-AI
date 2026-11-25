import { describe, expect, it } from 'vitest';
import {
  normalizeEvidenceUnit, parseEvidenceDates, parseEvidenceNumbers, parseEvidenceUnitContext,
} from '../apps/server/src/assistant/structured-evidence-parsing.js';

function numericQuotes(text: string) {
  return parseEvidenceNumbers(text).map(({ start, end, ...token }) => ({ quote: text.slice(start, end), ...token }));
}

function dateQuotes(text: string) {
  return parseEvidenceDates(text).map(({ start, end, date }) => ({ quote: text.slice(start, end), ...date }));
}

describe('structured evidence amounts', () => {
  it.each([
    ['27,400,013 people', 27_400_013],
    ['٢٧٬٤٠٠٬٠١٣ نسمة', 27_400_013],
    ['۲۷،۴۰۰،۰۱۳ نسمة', 27_400_013],
    ['27\u202f400\u202f013 residents', 27_400_013],
    ['27’400’013 inhabitants', 27_400_013],
  ] as const)('retains the source amount and unit in %s', (text, value) => {
    expect(numericQuotes(text)).toEqual([{ quote: text, value, unit: 'count', approximate: false, scaled: false }]);
  });

  it.each([
    ['حولها نحو ۲۷٫۴ مليون نسمة', 'نحو ۲۷٫۴ مليون نسمة', 27_400_000, 'count'],
    ['بِنَحْوِ ٤٫٥ آلاف نسمة', 'بِنَحْوِ ٤٫٥ آلاف نسمة', 4_500, 'count'],
    ['حَوَالَي ۲۷٫۴ مليونًا', 'حَوَالَي ۲۷٫۴ مليونًا', 27_400_000, undefined],
    ['ما يقرب من ٣ ملايين شخص', 'ما يقرب من ٣ ملايين شخص', 3_000_000, 'count'],
    ['Population was around 9.5 thousand people.', 'around 9.5 thousand people', 9_500, 'count'],
    ['GDP was about US$1.234 billion.', 'about US$1.234 billion', 1_234_000_000, 'USD'],
    ['حوالي ٣٫٢ مليارات ريال سعودي', 'حوالي ٣٫٢ مليارات ريال سعودي', 3_200_000_000, 'SAR'],
    ['Estimated at A$3 trillion.', 'Estimated at A$3 trillion', 3_000_000_000_000, 'AUD'],
    ['💡 6 million people تقريبًا.', '6 million people تقريبًا', 6_000_000, 'count'],
  ] as const)('normalizes the scale and preserves an approximation in %s', (text, quote, value, unit) => {
    expect(numericQuotes(text)).toEqual([{ quote, value, unit, approximate: true, scaled: true }]);
  });

  it.each([
    ['من ٣ إلى ٥ ملايين نسمة', 3_000_000, 5_000_000, 'count', true, false],
    ['4–6 million people', 4_000_000, 6_000_000, 'count', true, false],
    ['roughly between 4 and 5 million people', 4_000_000, 5_000_000, 'count', true, true],
    ['between 900 thousand and 1 million people', 900_000, 1_000_000, 'count', true, false],
    ['بين ٢٠ و٣٠ كم', 20, 30, 'km', false, false],
    ['بين ٢٠و٣٠ كم', 20, 30, 'km', false, false],
    ['US$10 to US$20', 10, 20, 'USD', false, false],
    ['−5–−3 م', -5, -3, 'm', false, false],
    ['0-15 km', 0, 15, 'km', false, false],
  ] as const)('preserves both endpoints and the shared scale or unit in %s', (text, value, upper, unit, scaled, approximate) => {
    expect(numericQuotes(text)).toEqual([{ quote: text, value, upper, unit, approximate, scaled }]);
  });

  it.each([
    ['٣٫٥٪', 3.5, 'percent'],
    ['٢,٣٤٥ ريال سعودي', 2_345, 'SAR'],
    ['٤٫٥ بالمائة', 4.5, 'percent'],
    ['7.6 per cent', 7.6, 'percent'],
    ['١٢ ر.س', 12, 'SAR'],
    ['−US$27.92', -27.92, 'USD'],
    ['$20 Australian dollars', 20, 'AUD'],
    ['$17', 17, 'dollar'],
    ['٣٠ ريال', 30, 'riyal'],
    ['29,029 feet', 29_029, 'ft'],
    ['10 km²', 10, 'km²'],
    ['50 km/h', 50, 'km/h'],
    ['2 percentage points', 2, 'percentage-point'],
    ['٨٬٨٤٨٫٨٦ متر', 8_848.86, 'm'],
    ['6,650 kilometres', 6_650, 'km'],
    ['.5 miles', 0.5, 'mi'],
  ] as const)('identifies percentages, currency and measurement units in %s', (text, value, unit) => {
    expect(numericQuotes(text)).toEqual([{ quote: text, value, unit, approximate: false, scaled: false }]);
  });

  it.each([
    '20 people per km²', '٥٠ نسمة لكل كم²', '2.3.4', '2024-06-30', '2019-02-29', '١٧/٠٣/٢٠٢٠',
    '2,34', '9,007,199,254,740,992', 'more than 25 million', 'أكثر من ٥ ملايين', '10 USD–20 EUR',
  ])('does not reinterpret an unsupported number-like span as an exact amount (%s)', text => {
    expect(parseEvidenceNumbers(text)).toEqual([]);
  });

  it('preserves a year and a following amount as separate tokens', () => {
    expect(numericQuotes('بحلول عام 1974 إلى نحو 12 دولارا للبرميل الواحد')).toEqual([
      { quote: '1974', value: 1974, unit: undefined, approximate: false, scaled: false },
      { quote: 'نحو 12 دولارا', value: 12, unit: 'dollar', approximate: true, scaled: false },
    ]);
  });

  it('distinguishes the Arabic Gregorian year marker from the abbreviation for metres', () => {
    const text = 'بلغ الارتفاع 2024م خلال عام 2024م';
    expect(numericQuotes(text)).toEqual([{ quote: '2024م', value: 2024, unit: 'm', approximate: false, scaled: false }]);
    expect(dateQuotes(text)).toHaveLength(2);
  });

  it('extracts only unambiguous context units and scale words from table labels', () => {
    expect(parseEvidenceUnitContext('GDP (billions of US$)')).toEqual({ unit: 'USD', scale: 1_000_000_000 });
    expect(parseEvidenceUnitContext('السكان (مليون نسمة)')).toEqual({ unit: 'count', scale: 1_000_000 });
    expect(parseEvidenceUnitContext('Currency conversion (EUR / USD, million or billion)')).toEqual({ unit: undefined, scale: undefined });
    expect(parseEvidenceUnitContext('Distance, kilometres')).toEqual({ unit: 'km', scale: undefined });
    expect(normalizeEvidenceUnit('  دُولَار  أَسْتُرَالِي  ')).toBe('AUD');
    expect(normalizeEvidenceUnit('People')).toBe('count');
  });
});

describe('structured evidence dates', () => {
  it.each([
    ['as of 30 June 2024', '30 June 2024', 2024, 6, 30],
    ['Recorded November 9th, 1989.', 'November 9th, 1989', 1989, 11, 9],
    ['في ٢٩ فبراير عام ٢٠٢٤', '٢٩ فبراير عام ٢٠٢٤', 2024, 2, 29],
    ['في السجل ۱۴ تشرين الأول ۲۰۲۱', '۱۴ تشرين الأول ۲۰۲۱', 2021, 10, 14],
    ['٣١/١٠/٢٠٢١', '٣١/١٠/٢٠٢١', 2021, 10, 31],
    ['11/23/2026', '11/23/2026', 2026, 11, 23],
    ['2000-02-29', '2000-02-29', 2000, 2, 29],
    ['💡 25 Sep. 2025', '25 Sep. 2025', 2025, 9, 25],
    ['الأول من سبتمبر من عام ١٩٣٩', 'الأول من سبتمبر من عام ١٩٣٩', 1939, 9, 1],
  ] as const)('recognizes and slices the Gregorian date in %s', (text, quote, year, month, day) => {
    expect(dateQuotes(text)).toEqual([{ quote, calendar: 'gregorian', year, month, day }]);
  });

  it('preserves date precision from the source', () => {
    expect(dateQuotes('March 2020 until 2022')).toEqual([
      { quote: 'March 2020', calendar: 'gregorian', year: 2020, month: 3 },
      { quote: '2022', calendar: 'gregorian', year: 2022 },
    ]);
  });

  it('labels Hijri month names and calendar markers without converting them', () => {
    expect(dateQuotes('الأول من رمضان عام ١٤٤٥هـ، و ۱۴۴۲ AH.')).toEqual([
      { quote: 'الأول من رمضان عام ١٤٤٥هـ', calendar: 'hijri', year: 1445, month: 9, day: 1 },
      { quote: '۱۴۴۲ AH.', calendar: 'hijri', year: 1442 },
    ]);
    expect(dateQuotes('17 رمضان 2هـ / 13 مارس 624م')).toEqual([
      { quote: '17 رمضان 2هـ', calendar: 'hijri', year: 2, month: 9, day: 17 },
      { quote: '13 مارس 624م', calendar: 'gregorian', year: 624, month: 3, day: 13 },
    ]);
    expect(dateQuotes('١٧ رمضان - ٢ هـ')).toEqual([{ quote: '١٧ رمضان - ٢ هـ', calendar: 'hijri', year: 2, month: 9, day: 17 }]);
    expect(dateQuotes('١٤٤٦-٠١-٠١ هجرية و 2024-07-07')).toEqual([
      { quote: '١٤٤٦-٠١-٠١ هجرية', calendar: 'hijri', year: 1446, month: 1, day: 1 },
      { quote: '2024-07-07', calendar: 'gregorian', year: 2024, month: 7, day: 7 },
    ]);
  });

  it.each(['3/10/2021', '2019-02-29', '31 April 2024', '29 فبراير ١٩٠٠', '31 Ramadan 1445', '1 Ramadan 1445 CE', '1.2024', 'March 7', 'رمضان ٧'])(
    'does not degrade an invalid or ambiguous full date to a year (%s)',
    text => expect(parseEvidenceDates(text)).toEqual([]),
  );
});
