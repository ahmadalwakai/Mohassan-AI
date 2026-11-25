import type { ReminderRecurrence } from '@mohassan/contracts';

// ECMAScript time units and Gregorian calendar arithmetic, retrieved 2026-11-25.
// https://tc39.es/ecma262/#sec-time-values-and-time-range
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Span = { start: number; end: number };
type CalendarDate = { year: number; month: number; day: number };
type WallTime = CalendarDate & { hour: number; minute: number; second?: number; millisecond?: number };
type Duration = { days: number; milliseconds: number; span: Span };
type Clarification = 'meridiem' | 'past' | 'missing' | 'invalid' | 'dst_gap' | 'dst_overlap';
export type ReminderTimeResult =
  | { kind: 'parsed'; dueAt: Date; recurrence: ReminderRecurrence | null; span: Span }
  | { kind: 'clarify'; reason: Clarification; span?: Span };
export type ReminderTimeOptions = {
  now: Date;
  timeZone: string;
  meridiem?: 'am' | 'pm';
  disambiguation?: 'earlier' | 'later';
};

function utcTime(value: WallTime): Date {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second ?? 0, value.millisecond ?? 0);
  return date;
}

function calendarParts(date: Date): CalendarDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function calendarDate(date: CalendarDate): Date {
  return utcTime({ ...date, hour: 0, minute: 0 });
}

function validDate(date: CalendarDate): boolean {
  const checked = calendarParts(calendarDate(date));
  // The API uses four-digit RFC 3339 years (retrieved 2026-11-25).
  // https://www.rfc-editor.org/rfc/rfc3339#section-5.6
  return date.year >= 1 && date.year <= 9999 && checked.year === date.year
    && checked.month === date.month && checked.day === date.day;
}

function validInstant(instant: Date): boolean {
  const year = instant.getUTCFullYear();
  return year >= 1 && year <= 9999;
}

function calendarShift(date: CalendarDate, days: number): CalendarDate {
  return calendarParts(new Date(calendarDate(date).getTime() + days * DAY));
}

function isoWeekday(date: CalendarDate): number {
  return calendarDate(date).getUTCDay() || 7;
}

function localizer(timeZone: string) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return (date: Date) => {
    const values = Object.fromEntries(clock.formatToParts(date).map(({ type, value }) => [type, Number(value)]));
    const { year, month, day, hour, minute, second } = values;
    return { year, month, day, hour, minute, second, millisecond: date.getUTCMilliseconds() };
  };
}

export function reminderLocalTime(date: Date, timeZone: string) {
  return localizer(timeZone)(date);
}

// ECMA-402 local fields and Temporal offset disambiguation, retrieved 2026-11-25.
// https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.formattoparts
// https://tc39.es/proposal-temporal/#sec-temporal-disambiguatepossibleepochnanoseconds
function resolveWallTime(value: WallTime, local: ReturnType<typeof localizer>) {
  const wall = utcTime(value).getTime();
  const offsets = new Set([wall - DAY, wall + DAY].map(probe => utcTime(local(new Date(probe))).getTime() - probe));
  const candidates = [...offsets].map(offset => new Date(wall - offset)).sort((a, b) => +a - +b);
  const exact = candidates.filter(candidate => +utcTime(local(candidate)) === wall);
  return { exact, compatible: exact[0] ?? candidates.at(-1)! };
}

export class ReminderCalendarExhausted extends RangeError {}

export function nextReminderOccurrence(recurrence: ReminderRecurrence, timeZone: string, after: Date): Date {
  const local = localizer(timeZone);
  const { year, month, day } = local(after);
  // A Gregorian month may omit the chosen date. Move to the next month with that date.
  for (let date = { year, month, day }; validDate(date); date = calendarShift(date, 1)) {
    if (recurrence.kind === 'weekly' && !recurrence.weekdays.includes(isoWeekday(date))) continue;
    if (recurrence.kind === 'monthly' && date.day !== recurrence.dayOfMonth) continue;
    const { hour, minute } = recurrence;
    const { compatible } = resolveWallTime({ ...date, hour, minute }, local);
    if (validInstant(compatible) && compatible > after) return compatible;
  }
  throw new ReminderCalendarExhausted('No future occurrence in the supported calendar');
}

