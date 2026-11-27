import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateLocalComputation } from '../apps/server/src/assistant/local-computation.js';
import { reasonCalendar } from '../apps/server/src/assistant/reasoning/calendar.js';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';

// Node Intl/ICU supplies an independent numeric calendar reference.
// https://www.unicode.org/reports/tr35/tr35-dates.html#Calendar_Elements (retrieved 2026-11-27)
function hijriDate(date: string, calendar: string): string {
  const formatter = new Intl.DateTimeFormat('en', {
    calendar, numberingSystem: 'latn', timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(date)).map(part => [part.type, part.value]));
  return [parts.year, parts.month.padStart(2, '0'), parts.day.padStart(2, '0')].join('-');
}

describe.each([
  ['0', 'islamic-umalqura'],
  ['1', 'islamic-civil'],
])('local calendar calculator with MOHASSAN_REASONING=%s', (flag, calendar) => {
  afterEach(() => vi.unstubAllEnvs());

  const now = new Date('2026-11-27');
  const compute = (request: string) => {
    vi.stubEnv('MOHASSAN_REASONING', flag);
    const result = evaluateLocalComputation(request, now);
    expect(result?.status).toBe('completed');
    return result!.evidence.find(item => item.value !== undefined)!.value!;
  };

  it.each([
    'كم يوما بين 5 جويلية 2026 و 1 أوت 2026؟',
    'كم يوما بين 5 يوليوز 2026 و 1 غشت 2026؟',
    'كم يوما بين 5 تموز 2026 و 1 آب 2026؟',
    'كم يوما بين 5 جويلية 2026 و 1 أوت 2026، وضّح الخطوات',
  ])('counts the Gregorian days in %s', request => {
    const days = (Date.parse('2026-08-01') - Date.parse('2026-07-05')) / (24 * 60 * 60 * 1000);
    expect(compute(request)).toBe(String(days));
  });

  it.each([
    ['حول 1 ربيع أول 1448 إلى الميلادي', '1448-03-01'],
    ['حول 1 ربيع الأول 1448 إلى الميلادي', '1448-03-01'],
    ['Convert 1 Rabi al Awwal 1448 to Gregorian', '1448-03-01'],
    ['Convert 1 Rabi al-Awwal 1448 to Gregorian', '1448-03-01'],
    ['Convert 1 Rabi Awwal 1448 to Gregorian', '1448-03-01'],
    ['Convert 1 Dhul Hijjah 1448 to Gregorian', '1448-12-01'],
    ['Convert 1 Dhul-Hijjah 1448 to Gregorian', '1448-12-01'],
    ['Convert 1 Dhu al-Hijjah 1448 to Gregorian', '1448-12-01'],
  ])('converts %s using the configured calendar', (request, expected) => {
    // Input month indices from CLDR 48.0.0 (retrieved 2026-11-27).
    // https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-cal-islamic-full/main
    expect(hijriDate(compute(request), calendar)).toBe(expected);
  });

  it.each([
    ['حول 5 جوان 2026 إلى الهجري', '2026-06-05'],
    ['حول 5 يونيه 2026 إلى الهجري', '2026-06-05'],
  ])('converts %s to Hijri', (request, gregorian) => {
    expect(compute(request)).toBe(hijriDate(gregorian, calendar));
  });
});

describe('arithmetic Islamic calendar', () => {
  it('labels the result approximate and identifies each calendar', () => {
    const result = reasonCalendar('Convert 1 Ramadan 1446 to Gregorian', 'en', new Date());
    expect(result?.status).toBe('completed');
    expect(result?.text).toContain('1446-09-01 AH ≈ 2025-03-01 Gregorian');
    expect(result?.text).toContain('Approximate in the arithmetic Islamic calendar');
  });

  it('uses the same UTC date throughout the first day of Ramadan', () => {
    const result = reasonCalendar('كم باقي على رمضان؟', 'ar', new Date('2025-03-01T23:59:59Z'));
    expect(result?.evidence.find(item => item.id === REASONING_VALUE_ID)?.value).toBe('0');
    expect(result?.text).toContain('2025-03-01 UTC');
    expect(result?.text).toContain('التقويم الهجري الحسابي');
  });

  it('counts toward the next start after the first day has passed', () => {
    const result = reasonCalendar('How many days until Ramadan?', 'en', new Date('2025-03-02T00:00:00Z'));
    expect(result?.evidence.find(item => item.id === REASONING_VALUE_ID)?.value).toBe('353');
    expect(result?.text).toContain('1447-09-01 AH');
  });

  it.each([
    ['Convert 3 km to m', 'en'],
    ['حوّل ٣ كم إلى م', 'ar'],
    ['How many days between 2025-01-01 and 2025-04-01?', 'en'],
    ['What is the difference between the Gregorian and Hijri calendars?', 'en'],
    ['Read this page to Gregorian readers', 'en'],
  ] as const)('leaves other requests to their usual path: %s', (request, lang) => {
    expect(reasonCalendar(request, lang, new Date())).toBeNull();
  });
});
