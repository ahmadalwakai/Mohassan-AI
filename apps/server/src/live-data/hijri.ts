import type { CivilDate, LiveLanguage } from '@mohassan/contracts';
import { UMM_AL_QURA_SOURCE, UMM_AL_QURA_YEAR_MASKS } from './umm-al-qura-data.js';

export { UMM_AL_QURA_ARCHIVE_DATE } from './umm-al-qura-data.js';

export type HijriMethod = 'umm-al-qura' | 'tabular';

interface HijriConversion {
  date: CivilDate;
  method: HijriMethod;
}

export const HIJRI_APPROXIMATE_AR = 'حساب تقريبي، قد يختلف يومًا عن تقويم أم القرى أو رؤية الهلال';
export const HIJRI_SOURCES: Record<HijriMethod, string> = {
  'umm-al-qura': UMM_AL_QURA_SOURCE,
  tabular: 'https://github.com/EdReingold/calendar-code2/blob/main/calendar.l',
};

const DAY_MS = 86_400_000;
// The Friday epoch (16 July 622 in the Julian calendar) in proleptic Gregorian dates.
// https://raw.githubusercontent.com/EdReingold/calendar-code2/main/calendar.l (retrieved 2026-11-25).
const HIJRI_EPOCH = Date.UTC(622, 6, 19) / DAY_MS;
const MAX_GREGORIAN_DAY = Date.UTC(9999, 11, 31) / DAY_MS;
const MONTHS_PER_YEAR = 12;

// The table shares the civil epoch. Its alignment is independently anchored in
// Saudi Royal Court decision 192/H: 1 Ramadan 1446 AH was 1 March 2025 (Umm al-Qura).
// https://www.spa.gov.sa/w2272518 (retrieved 2026-11-25).
const ummAlQuraStarts = new Int32Array(UMM_AL_QURA_YEAR_MASKS.length * MONTHS_PER_YEAR + 1);
ummAlQuraStarts[0] = HIJRI_EPOCH;
for (let index = 0; index < ummAlQuraStarts.length - 1; index++) {
  const yearMask = UMM_AL_QURA_YEAR_MASKS[Math.floor(index / MONTHS_PER_YEAR)];
  const monthBit = index % MONTHS_PER_YEAR;
  ummAlQuraStarts[index + 1] = ummAlQuraStarts[index] + 29 + ((yearMask >> monthBit) & 1);
}
const ummAlQuraEnd = ummAlQuraStarts[ummAlQuraStarts.length - 1];

function validParts({ year, month, day }: CivilDate): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999
    && Number.isInteger(month) && month >= 1 && month <= MONTHS_PER_YEAR
    && Number.isInteger(day) && day >= 1 && day <= 31;
}

function gregorianDay(date: CivilDate): number | null {
  if (!validParts(date)) return null;
  const day = new Date(0);
  day.setUTCFullYear(date.year, date.month - 1, date.day);
  if (day.getUTCMonth() !== date.month - 1 || day.getUTCDate() !== date.day) return null;
  return day.getTime() / DAY_MS;
}

function fromGregorianDay(serial: number): CivilDate {
  const day = new Date(serial * DAY_MS);
  return { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
}

// Civil tabular conversion from Dershowitz and Reingold, Calendrical Calculations,
// fixed-from-islamic and islamic-from-fixed (retrieved 2026-11-25); the same calendar
// convention and formulas as PR #26. The 30-year cycle contains 11 leap days.
// https://raw.githubusercontent.com/EdReingold/calendar-code2/main/calendar.l
function tabularMonthStart(year: number, month: number): number {
  return HIJRI_EPOCH + (year - 1) * 354 + Math.floor((11 * year + 3) / 30)
    + (month - 1) * 29 + Math.floor(month / 2);
}

function tabularHijri(serial: number): CivilDate {
  const year = Math.floor((30 * (serial - HIJRI_EPOCH) + 10_646) / 10_631);
  const priorDays = serial - tabularMonthStart(year, 1);
  const month = Math.floor((11 * priorDays + 330) / 325);
  return { year, month, day: serial - tabularMonthStart(year, month) + 1 };
}

function ummAlQuraHijri(serial: number): CivilDate {
  let low = 0;
  let high = ummAlQuraStarts.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (ummAlQuraStarts[middle] <= serial) low = middle;
    else high = middle;
  }
  return {
    year: Math.floor(low / MONTHS_PER_YEAR) + 1,
    month: low % MONTHS_PER_YEAR + 1,
    day: serial - ummAlQuraStarts[low] + 1,
  };
}

export function gregorianToHijri(date: CivilDate): HijriConversion | null {
  const serial = gregorianDay(date);
  if (serial === null || serial < HIJRI_EPOCH) return null;
  if (serial < ummAlQuraEnd) return { date: ummAlQuraHijri(serial), method: 'umm-al-qura' };
  return { date: tabularHijri(serial), method: 'tabular' };
}

export function hijriToGregorian(date: CivilDate): HijriConversion | null {
  if (!validParts(date)) return null;
  const { year, month, day } = date;
  const index = (year - 1) * MONTHS_PER_YEAR + month - 1;
  const inTable = index < ummAlQuraStarts.length - 1;
  const start = inTable ? ummAlQuraStarts[index] : tabularMonthStart(year, month);
  const next = inTable ? ummAlQuraStarts[index + 1] : month === MONTHS_PER_YEAR
    ? tabularMonthStart(year + 1, 1) : tabularMonthStart(year, month + 1);
  const serial = start + day - 1;
  if (serial >= next || serial > MAX_GREGORIAN_DAY) return null;
  return { date: fromGregorianDay(serial), method: inTable ? 'umm-al-qura' : 'tabular' };
}

// Unicode CLDR wide month names (retrieved 2026-11-25).
// https://github.com/unicode-org/cldr/blob/main/common/main/ar.xml
// https://github.com/unicode-org/cldr/blob/main/common/main/en.xml
const HIJRI_MONTHS: Record<LiveLanguage, readonly string[]> = {
  ar: ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة',
    'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'],
  en: ['Muharram', 'Safar', 'Rabiʻ I', 'Rabiʻ II', 'Jumada I', 'Jumada II',
    'Rajab', 'Shaʻban', 'Ramadan', 'Shawwal', 'Dhuʻl-Qiʻdah', 'Dhuʻl-Hijjah'],
};

export function formatHijri({ year, month, day }: CivilDate, language: LiveLanguage): string {
  return `${day} ${HIJRI_MONTHS[language][month - 1]} ${year} ${language === 'ar' ? 'هـ' : 'AH'}`;
}
