import { describe, expect, it } from 'vitest';
import { calculatePrayerTimes, renderPrayerTimes } from '../apps/server/src/live-data/prayer.js';
import type { CivilDate, LivePlace, PrayerMethod } from '../packages/contracts/src/live-data.js';

// GeoNames via https://geocoding-api.open-meteo.com/v1/search (name, count=1,
// language=en), retrieved 2026-11-25. These are city centers.
const makkah: LivePlace = { name: 'Makkah', latitude: 21.42664, longitude: 39.82563, timezone: 'Asia/Riyadh', countryCode: 'SA' };
const cairo: LivePlace = { name: 'Cairo', latitude: 30.06263, longitude: 31.24967, timezone: 'Africa/Cairo', countryCode: 'EG' };
const london: LivePlace = { name: 'London', latitude: 51.50853, longitude: -0.12574, timezone: 'Europe/London', countryCode: 'GB' };
const newYork: LivePlace = { name: 'New York', latitude: 40.71427, longitude: -74.00597, timezone: 'America/New_York', countryCode: 'US' };
const sydney: LivePlace = { name: 'Sydney', latitude: -33.86785, longitude: 151.20732, timezone: 'Australia/Sydney', countryCode: 'AU' };
const apia: LivePlace = { name: 'Apia', latitude: -13.83333, longitude: -171.76666, timezone: 'Pacific/Apia', countryCode: 'WS' };
const tromso: LivePlace = { name: 'Tromsø', latitude: 69.6489, longitude: 18.95508, timezone: 'Europe/Oslo', countryCode: 'NO' };

const minuteMs = 60_000;
const dayMs = 1440 * minuteMs;
const referenceDate = { year: 2026, month: 11, day: 25 };
const solstice = { year: 2026, month: 6, day: 21 };
const rad = Math.PI / 180;
const sin = (degrees: number) => Math.sin(degrees * rad);
const cos = (degrees: number) => Math.cos(degrees * rad);
const wrap360 = (degrees: number) => (degrees % 360 + 360) % 360;

// Independent reference. Jean Meeus, Astronomical Algorithms, 2nd ed.,
// ch. 12 and 15, https://shopatsky.com/products/astronomical-algorithms-2nd-edition.
// The sidereal time and rise/transit/set equations are also printed in Reda
// and Andreas (NREL), Eq. 28 and Appendix A, https://docs.nlr.gov/docs/fy08osti/34302.pdf.
// Evaluate right ascension and declination directly at each iteration using
// the US Naval Observatory almanac approximation https://aa.usno.navy.mil/faq/sun_approx.
// References retrieved 2026-11-25. This uses sidereal time and hour-angle
// corrections in place of NOAA's equation of time and altitude bisection.
function meeusEvent(date: CivilDate, place: LivePlace, direction: -1 | 0 | 1, target = -50 / 60) {
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  const daysFromJ2000 = (midnight - Date.UTC(2000, 0, 1, 12)) / dayMs;
  const centuries = daysFromJ2000 / 36_525;
  const greenwichMidnight = wrap360(280.46061837 + 360.98564736629 * daysFromJ2000
    + 0.000387933 * centuries ** 2 - centuries ** 3 / 38_710_000);

  function equatorial(days: number) {
    const anomaly = 357.529 + 0.98560028 * days;
    const longitude = 280.459 + 0.98564736 * days + 1.915 * sin(anomaly) + 0.020 * sin(2 * anomaly);
    const obliquity = 23.439 - 0.00000036 * days;
    return {
      rightAscension: Math.atan2(cos(obliquity) * sin(longitude), cos(longitude)) / rad,
      declination: Math.asin(sin(obliquity) * sin(longitude)) / rad,
    };
  }

  const { latitude, longitude } = place;
  const sunAtMidnight = equatorial(daysFromJ2000);
  const transit = wrap360(sunAtMidnight.rightAscension - longitude - greenwichMidnight) / 360;
  const horizonAngle = Math.acos((sin(target) - sin(latitude) * sin(sunAtMidnight.declination))
    / (cos(latitude) * cos(sunAtMidnight.declination))) / rad;
  let event = direction === 0 ? transit : transit + direction * horizonAngle / 360;
  for (let iteration = 0; iteration < 3; iteration++) {
    const { rightAscension, declination } = equatorial(daysFromJ2000 + event);
    const hourAngle = wrap360(greenwichMidnight + 360.985647 * event + longitude - rightAscension + 180) - 180;
    if (direction === 0) {
      event -= hourAngle / 360;
    } else {
      const altitude = Math.asin(sin(latitude) * sin(declination)
        + cos(latitude) * cos(declination) * cos(hourAngle)) / rad;
      event += (altitude - target) / (360 * cos(declination) * cos(latitude) * sin(hourAngle));
    }
  }
  return midnight + event * dayMs;
}

