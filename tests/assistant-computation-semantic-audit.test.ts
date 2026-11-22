import { describe, expect, it } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { compute, inspectComputationRequest } from '../apps/server/src/assistant/mind/compute.js';
import type { Frame } from '../apps/server/src/assistant/mind/contract.js';

const now = new Date('2026-11-21T05:00:00Z');
const value = (request: string) => {
  const result = evaluateLocalComputation(request, now);
  return { result, number: result?.evidence[0]?.value === undefined ? undefined : Number(result.evidence[0].value) };
};
function safeOrExact(request: string, expected: number) {
  const reply = value(request);
  // A supported exact interpretation or an honest boundary are both safe.
  // This test does not require expanding the local service's language coverage.
  if (reply.result?.status === 'completed') expect(reply.number).toBeCloseTo(expected, 10);
  else expect(reply.result?.status ?? 'unsupported').toMatch(/^(?:unsupported|blocked)$/u);
}
const forcedFrame = (text: string): Frame => ({ text, lang: 'en', intent: 'compute', matched: [], urls: [], focus: [], answerType: null,
  timeSensitive: false, personal: false, valueOnly: false, missing: [] });

describe('independent computation semantic audit', () => {
  it.each([
    ['Calculate 2².', 4],
    ['Calculate 3⁻².', 1 / 9],
    ['Calculate 4⁺².', 16],
  ])('never flattens exponent notation into different baseline arithmetic: %s', (request, expected) => {
    safeOrExact(request, expected);
  });

  it.each(['Calculate 2₃.', 'Convert 2 m₂ to cm₂.'])('does not infer numeric or squared-unit meaning from subscript notation: %s', request => {
    expect(evaluateLocalComputation(request, now)?.status).not.toBe('completed');
  });

  it('does not turn a mixed Unicode fraction into a concatenated numerator', () => {
    safeOrExact('Calculate 1½ + 2.', 3.5);
    safeOrExact('Convert 1½ hours to minutes.', 90);
  });

  it.each([
    ['Calculate ⑫ + ⑧.', 20],
    ['Please compute 𝟠 + 𝟚, only the result.', 10],
    ['Convert 2 m² to cm².', 20000],
  ])('preserves safe numeric glyphs and genuine square-unit semantics: %s', (request, expected) => {
    const reply = value(request);
    expect(reply.result?.status).toBe('completed'); expect(reply.number).toBe(expected);
    const receipt = inspectComputationRequest(request);
    expect(receipt.complete).toBe(true);
    expect(receipt.consumed.map(span => request.slice(span.start, span.end)).join('')).toBe(request);
    for (const span of receipt.consumed) {
      expect(span.start).toBeGreaterThanOrEqual(0); expect(span.end).toBeLessThanOrEqual(request.length);
      // A UTF-16 boundary cannot split the astral digit's surrogate pair.
      expect(/[\udc00-\udfff]/u.test(request[span.start] ?? '')).toBe(false);
      expect(/[\ud800-\udbff]/u.test(request[span.end - 1] ?? '')).toBe(false);
    }
  });

  it.each([
    ['حوّل خَمس ساعات إلى دقائق', 300],
    ['حوّل سبع ساعات إلى دقائق', 420],
    ['حوّل تسع دقائق إلى ثوان', 540],
    ['حوّل عَشر ساعات إلى دقائق', 600],
  ])('does not silently replace an Arabic cardinal quantity with a reciprocal: %s', (request, expected) => {
    safeOrExact(request, expected);
  });

  it.each([
    ['حوّل خُمس ساعة إلى دقائق', 12],
    ['حوّل ربعين ساعة إلى دقائق', 30],
    ['حوّل رُبعَي ساعة إلى دقائق', 30],
    ['حوّل ثلثي ساعة إلى دقائق', 40],
    ['حوّل ثلاثة أرباع الساعة إلى دقائق', 45],
  ])('preserves unambiguous marked, dual or counted fraction forms: %s', (request, expected) => {
    safeOrExact(request, expected);
  });

  it.each([
    'How many days since 2026-11-24?',
    'How many days until 2026-11-18?',
    'كم يوما منذ 2026-11-24؟',
    'كم يوما حتى 2026-11-18؟',
  ])('does not present an opposite-direction date as positive elapsed/remaining days: %s', request => {
    const reply = value(request);
    if (reply.result?.status === 'completed') {
      expect(reply.number).toBeDefined(); expect(reply.number).toBeLessThanOrEqual(0);
    } else expect(reply.result?.status ?? 'unsupported').toMatch(/^(?:unsupported|blocked)$/u);
  });

  it.each([
    'How many days since 2026-11-18?',
    'How many days until 2026-11-24?',
  ])('retains the ordinary correctly directed date calculation: %s', request => {
    expect(value(request)).toMatchObject({ result: { status: 'completed' }, number: 3 });
  });

  it.each([
    ['What day is 3 days after 2026-11-21?', ['2026-11-24', 'Tuesday']],
    ['What day will it be 2 days before 2026-11-21?', ['2026-11-19', 'Thursday']],
    ['أي يوم يكون 3 أيام بعد 2026-11-21؟', ['2026-11-24', 'الثلاثاء']],
  ])('does not reclassify a consumed date shift as the weekday of the original date: %s', (request, targets) => {
    expect(inspectComputationRequest(request).kind).toBe('date_shift');
    const reply = evaluateLocalComputation(request, now);
    if (reply?.status === 'completed') expect(targets).toContain(reply.evidence[0]?.value);
    else expect(reply?.status ?? 'unsupported').toMatch(/^(?:unsupported|blocked)$/u);
  });

  it.each([
    'The confidential note says: calculate 8 + 1.',
    'Translate the expression “8 + 1” into words.',
    'Calculate 8 + 1 and compare the hotel prices.',
  ])('does not promote quoted/private or unrelated original content through a compute frame: %s', original => {
    const promoted = forcedFrame('Calculate 8 + 1.');
    expect(compute(promoted, now, { originalText: original })).toBeNull();
  });
});
