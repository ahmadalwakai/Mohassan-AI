import { matchText } from './assistant/mind/normalize.js';

export type Calendar = 'hijri' | 'gregorian';
type MonthName = { calendar: Calendar; month: number; standalone?: true };

// Unicode CLDR 48.0.0, Gregorian format-wide names (retrieved 2026-11-27).
// https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-dates-full/main
const gregorian = {
  // ar, ar-EG, ar-SA
  arabic: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  // ar-SY, ar-IQ
  levantine: ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'],
  // ar-DZ, ar-TN
  algerianTunisian: ['جانفي', 'فيفري', 'مارس', 'أفريل', 'ماي', 'جوان', 'جويلية', 'أوت', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  // ar-MA
  moroccan: ['يناير', 'فبراير', 'مارس', 'أبريل', 'ماي', 'يونيو', 'يوليوز', 'غشت', 'شتنبر', 'أكتوبر', 'نونبر', 'دجنبر'],
  // en, then en format-abbreviated (en-GB uses Sept, added below).
  english: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  englishAbbreviated: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
} as const;

// Hijri names, in calendar order. All sources retrieved 2026-11-27.
// CLDR 48.0.0 ar/en ca-islamic-civil.json (format-wide):
// https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-cal-islamic-full/main
// Melaka State Mufti calendar (full English names):
// https://www.muftimelaka.gov.my/kalendar-hijrah?kh_m=3&kh_y=1448&lang=en
// Nepal Hajj Committee 2025 bulletin (Rabi Al Awwal, Jumada Al Oula, Jumada Al Akhira, Dhul Qidah, Dhul Hijjah):
// https://nepalhajj.moha.gov.np/upload/acc976b891007cfa79b7083cebb54551/files/Hajj_Bulletin_2025.pdf
// Central Mosque Rochdale (Rabi Al Awwal) and UAE Ministry of Foreign Affairs (Dhul Hijjah):
// https://centralmosquerochdale.com/prayer-times/prayer-times-archive/
// https://www.mofa.gov.ae/en/Missions/Manama/UAE-Relationships?tab=visit-country
// Egyptian National Library and Archives (ربيع أول، ربيع آخر، ربيع ثان، ذي القعدة، ذي الحجة):
// https://www.darelkotob.gov.eg/ar-eg/documents/%D8%AF%D9%88%D8%B1%D9%8A%D8%A7%D8%AA/al%20roznama%208.pdf
// Saudi Ministry of Health (ربيع الثاني، جمادى الثانية):
// https://www.moh.gov.sa/ministry/mediacenter/news/pages/news-2017-03-09-004.aspx
// Egyptian text preserved in NYU Arabic Collections Online (ربيع ثاني، جمادى أولى، جمادى ثانية):
// https://mc.dlib.nyu.edu/files/books/nyu_aco001233/nyu_aco001233_lo.pdf
// Library of Arabic Literature handbook, pp. 53–54 (Jumada al-Awwal, Jumada al-Thani):
// https://www.libraryofarabicliterature.org/assets/HANDBOOK-6.15.16.pdf#page=53
// Religious Authority Office of Sayyed Fadlallah (Jumada al-Thaniya):
// https://www.bayynat.org.lb/article/news/57067/friday-is-the-first-day-of-jumada-al-thaniya-1447-ah/en
const hijri = [
  // Telangana government's calendar: https://www.telangana.gov.in/Downloads/calendar-2026/
  ['محرم', 'Muharram', 'Moharram'],
  ['صفر', 'Safar'],
  // Pakistan Cabinet Division: https://cabinet.gov.pk/Detail/OTE2ODBiYmItZmI0MS00NDAwLWE5NGUtYmE1MGVjYzllMzAz
  ['ربيع الأول', 'ربيع أول', 'Rabiʻ I', "Rabi' al-Awwal", 'Rabi-ul-Awwal'],
  ['ربيع الآخر', 'ربيع الثاني', 'ربيع آخر', 'ربيع ثان', 'ربيع ثاني', 'Rabiʻ II', "Rabi' al-Thani"],
  ['جمادى الأولى', 'جمادى أولى', 'Jumada I', 'Jumada al-Ula', 'Jumada Al Oula', 'Jumada al-Awwal'],
  ['جمادى الآخرة', 'جمادى الثانية', 'جمادى ثانية', 'Jumada II', 'Jumada al-Akhirah', 'Jumada Al Akhira', 'Jumada al-Thani', 'Jumada al-Thaniya'],
  ['رجب', 'Rajab'],
  ['شعبان', 'Shaʻban'],
  // Brunei Darussalam Central Bank: https://www.bdcb.gov.bn/publications/details?id=01khjvp88thgvj7ma08e4va0qd
  ['رمضان', 'Ramadan', 'Ramadhan'],
  ['شوال', 'Shawwal'],
  // Saudi Ministry of Health (Dhul-Qadah): https://www.moh.gov.sa/en/ministry/mediacenter/news/pages/news-2014-10-02-001.aspx
  ['ذو القعدة', 'ذي القعدة', 'Dhuʻl-Qiʻdah', "Dhu al-Qi'dah", 'Dhul Qidah', 'Dhul-Qadah'],
  ['ذو الحجة', 'ذي الحجة', 'Dhuʻl-Hijjah', 'Dhu al-Hijjah', 'Dhul Hijjah'],
] as const;

function monthKey(name: string): string {
  return matchText(name).replace(/['‘’ʻʼʿ]/gu, '').replace(/[-‐‑\s]+/gu, ' ').trim();
}

const monthNames = new Map<string, MonthName>();
// Preserve the existing number-free conversation operands. آب folds to أب.
const standaloneNames = new Set<string>([
  ...gregorian.arabic, ...gregorian.english, ...gregorian.englishAbbreviated,
  ...gregorian.levantine.filter(name => name !== 'آب' && !name.includes(' ')),
]);
for (const names of Object.values(gregorian)) {
  names.forEach((name, index) => {
    const month: MonthName = { calendar: 'gregorian', month: index + 1 };
    if (standaloneNames.has(name)) month.standalone = true;
    monthNames.set(monthKey(name), month);
  });
}
// CLDR en-GB format-abbreviated, and Egypt's CAPMAS bilingual calendar headings (retrieved 2026-11-27).
// https://github.com/unicode-org/cldr-json/blob/48.0.0/cldr-json/cldr-dates-full/main/en-GB/ca-gregorian.json
// https://censusinfo.capmas.gov.eg/metadata-en-v4.2/index.php/catalog/398/download/817
monthNames.set(monthKey('Sept'), { calendar: 'gregorian', month: 9, standalone: true });
monthNames.set(monthKey('يونيه'), { calendar: 'gregorian', month: 6 });
monthNames.set(monthKey('يوليه'), { calendar: 'gregorian', month: 7 });

hijri.forEach((names, index) => {
  const month: MonthName = { calendar: 'hijri', month: index + 1 };
  for (const name of names) {
    const key = monthKey(name);
    monthNames.set(key, month);
    // A detached transliterated article is optional, as in "Rabi Awwal".
    // https://icpeoria.org/wp-content/uploads/2025/09/2025_ICP_PrayerSchedule-v2-Asr.pdf (retrieved 2026-11-27)
    monthNames.set(key.replace(/ al /u, ' '), month);
  }
});

export function lookupMonthName(name: string): MonthName | undefined {
  return monthNames.get(monthKey(name));
}

export const monthNameKeys: readonly string[] = [...monthNames.keys()];
export const maxMonthNameWords = Math.max(...monthNameKeys.map(name => name.split(' ').length));
