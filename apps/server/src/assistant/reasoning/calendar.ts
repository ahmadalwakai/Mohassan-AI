import type { Lang } from '../mind/contract.js';
import { normalizeRequest, stripCourtesyTail } from '../mind/normalize.js';
import { reasoned, reasoningGap, type ReasoningResult } from './result.js';

type Calendar = 'hijri' | 'gregorian';
type CalendarDate = { year: number; month: number; day: number; calendar?: Calendar };

const DAY_MS = 86_400_000;
const HIJRI_EPOCH = Date.UTC(622, 6, 19) / DAY_MS;
const MAX_YEAR = 9999;
const HIJRI = String.raw`(?:hijri(?: calendar)?|islamic(?: civil)? calendar|a\.?h\.?|(?:التقويم )?(?:الهجري|هجري)|ه)`;
const GREGORIAN = String.raw`(?:gregorian(?: calendar)?|c\.?e\.?|a\.?d\.?|(?:التقويم )?(?:الميلادي|ميلادي)|م)`;
const CALENDAR = `(?:${HIJRI}|${GREGORIAN})`;
const IS_HIJRI = new RegExp(`^${HIJRI}$`, 'u');
const EXPLICIT_HIJRI = new RegExp(String.raw`(?<!\p{L})${HIJRI}(?!\p{L})`, 'u');
const calendarOf = (label: string): Calendar => IS_HIJRI.test(label) ? 'hijri' : 'gregorian';
const otherCalendar = (calendar: Calendar): Calendar => calendar === 'hijri' ? 'gregorian' : 'hijri';

// Islamic civil arithmetic: Friday epoch, alternating months, 11 leap years per 30 years.
// https://www.unicode.org/reports/tr35/tr35-dates.html#Calendar_Elements
function hijriYearStart(year: number): number {
  return HIJRI_EPOCH + (year - 1) * 354 + Math.floor((11 * year + 3) / 30);
}

function hijriMonthStart(year: number, month: number): number {
  return hijriYearStart(year) + (month - 1) * 29 + Math.floor(month / 2);
}

function hijriDay(year: number, month: number, day: number): number | null {
  const start = hijriMonthStart(year, month);
  const next = month < 12 ? hijriMonthStart(year, month + 1) : hijriYearStart(year + 1);
  return day <= next - start ? start + day - 1 : null;
}

function gregorianDay(year: number, month: number, day: number): number | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY_MS;
}

function serial(date: CalendarDate, calendar: Calendar): number | null {
  const { year, month, day } = date;
  if (year < 1 || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return null;
  return calendar === 'hijri' ? hijriDay(year, month, day) : gregorianDay(year, month, day);
}

function toHijri(serialDay: number): Required<CalendarDate> {
  const year = Math.floor((30 * (serialDay - HIJRI_EPOCH) + 10_646) / 10_631);
  let month = 1;
  while (month < 12 && hijriMonthStart(year, month + 1) <= serialDay) month++;
  return { year, month, day: serialDay - hijriMonthStart(year, month) + 1, calendar: 'hijri' };
}

function toGregorian(serialDay: number): Required<CalendarDate> {
  const date = new Date(serialDay * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), calendar: 'gregorian' };
}

const months: Record<Calendar, readonly string[]> = {
  hijri: [
    'muharram|moharram|محرم', 'safar|صفر', 'rabi[’\']? al-awwal|rabi i|ربيع الاول',
    'rabi[’\']? al-thani|rabi ii|ربيع الاخر|ربيع الثاني',
    'jumada al-awwal|jumada i|جمادي الاولي', 'jumada al-thani|jumada ii|جمادي الاخره|جمادي الثانيه',
    'rajab|رجب', 'sha[’\']?ban|شعبان', 'ramadan|ramadhan|رمضان', 'shawwal|شوال',
    'dhu al-qi[’\']?dah|ذو القعده|ذي القعده', 'dhu al-hijjah|ذو الحجه|ذي الحجه',
  ],
  gregorian: [
    'january|jan|يناير|كانون الثاني', 'february|feb|فبراير|شباط', 'march|mar|مارس|اذار',
    'april|apr|ابريل|نيسان', 'may|مايو|ايار', 'june|jun|يونيو|حزيران',
    'july|jul|يوليو|تموز', 'august|aug|اغسطس|اب', 'september|sept|sep|سبتمبر|ايلول',
    'october|oct|اكتوبر|تشرين الاول', 'november|nov|نوفمبر|تشرين الثاني', 'december|dec|ديسمبر|كانون الاول',
  ],
};
const monthAlias = Object.entries(months).flatMap(([calendar, aliases]) =>
  aliases.map((pattern, index) => ({ calendar: calendar as Calendar, month: index + 1, matches: new RegExp(`^(?:${pattern})$`, 'u') })));
