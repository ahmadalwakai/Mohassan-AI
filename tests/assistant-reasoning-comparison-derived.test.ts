import { describe, expect, it } from 'vitest';
import { reasonDerivedComparison } from '../apps/server/src/assistant/reasoning/comparison-derived.js';

describe('comparisons using derived quantities', () => {
  it('uses the requested common billing horizon and shows the difference and inputs', () => {
    const text = 'Basic charges €17.50 per month while Plus charges €193 annually. Which costs less over a year and what is the difference?';
    const result = reasonDerivedComparison(text, 'en');
    expect(result?.evidence[0]?.value).toBe('Plus');
    expect(result?.text).toContain('210 € for one year');
    expect(result?.text).toContain('Difference — 17 € for one year.');
    expect(result?.evidence.slice(1).map(evidence => evidence.quote)).toEqual(['Basic charges €17.50 per month', 'Plus charges €193 annually']);
    expect(result?.claims[0]?.support).toEqual(['reasoning-result', 'comparison-input-1', 'comparison-input-2']);
  });

  it('compares exact ratios even when their decimal displays repeat', () => {
    const text = 'A six-box costs €2 and a nine-box costs €3. Which is less expensive per unit?';
    const result = reasonDerivedComparison(text, 'en');
    expect(result?.evidence[0]?.value).toBe('six-box = nine-box');
    expect(result?.text).toContain('≈ 0.333333 € per item');
  });

  it('normalizes prices based on an Arabic unit count, including the dual', () => {
    const text = 'متجر النخيل يبيع 5 وحدات بـ35 درهم بينما متجر الساحة وحدتين بـ12 درهم. أيهما أوفر للوحدة؟';
    const result = reasonDerivedComparison(text, 'ar');
    expect(result?.evidence[0]?.value).toBe('متجر الساحة');
    expect(result?.text).toContain('6 درهم للوحدة');
    expect(result?.evidence[2]?.quote).toBe('متجر الساحة وحدتين بـ12 درهم');
  });

  it('computes elapsed time from attributed ranges and arrival/departure pairs', () => {
    const text = 'Morgan walked from 7:12 am to 7:36 am. Terry departed at 06:55 and arrived at 07:14. Who had the quicker commute and by how many minutes?';
    const result = reasonDerivedComparison(text, 'en');
    expect(result?.evidence[0]?.value).toBe('Terry');
    expect(result?.text).toContain('Morgan — 24 min');
    expect(result?.text).toContain('Terry — 19 min');
    expect(result?.text).toContain('Difference — 5 min');
  });

  it('counts across midnight given an explicit next day', () => {
    const text = 'River: 23:44 – 00:08 next day. Quinn: 18:08 – 18:31. Whose trip was longer?';
    const result = reasonDerivedComparison(text, 'en');
    expect(result?.evidence[0]?.value).toBe('River');
    expect(result?.text).toContain('River — 24 min');
  });

  it.each([
    'Rates A charges €17 each month. Rates B charges £193 annually. Which costs less over a year?',
    'Rates A charges €17 each month. Rates B charges €193. Which costs less over a year?',
    'Rates A charges €17 each month. Rates B charges €193 annually. Which costs less over two months?',
    'Rates A charges €17 each month before fees. Rates B charges €193 annually. Which costs less over a year?',
    'Rates A charges around €17 each month. Rates B charges €193 annually. Which costs less over a year?',
    'Rates A charges €17 each month. Rates B charges €193 annually. Which costs less over a year and send it to my landlord?',
    'Rates A charges €17 each month. Rates B charges €193 annually. Which costs less over a year then save the answer?',
    'Rates A charges €17 each month. Rates B charges €193 annually. Which costs less over a year and click Buy?',
    'East sells 5 pounds of rice for $9. West sells 5 ounces of rice for $7. Which is cheaper per item?',
    'River: 23:44 – 00:08. Quinn: 18:08 – 18:31. Whose trip was shorter?',
    'River: 11:34 pm – 12:12. Quinn: 18:08 – 18:31. Whose trip was longer?',
    'River: 23:44 – 24:08. Quinn: 18:08 – 18:31. Whose trip was longer?',
    'Morgan walked from 7:12 am to 7:36 am. Terry departed at 06:55 and arrived at 07:14. Who left first?',
  ])('requires compatible, fully attributed inputs for %s', text => {
    expect(reasonDerivedComparison(text, 'en')).toBeNull();
  });
});
