import { describe, expect, it } from 'vitest';
import type { CivilDate } from '@mohassan/contracts';
import { formatHijri, gregorianToHijri, hijriToGregorian } from '../apps/server/src/live-data/hijri.js';
import { kacstMonthStarts } from './fixtures/live-data/kacst-month-starts-1440-1450.js';

const DAY_MS = 86_400_000;

const sameDay = (left: CivilDate | undefined, right: CivilDate) => left?.year === right.year
  && left.month === right.month && left.day === right.day;

function requireDate(value: ReturnType<typeof gregorianToHijri>): CivilDate {
  if (!value) throw new Error('Expected a valid calendar date');
  return value.date;
}

function parseIso(iso: string): CivilDate {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function utcDayTime({ year, month, day }: CivilDate): number {
  return Date.UTC(year, month - 1, day);
}

function gregorianParts(time: number): CivilDate {
  const date = new Date(time);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

describe('Hijri calendar', () => {
  it('matches both ways on the first day of every month in the official table for 1440–1450 AH', () => {
    let checkedMonths = 0;
    for (const [year, starts] of Object.entries(kacstMonthStarts)) {
      starts.forEach((start, index) => {
        const gregorian = parseIso(start);
        const hijri = { year: Number(year), month: index + 1, day: 1 };
        expect(hijriToGregorian(hijri)).toEqual({ date: gregorian, method: 'umm-al-qura' });
        expect(gregorianToHijri(gregorian)).toEqual({ date: hijri, method: 'umm-al-qura' });
        checkedMonths++;
      });
    }
    expect(checkedMonths).toBe(11 * 12);
  });

  it('round-trips every Gregorian day in the supported range, including the table join', () => {
    // The civil Friday epoch is July 16 in the Julian calendar. See Reingold's
    // islamic-epoch, retrieved 2026-11-25: https://github.com/EdReingold/calendar-code2/blob/main/calendar.l
    const first = Date.UTC(622, 6, 19);
    const last = Date.UTC(9999, 11, 31);
    for (let time = first; time <= last; time += DAY_MS) {
      const gregorian = gregorianParts(time);
      const hijri = gregorianToHijri(gregorian);
      const back = hijri && hijriToGregorian(hijri.date);
      if (!back || back.method !== hijri?.method || !sameDay(back.date, gregorian)) {
        throw new Error(`Failed Gregorian → Hijri → Gregorian for ${new Date(time).toISOString()}`);
      }
    }
  }, 30_000);

  it('round-trips both ends of every supported Hijri month and enforces official and tabular lengths', () => {
    // Calendar type and intercalary years from Unicode CLDR (retrieved 2026-11-25).
    // https://cldr.unicode.org/development/development-process/design-proposals/islamic-calendar-types
    const civilLeapYears = new Set([2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29]);
    const last = requireDate(gregorianToHijri({ year: 9999, month: 12, day: 31 }));
    for (let year = 1; year <= last.year; year++) {
      const namedMonths = year === last.year ? last.month : 12;
      for (let month = 1; month <= namedMonths; month++) {
        const first = { year, month, day: 1 };
        const start = hijriToGregorian(first);
        if (!start || !sameDay(gregorianToHijri(start.date)?.date, first)) {
          throw new Error(`Failed Hijri → Gregorian → Hijri for the start of ${year}-${month} AH`);
        }
        if (year === last.year && month === last.month) continue;
        const tail = { year, month, day: 30 };
        const thirtieth = hijriToGregorian(tail);
        const lastOfMonth = thirtieth ?? hijriToGregorian({ ...tail, day: 29 });
        const next = month < 12 ? { year, month: month + 1, day: 1 } : { year: year + 1, month: 1, day: 1 };
        const nextStart = requireDate(hijriToGregorian(next));
        const length = (utcDayTime(nextStart) - utcDayTime(start.date)) / DAY_MS;
        const tabularLength = month % 2 === 1 || month === 12 && civilLeapYears.has(year % 30) ? 30 : 29;
        if ((length !== 29 && length !== 30) || (start.method === 'tabular' && length !== tabularLength)
          || Boolean(thirtieth) !== (length === 30) || hijriToGregorian({ ...tail, day: 31 }) !== null
          || !lastOfMonth || !sameDay(gregorianToHijri(lastOfMonth.date)?.date, { ...tail, day: length })) {
          throw new Error(`Invalid Hijri month length or last day for ${year}-${month} AH`);
        }
      }
    }
  });

  it('switches to the approximate method precisely after the captured Umm al-Qura coverage', () => {
    // From the KACST table cited in umm-al-qura-data.ts: the end of 1500 AH is
    // the official starting day plus the sum of every captured month length.
    const finalOfficialDay = { year: 2077, month: 11, day: 16 };
    const firstTabularDay = { year: 2077, month: 11, day: 17 };
    expect(gregorianToHijri(finalOfficialDay)?.method).toBe('umm-al-qura');
    expect(gregorianToHijri(firstTabularDay)).toEqual({
      date: { year: 1501, month: 1, day: 1 }, method: 'tabular',
    });
    expect(hijriToGregorian({ year: 1501, month: 1, day: 1 })).toEqual({
      date: firstTabularDay, method: 'tabular',
    });
  });

  it('rejects invalid dates instead of normalizing them into other months', () => {
    expect(gregorianToHijri({ year: 2025, month: 2, day: 29 })).toBeNull();
    expect(gregorianToHijri({ year: 2025, month: 2, day: 1.5 })).toBeNull();
    expect(gregorianToHijri({ year: 622, month: 7, day: 18 })).toBeNull();
    expect(hijriToGregorian({ year: 1446, month: 13, day: 1 })).toBeNull();
    expect(hijriToGregorian({ year: 0, month: 1, day: 1 })).toBeNull();
    expect(hijriToGregorian({ year: 9999, month: 1, day: 1 })).toBeNull();
  });

  it('formats lunar month names in Arabic and English', () => {
    const date = { year: 1446, month: 9, day: 1 };
    expect(formatHijri(date, 'ar')).toBe('1 رمضان 1446 هـ');
    expect(formatHijri(date, 'en')).toBe('1 Ramadan 1446 AH');
  });
});
