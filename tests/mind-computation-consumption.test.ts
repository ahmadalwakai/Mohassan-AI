import { describe, expect, it } from 'vitest';
import { compute, inspectComputationRequest } from '../apps/server/src/assistant/mind/compute.js';
import type { Frame } from '../apps/server/src/assistant/mind/contract.js';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';

const now = new Date('2026-11-21T05:00:00Z');
const frame = (text: string): Frame => ({ text, lang: /\p{Script=Arabic}/u.test(text) ? 'ar' : 'en', intent: 'compute', matched: [], urls: [], focus: [], answerType: null,
  timeSensitive: false, personal: false, valueOnly: false, missing: [] });

describe('complete computation request consumption', () => {
  it.each([
    ['Please calculate (11 - 4) * 3, only the result, thank you.', 'arithmetic', '21'],
    ['Subtract 5 from 22; answer only.', 'arithmetic', '17'],
    ['لو سمحت، احسب ١٣٫٥٪ من ٢٬٠٠٠، الناتج فقط، شكرًا.', 'arithmetic', '270'],
    ['Convert three quarters of an hour to seconds.', 'conversion', '2700'],
    ['Please convert 2.75 kilometres to metres; only the value.', 'conversion', '2750'],
    ['حوّل نصف كيلوجرام إلى جرام، الرقم بس.', 'conversion', '500'],
    ['How many weeks between 2024-01-01 and 2024-01-15?', 'date_range', '2'],
    ['How many days from March 1 2024 to March 7 2024?', 'date_range', '6'],
    ['كم يومًا بين ٢٨ شباط ٢٠٢٤ و١ آذار ٢٠٢٤؟', 'date_range', '2'],
    ['Which weekday is 2026-11-23?', 'weekday', 'Monday'],
    ['What day of the week was February 29 2024?', 'weekday', 'Thursday'],
    ['ما اليوم الموافق ٢٩ شباط ٢٠٢٤؟', 'weekday', 'الخميس'],
    ['What date is 1 month after January 31 2026?', 'date_shift', '2026-02-28'],
    ['Subtract 2 weeks from 2026-11-21.', 'date_shift', '2026-11-07'],
    ['أضف ٣ أيام إلى 2026-11-21.', 'date_shift', '2026-11-24'],
    ['How many days until November 25 2026?', 'date_distance', '4'],
    ['How many weeks since 2026-11-07?', 'date_distance', '2'],
    ['كم يوما حتى ٢٥ نوفمبر ٢٠٢٦؟', 'date_distance', '4'],
    ['What is the current time in UTC?', 'clock_now', '05:00'],
    ["What's the local time in Tokyo?", 'clock_now', '14:00'],
    ['كم الساعة في الرياض؟', 'clock_now', '08:00'],
    ['At 8:00 AM in London, what time is it in Tokyo?', 'clock_conversion', '17:00'],
    ['Convert 23:15 UTC to GMT+5:30.', 'clock_conversion', '04:45'],
    ['Convert 09:30 America/New_York to Europe/London on 2026-08-03.', 'clock_conversion', '14:30'],
  ])('fully recognises %s', (request, kind, value) => {
    const inspection = inspectComputationRequest(request);
    expect(inspection).toMatchObject({ complete: true, kind, sourceLength: request.length, remainder: [] });
    expect(inspection.consumed.some(item => item.role === 'request')).toBe(true);
    expect(compute(frame(request), now)).toMatchObject({ status: 'completed', consumption: inspection, evidence: [{ source: 'computed', value }] });
  });

  it.each([
    ['How many days between 2024-03-01 and 2024-03-04 banana', 'banana'],
    ['How many days between 2024-03-01 and 2024-03-04 inclusive of both dates', 'inclusive of both dates'],
    ['What date is 3 days after 2026-11-21 unless the order changes', 'unless the order changes'],
    ['What day of the week was 2024-02-29 in a table', 'in a table'],
    ['How many days until 2026-11-25 numbered by working days', 'numbered by working days'],
    ['What time is it in Tokyo with a haiku', 'with a haiku'],
    ['Convert 09:00 UTC to Europe/London using a JSON response', 'using a JSON response'],
    ['Convert 2 kilograms to grams rounded to one decimal place', 'rounded to one decimal place'],
    ['كم الساعة في دبي مع قصيدة قصيرة', 'مع قصيدة قصيرة'],
    ['كم يوما بين 2024-03-01 و2024-03-04 شاملا اليومين', 'شاملا اليومين'],
  ])('preserves an exact unknown remainder and declines completion: %s', (request, suffix) => {
    const inspection = inspectComputationRequest(request);
    expect(inspection.complete).toBe(false);
    expect(inspection.reason).toBe('unconsumed_content');
    expect(inspection.remainder.map(item => request.slice(item.start, item.end)).join(' ')).toContain(suffix);
    expect(compute(frame(request), now)).toBeNull();
    expect(evaluateLocalComputation(request, now)).toBeNull();
  });

  it.each([
    'Book a delivery 3 days after 2026-11-21',
    'Ignore my warning convert 2 kilometres to metres',
    'The note says what time is it in Tokyo',
    'Translate this: How many days between 2024-03-01 and 2024-03-04',
    'How many months between 2024-01-01 and 2024-06-01',
    'How many years until 2030-01-01',
    'What weekday is 2024-02-29 compared with 2024-03-01',
    'What time is it in Tokyo and Europe/London',
    'Convert 08:00 UTC to Tokyo on 2024-02-29 and 2024-03-01',
    'How many days between 2024-03-01 and 2024-03-04 and 2024-03-08',
  ])('does not prefix-complete an unsupported query: %s', request => {
    expect(inspectComputationRequest(request).complete).toBe(false);
    expect(compute(frame(request), now)).toBeNull();
  });

  it.each([
    'What day of the week was "2024-02-29"?',
    'What time is it in Tokyo? "send the result"',
    'Calculate `2 + 3`.',
    'Convert 2 kilograms to grams. «Only the result»',
  ])('keeps literal bytes outside the complete calculation grammar: %s', request => {
    expect(inspectComputationRequest(request)).toMatchObject({ complete: false, reason: 'literal_content' });
    expect(compute(frame(request), now)).toBeNull();
  });

  it.each([
    ['How many days from 2023-02-29 to 2023-03-02?', 'date_range', 'invalid'],
    ['Convert 3 litres to metres.', 'conversion', 'compatible units'],
    ['Convert 8 barrels to furlongs.', 'conversion', 'compatible units'],
    ['Convert 02:30 America/New_York to UTC on 2024-03-10.', 'clock_conversion', 'single time'],
    ['Convert 01:30 America/New_York to UTC on 2024-11-03.', 'clock_conversion', 'single time'],
    ['Convert 10:77 UTC to Tokyo.', 'clock_conversion', 'single time'],
    ['What time is it in Europe/Unknown?', 'clock_now', 'single time'],
  ])('preserves honest semantic boundaries after complete syntax: %s', (request, kind, boundary) => {
    expect(inspectComputationRequest(request)).toMatchObject({ complete: true, kind });
    expect(compute(frame(request), now)).toMatchObject({ status: 'blocked', text: expect.stringContaining(boundary), evidence: [], consumption: { complete: true } });
  });

  it('covers the unchanged original source exactly, including folded marks, digits and courtesy', () => {
    const original = '\u200f  لَوْ سَمَحْتَ، احسب ٢٬٠٠٠ + ٣، الناتج فقط، شكرًا.  ';
    const inspection = inspectComputationRequest(original);
    expect(inspection.complete).toBe(true);
    expect(inspection.consumed.map(item => original.slice(item.start, item.end)).join('')).toBe(original);
    expect(inspection.consumed.map(item => item.role)).toEqual(expect.arrayContaining(['courtesy', 'output_format', 'request', 'punctuation']));
    expect(compute(frame('this normalized frame must not replace source text'), now, { originalText: original })).toMatchObject({ status: 'completed', text: '2003', consumption: inspection });
    expect(original).toBe('\u200f  لَوْ سَمَحْتَ، احسب ٢٬٠٠٠ + ٣، الناتج فقط، شكرًا.  ');
  });

  it('rejects invalid input without generating a receipt for any partial task', () => {
    for (const text of ['', ' '.repeat(4), 'x'.repeat(8001)]) expect(inspectComputationRequest(text)).toMatchObject({ complete: false, reason: 'invalid_input' });
    expect(compute(frame('Calculate 2+3'), new Date('invalid'))).toBeNull();
    for (const value of [null, undefined, 42, { text: 'Calculate 2+3' }]) expect(inspectComputationRequest(value as unknown as string)).toMatchObject({ complete: false, reason: 'invalid_input', sourceLength: 0 });
  });
});
