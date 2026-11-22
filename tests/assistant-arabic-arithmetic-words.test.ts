import { describe, expect, it } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';

const now = new Date('2026-11-22T17:00:00Z');

// Arithmetic written in Arabic words and Arabic-Indic digits, through the calculator the chat uses (mind/compute.ts via
// local-computation.ts). An operator word takes its preposition with it: «قسمة على», «مقسومة على», «ضرب في». The wording
// here is this test's own; the real requests that failed were rq014, rq070 and rq039 of the frozen set of 2026-11-22.
describe('arithmetic in Arabic words', () => {
  it.each([
    ['احسب (٢٥ زائد ١٥) قسمة على ٨', '(25 + 15) / 8 = 5'],
    ['احسب (٩ زائد 3) قسمة على ٤', '(9 + 3) / 4 = 3'],
    ['كم ٤٢ قسمه علي ٦', '42 / 6 = 7'],
    ['١٨ مقسومة على ٣', '18 / 3 = 6'],
    ['ما هو ناتج ٦ ضرب في ٧', '6 * 7 = 42'],
    ['٨ زايد ٥', '8 + 5 = 13'],
    ['كم حاصل ١٢ × ١١؟', '12 * 11 = 132'],
    ['كم نتيجة ٥٠ ناقص ٨', '50 - 8 = 42'],
    ['احسب ٣٠ قسمة على ٤، الناتج فقط', '7.5'],
  ])('computes «%s»', (request, line) => {
    const result = evaluateLocalComputation(request, now);
    expect(result?.status).toBe('completed');
    expect(result?.text).toBe(line);
    expect(result?.evidence[0]?.source).toBe('computed');
  });

  it('reports division by zero written in words as an understood boundary', () => {
    const result = evaluateLocalComputation('٩ قسمة على ٠', now);
    expect(result?.status).toBe('blocked');
    expect(result?.text).toContain('صفر');
  });

  it.each([
    'احسب قسمة التركة بين الورثة',
    'ما حاصل ضرب الأرقام في حياتنا',
    'ما 3 كتب تنصحني بها',
    'قسمة على صفر',
    'كم حاصل مبيعات الشركة هذا العام؟',
  ])('leaves «%s» to the other routes', request => {
    expect(evaluateLocalComputation(request, now)).toBeNull();
  });
});
