import { describe, expect, it } from 'vitest';
import { ReminderCalendarExhausted, nextReminderOccurrence, parseReminderDuration, parseReminderTime, shiftReminderTime } from '../apps/server/src/reminders/time.js';

// The UTC oracles use IANA tzdb 2026f (retrieved 2026-11-25 and compiled with zic).
// https://data.iana.org/time-zones/releases/tzdata2026f.tar.gz
// The fixture's intended local civil time is converted using Python datetime with
// ZoneInfo.from_file. For a shifted gap or first repeated hour, use fold=0.
// https://docs.python.org/3/library/zoneinfo.html (retrieved 2026-11-25)
// Calendar durations add days to the local datetime. Elapsed durations add minutes to UTC.
// Columns in order are Arabic, English, IANA zone, fixed now and expected UTC.
const cases = [
  ['ذكرني غدًا الساعة 9 مساءً بالاجتماع', 'remind me tomorrow at 9pm about the meeting', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T18:00:00.000Z'],
  ['ذكرني بعد ساعتين بالاتصال بسامي', 'remind me in 2 hours to call Sami', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T08:00:00.000Z'],
  ['غداً الساعة ٩ صباحاً', 'tomorrow at 9am', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T06:00:00.000Z'],
  ['غدا الساعه ٩ ص', 'tomorrow at 9 a.m.', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T06:00:00.000Z'],
  ['بكرة ٩ بالليل', 'tomorrow at 9 p.m.', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T18:00:00.000Z'],
  ['بكرا الساعة ١٤:٣٠', 'tomorrow at 14:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T11:30:00.000Z'],
  ['يوم الجمعة 10 صباحًا', 'on Friday at 10am', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-27T07:00:00.000Z'],
  ['25 ديسمبر الساعة 14:30', 'December 25th at 14:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-12-25T11:30:00.000Z'],
  ['٢٥ كانون الأول ١٤:٣٠', '25 Dec at 14:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-12-25T11:30:00.000Z'],
  ['اليوم الساعة ١١:٥٨', '11:58 today', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T08:58:00.000Z'],
  ['ذكرني بدفع الفاتورة اليوم الساعة ١٨', 'remind me to pay the bill today at 18', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T15:00:00.000Z'],
  ['بعد نصف ساعة', 'in half an hour', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T06:30:00.000Z'],
  ['بعد ربع ساعة', 'in a quarter of an hour', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T06:15:00.000Z'],
  ['بعد ٤٥ دقيقة', 'in 45 minutes', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T06:45:00.000Z'],
  ['بعد دقيقتين', 'in two minutes', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T06:02:00.000Z'],
  ['بعد يومين', 'in two days', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-27T06:00:00.000Z'],
  ['بعد ٣ أيام', 'in 3 days', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-28T06:00:00.000Z'],
  ['بعد أسبوعين', 'in two weeks', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-12-09T06:00:00.000Z'],
  ['بعد غد الساعة ٢ مساءً', 'the day after tomorrow at 2pm', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-27T11:00:00.000Z'],
  ['١ أكتوبر الساعة ٠٨:٣٠', 'October 1st at 08:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2027-10-01T05:30:00.000Z'],
  ['٢٩ فبراير الساعة ١٢:٠٠', 'February 29 at 12:00', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2028-02-29T09:00:00.000Z'],
  ['٣١ يناير ٢٠٢٧ الساعة ١٢:٠٠', 'January 31, 2027 at 12:00', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2027-01-31T09:00:00.000Z'],
  ['غدًا الساعة ١٢ صباحًا', 'tomorrow at 12am', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T21:00:00.000Z'],
  ['غدًا الساعة ١٢ مساءً', 'tomorrow at 12pm', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T09:00:00.000Z'],
  ['كل يوم الساعة ١٠:٣٠', 'every day at 10:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-25T07:30:00.000Z'],
  ['كل يوم الساعة ٨ صباحا', 'daily at 8am', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T05:00:00.000Z'],
  ['كل أسبوع الإثنين والأربعاء الساعة ٩ ص', 'every Monday and Wednesday at 9am', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-30T06:00:00.000Z'],
  ['أسبوعيًا أيام الخميس والسبت الساعة ١٩:٠٠', 'weekly on Thursdays and Saturdays at 19:00', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T16:00:00.000Z'],
  ['يوم 31 من كل شهر الساعة 9 صباحًا', 'on the 31st of every month at 9am', 'Asia/Riyadh', '2026-01-31T07:00:00Z', '2026-03-31T06:00:00.000Z'],
  ['كل شهر يوم ٣١ الساعة ١٤:٣٠', 'monthly on the 31st at 14:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-12-31T11:30:00.000Z'],
  ['بكرة الساعة ۹:۱۵', 'tomorrow at 09:15', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-26T06:15:00.000Z'],
  ['الاثنين الساعة ١٨:٠٠', 'next Monday at 18:00', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-11-30T15:00:00.000Z'],
  ['بعد اسبوع', 'in one week', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2026-12-02T06:00:00.000Z'],
  ['2027-12-25 الساعة 14:30', '2027-12-25T14:30', 'Asia/Riyadh', '2026-11-25T06:00:00Z', '2027-12-25T11:30:00.000Z'],
  ['غداً الساعة ٠٠:١٥', 'tomorrow at 00:15', 'Asia/Riyadh', '2026-11-29T22:00:00Z', '2026-11-30T21:15:00.000Z'],
  ['أخر الموعد بعد ساعتين', 'in 2 hours', 'Europe/London', '2026-03-29T00:30:00Z', '2026-03-29T02:30:00.000Z'],
  ['بعد ٣ أيام', 'in 3 days', 'Europe/London', '2026-03-27T09:00:00Z', '2026-03-30T08:00:00.000Z'],
  ['غداً الساعة ٩ صباحًا', 'tomorrow at 9am', 'Europe/London', '2026-03-28T09:00:00Z', '2026-03-29T08:00:00.000Z'],
  ['كل يوم الساعة ٠١:٣٠', 'every day at 01:30', 'Europe/London', '2026-03-29T00:30:00Z', '2026-03-29T01:30:00.000Z'],
  ['غداً الساعة ٠٠:٣٠', 'tomorrow at 00:30', 'Europe/London', '2026-03-31T13:00:00Z', '2026-03-31T23:30:00.000Z'],
  ['٢٥ أكتوبر الساعة ٩ صباحًا', 'Oct 25 at 9am', 'Europe/London', '2026-10-24T09:00:00Z', '2026-10-25T09:00:00.000Z'],
  ['بعد يوم', 'in one day', 'Europe/London', '2026-10-24T08:00:00Z', '2026-10-25T09:00:00.000Z'],
  ['غدًا الساعة ٩ صباحاً', 'tomorrow at 9 a.m.', 'Europe/London', '2026-10-31T09:00:00Z', '2026-11-01T09:00:00.000Z'],
  ['كل يوم الساعة ١:٣٠', 'daily at 1:30', 'Europe/London', '2026-10-25T00:00:00Z', '2026-10-25T00:30:00.000Z'],
  ['غداً الساعة ٩ صباحًا', 'tomorrow at 9am', 'America/New_York', '2026-03-07T09:00:00Z', '2026-03-08T13:00:00.000Z'],
  ['بعد ساعتين', 'in 2 hours', 'America/New_York', '2026-03-08T06:00:00Z', '2026-03-08T08:00:00.000Z'],
  ['بعد يوم', 'in one day', 'America/New_York', '2026-03-07T13:00:00Z', '2026-03-08T12:00:00.000Z'],
  ['كل يوم الساعة ٠٢:٣٠', 'every day at 02:30', 'America/New_York', '2026-03-08T06:30:00Z', '2026-03-08T07:30:00.000Z'],
  ['بكرة الساعة ١٠ صباحًا', 'tomorrow at 10am', 'America/New_York', '2026-10-31T13:00:00Z', '2026-11-01T15:00:00.000Z'],
  ['بعد ساعتين', 'in 2 hours', 'America/New_York', '2026-11-01T05:00:00Z', '2026-11-01T07:00:00.000Z'],
  ['بعد يوم', 'in one day', 'America/New_York', '2026-10-31T13:00:00Z', '2026-11-01T14:00:00.000Z'],
  ['كل يوم الساعة ٠١:٣٠', 'every day at 01:30', 'America/New_York', '2026-11-01T05:00:00Z', '2026-11-01T05:30:00.000Z'],
  ['بكرة الساعة ٠٠:١٥', 'tomorrow at 00:15', 'America/New_York', '2026-12-31T23:00:00Z', '2027-01-01T05:15:00.000Z'],
] as const;

describe('deterministic reminder time expressions', () => {
  const expressions = cases.flatMap(([arabic, english, timeZone, now, expected]) =>
    [arabic, english].map(input => [input, timeZone, now, expected] as const));

  it.each(expressions)('parses %s in %s at %s', (input, timeZone, now, expected) => {
    const result = parseReminderTime(input, { timeZone, now: new Date(now) });
    expect(result).toMatchObject({ kind: 'parsed', dueAt: new Date(expected) });
  });
});

describe('reminder clarification and time spans', () => {
  const now = new Date('2026-11-25T06:00:00Z');
  const timeZone = 'Asia/Riyadh';
  const options = { now, timeZone };

  it.each([
    ['remind me tomorrow at 9', 'meridiem'],
    ['ذكرني بكرة الساعة ٩', 'meridiem'],
    ['9', 'meridiem'],
    ['today at 8am', 'past'],
    ['اليوم الساعة ٨ صباحًا', 'past'],
    ['today at 09:00', 'past'],
    ['February 30 at 15:00', 'invalid'],
    ['2026-02-29T09:00', 'invalid'],
    ['remind me at 25:30', 'invalid'],
    ['بعد ٠ ساعة', 'invalid'],
    ['tomorrow at 9am or 10am', 'invalid'],
    ['remind me to call Sami', 'missing'],
  ] as const)('asks about %s (%s)', (input, reason) => {
    expect(parseReminderTime(input, options)).toMatchObject({ kind: 'clarify', reason });
  });

  it('retains the original reminder text and accepts an AM or PM clarification', () => {
    const input = 'ذكرني غدًا في الساعة ٩ بالاجتماع مع Sami';
    const result = parseReminderTime(input, { ...options, meridiem: 'pm' });
    expect(result).toMatchObject({ kind: 'parsed', dueAt: new Date('2026-11-26T18:00:00Z') });
    const { start, end } = result.span!;
    expect(input.slice(start, end)).toBe('غدًا في الساعة ٩');
    expect(`${input.slice(0, start)}${input.slice(end)}`.replace(/\s+/gu, ' ')).toBe('ذكرني بالاجتماع مع Sami');
  });

  it.each([
    ['remind me tomorrow to call Sami', 'tomorrow'],
    ['ذكرني بكرة بالاتصال بسامي', 'بكرة'],
    ['remind me on Friday about the meeting', 'on Friday'],
    ['كل يوم بموعد الدواء', 'كل يوم'],
  ])('marks the date or recurrence when a clock is missing in %s', (input, date) => {
    const result = parseReminderTime(input, options);
    expect(result).toMatchObject({ kind: 'clarify', reason: 'missing' });
    expect(input.slice(result.span?.start, result.span?.end)).toBe(date);
  });

  it('keeps a weekday in the reminder subject', () => {
    expect(parseReminderTime('remind me to send Friday’s invoice', options))
      .toEqual({ kind: 'clarify', reason: 'missing' });
  });

  it('accepts Arabic clock labels with attached Arabic-Indic digits', () => {
    expect(parseReminderTime('غداً الساعة٩ مساءً', options))
      .toMatchObject({ kind: 'parsed', dueAt: new Date('2026-11-26T18:00:00Z') });
  });

  it('recognizes a modified Arabic weekday', () => {
    expect(parseReminderTime('يوم الجمعة القادمة الساعة ٩ صباحًا', options))
      .toMatchObject({ kind: 'parsed', dueAt: new Date('2026-11-27T06:00:00Z') });
  });

  it.each([
    ['Europe/London', '2026-03-28T09:00:00Z', '2026-03-29T01:30'],
    ['America/New_York', '2026-03-07T09:00:00Z', '2026-03-08T02:30'],
  ] as const)('asks for another time in the %s spring gap', (timeZone, fixedNow, input) => {
    expect(parseReminderTime(input, { timeZone, now: new Date(fixedNow) }))
      .toMatchObject({ kind: 'clarify', reason: 'dst_gap' });
  });

  it.each([
    ['Europe/London', '2026-10-24T09:00:00Z', '2026-10-25T01:30', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'],
    ['America/New_York', '2026-10-31T09:00:00Z', '2026-11-01T01:30', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
  ] as const)('asks which occurrence to use in the %s autumn overlap', (timeZone, fixedNow, input, earlier, later) => {
    const options = { timeZone, now: new Date(fixedNow) };
    expect(parseReminderTime(input, options)).toMatchObject({ kind: 'clarify', reason: 'dst_overlap' });
    expect(parseReminderTime(input, { ...options, disambiguation: 'earlier' }))
      .toMatchObject({ kind: 'parsed', dueAt: new Date(earlier) });
    expect(parseReminderTime(input, { ...options, disambiguation: 'later' }))
      .toMatchObject({ kind: 'parsed', dueAt: new Date(later) });
  });

  it('keeps the intended calendar day when a reminder is postponed across DST', () => {
    const timeZone = 'America/New_York';
    const start = new Date('2026-03-07T13:00:00Z');
    const duration = parseReminderDuration('يوم')!;
    expect(shiftReminderTime(start, timeZone, duration)).toEqual(new Date('2026-03-08T12:00:00Z'));
  });
});

describe('wall time recurrence', () => {
  it('records daily, ISO weekday and day of month recurrence with local clock fields', () => {
    const options = { now: new Date('2026-11-25T06:00:00Z'), timeZone: 'Asia/Riyadh' };
    expect(parseReminderTime('كل يوم الساعة ١٠:٣٠', options)).toMatchObject({
      recurrence: { kind: 'daily', hour: 10, minute: 30 },
    });
    expect(parseReminderTime('weekly on Mondays, Fridays, and Sundays at 09:30', options)).toMatchObject({
      recurrence: { kind: 'weekly', weekdays: [1, 5, 7], hour: 9, minute: 30 },
    });
    expect(parseReminderTime('every week on Monday at 09:30', options)).toMatchObject({
      recurrence: { kind: 'weekly', weekdays: [1], hour: 9, minute: 30 },
    });
    expect(parseReminderTime('يوم 31 من كل شهر الساعة 9 صباحًا', options)).toMatchObject({
      recurrence: { kind: 'monthly', dayOfMonth: 31, hour: 9, minute: 0 },
    });
    expect(parseReminderTime('every month on day 31 at 09:30', options)).toMatchObject({
      recurrence: { kind: 'monthly', dayOfMonth: 31, hour: 9, minute: 30 },
    });
  });

  it('returns to the requested hour after a spring gap', () => {
    const recurrence = { kind: 'daily', hour: 1, minute: 30 } as const;
    const timeZone = 'Europe/London';
    const shifted = nextReminderOccurrence(recurrence, timeZone, new Date('2026-03-29T00:30:00Z'));
    expect(shifted).toEqual(new Date('2026-03-29T01:30:00Z'));
    expect(nextReminderOccurrence(recurrence, timeZone, shifted)).toEqual(new Date('2026-03-30T00:30:00Z'));
  });

  it('only schedules the first occurrence of a repeated daily hour', () => {
    const recurrence = { kind: 'daily', hour: 1, minute: 30 } as const;
    const timeZone = 'Europe/London';
    const first = nextReminderOccurrence(recurrence, timeZone, new Date('2026-10-25T00:00:00Z'));
    expect(first).toEqual(new Date('2026-10-25T00:30:00Z'));
    expect(nextReminderOccurrence(recurrence, timeZone, first)).toEqual(new Date('2026-10-26T01:30:00Z'));
  });

  it('skips missing monthly dates and keeps the end of the month', () => {
    const recurrence = { kind: 'monthly', dayOfMonth: 31, hour: 9, minute: 0 } as const;
    expect(nextReminderOccurrence(recurrence, 'Asia/Riyadh', new Date('2026-01-31T06:00:00Z')))
      .toEqual(new Date('2026-03-31T06:00:00Z'));
  });

  it('reports exhaustion beyond the four-digit calendar range', () => {
    const recurrence = { kind: 'daily', hour: 23, minute: 30 } as const;
    const now = new Date('9999-12-31T20:00:00Z');
    const timeZone = 'America/New_York';
    expect(() => nextReminderOccurrence(recurrence, timeZone, now)).toThrow(ReminderCalendarExhausted);
    expect(parseReminderTime('daily at 23:30', { now, timeZone })).toMatchObject({ kind: 'clarify', reason: 'invalid' });
  });
});
