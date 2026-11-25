import { describe, expect, it } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { compute, inspectComputationRequest } from '../apps/server/src/assistant/mind/compute.js';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';

const now = new Date('2026-10-15T14:00:00Z');

describe('spoken unit conversions', () => {
  it.each([
    ['قديش دقيقة في تلات ساعات؟', '180', '3 × 60'],
    ['كام دقيقة في ساعتين ونص؟', '150', '2 × 60 + 0.5 × 60'],
    ['عندي ٧ لترات، كم تساوي بالمليلتر؟', '7000', '7 × 1000'],
    ['حوّل ساعة إلا ثلث إلى ثواني.', '2400', '1 × 3600 −'],
    ['حوّل ٢٫٤ hours إلى دقائق، ووضح الخطوات.', '144', '2.4 × 60'],
    ['حوّل ثلاث ساعات و٦ دقايق إلى ثواني.', '11160', '3 × 3600 + 6 × 60'],
    ['How many minutes are there in one hour and forty-five minutes?', '105', '1 × 60 + 45 × 1'],
    ['What is eighty-four seconds in minutes?', '1.4', '84 ÷ 60'],
    ['Convert -3 and a half hours to minutes.', '-210', '−(3 × 60 + 0.5 × 60)'],
    ['Convert -4 hours and -10 minutes to minutes.', '-250', '(-4 × 60 − 10 × 1)'],
    ['Convert -0 and a quarter hour to minutes.', '-15', '−(0 × 60 + 0.25 × 60)'],
  ])('routes and shows the working for %s', (request, value, step) => {
    expect(buildFrame(request).intent).toBe('compute');
    const consumption = inspectComputationRequest(request);
    expect(consumption).toMatchObject({ complete: true, kind: 'conversion', remainder: [] });
    expect(evaluateLocalComputation(request, now)).toMatchObject({
      status: 'completed', text: expect.stringContaining(step), consumption,
      evidence: [{ id: 'calculation', value, source: 'computed', quote: expect.stringContaining(step) }],
    });
  });

  it('keeps the conversion proof for a value-only request', () => {
    const request = 'How many grams in half a kilogram? Just the result.';
    expect(evaluateLocalComputation(request, now)).toMatchObject({
      status: 'completed', text: '500', evidence: [{ value: '500', quote: expect.stringContaining('0.5 × 1000') }],
    });
  });

  it.each([
    'How many grams in two minutes and a litre?',
    'Convert 20 degrees Celsius and 10 degrees Celsius to Fahrenheit.',
  ])('blocks an incompatible conversion without a computed claim: %s', request => {
    expect(evaluateLocalComputation(request, now)).toMatchObject({ status: 'blocked', evidence: [] });
  });

  it.each([
    'How many seconds in minutes?',
    'How many metres in ³ miles?',
    'How many grams in a kilogram using the number off this page?',
    'Tell us how many minutes in two hours; also write a poem.',
    'What is 18 euros in dollars?',
  ])('does not complete a conversion outside the supported scope: %s', request => {
    expect(inspectComputationRequest(request).complete).toBe(false);
    expect(compute(buildFrame(request), now, { originalText: request })).toBeNull();
  });
});
