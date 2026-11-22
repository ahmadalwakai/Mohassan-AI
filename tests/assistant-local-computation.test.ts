import { describe, expect, it } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';

const now = new Date('2026-11-21T05:00:00Z');

describe('shared local computation capability', () => {
  it.each([
    ['كم ١٢٫٥٪ من ٤٨٠؟', '60'],
    ['احسب -3^2، النتيجة فقط', '-9'],
    ['Compute 2^-2. Only the result.', '0.25'],
    ['Convert 86 °F to Celsius.', '30'],
    ['حوّل ٣٫٧٥ كيلوجرام إلى جرام.', '3750'],
    ['How many days between 2024-02-28 and 2024-03-01?', '2'],
    ['What time is it in Tokyo?', '14:00'],
  ])('computes %s with its supporting evidence', (request, value) => {
    const result = evaluateLocalComputation(request, now);
    expect(result?.status).toBe('completed');
    expect(result?.text).toContain(value);
    expect(result?.evidence).toMatchObject([{ source: 'computed', value }]);
    expect(result?.claims[0].support).toContain(result?.evidence[0]?.id);
  });

  it.each([
    ['Calculate 2^100.', 'number range'],
    ['احسب ٧ ÷ ٠', 'صفر'],
    ['Convert 3 litres to metres.', 'compatible units'],
  ])('reports an understood calculation boundary for %s', (request, boundary) => {
    const result = evaluateLocalComputation(request, now);
    expect(result?.status).toBe('blocked');
    expect(result?.text).toContain(boundary);
    expect(result?.evidence).toEqual([]);
  });

  it.each([
    'كم سعر الذهب اليوم؟',
    'Convert 27 GBP to JPY.',
    'ما ميزانية حملتي في الذاكرة؟',
    'افتح موقع الشركة ثم احسب عدد الموظفين',
    'Summarize this sentence: "calculate 2+2".',
    'احسب',
    'Calculate console.log(1).',
    'ما عاصمة اليابان؟',
    'x'.repeat(4001),
  ])('leaves non-computation requests on their own path: %s', request => {
    expect(evaluateLocalComputation(request, now)).toBeNull();
  });
});
