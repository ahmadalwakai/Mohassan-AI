import type { CivilDate, HijriIntent, LiveLanguage } from '@mohassan/contracts';
import { lookupMonthName, type Calendar } from '../month-names.js';

const HIJRI = String.raw`(?:hijri(?: calendar)?|islamic(?: civil)? calendar|a\.?h\.?|(?:التقويم )?(?:ال)?هجري|ه)`;
const GREGORIAN = String.raw`(?:gregorian(?: calendar)?|c\.?e\.?|a\.?d\.?|(?:التقويم )?(?:ال)?ميلادي|م)`;
const CALENDAR = `(?:${HIJRI}|${GREGORIAN})`;
const isHijri = new RegExp(`^${HIJRI}$`, 'u');
const calendarOf = (label: string): Calendar => isHijri.test(label) ? 'hijri' : 'gregorian';

const eraStart = new RegExp(`^(?:the )?(${CALENDAR}) +`, 'u');
const eraEnd = new RegExp(String.raw`(?<=\d) *(${CALENDAR})$`, 'u');
const namedDate = /^(?:(\d{1,2})(?:st|nd|rd|th)? (.+?)|(.+?) (\d{1,2})(?:st|nd|rd|th)?)[ ,،]+(\d{1,4})$/u;

function parseDate(text: string): { date: CivilDate; calendar?: Calendar } | undefined {
  let body = text.trim().replace(/^(?:(?:the )?date|التاريخ|تاريخ) +/u, '');
  const head = eraStart.exec(body);
  if (head) body = body.slice(head[0].length);
  const tail = eraEnd.exec(body);
  if (tail) body = body.slice(0, tail.index);
  const calendar = head ? calendarOf(head[1]) : tail ? calendarOf(tail[1]) : undefined;
  if (tail && calendar !== calendarOf(tail[1])) return;
  const numeric = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/u.exec(body);
  if (numeric) return { date: { year: +numeric[1], month: +numeric[3], day: +numeric[4] }, calendar };
  const arabicNumeric = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/u.exec(body);
  if (arabicNumeric) return { date: { year: +arabicNumeric[4], month: +arabicNumeric[3], day: +arabicNumeric[1] }, calendar };
  const named = namedDate.exec(body);
  if (!named) return;
  const alias = lookupMonthName(named[2] ?? named[3]);
  if (!alias || calendar && calendar !== alias.calendar) return;
  return { date: { year: +named[5], month: alias.month, day: +(named[1] ?? named[4]) }, calendar: alias.calendar };
}

const TODAY = /^(?:(?:what(?: is|'s)|show me|give me|tell me) )?(?:the )?(?:today(?:'s)?(?: (?:hijri|islamic))? date(?: in (?:the )?(?:hijri|islamic)(?: calendar)?)?|(?:hijri|islamic)(?: calendar)? date(?: (?:for )?today| right now)?|(?:hijri|islamic) today|date today in (?:the )?(?:hijri|islamic)(?: calendar)?|today in (?:the )?(?:hijri|islamic)(?: calendar)?)$/u;
const TODAY_AR = /^(?:(?:ما(?: هو)?|كم|ماهو|اعطني|احسب|احسب لي|اخبرني|اريد) )?(?:(?:ال)?تاريخ (?:اليوم (?:ب(?:التقويم )?(?:ال)?هجري|الهجري|هجريا?)|الهجري(?: اليوم| الان| لليوم)?)|(?:اليوم|النهارده) (?:كم )?(?:ب(?:التقويم )?(?:ال)?هجري|هجري))$/u;
const SOURCE_FIRST = new RegExp(`^(?:convert|حول) (?:from|من) (${CALENDAR}) (?:to|into|الي) (${CALENDAR})[:،, ]+(.+)$`, 'u');
const EQUIVALENT = new RegExp(`^(?:(?:what is|what's) (?:the )?|(?:ما(?: هو)? )?(?:التاريخ|تاريخ) )?(${CALENDAR}) (?:equivalent of|الموافق|المقابل ل) (.+)$`, 'u');
const BY_DATE = new RegExp(String.raw`^(?:(?:convert|calculate|what is|what's|what was|حول|تحويل|احسب|ما هو|ما|كم يوافق) +)?(.+?)(?: +(?:from|من) +(${CALENDAR}))? +(?:(?:to|into|in|as|الي|ل) +(?:the )?|(?:كم )?يوافق +ب?|[بل])(${CALENDAR})$`, 'u');

export function recognizeHijri(body: string, language: LiveLanguage): HijriIntent | null {
  if (TODAY.test(body) && /\b(?:hijri|islamic)\b/u.test(body) || TODAY_AR.test(body)) {
    return { kind: 'hijri', language, direction: 'today' };
  }
  if (/^calculate a date in the hijri calendar$/u.test(body)) return { kind: 'hijri', language, direction: 'to-hijri' };
  const sourceFirst = SOURCE_FIRST.exec(body);
  const equivalent = EQUIVALENT.exec(body);
  const byDate = BY_DATE.exec(body);
  const target = sourceFirst?.[2] ?? equivalent?.[1] ?? byDate?.[3];
  const input = sourceFirst?.[3] ?? equivalent?.[2] ?? byDate?.[1];
  if (!target || !input) return null;
  const destination = calendarOf(target);
  const declared = sourceFirst?.[1] ?? byDate?.[2];
  const parsed = parseDate(input);
  const origin = declared ? calendarOf(declared) : parsed?.calendar;
  if (origin === destination || destination === 'gregorian' && origin !== 'hijri' && target.length === 1) return null;
  if (!parsed && !sourceFirst && !(equivalent && /\d/u.test(input))) return null;
  // A named Hijri target or source distinguishes a date request from metres (م).
  if (!parsed && target.length === 1 && !declared) return null;
  const date = parsed && (!declared || !parsed.calendar || origin === parsed.calendar) ? parsed.date : undefined;
  return { kind: 'hijri', language, direction: destination === 'hijri' ? 'to-hijri' : 'to-gregorian', date };
}
