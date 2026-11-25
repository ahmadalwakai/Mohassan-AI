import { describe, expect, it } from 'vitest';
import { reasonCalendar } from '../apps/server/src/assistant/reasoning/calendar.js';
import { REASONING_VALUE_ID } from '../apps/server/src/assistant/reasoning/result.js';

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
