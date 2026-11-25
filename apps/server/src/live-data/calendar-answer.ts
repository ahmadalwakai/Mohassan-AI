import type { CivilDate, HijriIntent, LiveLanguage } from '@mohassan/contracts';
import type { PreparedComputationSource } from '../assistant/mind/computation-consumption.js';
import { finishComputationConsumption } from '../assistant/mind/computation-consumption.js';
import { matchText } from '../assistant/mind/normalize.js';
import {
  formatHijri, gregorianToHijri, hijriToGregorian, HIJRI_APPROXIMATE_AR, HIJRI_SOURCES, UMM_AL_QURA_ARCHIVE_DATE,
} from './hijri.js';
import { recognizeHijri } from './recognize-calendar.js';

export const civilDateLabel = ({ year, month, day }: CivilDate) =>
  [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');

export function civilDateInZone(now: Date, timeZone?: string): { date: CivilDate; timeZone: string } {
  let format: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    calendar: 'gregory', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
  };
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timeZone && !/^[+-]/u.test(timeZone) ? timeZone : 'UTC' });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  const parts = Object.fromEntries(format.formatToParts(now).map(({ type, value }) => [type, value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return { timeZone: format.resolvedOptions().timeZone, date: { year, month: Number(parts.month), day: Number(parts.day) } };
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(0);
  shifted.setUTCFullYear(date.year, date.month - 1, date.day + days);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function validCivilDate(date: CivilDate): boolean {
  return date.year >= 1 && date.year <= 9999 && civilDateLabel(addCivilDays(date, 0)) === civilDateLabel(date);
}

export function answerHijri(intent: HijriIntent, now: Date, timeZone?: string) {
  const { direction, language } = intent;
  const ar = language === 'ar';
  const today = direction === 'today' ? civilDateInZone(now, timeZone) : undefined;
  const input = today?.date ?? intent.date;
  const result = input && (direction === 'to-gregorian' ? hijriToGregorian(input) : gregorianToHijri(input));
  if (!result || !input) return {
    status: 'blocked' as const, text: ar
      ? 'اذكر تاريخًا هجريًا أو ميلاديًا صالحًا وكاملًا للتحويل، مع اليوم والشهر والسنة.'
      : 'Specify a complete, valid Hijri or Gregorian date, including the day, month and year.',
  };
  const gregorian = direction === 'to-gregorian' ? result.date : input;
  const hijri = direction === 'to-gregorian' ? input : result.date;
  const date = civilDateLabel(gregorian);
  const lunarDate = formatHijri(hijri, language);
  const value = direction === 'to-gregorian' ? date : civilDateLabel(hijri);
  const official = result.method === 'umm-al-qura';
  const method = official
    ? ar ? 'جدول تقويم أم القرى من مدينة الملك عبد العزيز للعلوم والتقنية' : 'Umm al-Qura month-length table from KACST'
    : ar ? 'التقويم الهجري الحسابي الجدولي' : 'Tabular Islamic civil calendar';
  const source = HIJRI_SOURCES[result.method];
  const line = direction === 'to-gregorian' ? `${lunarDate} ↔ ${date}` : `${date} ↔ ${lunarDate}`;
  const time = today
    ? ar ? `التاريخ الهجري اليوم بحسب التاريخ المحلي ${date} في منطقة ${today.timeZone}.` : `Local date ${date} in ${today.timeZone}.`
    : ar ? `التاريخ الميلادي المحوّل ${date}.` : `Gregorian conversion date ${date}.`;
  const snapshot = official
    ? ar ? `نسخة الجدول المؤرشفة في ${UMM_AL_QURA_ARCHIVE_DATE}.` : `Table snapshot archived on ${UMM_AL_QURA_ARCHIVE_DATE}.`
    : ar ? HIJRI_APPROXIMATE_AR : `Approximate calculation. The date may differ by one day from Umm al-Qura or moon sighting.\n${HIJRI_APPROXIMATE_AR}`;
  return {
    value, date, source, method, status: 'completed' as const,
    text: [line, time, snapshot, `${ar ? 'الطريقة والمصدر' : 'Method and source'} [${method}](${source}).`].join('\n'),
  };
}

function matchHijriSource(source: PreparedComputationSource, language: LiveLanguage) {
  if (!source.valid || source.literal || /[¹²³\u2070-\u209f]/u.test(source.original)) return null;
  return recognizeHijri(matchText(source.input).replace(/[‘’]/gu, "'").replace(/\s+/gu, ' '), language);
}

const calendarConsumption = (source: PreparedComputationSource) =>
  finishComputationConsumption(source, 'date_distance', { start: 0, end: source.input.length });

export function inspectHijri(source: PreparedComputationSource) {
  return matchHijriSource(source, 'en') ? calendarConsumption(source) : null;
}

export function computeHijri(source: PreparedComputationSource, language: LiveLanguage, now: Date, timeZone?: string) {
  const intent = matchHijriSource(source, language);
  if (!intent || !Number.isFinite(now.getTime())) return null;
  const consumption = calendarConsumption(source);
  const result = answerHijri(intent, now, timeZone);
  if (result.status === 'blocked') return { ...result, consumption, claims: [], evidence: [] };
  const evidence = { id: 'hijri-date', source: 'computed' as const, quote: result.text, value: result.value, sourceRef: result.source, title: result.method };
  return {
    status: result.status, text: result.text, consumption, evidence: [evidence],
    claims: [{ text: result.text, support: [evidence.id], status: 'confirmed' as const }],
  };
}