const prefix = new RegExp(`^(?:the )?(${CALENDAR}) +`, 'u');
const suffix = new RegExp(` *(${CALENDAR})$`, 'u');
const namedDate = /^(?:(\d{1,2})(?:st|nd|rd|th)? (.+?)|(.+?) (\d{1,2})(?:st|nd|rd|th)?)[ ,،]+(\d{1,4})$/u;

function parseDate(text: string): CalendarDate | null {
  let body = text.trim().replace(/^(?:(?:the )?date|التاريخ|تاريخ) +/u, '');
  const head = prefix.exec(body);
  if (head) body = body.slice(head[0].length);
  const tail = suffix.exec(body);
  if (tail) body = body.slice(0, tail.index);
  const calendar = head ? calendarOf(head[1]) : tail ? calendarOf(tail[1]) : undefined;
  if (tail && calendar !== calendarOf(tail[1])) return null;

  const numeric = /^(\d{1,4})([-/])(\d{1,2})\2(\d{1,2})$/u.exec(body);
  if (numeric) return { year: Number(numeric[1]), month: Number(numeric[3]), day: Number(numeric[4]), calendar };
  const named = namedDate.exec(body);
  if (!named) return null;
  const alias = monthAlias.find(entry => entry.matches.test(named[2] ?? named[3]));
  if (!alias || calendar && calendar !== alias.calendar) return null;
  return { year: Number(named[5]), month: alias.month, day: Number(named[1] ?? named[4]), calendar: alias.calendar };
}

function iso(date: CalendarDate): string {
  return [String(date.year).padStart(4, '0'), String(date.month).padStart(2, '0'), String(date.day).padStart(2, '0')].join('-');
}

function label(date: CalendarDate, calendar: Calendar, lang: Lang): string {
  if (lang === 'ar') return `${iso(date)} ${calendar === 'hijri' ? 'هـ' : 'م'}`;
  return `${iso(date)} ${calendar === 'hijri' ? 'AH' : 'Gregorian'}`;
}

function approximate(lang: Lang, line: string, value: string): ReasoningResult {
  return reasoned(lang, lang === 'ar'
    ? `${line}\nتقريبًا وفق التقويم الهجري الحسابي، وقد يختلف عن التقويم المحلي المعتمد على رؤية الهلال.`
    : `${line}\nApproximate in the arithmetic Islamic calendar. Dates may differ from local moon-sighting calendars.`, value);
}

function invalidDate(lang: Lang): ReasoningResult {
  return reasoningGap(lang, lang === 'ar'
    ? 'أحتاج تاريخًا صالحًا وكاملًا. اكتب السنة ثم الشهر ثم اليوم، وحدد التقويم لكل تاريخ عند المقارنة.'
    : 'Use a valid complete date in year-month-day order and identify each calendar when comparing dates.');
}

