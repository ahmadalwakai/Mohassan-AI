/**
 * The live line under the owner's message: what the assistant is doing right now, in the present
 * tense («يقرأ ويكيبيديا…»). Step records keep their noun form («قراءة ويكيبيديا»), as a log reads,
 * so one label serves both without a second string at every call site.
 */

/** Leading nouns whose object reads the same after the verb. Compounds such as «حساب محلي» are left alone. */
const LIVE_FORMS: [RegExp, string][] = [
  [/^البحث في الذاكرة عن /u, 'يبحث في الذاكرة عن '],
  [/^البحث في /u, 'يبحث في '],
  [/^البحث عن /u, 'يبحث عن '],
  [/^إعادة قراءة /u, 'يعيد قراءة '],
  [/^قراءة /u, 'يقرأ '],
  [/^فتح /u, 'يفتح '],
  [/^النقر على /u, 'ينقر على '],
  [/^الضغط على /u, 'يضغط على '],
  [/^ضغط مفتاح/u, 'يضغط مفتاح'],
  [/^الكتابة في /u, 'يكتب في '],
  [/^الكتابة على /u, 'يكتب على '],
  [/^كتابة /u, 'يكتب '],
  [/^اختيار /u, 'يختار '],
  [/^التمرير /u, 'يمرّر '],
  [/^الرجوع/u, 'يرجع'],
  [/^انتظار /u, 'ينتظر '],
  [/^فحص /u, 'يفحص '],
  [/^الحفظ في /u, 'يحفظ في '],
  [/^حفظ /u, 'يحفظ '],
  [/^إرسال /u, 'يرسل '],
  [/^إنشاء /u, 'ينشئ '],
  [/^إعداد /u, 'يعدّ '],
  [/^تحميل /u, 'يحمّل '],
  [/^تنفيذ /u, 'ينفذ '],
  [/^التحقق من /u, 'يتحقق من '],
  [/^تسجيل الدخول/u, 'يسجّل الدخول'],
  [/^إدخال /u, 'يدخل '],
  [/^بدء /u, 'يبدأ '],
  [/^تغيير /u, 'يغيّر '],
];

/** The live form of a step label; sentences and English labels come back unchanged. */
export function liveLabel(label: string): string {
  const text = label.trim();
  for (const [pattern, verb] of LIVE_FORMS) if (pattern.test(text)) return text.replace(pattern, verb);
  return text;
}

export const hostOf = (url: string): string => URL.parse(url)?.hostname.replace(/^www\./, '') ?? url;

/** A site as people call it: «ويكيبيديا», not «ar.wikipedia.org». */
const SITE_NAMES: [RegExp, string][] = [
  [/(^|\.)wikipedia\.org$/, 'ويكيبيديا'], [/(^|\.)bbc\.(com|co\.uk)$/, 'بي بي سي'], [/(^|\.)aljazeera\.(net|com)$/, 'الجزيرة'],
  [/(^|\.)skynewsarabia\.com$/, 'سكاي نيوز عربية'], [/(^|\.)theguardian\.com$/, 'الغارديان'], [/(^|\.)gov\.uk$/, 'GOV.UK'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo'], [/(^|\.)bing\.com$/, 'Bing'],
];
export function siteName(url: string): string {
  const host = hostOf(url);
  return SITE_NAMES.find(([pattern]) => pattern.test(host))?.[1] ?? host;
}

/** «قراءة ويكيبيديا (3 صفحات)» or «قراءة ويكيبيديا وبي بي سي»: each site once, with its page count when it repeats. */
export function readingLabel(urls: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const url of urls) { const name = siteName(url); counts.set(name, (counts.get(name) ?? 0) + 1); }
  const pages = (count: number) => count === 2 ? 'صفحتان' : count <= 10 ? `${count} صفحات` : `${count} صفحة`;
  return `قراءة ${[...counts].map(([name, count]) => count > 1 ? `${name} (${pages(count)})` : name).join(' و')}`;
}