// Arabic-Indic and Extended Arabic-Indic decimal digit blocks, retrieved 2026-11-25.
// https://www.unicode.org/charts/PDF/U0600.pdf
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي')
    .replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x0660 : 0x06f0)));
}

function indexedSource(input: string) {
  let normalized = '';
  let offset = 0;
  const offsets: Span[] = [];
  for (const char of input) {
    const start = offset;
    offset += char.length;
    const folded = fold(char);
    if (!folded) {
      const previous = offsets.at(-1);
      if (previous) previous.end = offset;
    }
    for (let index = 0; index < folded.length; index++) offsets.push({ start, end: offset });
    normalized += folded;
  }
  return {
    normalized,
    span(match: RegExpMatchArray): Span {
      const index = match.index!;
      return { start: offsets[index].start, end: offsets[index + match[0].length - 1].end };
    },
  };
}

// Gregorian month and weekday spellings come from the runtime's Unicode CLDR data.
// https://unicode.org/reports/tr35/tr35-dates.html#months_days_quarters_eras (retrieved 2026-11-25)
function calendarNames(field: 'month' | 'weekday') {
  const names = new Map<string, number>();
  const epoch = calendarParts(new Date(0));
  for (const locale of ['en', 'en-GB', 'ar', 'ar-LB', 'ar-MA', 'ar-TN']) {
    const english = locale.startsWith('en');
    const widths = english ? ['long', 'short'] as const : ['long'] as const;
    for (const width of widths) {
      const format = new Intl.DateTimeFormat(locale, { [field]: width, calendar: 'gregory', timeZone: 'UTC' });
      const count = field === 'month' ? 12 : 7;
      for (let index = 1; index <= count; index++) {
        const date = field === 'month' ? calendarDate({ year: epoch.year, month: index, day: 1 })
          : calendarDate(calendarShift(epoch, index - isoWeekday(epoch)));
        const word = fold(format.format(date));
        names.set(word, index);
        if (field === 'weekday' && word.startsWith('ال')) names.set(word.slice(2), index);
        if (field === 'weekday' && english && width === 'long') names.set(`${word}s`, index);
      }
    }
  }
  return names;
}

function alternatives(names: Map<string, number>): string {
  return [...names.keys()].sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+'))
    .join('|');
}

