import type { CivilDate, LiveDataIntent, LiveLanguage, PrayerIntent, WeatherIntent } from '@mohassan/contracts';
import { matchText, normalizeRequest, stripCourtesyTail } from '../assistant/mind/normalize.js';
import { recognizeHijri } from './recognize-calendar.js';
import { recognizeMarket } from './recognize-market.js';

const CITY = /^[\p{L}\p{M}][\p{L}\p{M}.'’ -]*(?:[,،] *[\p{L}\p{M}][\p{L}\p{M}.'’ -]*){0,2}$/u;
const NOT_CITY = /\b(?:and|or|then|again|near me|my (?:city|area|location)|what|mean(?:ing|s)?|how to|history|app|video|poem|poetry|literature|weather|prayer|forecast|sales|prediction|article|with|using|use|dynamics|station|tomorrow)\b|(?:^| )(?:ثم|معني|كلمه|تعريف|الفرق|مقال|بحث|قصيده|فيلم|قريبي|منطقتي|مدينتي|مكاني|ديني|المعموديه|الزواج|العيد|غدا?|بكره)(?= |$)/u;
const LOCAL_PLACE = /^(?:near me|(?:in|for) my (?:city|area|location)|بالقرب مني|عندي|في (?:مدينتي|منطقتي))$/u;

export function cityName(input: string): string | undefined {
  const name = input.trim().replace(/ +/gu, ' ').replace(/[.!?؟]+$/u, '').trim();
  return name.length <= 100 && name.split(' ').length <= 12 && CITY.test(name) && !NOT_CITY.test(matchText(name)) ? name : undefined;
}

function restoreCityMarks(place: string, request: string): string {
  // Matching folds Arabic vowel marks. Restore the user's spelling for the
  // geocoder, where عُمان and عمّان can denote different places.
  if (!/\p{Script=Arabic}/u.test(place)) return place;
  const pattern = [...place].map(char => {
    if (char === ' ') return '\\s+';
    const escaped = char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return /\p{Script=Arabic}/u.test(char) ? `${escaped}\\p{M}*` : escaped;
  }).join('');
  const found = new RegExp(`(?<![\\p{L}\\p{M}])${pattern}(?![\\p{L}\\p{M}])`, 'u').exec(request.normalize('NFKC'))?.[0];
  return (found && cityName(found)) || place;
}

const EN_INTRO = String.raw`(?:(?:what(?: is|'s| are| time is| time are)|when(?: is| are| does| do)|show me|give me|tell me|check|find|get|i want|can you (?:show|tell|give) me) )?(?:the )?`;
const AR_INTRO = String.raw`(?:(?:ما(?: هو| هي)?|ماهو|ماهي|كم|متي|اعطني|اعطيني|ارني|اخبرني|اريد|ابي|ابغي|بدي|وش|ايش|كيف|احسب(?: لي)?) )?`;
const TODAY = String.raw`(?:today(?:'s)?|now|right now|اليوم|الان|حاليا|النهارده)`;
const TOMORROW = String.raw`(?:tomorrow(?:'s)?|غدا|غد|بكره)`;
const HOURLY = String.raw`(?:(?:(?:for )?(?:the )?next )?24(?:-| )?(?:hours?|h)|hourly|(?:(?:ال|للـ?)?24 ساعه)(?: القادمه| المقبله)?|(?:خلال |ل)?(?:ال)?ساعات القادمه|ساعه بساعه)`;
const DAILY = String.raw`(?:(?:(?:for )?(?:the )?next )?7(?:-| )days?|(?:next|this) week|weekly|(?:ال|ل)?7 ايام(?: القادمه| المقبله)?|(?:لمده |ل)?(?:سبعه|سبع) ايام|(?:هذا |هدا )?(?:ال|لل)اسبوع(?: القادم| المقبل)?)`;
const WHEN_WEATHER = `(?:${HOURLY}|${DAILY}|${TODAY}|current)`;
const WEATHER_EN = String.raw`(?:weather(?: forecast| conditions| report)?|temperature|(?:7(?:-| )day|24(?:-| )hour|weekly|hourly) (?:weather )?forecast)`;
const WEATHER_AR = String.raw`(?:(?:ال)?طقس|(?:ال)?جو|(?:حاله|احوال) (?:ال)?طقس|توقعات (?:ال)?طقس|نشره (?:ال)?طقس|(?:درجه )?الحراره)`;
const WEATHER_HEAD = new RegExp(`^(?:${EN_INTRO}|${AR_INTRO})(?:(?<before>${WHEN_WEATHER}) )?(?<topic>${WEATHER_EN}|${WEATHER_AR})(?= |$)`, 'u');
const WEATHER_WHEN = new RegExp(`(?:^| +)(?:for |لمده |خلال )?(?<when>${WHEN_WEATHER})$`, 'u');
const WEATHER_FIRST = new RegExp(`^(?<when>${WHEN_WEATHER})(?= |$)`, 'u');
const WEATHER_HOURLY = new RegExp(`^(?:${HOURLY}|(?:24(?:-| )hour|hourly) (?:weather )?forecast)$`, 'u');
const WEATHER_DAILY = new RegExp(`^(?:${DAILY}|(?:7(?:-| )day|weekly) (?:weather )?forecast)$`, 'u');
const PLACE_PREPOSITION = /^(?:(?:in|at|for|في|بمدينه|لمدينه|مدينه) +|ب(?=\p{Script=Arabic}))/u;

