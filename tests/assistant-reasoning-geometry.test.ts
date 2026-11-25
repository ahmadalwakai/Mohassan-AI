import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';
import { reasonWordProblem } from '../apps/server/src/assistant/reasoning/word-problems.js';

describe('local rectangle-area reasoning', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['Find the area of a rectangle measuring 11 ft by 6 feet.', 'en', '11 × 6 = 66 ft².'],
    ['A rectangle is 8 mm long and 6 mm wide. What is its area?', 'en', '8 × 6 = 48 mm².'],
    ['Compute the area of a rectangle measuring 9×4 cm.', 'en', '9 × 4 = 36 cm².'],
    ['عندي مستطيل طوله ستة أمتار وعرضه ٤ أمتار، قديش مساحته؟', 'ar', '6 × 4 = 24 م².'],
  ] as const)('derives rectangle area from two dimensions (%s)', (request, lang, equation) => {
    const reply = reasonWordProblem(request, lang);
    expect(reply?.status).toBe('completed');
    expect(reply?.text).toContain(equation);
    expect(reply?.evidence[0]).toMatchObject({ id: REASONING_VALUE_ID, source: 'computed' });
    expect(reply?.claims[0]?.support).toContain(REASONING_VALUE_ID);
  });

  it('converts a dimension to the requested length unit before multiplying', () => {
    const reply = reasonWordProblem('A rectangle has a length of 1 m and a width of 25 cm. What is its area in square centimeters?', 'en');
    expect(reply?.text).toBe('Convert the dimension to the target length unit. 1 ÷ 0.01 = 100 cm.\nRectangle area = length × width. (1 ÷ 0.01) × 25 = 2500 cm².');
    expect(reply?.evidence[0]?.value).toBe('2500');
    const arabic = reasonWordProblem('مساحة مستطيل طوله ١ م وعرضه ٣٠ سم بالسنتيمتر المربع؟', 'ar');
    expect(arabic?.text).toContain('(1 ÷ 0.01) × 30 = 3000 سم².');
  });

  it('answers a request with the target area unit first through the local calculation entry point', () => {
    const request = 'Compute the area in cm² of this rectangle with sides of 2 m by 5 mm.';
    vi.stubEnv('MOHASSAN_REASONING', undefined);
    expect(evaluateLocalComputation(request)).toBeNull();
    vi.stubEnv('MOHASSAN_REASONING', '1');
    const reply = evaluateLocalComputation(request);
    expect(reply?.status).toBe('completed');
    expect(reply?.text).toContain('2 ÷ 0.01 = 200 cm.');
    expect(reply?.text).toContain('5 × 0.001 ÷ 0.01 = 0.5 cm.');
    expect(reply?.text).toContain('(2 ÷ 0.01) × (5 × 0.001 ÷ 0.01) = 100 cm².');
    expect(reply?.evidence[0]?.value).toBe('100');
  });

  it('reports a gap for a nonpositive rectangle dimension', () => {
    const reply = reasonWordProblem('Find the area of a rectangle with sides of 0 ft by 8 ft.', 'en');
    expect(reply?.status).toBe('blocked');
    expect(reply?.evidence).toEqual([]);
  });

  it.each([
    'Find the area of a rectangle 3 kg by 8 kg.',
    'Find the area of a rectangle 4² metres by 6 metres.',
    'Find the area in m₂ of a rectangle 4 metres by 6 metres.',
    'Find the area of a rectangle 3 m by 8 m. Then email the answer.',
    'مساحة بالمتر المربع لمستطيل طوله ٤ م وعرضه ٥ م بالسنتيمتر المربع؟',
  ])('leaves incompatible units, another action, or conflicting output units to the caller (%s)', request => {
    expect(reasonWordProblem(request, /\p{Script=Arabic}/u.test(request) ? 'ar' : 'en')).toBeNull();
  });
});