const conversion = new RegExp(String.raw`^(?:(?:convert|calculate|حول|احسب) +|(?:what is|what's|ما هو|ما|كم يوافق) +)?(.+?)(?: +(?:from|من) +(${CALENDAR}))? +(?:(?:to|into|in|as|الي|ل|يوافق|كم يوافق) +(?:the )?|ب|ل)(${CALENDAR})$`, 'u');
const conversionWithSource = new RegExp(String.raw`^(?:convert|حول) (?:from|من) (${CALENDAR}) (?:to|into|الي) (${CALENDAR})[:،, ]+(.+)$`, 'u');
const equivalent = new RegExp(String.raw`^(?:what is (?:the )?)?(${CALENDAR}) equivalent of (.+)$`, 'u');
const equivalentArabic = new RegExp(String.raw`^(?:ما |ما هو )?(?:التاريخ |تاريخ )(${CALENDAR}) (?:الموافق|المقابل ل) (.+)$`, 'u');

function convert(input: string, lang: Lang): ReasoningResult | null {
  const sourceFirst = conversionWithSource.exec(input);
  const byDate = conversion.exec(input);
  const byEquivalent = equivalent.exec(input) ?? equivalentArabic.exec(input);
  if (!sourceFirst && !byDate && !byEquivalent) return null;
  const date = parseDate(sourceFirst?.[3] ?? byDate?.[1] ?? byEquivalent![2]);
  const targetLabel = sourceFirst?.[2] ?? byDate?.[3] ?? byEquivalent![1];
  const target = calendarOf(targetLabel);
  const declared = sourceFirst?.[1] ?? byDate?.[2];
  // A short era suffix can also denote a unit, such as "م" for meters.
  if (!date && !declared && (targetLabel.length === 1 || !/^(?:convert\b|حول(?!\p{L}))|\d/u.test(input))) return null;
  const source = declared ? calendarOf(declared) : date?.calendar ?? otherCalendar(target);
  if (!date || date.calendar && date.calendar !== source || source === target) return invalidDate(lang);
  const days = serial(date, source);
  if (days === null || days < HIJRI_EPOCH) return invalidDate(lang);
  const result = target === 'hijri' ? toHijri(days) : toGregorian(days);
  if (result.year > MAX_YEAR) return invalidDate(lang);
  return approximate(lang, `${label(date, source, lang)} ≈ ${label(result, target, lang)}`, iso(result));
}

const between = /^(?:how many days (?:are there )?between|(?:what is|calculate|compute) (?:the )?(?:date difference|difference in days|difference|days) between|days between|كم (?:عدد )?(?:يوم|يوما|(?:ال)?ايام) بين|(?:احسب )?(?:فرق الايام|فرق التاريخين|الفارق) بين) (.+?) (?:and |و *)(.+)$/u;
const fromTo = /^(?:how many days (?:are there )?from|days from|كم (?:يوم|يوما|ايام) من|احسب (?:الايام|عدد الايام) من) (.+?) (?:to|until|الي|حتي) (.+)$/u;
const withinHijri = / (?:in (?:the )?(?:hijri|islamic(?: civil)?) calendar|بالتقويم الهجري)$/u;

function difference(input: string, lang: Lang): ReasoningResult | null {
  const scope = withinHijri.test(input) ? 'hijri' : undefined;
  const phrase = scope ? input.replace(withinHijri, '') : input;
  const range = between.exec(phrase) ?? fromTo.exec(phrase);
  if (!range) return null;
  const left = parseDate(range[1]);
  const right = parseDate(range[2]);
  if (!scope && left?.calendar !== 'hijri' && right?.calendar !== 'hijri' && !(/\d/u.test(phrase) && EXPLICIT_HIJRI.test(phrase))) return null;
  const firstCalendar = left?.calendar ?? scope;
  const secondCalendar = right?.calendar ?? scope;
  if (!left || !right || !firstCalendar || !secondCalendar) return invalidDate(lang);
  if (scope && (firstCalendar !== scope || secondCalendar !== scope)) return invalidDate(lang);
  const first = serial(left, firstCalendar);
  const second = serial(right, secondCalendar);
  if (first === null || second === null) return invalidDate(lang);
  const days = Math.abs(first - second);
  return approximate(lang, lang === 'ar'
    ? `الفرق بين ${label(left, firstCalendar, lang)} و${label(right, secondCalendar, lang)} هو ${days} يومًا.`
    : `The difference between ${label(left, firstCalendar, lang)} and ${label(right, secondCalendar, lang)} is ${days} days.`, String(days));
}