function weatherIntent(body: string, original: string, language: LiveLanguage): WeatherIntent | null {
  const head = WEATHER_HEAD.exec(body);
  if (!head) return null;
  let offset = head[0].length;
  let tail = body.slice(offset).trimStart();
  offset = body.length - tail.length;
  const whenFirst = WEATHER_FIRST.exec(tail);
  if (whenFirst) {
    tail = tail.slice(whenFirst[0].length).trimStart();
    offset = body.length - tail.length;
  }
  const whenLast = WEATHER_WHEN.exec(tail);
  if (whenLast) tail = tail.slice(0, whenLast.index).trimEnd();
  const when = head.groups?.before ?? whenFirst?.groups?.when ?? whenLast?.groups?.when ?? head.groups?.topic ?? '';
  const period = WEATHER_HOURLY.test(when) ? 'hourly' : WEATHER_DAILY.test(when) ? 'daily' : 'current';
  if (!tail || LOCAL_PLACE.test(tail)) return { kind: 'weather', language, period };
  const preposition = PLACE_PREPOSITION.exec(tail);
  const directCity = /^(?:weather|الطقس|طقس|الجو|جو)$/u.test(head.groups?.topic ?? '');
  const place = (preposition || directCity) && cityName(original.slice(offset + (preposition?.[0].length ?? 0), offset + tail.length));
  if (!place) return null;
  return { kind: 'weather', language, period, place };
}

const PRAYER_EN = String.raw`(?:prayer (?:times?|schedule|timetable)|salah (?:times?|schedule)|salat times?|(?:time (?:for|of) )?(?:fajr|dhuhr|zuhr|asr|maghrib|isha)(?: prayer)?(?: time| starts?| begins?)?)`;
const PRAYER_AR = String.raw`(?:(?:مواقيت|اوقات|مواعيد|توقيت|موعد|وقت) (?:الصلوات|الصلاه|الاذان|(?:صلاه |اذان )?(?:الفجر|الظهر|العصر|المغرب|العشاء))|(?:الصلوات|اذان (?:الفجر|الظهر|العصر|المغرب|العشاء)))`;
const PRAYER_HEAD = new RegExp(`^(?:${EN_INTRO}|${AR_INTRO})(?:(?<before>${TODAY}|${TOMORROW}) )?(?:${PRAYER_EN}|${PRAYER_AR})(?= |$)`, 'u');
const EXPLICIT_DAY = String.raw`\d{4}-\d{1,2}-\d{1,2}`;
const PRAYER_FIRST = new RegExp(`^(?<day>${TODAY}|${TOMORROW}|${EXPLICIT_DAY})(?= |$)`, 'u');
const PRAYER_LAST = new RegExp(`(?:^| +)(?:on |بتاريخ |يوم )?(?<day>${TODAY}|${TOMORROW}|${EXPLICIT_DAY})$`, 'u');
const PRAYER_OPTIONS = new Map<string, Pick<PrayerIntent, 'method' | 'asr' | 'highLatitude'>>([
  [String.raw`(?:umm (?:al[ -])?qura|ام القري)`, { method: 'umm-al-qura' }],
  [String.raw`(?:mwl|muslim world league|رابطه العالم الاسلامي)`, { method: 'mwl' }],
  [String.raw`(?:egyptian(?: general authority of survey| survey)?|هيئه المساحه المصريه|الهيئه المصريه العامه للمساحه)`, { method: 'egypt' }],
  [String.raw`(?:karachi|university of islamic sciences(?:[ ,]+karachi)?|كراتشي|جامعه العلوم الاسلاميه(?: في كراتشي)?)`, { method: 'karachi' }],
  [String.raw`(?:isna|islamic society of north america|الجمعيه الاسلاميه لامريكا الشماليه|اسنا)`, { method: 'isna' }],
  [String.raw`(?:hanafi(?: asr)?|الحنفي|حنفي|العصر الحنفي)`, { asr: 'hanafi' }],
  [String.raw`(?:standard asr|asr standard|العصر القياسي|العصر العادي)`, { asr: 'standard' }],
  [String.raw`(?:angle[ -]based|قاعده الزاويه|طريقه الزاويه|زاويه الشفق)`, { highLatitude: 'angle-based' }],
  [String.raw`(?:one[ -]seventh(?: of the night)?|1\/7(?: of the night)?|سبع الليل)`, { highLatitude: 'one-seventh' }],
  [String.raw`(?:(?:the )?middle of the night|half(?: of)? the night|منتصف الليل|نصف الليل)`, { highLatitude: 'middle-of-night' }],
]);
const OPTION_SUFFIXES = [...PRAYER_OPTIONS].map(([pattern, options]) => [
  new RegExp(String.raw`(?:^|(?:[,،] *| +)(?:using |with |by |method |high[ -]latitude rule |حسب |وفق |طريقه |بطريقه |بقاعده )*)(?:${pattern})(?: method| rule)?$`, 'u'),
  options,
] as const);