function minutesApart(actual: number | null, reference: number) {
  expect(actual).not.toBeNull();
  return Math.abs(actual! - reference) / minuteMs;
}

function localMinutes(timestamp: number | null, timezone: string) {
  expect(timestamp).not.toBeNull();
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [hours, minutes] = clock.format(Math.round(timestamp! / minuteMs) * minuteMs).split(':').map(Number);
  return hours * 60 + minutes;
}

describe('local prayer times', () => {
  it.each([
    { place: makkah, date: referenceDate },
    { place: cairo, date: { year: 2024, month: 2, day: 29 } },
    { place: london, date: referenceDate },
    { place: london, date: solstice },
    { place: newYork, date: { year: 2026, month: 3, day: 8 } },
    { place: sydney, date: { year: 2026, month: 12, day: 21 } },
  ])('orders events and agrees within one minute of Meeus for $place.name on $date', ({ date, place }) => {
    const { times } = calculatePrayerTimes(date, place);
    const order = [times.fajr, times.sunrise, times.dhuhr, times.asr, times.maghrib, times.isha];
    for (const [index, time] of order.entries()) {
      expect(time).not.toBeNull();
      if (index > 0) expect(time!).toBeGreaterThan(order[index - 1]!);
    }
    expect(minutesApart(times.dhuhr, meeusEvent(date, place, 0))).toBeLessThan(1);
    expect(minutesApart(times.sunrise, meeusEvent(date, place, -1))).toBeLessThan(1);
    expect(minutesApart(times.maghrib, meeusEvent(date, place, 1))).toBeLessThan(1);
  });

  // Method angles copied from https://praytimes.org/docs/calculation on 2026-11-25.
  it.each<{ method: PrayerMethod; fajr: number; isha: number }>([
    { method: 'mwl', fajr: 18, isha: 17 },
    { method: 'egypt', fajr: 19.5, isha: 17.5 },
    { method: 'karachi', fajr: 18, isha: 18 },
    { method: 'isna', fajr: 15, isha: 15 },
  ])('uses $method angles for both twilight events', ({ method, fajr, isha }) => {
    const result = calculatePrayerTimes(referenceDate, makkah, { method });
    expect(result.method).toBe(method);
    expect(minutesApart(result.times.fajr, meeusEvent(referenceDate, makkah, -1, -fajr))).toBeLessThan(1);
    expect(minutesApart(result.times.isha, meeusEvent(referenceDate, makkah, 1, -isha))).toBeLessThan(1);
  });

  it('uses the default Umm al-Qura Fajr angle and switches Isha intervals in Ramadan', () => {
    const ordinary = calculatePrayerTimes(referenceDate, makkah);
    const ramadan = calculatePrayerTimes(referenceDate, makkah, { ramadan: true });
    expect(ordinary.method).toBe('umm-al-qura');
    expect(minutesApart(ordinary.times.fajr, meeusEvent(referenceDate, makkah, -1, -18.5))).toBeLessThan(1);
    expect(minutesApart(ordinary.times.isha, ordinary.times.maghrib!)).toBeCloseTo(90);
    expect(minutesApart(ramadan.times.isha, ramadan.times.maghrib!)).toBeCloseTo(120);
  });

  it('defaults by country and delays Asr with the Hanafi shadow factor', () => {
    expect(calculatePrayerTimes(referenceDate, cairo).method).toBe('egypt');
    expect(calculatePrayerTimes(referenceDate, newYork).method).toBe('isna');
    expect(calculatePrayerTimes(referenceDate, london).method).toBe('mwl');
    expect(calculatePrayerTimes(referenceDate, { ...makkah, countryCode: 'PK' }).method).toBe('karachi');
    const standard = calculatePrayerTimes(referenceDate, cairo);
    const hanafi = calculatePrayerTimes(referenceDate, cairo, { asr: 'hanafi' });
    expect(hanafi.times.asr).toBeGreaterThan(standard.times.asr!);
    expect(hanafi.times.asr).toBeLessThan(hanafi.times.maghrib!);
    expect(hanafi.times.dhuhr).toBe(standard.times.dhuhr);
    expect(renderPrayerTimes(hanafi, 'القاهرة', 'ar')).toContain('حنفي (معامل الظل 2)');
  });

  it.each([
    { rule: 'angle-based' as const, label: 'angle-based', fajrShare: 18 / 60, ishaShare: 17 / 60 },
    { rule: 'one-seventh' as const, label: 'one-seventh of the night', fajrShare: 1 / 7, ishaShare: 1 / 7 },
    { rule: 'middle-of-night' as const, label: 'middle of the night', fajrShare: 1 / 2, ishaShare: 1 / 2 },
  ])('uses the $rule rule on London summer nights and names it', ({ rule, label, fajrShare, ishaShare }) => {
    const result = calculatePrayerTimes(solstice, london, { highLatitude: rule });
    const previous = calculatePrayerTimes({ ...solstice, day: 20 }, london);
    const next = calculatePrayerTimes({ ...solstice, day: 22 }, london);
    const { fajr, sunrise, maghrib, isha } = result.times;
    expect(result.adjusted).toEqual(['fajr', 'isha']);
    expect((sunrise! - fajr!) / (sunrise! - previous.times.maghrib!)).toBeCloseTo(fajrShare, 8);
    expect((isha! - maghrib!) / (next.times.sunrise! - maghrib!)).toBeCloseTo(ishaShare, 8);
    expect(renderPrayerTimes(result, 'London', 'en')).toContain(`${label}, used to estimate Fajr, Isha`);
  });

  it('reports missing polar twilight and horizon events without manufacturing times', () => {
    const result = calculatePrayerTimes(solstice, tromso);
    expect(result.times).toMatchObject({ fajr: null, sunrise: null, maghrib: null, isha: null });
    expect(result.adjusted).toEqual([]);
    expect(renderPrayerTimes(result, 'Tromsø', 'en')).toContain('Sunrise — unavailable astronomically');
  });

  it('uses the geocoded timezone on the international date line and cites the inputs', () => {
    const result = calculatePrayerTimes(referenceDate, apia);
    expect(new Date(result.times.dhuhr!).toISOString().slice(0, 10)).toBe('2026-11-24');
    const text = renderPrayerTimes(result, 'Apia', 'en');
    expect(text).toContain('2026-11-25 (Pacific/Apia)');
    expect(text).not.toContain('(2026-11-24)');
    expect(text).toContain('NOAA solar equations');
    expect(text).toContain('GeoNames');
  });
});

