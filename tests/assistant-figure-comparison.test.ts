import { describe, expect, it } from 'vitest';
import { compareFigures } from '../apps/server/src/assistant/figure-comparison.js';

// Synthetic claims use the owner's examples and the comparator's documented rounding rule.
// International mile conversion from NIST SP 811, retrieved 2026-11-27:
// https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9
const mileInKm = 1.609344;

describe('compareFigures', () => {
  it.each([
    ['5 ملايين', '5 آلاف', 'different-value'],
    ['105 مليون', '105.3 million', 'agree'],
    ['105 مليون', '104.5 million', 'different-value'],
    ['5 million', '5.03 million', 'different-value'],
    ['105.0 million', '105.3 million', 'different-value'],
    ['105 million', '105,300,000', 'agree'],
    ['105', '105.3', 'different-value'],
    ['-105 million', '+105 million', 'different-value'],
    ['٥ ملايين', '5M', 'agree'],
    ['٥ آلاف', '5k', 'agree'],
    ['5K', '5 thousand', 'agree'],
    ['5 مليارات', '5 bn', 'agree'],
    ['١٠٥٫٣ مليون', '۱۰۵,۳ million', 'agree'],
    ['١٠٥٬٣٠٠٬٠٠٠', '105\u202f300\u202f000', 'agree'],
    ['105.300.000,5', '105,300,000.5', 'agree'],
  ])('compares the magnitudes in %s and %s', (first, second, kind) => {
    expect(compareFigures(first, second)).toEqual({ kind });
    expect(compareFigures(second, first)).toEqual({ kind });
  });

  it.each([
    ['5%', '5', 'different-unit'],
    ['٥ بالمائة', '5 percent', 'agree'],
    ['5 percent', '5 percentage points', 'different-unit'],
    ['٥ أشخاص', '5 people', 'agree'],
    ['عدد السكان ٥ ملايين', '5 million people', 'agree'],
    ['5 km', '5 miles', 'different-value'],
    [`${mileInKm} km`, '1 mile', 'agree'],
    [`${mileInKm * 1000} kilometres`, '١٬٠٠٠ ميل', 'agree'],
    ['5 km', '5 kg', 'different-unit'],
    ['5 km²', '5 km', 'different-unit'],
    ['5 km/h', '5 km', 'different-unit'],
    ['5 miles an hour', '5 miles', 'uncomparable'],
    ['5 miles squared', '5 miles', 'uncomparable'],
    ['٥ كيلوغرامات', '5 kg', 'agree'],
    ['USD 5', '5 US dollars', 'agree'],
    ['٥ ريالات سعودية', 'SAR5', 'agree'],
    ['ZAR5', '5 ZAR', 'agree'],
    ['5 USD', '5 CAD', 'different-unit'],
    ['5 dollars', '5 USD', 'uncomparable'],
    ['5 apples', '5 oranges', 'uncomparable'],
  ])('checks the units in %s and %s', (first, second, kind) => {
    expect(compareFigures(first, second)).toEqual({ kind });
  });

  it.each([
    ['في ٢٠١٠ بلغ عدد السكان ٥ ملايين', 'عام ٢٠٢٤ بلغ عدد السكان ٥ ملايين', 'different-period'],
    ['The total was 5 million as of 2023', 'بلغ الإجمالي ٥ ملايين عام ٢٠٢٣', 'agree'],
    ['5 million as of 2024-05-01', '5 million as of May 1, 2024', 'agree'],
    ['5 million as of 2024-05-01', '5 million as of 2024-05-02', 'different-period'],
    ['5 million in 2024', '5 million in mid-2024', 'different-period'],
    ['5 million since 2024', '5 million in 2024', 'different-period'],
    ['2024: 5 million', '5 million in 2024', 'agree'],
    ['5 million in 2024', '5 million as of 2024-05-01', 'different-period'],
    ['5 million from 2010 to 2024.', '5 million between 2010 and 2024.', 'agree'],
    ['5 million from 2010 to 2024.', '5 million between 2010 and 2023.', 'different-period'],
    ['5 million from 2010 to 2024.', '5 million in 2010.', 'different-period'],
    ['5–7 million', 'بين ٥ و٧ ملايين', 'agree'],
    ['5–7 million', 'from 5 to 8 million', 'different-value'],
    ['5–7 million', '5 million', 'different-value'],
    ['2010–2024 people', '2,010 to 2,024 people', 'agree'],
    ['5 million in 2024 and 6 million in 2023', '5 million in 2024', 'uncomparable'],
    ['5 km in 2024, a gain of 2 km', '5 km in 2024', 'uncomparable'],
  ])('checks dates and ranges in %s and %s', (first, second, kind) => {
    expect(compareFigures(first, second)).toEqual({ kind });
  });

  it('identifies the source that omitted the period only when the figures match', () => {
    expect(compareFigures('5 million', '5 million in 2024')).toEqual({ kind: 'agree-period-unstated', unstatedSource: 'first' });
    expect(compareFigures('5 million in 2024', '5 million')).toEqual({ kind: 'agree-period-unstated', unstatedSource: 'second' });
    expect(compareFigures('5 million in 2024', '5 thousand')).toEqual({ kind: 'different-value' });
  });

  it('keeps a lone year out of quantity comparisons but supports date questions', () => {
    expect(compareFigures('The university opened in 2024.', '2024')).toEqual({ kind: 'uncomparable' });
    expect(compareFigures('In 2024.', '2024 people')).toEqual({ kind: 'uncomparable' });
    expect(compareFigures('2024 people', '2,024 people')).toEqual({ kind: 'agree' });
    expect(compareFigures('The university opened in 2024.', 'عام ٢٠٢٤', { kind: 'date' })).toEqual({ kind: 'agree' });
    expect(compareFigures('The university opened in 2024.', 'عام ٢٠١٠', { kind: 'date' })).toEqual({ kind: 'different-period' });
    expect(compareFigures('The university opened in 2024.', '2024 people', { kind: 'date' })).toEqual({ kind: 'uncomparable' });
  });
});