const months = calendarNames('month');
const weekdays = calendarNames('weekday');
const monthName = `(?:${alternatives(months)})`;
const weekdayName = `(?:${alternatives(weekdays)})`;
const weekdaySeparator = String.raw`\s*(?:[,،]\s*(?:(?:and|و)\s*)?|and\s+|و\s*)`;
const weekdayList = String.raw`${weekdayName}(?:${weekdaySeparator}${weekdayName})*`;
const ordinal = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const namedDate = String.raw`(?:${ordinal}\s+${monthName}|${monthName}\s+${ordinal})(?:[,،\s]+\d{4})?`;
const upcomingWeekday = String.raw`القادمه?|التاليه?|الجايه?`;
const weekdayDate = String.raw`(?:(?:next|this|يوم)\s+)?${weekdayName}(?:\s+(?:${upcomingWeekday}))?`;
const dayAfterTomorrow = String.raw`(?:the\s+)?day\s+after\s+tomorrow|بعد\s+(?:غد|بكره)`;
const tomorrow = String.raw`tomorrow|غدا?|الغد|بكره|بكرا`;
const dateLabel = String.raw`(?:(?:on|في|بتاريخ)\s+)?(?:${dayAfterTomorrow}|${tomorrow}|today|اليوم|${namedDate}|${weekdayDate}|\d{4}-\d{2}-\d{2})`;
const daily = String.raw`daily|every\s+day|يوميا|كل\s+يوم`;
const weeklyPrefix = String.raw`(?:weekly\s+on\s+|every\s+(?:week\s+on\s+)?|اسبوعيا\s+(?:(?:يوم|ايام)\s+)?|كل\s+(?:اسبوع\s+)?(?:(?:يوم|ايام)\s+)?)`;
const weekly = `${weeklyPrefix}${weekdayList}`;
const monthly = String.raw`(?:(?:monthly|every\s+month|شهريا|كل\s+شهر)\s+(?:(?:on|the|day|في|يوم)\s+)*${ordinal}|(?:on\s+(?:the\s+)?(?:day\s+)?|يوم\s+)${ordinal}\s+(?:of\s+every\s+month|من\s+كل\s+شهر))`;
const clockPrefix = String.raw`(?:at\s+|(?:(?:في|عند|علي)\s+)?(?:الساعه|ساعه)\s*)`;
const am = String.raw`a\.?m\.?|(?:ب)?الصباح|صباحا?|ص`;
const pm = String.raw`p\.?m\.?|(?:ب)?المساء|مساءا?|م|(?:ب)?الليل|ليلا?|عصرا?`;
const clockToken = String.raw`\d{1,2}(?::\d{2})?(?:\s*(?:${am}|${pm}))?`;
const explicitClock = String.raw`(?:${clockPrefix}${clockToken}|\d{1,2}:\d{2}(?:\s*(?:${am}|${pm}))?|\d{1,2}\s*(?:${am}|${pm}))`;
const start = String.raw`(?<![\p{L}\p{N}_])`;
const end = String.raw`(?![\p{L}\p{N}_:])`;
const clockGap = String.raw`(?:\s+|[,،]\s*)(?:${clockPrefix})?`;
const matchPatterns = [
  String.raw`(?<cycle>${monthly}|${daily}|${weekly})${clockGap}(?<clock>${clockToken})`,
  String.raw`(?<clock>${explicitClock})\s+(?<cycle>${monthly}|${daily}|${weekly})`,
  String.raw`(?<date>\d{4}-\d{2}-\d{2})t(?<clock>\d{2}:\d{2})`,
  String.raw`(?<date>${dateLabel})${clockGap}(?<clock>${clockToken})`,
  String.raw`(?<clock>${explicitClock})\s+(?<date>${dateLabel})`,
  String.raw`(?<clock>${explicitClock})`,
  String.raw`(?<=^\s*)(?<clock>${clockToken})(?=\s*$)`,
].map(pattern => new RegExp(`${start}(?:${pattern})${end}`, 'gu'));
const partialDate = new RegExp(String.raw`${start}(?:${monthly}|${daily}|${weekly}|${dateLabel})(?![\p{L}\p{N}_:'’])`, 'gu');

const measure = String.raw`\d+\s*(?:minutes?|hours?|days?|weeks?|دقائق|دقيقه|ساعه|ساعات|يوم|ايام|اسبوع|اسابيع)`;
const scalar = String.raw`(?:one|an?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:minutes?|hours?|days?|weeks?)`;
const fractional = String.raw`(?:a\s+)?(?:half\s+(?:an?\s+)?|quarter\s+(?:of\s+)?(?:an?\s+)?)hour|(?:ربع|نصف|نص)\s+ساعه`;
const uncounted = String.raw`دقيقه|دقيقتين|دقيقتان|ساعه|ساعتين|ساعتان|يوم|يومين|يومان|اسبوع|اسبوعين|اسبوعان`;
const durationLabel = `${fractional}|${scalar}|${measure}|${uncounted}`;
const relativeLead = String.raw`(?:in|after|بعد)\s+`;
const relative = new RegExp(`${start}${relativeLead}(?<amount>${durationLabel})${end}`, 'gu');
const durationPattern = new RegExp(`${start}(?:${relativeLead})?(?<amount>${durationLabel})${end}`, 'u');