function compareTimetable(place: LivePlace, published: readonly string[]) {
  const { times } = calculatePrayerTimes(referenceDate, place);
  return Object.values(times).map((time, index) => {
    const [hours, minutes] = published[index].split(':').map(Number);
    return localMinutes(time, place.timezone) - (hours * 60 + minutes);
  });
}

describe('2026-11-25 published prayer timetables', () => {
  it('compares Makkah to the official Umm al-Qura row', () => {
    // Retrieved 2026-11-25, page 6 (15 Jumada al-Akhirah). The numerical row
    // is transcribed into 24-hour time from the official Saudi government PDF.
    // https://qurancomplex.gov.sa/files/prayer-calendar-1448-makkah.pdf
    const differences = compareTimetable(makkah, ['05:18', '06:37', '12:08', '15:16', '17:38', '19:08']);
    expect(Math.max(...differences.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('compares Cairo to the Egyptian General Authority of Survey row', () => {
    // Retrieved 2026-11-25. The numerical row is transcribed into 24-hour time.
    // https://www.esa.gov.eg/praytimes.aspx
    const differences = compareTimetable(cairo, ['04:57', '06:28', '11:42', '14:36', '16:55', '18:17']);
    expect(Math.max(...differences.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('compares the London default to the East London Mosque start times', () => {
    // Retrieved 2026-11-25; begins columns and 1 Mithl Asr, transcribed to 24-hour time.
    // https://www.eastlondonmosque.org.uk/prayer-times
    // The mosque applies M25-wide safeguards and uses Hizbul Ulama for dusk.
    // https://www.eastlondonmosque.org.uk/prayer-times-and-calendar-explained
    const [fajr, sunrise, dhuhr, asr, maghrib, isha] = compareTimetable(london, ['05:50', '07:32', '11:53', '13:41', '16:03', '17:39']);
    expect(Math.max(...[sunrise, dhuhr, asr, maghrib].map(Math.abs))).toBeLessThanOrEqual(7);
    expect(fajr).toBeLessThan(-10);
    expect(isha).toBeGreaterThan(10);
  });
});
