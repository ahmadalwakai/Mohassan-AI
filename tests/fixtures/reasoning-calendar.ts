import type { DevelopmentCase } from './reasoning-development.js';

const calendarCase = (id: string, request: string, expected: string | null): DevelopmentCase => ({
  id: `calendar-${id}`, category: 'calendar', request, expected,
});

function arabicDigits(value: string): string {
  return value.replace(/\d/gu, digit => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]);
}

// Development checks only. These civil-calendar month starts are fixed from
// local ICU islamic-civil reference data. UTC day offsets enumerate exact
// conversions independently of the application. No AI generation or training.
const monthStarts = [
  '2024-07-08', '2024-08-07', '2024-09-05', '2024-10-05', '2024-11-03', '2024-12-03',
  '2025-01-01', '2025-01-31', '2025-03-01', '2025-03-31', '2025-04-29', '2025-05-29',
] as const;
const monthCases = monthStarts.flatMap((first, month) => [0, 1, 28].flatMap((offset, wording) => {
  const gregorian = new Date(`${first}T00:00:00Z`);
  gregorian.setUTCDate(gregorian.getUTCDate() + offset);
  const gregorianDate = gregorian.toISOString().slice(0, 10);
  const hijriDate = `1446-${String(month + 1).padStart(2, '0')}-${String(offset + 1).padStart(2, '0')}`;
  const forward = [
    `Convert ${gregorianDate} Gregorian to Hijri`,
    `حوّل ${arabicDigits(gregorianDate)} م إلى الهجري`,
    `What's ${gregorianDate} in the Islamic calendar?`,
  ];
  const reverse = [
    `Convert from Hijri to Gregorian: ${hijriDate}`,
    `${arabicDigits(hijriDate)}هـ كم يوافق ميلادي؟`,
    `What is the Gregorian equivalent of ${hijriDate} AH?`,
  ];
  return [
    calendarCase(`month-${month + 1}-offset-${offset}-hijri`, forward[wording], hijriDate),
    calendarCase(`month-${month + 1}-offset-${offset}-gregorian`, reverse[wording], gregorianDate),
  ];
}));

export const calendarCases: readonly DevelopmentCase[] = [
  ...monthCases,
  calendarCase('epoch', 'Convert 1 Muharram 1 AH to Gregorian', '0622-07-19'),
  calendarCase('pre-epoch', 'Convert 0622-07-18 Gregorian to Hijri', null),
  calendarCase('leap-day', 'Convert 0002-12-30 AH to CE', '0624-06-26'),
  calendarCase('last-day', 'Convert 0001-12-29 AH to Gregorian', '0623-07-07'),
  calendarCase('common-year-invalid', 'Convert 0001-12-30 AH to Gregorian', null),
  calendarCase('hijri-month-invalid', 'Convert 1446-08-30 AH to Gregorian', null),
  calendarCase('gregorian-leap', 'Convert February 29, 2024 to Hijri', '1445-08-19'),
  calendarCase('gregorian-century-invalid', 'Convert February 29, 1900 to Hijri', null),
  calendarCase('hijri-year-zero', 'Convert 0000-01-01 AH to Gregorian', null),
  calendarCase('hijri-month-thirteen', 'Convert 1446-13-01 AH to Gregorian', null),
  calendarCase('era-conflict', 'Convert 1446-09-01 AH from Gregorian to Hijri', null),
  calendarCase('arabic-named-month', 'ما التاريخ الهجري الموافق ١ آذار ٢٠٢٥؟', '1446-09-01'),
  calendarCase('arabic-named-hijri', 'حوّل ٢٩ ذو القعدة ١٤٤٦ إلى ميلادي', '2025-05-27'),
  calendarCase('same-calendar', 'حول ۱۴۴۶/۰۹/۰۱ هجري للهجري', null),
  calendarCase('persian-digits-convert', 'حول ۱۴۴۶/۰۹/۰۱ هجري للميلادي', '2025-03-01'),
  calendarCase('mixed-date-range', 'How many days between 2025-02-20 Gregorian and 1446-09-01 AH?', '9'),
  calendarCase('mixed-date-range-reversed', 'Days between 1446-09-01 AH and 2025-02-20 Gregorian', '9'),
  calendarCase('mixed-date-range-zero', 'How many days between 1 Ramadan 1446 and March 1, 2025?', '0'),
  calendarCase('named-date-range', 'What is the difference in days between 29 Sha’ban 1446 and 1 Shawwal 1446?', '31'),
  calendarCase('scoped-date-range', 'How many days from 1446-09-01 to 1446-10-01 in the Hijri calendar?', '30'),
  calendarCase('arabic-date-range', 'كم يوم بين ١ محرم ١ هجري و٨ يوليو ٦٢٣ م؟', '354'),
  calendarCase('ambiguous-date-range', 'How many days between 2025-02-20 and 1446-09-01 AH?', null),
  calendarCase('range-invalid-day', 'How many days between 1446-08-30 AH and 1446-09-01 AH?', null),
  calendarCase('ramadan-english', 'How many days until Ramadan?', '9'),
  calendarCase('ramadan-msa', 'كم يومًا حتى بداية رمضان؟', '9'),
  calendarCase('ramadan-gulf', 'كم باقي على رمضان؟', '9'),
  calendarCase('ramadan-egyptian', 'فاضل كام يوم على رمضان؟', '9'),
  calendarCase('ramadan-levantine', 'قديش ضايل لرمضان؟', '9'),
  calendarCase('ramadan-iraqi', 'شكد باقي لرمضان؟', '9'),
  calendarCase('ramadan-specific', 'Days until Ramadan 1447 AH', '363'),
  calendarCase('ramadan-specific-arabic', 'كم باقي على رمضان ١٤٤٧هـ؟', '363'),
  calendarCase('days-since', 'How many days since 1 Sha’ban 1446?', '20'),
  calendarCase('days-until', 'كم يوم باقي حتى ١ رمضان ١٤٤٦؟', '9'),
  calendarCase('days-until-past', 'How many days until 1446-08-01 AH?', null),
  calendarCase('days-since-future', 'كم يوم منذ ١ رمضان ١٤٤٦؟', null),
];