function durationFrom(value: string, span: Span): Duration {
  value = value.replace(/\s+/gu, ' ');
  if (/^(?:ربع|(?:a )?quarter)/u.test(value)) return { days: 0, milliseconds: HOUR / 4, span };
  if (/^(?:نصف|نص|(?:a )?half)/u.test(value)) return { days: 0, milliseconds: HOUR / 2, span };
  const [first, ...rest] = value.split(/\s+/u);
  const unit = rest.join(' ') || first;
  // English short cardinal sequence from CLDR (retrieved 2026-11-25).
  // https://github.com/unicode-org/cldr/blob/main/common/rbnf/en.xml
  const cardinalOrder = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
  const numeral = /^\d+/u.exec(first)?.[0];
  const count = numeral ? Number(numeral) : Math.max(1, cardinalOrder.indexOf(first) + 1)
    * (/(?:تين|تان|مين|مان|عين|عان)$/u.test(unit) ? 2 : 1);
  const measure = unit.replace(/^\d+/u, '');
  if (/^(?:day|يوم|ايام)/u.test(measure)) return { days: count, milliseconds: 0, span };
  if (/^(?:week|اسبوع|اسابيع)/u.test(measure)) return { days: 7 * count, milliseconds: 0, span };
  return { days: 0, milliseconds: count * (/^(?:hour|ساع)/u.test(measure) ? HOUR : MINUTE), span };
}

export function parseReminderDuration(input: string): Duration | null {
  const source = indexedSource(input);
  const match = durationPattern.exec(source.normalized);
  return match ? durationFrom(match.groups!.amount, source.span(match)) : null;
}

export function shiftReminderTime(dueAt: Date, timeZone: string, duration: Duration): Date {
  let base = dueAt;
  if (duration.days) {
    const local = localizer(timeZone);
    const current = local(dueAt);
    const date = calendarShift(current, duration.days);
    if (!validDate(date)) return new Date(NaN);
    base = resolveWallTime({ ...current, ...date }, local).compatible;
  }
  const shifted = new Date(base.getTime() + duration.milliseconds);
  return validInstant(shifted) ? shifted : new Date(NaN);
}

function readDate(value: string, today: CalendarDate): CalendarDate | null {
  const label = value.replace(/^(?:on|في|بتاريخ)\s+/u, '').replace(/\s+/gu, ' ');
  if (label === 'today' || label === 'اليوم') return today;
  if (new RegExp(`^(?:${tomorrow})$`, 'u').test(label)) return calendarShift(today, 1);
  if (new RegExp(`^(?:${dayAfterTomorrow})$`, 'u').test(label)) return calendarShift(today, 2);
  const upcoming = new RegExp(` (?:${upcomingWeekday})$`, 'u');
  const weekday = weekdays.get(label.replace(/^(?:next|this|يوم) /u, '').replace(upcoming, ''));
  if (weekday !== undefined) {
    const days = (weekday - isoWeekday(today) + 7) % 7;
    return calendarShift(today, days || (label.startsWith('next ') || upcoming.test(label) ? 7 : 0));
  }
  if (/^\d{4}-/u.test(label)) {
    const [year, month, day] = label.split('-').map(Number);
    const date = { year, month, day };
    return validDate(date) ? date : null;
  }
  const words = label.replace(/[,،]/gu, ' ').split(/\s+/u);
  const yearPart = words.at(-1)!;
  const explicitYear = /^\d{4}$/u.test(yearPart);
  if (explicitYear) words.pop();
  const dayIndex = words.findIndex(word => /^\d/u.test(word));
  const [dayWord] = words.splice(dayIndex, 1);
  const month = months.get(words.join(' '));
  const day = Number.parseInt(dayWord, 10);
  if (!month || !validDate({ year: 2000, month, day })) return null;
  const date = { year: explicitYear ? Number(yearPart) : today.year, month, day };
  if (explicitYear) return validDate(date) ? date : null;
  // Advance an undated month/day to its next Gregorian date, including leap day.
  while (date.year <= 9999 && (!validDate(date) || calendarDate(date) < calendarDate(today))) date.year++;
  return validDate(date) ? date : null;
}

function readClock(value: string, meridiem?: ReminderTimeOptions['meridiem']) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(.*)$/u.exec(value.replace(new RegExp(`^${clockPrefix}`, 'u'), ''))!;
  const [, hourLabel, minuteLabel, periodLabel] = match;
  const hour = Number(hourLabel);
  const minute = Number(minuteLabel ?? 0);
  if (hour > 23 || minute > 59 || (periodLabel && (hour < 1 || hour > 12))) return 'invalid' as const;
  if (periodLabel) return { hour: hour % 12 + (new RegExp(`^(?:${pm})$`, 'u').test(periodLabel) ? 12 : 0), minute };
  if (hour === 0 || hour > 12 || minuteLabel !== undefined || hourLabel.startsWith('0')) return { hour, minute };
  if (!meridiem) return 'meridiem' as const;
  return { hour: hour % 12 + (meridiem === 'pm' ? 12 : 0), minute };
}