const englishRamadanLead = String.raw`(?:(?:how many )?days(?: (?:are )?(?:left|remaining))? (?:until|till|to) +)`;
const arabicRamadanLead = String.raw`(?:(?:كم (?:يوم|يوما|ايام)(?: (?:باقي|متبقي))?|(?:كم|كام|قديش|شكد) (?:باقي|بقي|ضايل|متبقي|فاضل|ضل)(?: (?:يوم|ايام))?|(?:باقي|فاضل) (?:كم|كام) يوم) (?:(?:علي|الي|حتي) +|ل *))`;
const ramadanDays = new RegExp(String.raw`^(?:${englishRamadanLead}|${arabicRamadanLead})(?:(?:the )?(?:start|beginning) of |(?:بدايه|اول) )?(?:next |ال)?(?:ramadhan?|ramadan|رمضان)(?: (?:المقبل|الجاي|القادم))?(?: +(\d{1,4})(?: *${HIJRI})?)?$`, 'u');
const dateDistance = /^(?:how many days(?: (?:are )?(?:left|remaining))?|days|كم (?:يوم|يوما|ايام)(?: (?:باقي|متبقي))?) (until|till|since|الي|حتي|علي|منذ) (.+)$/u;

function distance(input: string, lang: Lang, now: Date): ReasoningResult | null {
  const ramadan = ramadanDays.exec(input);
  const request = dateDistance.exec(input);
  const specified = request ? parseDate(request[2]) : null;
  if (!ramadan && specified?.calendar !== 'hijri' && !(request && /\d/u.test(request[2]) && EXPLICIT_HIJRI.test(request[2]))) return null;
  if (!ramadan && !specified) return invalidDate(lang);

  const today = Math.floor(now.getTime() / DAY_MS);
  if (!Number.isFinite(today) || today < HIJRI_EPOCH || today > gregorianDay(MAX_YEAR, 12, 31)!) return invalidDate(lang);
  let date = specified;
  if (ramadan) {
    const current = toHijri(today);
    const start = hijriMonthStart(current.year, 9);
    date = { year: ramadan[1] ? Number(ramadan[1]) : current.year + Number(start < today), month: 9, day: 1, calendar: 'hijri' };
  }
  if (!date) return invalidDate(lang);
  const target = serial(date, 'hijri');
  if (target === null || toGregorian(target).year > MAX_YEAR) return invalidDate(lang);
  const since = request?.[1] === 'since' || request?.[1] === 'منذ';
  const days = since ? today - target : target - today;
  if (days < 0) return reasoningGap(lang, lang === 'ar'
    ? 'التاريخ لا يوافق الاتجاه المطلوب. «منذ» لتاريخ مضى و«حتى» لتاريخ لم يمضِ.'
    : 'The date contradicts the direction. Use “since” for a past date or “until” for a date that has yet to pass.');
  const event = ramadan ? lang === 'ar' ? 'بداية رمضان، ' : 'the start of Ramadan, ' : '';
  const direction = lang === 'ar' ? since ? 'منذ' : 'حتى' : since ? 'since' : 'until';
  const todayLabel = `${iso(toGregorian(today))} UTC`;
  const targetLabel = `${event}${label(date, 'hijri', lang)} (≈ ${label(toGregorian(target), 'gregorian', lang)})`;
  return approximate(lang, lang === 'ar'
    ? `${days} يومًا ${direction} ${targetLabel}، محسوبة من ${todayLabel}.`
    : `${days} days ${direction} ${targetLabel}, measured from ${todayLabel}.`, String(days));
}

export function reasonCalendar(text: string, lang: Lang, now: Date): ReasoningResult | null {
  const body = stripCourtesyTail(normalizeRequest(text).match).replace(/[.!?؟،]+$/u, '').trim().replace(/\s+/gu, ' ')
    .replace(/ لل(هجري|ميلادي)$/u, ' الي ال$1');
  return difference(body, lang) ?? distance(body, lang, now) ?? convert(body, lang);
}