function prayerIntent(body: string, original: string, language: LiveLanguage): PrayerIntent | null {
  const head = PRAYER_HEAD.exec(body);
  if (!head) return null;
  let tail = body.slice(head[0].length).trimStart();
  const offset = body.length - tail.length;
  const options: Omit<PrayerIntent, 'kind' | 'language'> = {};
  for (let found = true; found && tail; ) {
    found = false;
    for (const [pattern, values] of OPTION_SUFFIXES) {
      const match = pattern.exec(tail);
      // “in Karachi” names a city while “using Karachi” names its method.
      if (!match || /(?:^| )(?:in|at|for|في)$/u.test(tail.slice(0, match.index).trimEnd())) continue;
      Object.assign(options, values);
      tail = tail.slice(0, match.index).trimEnd();
      found = true;
      break;
    }
  }
  const first = PRAYER_FIRST.exec(tail);
  const last = first ? null : PRAYER_LAST.exec(tail);
  const when = head.groups?.before ?? first?.groups?.day ?? last?.groups?.day;
  if (when) {
    if (new RegExp(`^${TOMORROW}$`, 'u').test(when)) options.dayOffset = 1;
    else if (/^\d/u.test(when)) {
      const [year, month, day] = when.split('-').map(Number);
      options.date = { year, month, day } satisfies CivilDate;
    }
  }
  const rest = first ? tail.slice(first[0].length).trimStart() : last ? tail.slice(0, last.index).trimEnd() : tail;
  if (rest && !LOCAL_PLACE.test(rest)) {
    const start = offset + (first ? tail.length - rest.length : 0);
    const preposition = PLACE_PREPOSITION.exec(rest);
    const place = preposition && cityName(original.slice(start + preposition[0].length, start + rest.length));
    if (!place) return null;
    options.place = place;
  }
  return { kind: 'prayer', language, ...options };
}

export function recognizeLiveData(request: string): LiveDataIntent | null {
  if (request.length > 500 || /["`«»“”]|https?:|[\n\r]/iu.test(request)) return null;
  const normalized = normalizeRequest(request);
  const original = stripCourtesyTail(normalized.text).replace(/[.!?؟،]+$/u, '').replace(/\s+/gu, ' ').trim();
  const body = matchText(original).replace(/[‘’]/gu, "'");
  const language = /\p{Script=Arabic}/u.test(original) ? normalized.lang : 'en';
  const result = recognizeHijri(body, language)
    ?? prayerIntent(body, original, language)
    ?? weatherIntent(body, original, language)
    ?? recognizeMarket(body, language, original);
  if ((result?.kind === 'prayer' || result?.kind === 'weather') && result.place) {
    result.place = restoreCityMarks(result.place, request);
  }
  return result;
}