function readRecurrence(value: string, clock: { hour: number; minute: number }): ReminderRecurrence | null {
  if (new RegExp(`^(?:${daily})$`, 'u').test(value)) return { kind: 'daily', ...clock };
  if (new RegExp(`^(?:${monthly})$`, 'u').test(value)) {
    const dayOfMonth = Number(/\d+/u.exec(value)![0]);
    return dayOfMonth >= 1 && dayOfMonth <= 31 ? { kind: 'monthly', dayOfMonth, ...clock } : null;
  }
  const days = value.replace(new RegExp(`^${weeklyPrefix}`, 'u'), '').split(new RegExp(weekdaySeparator, 'u'));
  const uniqueDays = new Set(days.map(day => weekdays.get(day.replace(/\s+/gu, ' '))!));
  return { kind: 'weekly', weekdays: [...uniqueDays].sort((a, b) => a - b), ...clock };
}

export function parseReminderTime(input: string, options: ReminderTimeOptions): ReminderTimeResult {
  const { now, timeZone, meridiem, disambiguation } = options;
  const source = indexedSource(input);
  const [match, ...alternatives] = [relative, ...matchPatterns].flatMap(pattern => [...source.normalized.matchAll(pattern)]);
  if (!match) {
    const partials = [...source.normalized.matchAll(partialDate)].filter(date => {
      // A weekday inside the subject may name the event rather than the reminder.
      return !weekdays.has(date[0]) || !source.normalized.slice(0, date.index).trim()
        || !source.normalized.slice(date.index + date[0].length).trim();
    });
    return { kind: 'clarify', reason: 'missing', ...(partials.length === 1 ? { span: source.span(partials[0]) } : {}) };
  }
  const span = source.span(match);
  if (alternatives.some(alternative => {
    const other = source.span(alternative);
    return other.start >= span.end || other.end <= span.start;
  })) return { kind: 'clarify', reason: 'invalid', span };
  const { amount, clock: clockText, cycle, date: dateText } = match.groups!;
  if (amount) {
    const dueAt = shiftReminderTime(now, timeZone, durationFrom(amount, span));
    return Number.isFinite(dueAt.getTime()) && dueAt > now
      ? { kind: 'parsed', dueAt, span, recurrence: null } : { kind: 'clarify', reason: 'invalid', span };
  }
  const clock = readClock(clockText, meridiem);
  if (typeof clock === 'string') return { kind: 'clarify', reason: clock, span };
  if (cycle) {
    const recurrence = readRecurrence(cycle, clock);
    if (!recurrence) return { kind: 'clarify', reason: 'invalid', span };
    try {
      return { kind: 'parsed', dueAt: nextReminderOccurrence(recurrence, timeZone, now), recurrence, span };
    } catch (error) {
      if (error instanceof ReminderCalendarExhausted) return { kind: 'clarify', reason: 'invalid', span };
      throw error;
    }
  }
  const local = localizer(timeZone);
  const today = calendarParts(calendarDate(local(now)));
  const date = dateText ? readDate(dateText, today) : today;
  if (!date) return { kind: 'clarify', reason: 'invalid', span };
  const { exact } = resolveWallTime({ ...date, ...clock }, local);
  if (!exact.length) return { kind: 'clarify', reason: 'dst_gap', span };
  if (exact.length > 1 && !disambiguation) return { kind: 'clarify', reason: 'dst_overlap', span };
  const dueAt = disambiguation === 'later' ? exact.at(-1)! : exact[0];
  if (!validInstant(dueAt)) return { kind: 'clarify', reason: 'invalid', span };
  return dueAt > now ? { kind: 'parsed', dueAt, recurrence: null, span } : { kind: 'clarify', reason: 'past', span };
}
