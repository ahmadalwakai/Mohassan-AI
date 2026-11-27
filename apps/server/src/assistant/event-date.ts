/** Surface relations for dated events. Match names and event forms as whole words. */
import { normalizeAnswerDigits } from './answer-check.js';
import { findEventOriginDate } from './event-date-origin.js';

const wordStart = '(?<![\\p{L}\\p{N}’\'-])';
const wordEnd = '(?![\\p{L}\\p{N}’\'-])';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const key = (text: string) => normalizeAnswerDigits(text.toLowerCase().replace(/[ـ\p{M}\p{Cf}]/gu, ''))
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/[‘’]/gu, "'").replace(/\*/gu, ' ');

type Endpoint = 'start' | 'end' | 'range';
const properName = "(?:the\\s+)?\\p{Lu}[\\p{L}'’–-]*(?:\\s+\\p{Lu}[\\p{L}'’–-]*){0,5}";
const place = `(?:in|at|near)\\s+${properName}`;
const byAgent = `by\\s+${properName}`;
const material = '(?:of|from|with)\\s+\\p{L}+(?:-\\p{L}+)*';
type Event = { verb: string; ask?: string; noun?: string; endpoint?: Endpoint; life?: boolean; independence?: boolean; complement?: string; historicalOrigin?: boolean };

// Base event forms and historical date syntax from hands.ts and factual-evidence.ts at 29448ae (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/tree/29448ae/apps/server/src/assistant
const english: readonly Event[] = [
  { verb: 'fall|falls|fell|fallen|collapse[ds]?|comes? down|came down', noun: 'fall|collapse', endpoint: 'end' },
  { verb: 'end(?:s|ed)?|conclude[ds]?', noun: 'end|conclusion', endpoint: 'end' },
  { verb: 'becom(?:e|es|ing) independent|became independent|(?:gain|achieve|declare)(?:s|ed)? independence', noun: 'independence', independence: true },
  { verb: 'born', noun: 'birth', endpoint: 'start', life: true, complement: place },
  { verb: 'di(?:e|es|ed)|pass(?:es|ed)? away', noun: 'death', endpoint: 'end', life: true, complement: place },
  { verb: 'live[ds]?|alive', endpoint: 'range', life: true },
  { verb: 'founded|founds|establish(?:es|ed)?|incorporate[ds]?', ask: 'found', noun: 'founding|foundation|establishment|incorporation', complement: `${byAgent}|${place}`, historicalOrigin: true },
  { verb: 'construct(?:s|ed)?|builds?|built', noun: 'construction', complement: `${material}|${byAgent}|${place}` },
  { verb: 'open(?:s|ed)?|inaugurate[ds]?', noun: 'opening|inauguration', complement: `to the public|${place}`, historicalOrigin: true },
  { verb: 'begins?|began|begun|start(?:s|ed)?|commence[ds]?|originate[ds]?', noun: 'start|beginning', endpoint: 'start', complement: `${byAgent}|${place}`, historicalOrigin: true },
  { verb: 'release[ds]?|publish(?:es|ed)?|premiere[ds]?', noun: 'release|publication|premiere', complement: `to (?:the public|theatres|theaters|cinemas)|${byAgent}|${place}` },
  { verb: 'perform(?:s|ed)?', noun: 'performance', complement: `${byAgent}|${place}` },
  { verb: 'happen(?:s|ed)?|occur(?:s|red)?|take[sn]? place|took place' },
  { verb: 'invent(?:s|ed)?', noun: 'invention', complement: `${byAgent}|${place}` },
  { verb: 'discover(?:s|ed)?', noun: 'discovery', complement: `${byAgent}|${place}` },
  { verb: 'sign(?:s|ed)?', noun: 'signing' },
  { verb: 'dissolve[ds]?', noun: 'dissolution' },
  { verb: 'launch(?:es|ed)?', noun: 'launch' },
];

const arabic: readonly Event[] = [
  { verb: 'سقط(?:ت)?|انهار(?:ت)?', noun: 'سقوط|انهيار', endpoint: 'end' },
  { verb: 'انته[يت]|انقض[يت]', noun: 'انتهاء|نهايه', endpoint: 'end' },
  { verb: 'استقل(?:ت)?', noun: 'استقلال', independence: true },
  { verb: 'ولد(?:ت)?', noun: 'ولاده|مولد', endpoint: 'start', life: true },
  { verb: 'توفي(?:ت)?|مات(?:ت)?', noun: 'وفاه|موت', endpoint: 'end', life: true },
  { verb: 'عاش(?:ت)?', endpoint: 'range', life: true },
  { verb: 'تاسس(?:ت)?|اسس(?:ت)?|انش[ئا](?:ت)?', noun: 'تاسيس|انشاء', historicalOrigin: true },
  { verb: 'بني(?:ت)?', noun: 'بناء' },
  { verb: 'افتتح(?:ت)?', noun: 'افتتاح', historicalOrigin: true },
  { verb: 'بدا(?:ت)?|اندلع(?:ت)?', noun: 'بدء|بدايه|اندلاع', endpoint: 'start', historicalOrigin: true },
  { verb: 'صدر(?:ت)?|نشر(?:ت)?', noun: 'صدور|نشر' },
  { verb: 'حدث(?:ت)?|وقع(?:ت)?', noun: 'حدوث|وقوع' },
  { verb: 'وقع(?:ت)?', noun: 'توقيع' },
  { verb: 'اخترع(?:ت)?', noun: 'اختراع' },
  { verb: 'اكتشف(?:ت)?', noun: 'اكتشاف' },
  { verb: 'اغتيل(?:ت)?', noun: 'اغتيال' },
  { verb: 'توحد(?:ت)?', noun: 'توحيد' },
];

export type EventDateQuestion = { subject: string; lang: 'ar' | 'en'; event: Event };

const modifiers = '(?:(?:be|get|first|officially|originally)\\s+)*';
const englishWhen = /^(?:when|(?:on |in )?what (?:date|day|year))\s+(?:(?:did|does|was|were|is|are)\s+)?(.+)$/u;
const arabicWhen = /^(?:[وف]?متي|في اي (?:عام|سنه|تاريخ|يوم))\s+(.+)$/u;
const arabicPossessionVerb = '(?:نال(?:ت)?|اعلن(?:ت)?|حقق(?:ت)?)';

export function parseEventDateQuestion(question: string): EventDateQuestion | undefined {
  const normalized = key(question).trim().replace(/[\s.!?؟]+$/u, '');
  const lang = arabicWhen.test(normalized) ? 'ar' : 'en';
  const request = (lang === 'ar' ? arabicWhen : englishWhen).exec(normalized)?.[1];
  if (!request) return;
  for (const event of lang === 'ar' ? arabic : english) {
    const verb = `${lang === 'ar' ? '' : modifiers}(?:${event.verb}${event.ask ? `|${event.ask}` : ''})`;
    const head = lang === 'ar' ? `^(?:${verb}${event.noun ? `|(?:تمت?\\s+)?(?:ال)?(?:${event.noun})` : ''})\\s+(.+)$`
      : event.noun && `^(?:the\\s+)?(?:${event.noun})\\s+of\\s+(.+?)(?:\\s+(?:happen(?:ed)?|occur(?:red)?|take place|took place))?$`;
    const tail = `^(.+?)\\s+${verb}$`;
    const possessive = lang === 'ar' && event.independence ? new RegExp(`^${arabicPossessionVerb}\\s+(.+?)\\s+استقلال(?:ها|ه)$`, 'u').exec(request) : null;
    const match = possessive ?? (head ? new RegExp(head, 'u').exec(request) : null) ?? new RegExp(tail, 'u').exec(request);
    const subject = match?.[1]?.trim().replace(/^the\s+/u, '')
      .replace(lang === 'ar' && event.endpoint === 'start' && !event.life ? /^عمليه\s+(?=\S+\s+\S)/u : /^$/u, '');
    if (!subject || /^(?:it|he|she|they|هو|هي|هم)$/u.test(subject)) continue;
    return { subject, lang, event };
  }
}

type DateMatch = { at: number; end: number };
const month = '(?:january|february|march|april|may|june|july|august|september|october|november|december|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر|(?:كانون|تشرين) (?:الاول|الثاني)|شباط|اذار|نيسان|ايار|حزيران|تموز|اب|ايلول|جويليه)';
const era = '(?:bce|bc|ce|ad|قبل الميلاد|(?:ق\\.\\s*)?(?:م(?:يلادي(?:ه)?)?|ه(?:جري(?:ه)?)?))';
const day = '\\d{1,2}(?:st|nd|rd|th)?';
const year = `\\d{1,4}(?:\\s*${era})?`;
const century = '(?:(?:\\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|[a-z]+teenth|twentieth|twenty-first))\\s+century';
const weekdays = ['en', 'ar'].flatMap(locale => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, day) => key(formatter.format(day * 24 * 60 * 60 * 1000)));
}).map(escape).join('|');
const calendarDate = `(?:${day}\\s+(?:(?:of|من)\\s+)?${month}(?:\\s+(?:(?:عام|سنه)\\s+)?${year})?|${month}\\s+${day},?\\s+${year}|${month}\\s+(?:(?:عام|سنه)\\s+)?\\d{3,4}(?:\\s*${era})?)`;
const dateToken = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:(?:${weekdays})[,،]?\\s+)?${calendarDate}|${century}|\\d{4}-\\d{2}-\\d{2}|${era}\\s*\\d{1,4}|\\d{1,4}\\s*${era}|\\d{3,4}s?|\\d{1,2})(?![\\p{L}\\p{N}]|[.,]\\d)`, 'gu');
const timeCue = /(?:^|[^\p{L}])(?:in|on|during|since|from|around|about|circa|between|by|to|عام|سنه|في|يوم|من|الي|بين|حوالي)\s+(?:(?:the|year|عام|سنه|يوم)\s+)*$/u;
const shortYearCue = /(?:^|[^\p{L}])(?:(?:عام|سنه|year)\s+|in\s+(?:the\s+year\s+)?|في\s+(?:(?:عام|سنه)\s+)?)$/u;
const datePrefix = /^\s*(?:(?:the|year|[وف]?في|[وف]?عام|[وف]?سنه|يوم|منذ|in|on|during|around|about|circa|early|late|mid|اوائل|اواخر|منتصف)\s+)*$/u;
const nonDate = /^\s*(?:[%٪]|(?:people|persons|times|years|days|months|hours|soldiers|casualties|مليون|مليار|شخص|عاما|سنه|سنوات|يوما)(?!\p{L}))/u;

function dateMatches(text: string): DateMatch[] {
  return [...text.matchAll(dateToken)].flatMap(match => {
    const [value] = match;
    const at = match.index, end = at + value.length;
    if (/^\d{1,4}$/u.test(value) && (nonDate.test(text.slice(end))
      || (value.length < 3 ? !shortYearCue.test(text.slice(0, at)) : value.length === 3 && !timeCue.test(text.slice(0, at))))) return [];
    return [{ at, end }];
  });
}

const englishBoundary = /\b(?:and|but|then|which|who|that|when|before|after|while|as|since|although|whereas|because|so that|followed by|leading to|led to|pav(?:e[ds]?|ing) the way|result(?:ed|ing|s) in)\b/u;
const arabicBoundary = /(?<!\p{L})(?:ثم|حيث|عندما|حينما|الذي|التي|الذين|بينما|لكن|لان|بعد(?:ما)?|قبل(?:ما)?|مما)(?!\p{L})/u;
const arabicCoordination = `(?<!\\p{L})[وف](?=(?:${arabic.map(event => event.verb).join('|')}|اد[يت]|تسبب(?:ت)?)(?!\\p{L}))`;
const clauseBoundary = new RegExp(`[.!?؟؛;\\n]|[,،](?!\\d)|${englishBoundary.source}|${arabicBoundary.source}|${arabicCoordination}`, 'gu');
const leadingDateTail = /^[\s,،:()]*$/u;

function dateClauses(text: string, dates: readonly DateMatch[], name: RegExp): { at: number; text: string; precededBy: string }[] {
  const protectedSpans = [...dates, ...[...text.matchAll(new RegExp(name.source, 'gu'))].map(match => ({ at: match.index, end: match.index + match[0].length })),
    ...[...text.matchAll(/\([^()]*\)/gu)].map(match => ({ at: match.index, end: match.index + match[0].length }))];
  const clauses = [];
  let at = 0, precededBy = '';
  for (const match of text.matchAll(clauseBoundary)) {
    const cut = match.index;
    if (protectedSpans.some(span => cut >= span.at && cut < span.end)) continue;
    if (/^[,،]$/u.test(match[0]) && dates.some(date => date.at >= at && date.end <= cut
      && datePrefix.test(text.slice(at, date.at)) && leadingDateTail.test(text.slice(date.end, cut)))) continue;
    const clauseText = text.slice(at, cut);
    if (clauseText.trim()) clauses.push({ at, text: clauseText, precededBy });
    at = cut + match[0].length;
    precededBy = match[0];
  }
  clauses.push({ at, text: text.slice(at), precededBy });
  return clauses;
}

function subjectPattern({ subject, lang }: EventDateQuestion): string {
  return lang === 'en' ? escape(subject).replace(/\s+/gu, '\\s+') : subject.split(/\s+/u).map((word, at) => {
    const article = word.startsWith('ال') && word.length > 3 ? '(?:ال)?' : '';
    const bare = article ? word.slice(2) : word;
    // Both spellings occur for the same named subject (https://ar.wikipedia.org/wiki/الغزو_السوفيتي_لبولندا, 2026-11-27).
    const spelling = /^(?:سوفياتي|سوفيتي)$/u.test(bare) ? 'سوفيا?تي' : escape(bare);
    return `${at === 0 ? '[وف]?' : ''}${article}${spelling}`;
  }).join('\\s+');
}

const aside = '(?:\\s*\\([^()]*\\)|\\s*\\[\\d+\\])*';

function arabicStartDescription(event: Event): string | undefined {
  if (event.endpoint !== 'start' || event.life) return;
  // A copula and a type describe the named event. A possessive can refer to its incidents explicitly.
  const eventType = '(?:عمليه|معركه|حرب|ثوره|حمله|صراع|نزاع|حدث|احتجاجات|اضطرابات)';
  const modifiers = '(?:\\s+\\p{L}+(?:ي|يه)){0,4}';
  return `(?:هو|هي)\\s+${eventType}${modifiers}\\s+(?:${event.verb})(?:\\s+(?:احداث|وقائع)(?:ه|ها))?`;
}

function eventPredicates(request: EventDateQuestion, name: string): RegExp[] {
  const { event, lang } = request;
  const verb = `(?:${event.verb})`;
  const noun = event.noun && `(?:${event.noun})`;
  const enPreamble = `${aside}\\s+(?:(?:was|were|is|are|had|been|has|have|got|first|officially|originally)\\s+)*`;
  const arPreamble = `${aside}\\s+(?:(?:قد|تمت?)\\s+)?`;
  const verbPattern = lang === 'ar' ? `(?:[وف]?(?:قد\\s+)?${verb}\\s+${name}|${name}${arPreamble}[وف]?${verb})`
    : `(?:the\\s+)?${name}${enPreamble}${verb}`;
  const nounPattern = noun && (lang === 'ar' ? `(?:[وف]?(?:ال)?${noun}\\s+${name}${event.independence ? `|[وف]?${arabicPossessionVerb}\\s+${name}\\s+${noun}(?:ها|ه)` : ''})`
    : `(?:(?:the\\s+)?${noun}\\s+of\\s+(?:the\\s+)?${name}|${name}'s\\s+${noun})`);
  const description = lang === 'ar' && arabicStartDescription(event);
  const patterns = [verbPattern, ...(nounPattern ? [nounPattern] : []), ...(description ? [`${name}${aside}\\s+${description}`] : [])];
  return patterns.map(pattern => new RegExp(`${wordStart}${pattern}${wordEnd}`, 'gu'));
}

const eventIntro = /^\s*(?:(?:officially|originally|first|كما|[وف]?قد|[وف]?تمت?|[وف]?اعلن(?:ت)?|[وف]?تم الاعلان عن|[وف]?جر[يىت])\s+)*$/u;
const temporalLink = /^(?:[\s,:–—()\[\]-]|\b(?:occurred|happened|took place|was|is|became official|officially|first|in book form|in|on|during|around|about|circa|the|year|at midnight|early|late|mid)\b|(?<!\p{L})(?:ب?دون اعلان رسمي|حدث|وقع|كان|تم|رسميا|في|يوم|عام|سنه|بتاريخ|اوائل|اواخر|منتصف)(?!\p{L}))*$/u;
const independenceOrigin = /^(?:\s+from\s+|\s+(?:عن|من)\s+)[\p{L} .’'-]+?\s+(?:in|on|في|عام|سنه|يوم)\s+$/u;
const uncertain = /\b(?:might|could|would|not|never|alleged)\b|(?<!\p{L})(?:ربما|لم|لن|ليس)(?!\p{L})/u;
const dateRange = /^\s*(?:[–—-]|to|until|and|الي|حتي)\s+(?:(?:عام|سنه)\s+)?$|^\s*[–—-]\s*$/u;

export function isStandaloneEventDate(value: string): boolean {
  const text = key(value).trim().replace(/[.!?؟]+$/u, '');
  const dates = dateMatches(text);
  const first = dates[0], last = dates.at(-1);
  if (!first || !last || !datePrefix.test(text.slice(0, first.at)) || text.slice(last.end).trim()) return false;
  return first === last || dates.length === 2 && dateRange.test(text.slice(first.end, last.at));
}

const arabicBirthLabel = /^\s*(?:ولد(?:ت)?|الولاده|الميلاد|المولد)\s*[:：]?\s*$/u;
const arabicDeathLabel = /\s*[–—-]\s*(?:الوفاه|توفي(?:ت)?|مات(?:ت)?)\s*[:：]?\s*$/u;

/** A lifespan belongs to the person described by the opening, including named birth/death entries. */
function biographyFor(request: EventDateQuestion, text: string, dates: readonly DateMatch[], name: string, title?: string): DateMatch | undefined {
  const { event, lang } = request;
  if (!event.life) return;
  const ownTitle = key(title ?? '').replace(/^(?:wikipedia|ويكيبيديا)\s+[-–—|]\s+/u, '')
    .replace(/\s+[-–—|]\s+(?:wikipedia|ويكيبيديا)$/u, '').replace(/^the\s+/u, '').trim() === request.subject;
  const parts = request.subject.split(/\s+/u);
  let alias = '';
  if (ownTitle && parts.length === 2) {
    const [first, last] = parts as [string, string];
    alias = lang === 'ar' ? `|${escape(first)}\\s+\\p{Script=Arabic}+\\s+${escape(last)}`
      : first.length >= 3 ? `|(?:\\p{L}+\\s+){0,2}${escape(first)}\\p{L}{0,5}\\s+${escape(last)}` : '';
  }
  const trailingName = lang === 'ar' ? '(?:\\s+\\p{Script=Arabic}+){0,2}' : '';
  const opening = new RegExp(`^\\s*(?:the\\s+)?(?:${name}${alias})${wordEnd}${trailingName}[\\s,،]*\\(([^()]*)\\)`, 'u').exec(text);
  if (!opening) return;
  const start = opening[0].indexOf('(') + 1, end = opening[0].length - 1;
  const span = dates.filter(date => date.at >= start && date.end <= end);
  const [first, last] = span;
  if (!first) return;
  const before = text.slice(start, first.at);
  if (!last && event.endpoint === 'start' && /^\s*ولد(?:ت)?\s+في\s*$/u.test(before)) return first;
  if (span.length !== 2 || !last) return;
  const between = text.slice(first.end, last.at);
  const birthName = /^\s*born(?:\s+\p{L}+){0,4}(?:\[\d+\])?\s+$/u.test(before);
  if (!(dateRange.test(between) && (datePrefix.test(before) || birthName))
    && !(arabicBirthLabel.test(before) && arabicDeathLabel.test(between))) return;
  if (event.endpoint === 'start') return first;
  if (event.endpoint === 'end') return last;
  return { at: first.at, end: last.end };
}

function rangeFor(request: EventDateQuestion, text: string, dates: readonly DateMatch[], name: string): { at: number; end: number } | undefined {
  const { endpoint, life } = request.event;
  if (!endpoint || dates.length !== 2) return;
  const [first, last] = dates as [DateMatch, DateMatch];
  if (!dateRange.test(text.slice(first.end, last.at))) return;
  const subject = new RegExp(`^\\s*(?:the\\s+)?${name}${wordEnd}`, 'u').exec(text);
  if (!subject) return;
  const before = text.slice(subject[0].length, first.at);
  const after = text.slice(last.end);
  const parenthetical = /^(?:\s*,\s*or\s+[^()]+)?\s*\(\s*(?:[^()]+;\s*)?$/u.test(before)
    && /^\s*\)[\s,]*(?:was|is|were|هو|هي|كان|كانت)(?!\p{L})/u.test(after);
  const duration = !life && /(?:\b(?:stood|encircled|lasted)\b[^;.!?]*\b(?:from|between)|(?<!\p{L})(?:دامت?|استمرت?|للفتره)\s+من)\s+(?:(?:عام|سنه)\s+)?$/u.test(before);
  if (!parenthetical && !duration) return;
  return endpoint === 'start' ? first : endpoint === 'end' ? last : { at: first.at, end: last.end };
}

export interface EventDateLine {
  hasDate: boolean;
  hasEvent: boolean;
  hasSubject: boolean;
  hasEarlierDate: boolean;
  date?: string;
  dateAt?: number;
  clause?: string;
  inferredRange?: boolean;
  historicalOrigin?: boolean;
}

/** Look for a local date relation and keep the source spelling for evidence and display. */
export function inspectEventDateLine(request: EventDateQuestion, line: string, title?: string): EventDateLine {
  const text = key(line);
  const dates = dateMatches(text);
  const name = subjectPattern(request);
  const subject = new RegExp(`${wordStart}${name}(?:${wordEnd}|(?='s\\b))`, 'u');
  const { event, lang } = request;
  const arPrefix = lang === 'ar' ? '[وف]?(?:بال|لل|ال)?' : '';
  const eventCue = new RegExp(`${wordStart}${arPrefix}(?:${event.verb}${event.noun ? `|${event.noun}` : ''})${wordEnd}`, 'u');
  const info = { hasDate: dates.length > 0, hasEvent: eventCue.test(text), hasSubject: subject.test(text), hasEarlierDate: false };
  if (!info.hasDate) return info;
  const origin = event.historicalOrigin ? findEventOriginDate(request, text, dates, name, title && key(title)) : undefined;
  const rawOffsets = text.length === line.length ? undefined : [...line.matchAll(/[^ـ\p{M}\p{Cf}]/gu)]
    .flatMap(match => Array.from({ length: match[0].length }, (_, offset) => match.index + offset));
  const rawAt = (at: number) => rawOffsets?.[at] ?? (rawOffsets ? line.length : at);
  const complement = event.complement && new RegExp(`^\\s+(?:${event.complement})\\s+(?:in|on|during|around|about|circa)\\s+(?:(?:the|year)\\s+)*$`, 'u');
  const linksDate = (afterPredicate: number, dateAt: number): boolean => {
    const gap = text.slice(afterPredicate, dateAt);
    const rawGap = line.slice(rawAt(afterPredicate), rawAt(dateAt));
    const alias = lang === 'ar' ? /^\s+[A-Z][\p{Script=Latin}'-]*(?=\s)/u.exec(rawGap) : null;
    return temporalLink.test(gap) || Boolean(event.independence && independenceOrigin.test(gap)
      || complement && complement.test(rawGap) || alias && temporalLink.test(key(rawGap.slice(alias[0].length))));
  };
  const bound = (date: { at: number; end: number }, clauseAt: number, clauseEnd: number, hasEarlierDate: boolean): EventDateLine => ({
    ...info, hasEarlierDate, dateAt: rawAt(date.at), date: line.slice(rawAt(date.at), rawAt(date.end)).trim(),
    clause: line.slice(rawAt(clauseAt), rawAt(clauseEnd)).trim(),
  });
  const biography = biographyFor(request, text, dates, name, title);
  const fallback = biography ? { ...bound(biography, 0, text.length, false), inferredRange: true }
    : origin ? { ...bound(origin.date, origin.at, origin.end, false), historicalOrigin: true } : info;
  if (!info.hasSubject) return fallback;
  const predicates = eventPredicates(request, name);
  const clauses = dateClauses(text, dates, subject);
  // Relative clauses, coordination and topic/comment constructions can carry a named subject across a comma.
  const named = `^\\s*(?:${lang === 'ar' ? 'كما' : 'the'}\\s+)?${name}${wordEnd}${aside}`;
  const subjectOnly = new RegExp(`${named}\\s*$`, 'u');
  const start = event.endpoint === 'start' && !event.life;
  const englishDefinition = lang === 'en' && start ? new RegExp(`${named}\\s+(?:is|was)\\s+(?:a|an|the)\\s+(?:[\\p{L}-]+\\s+){0,6}?(?:agency|alliance|association|body|coalition|company|department|force|group|initiative|institution|mission|organisation|organization|program(?:me)?|team)(?:\\s+in\\s+[\\p{L} -]+)?\\s*$`, 'u') : null;
  const englishParticiple = `(?:(?:first|officially|originally)\\s+)*`;
  const established = new RegExp(`^\\s*${englishParticiple}(?:established|formed|founded|created)${wordEnd}`, 'u');
  const arabicLead = new RegExp(`^\\s*(?:(?:[يت]قع|[يت]وجد|[يت]عد|كان(?:ت)?)\\s+)?${name}${wordEnd}`, 'u');
  const arabicTopic = lang === 'ar' && event.noun ? new RegExp(`^\\s*(?:اما\\s+)?(?:ال)?(?:${event.noun})\\s+${name}${wordEnd}${aside}\\s*$`, 'u') : null;
  const arabicComment = /^\s*[وف]?(?:قد\s+)?تمت?(?!\p{L})/u;
  const arabicDescription = lang === 'ar' && arabicStartDescription(event);
  const arabicDefinition = arabicDescription ? new RegExp(`^\\s*${arabicDescription}${wordEnd}`, 'u') : null;
  const carriedPredicate = new RegExp(`^\\s*${lang === 'ar' ? '[وف]?(?:قد\\s+)?' : englishParticiple}(?:${event.verb})${wordEnd}`, 'u');
  for (const [index, clause] of clauses.entries()) {
    const end = clause.at + clause.text.length;
    const localDates = dates.filter(date => date.at >= clause.at && date.end <= end);
    if (!localDates.length || uncertain.test(clause.text)) continue;
    const relations = predicates.flatMap(pattern => [...clause.text.matchAll(pattern)].map(match => ({
      at: clause.at + match.index, end: clause.at + match.index + match[0].length,
    })));
    const previous = clauses[index - 1];
    const comma = /^[,،]$/u.test(clause.precededBy);
    let carried: RegExpExecArray | null | undefined;
    if (previous && lang === 'ar') {
      const coordinated = /^[وف]$/u.test(clause.precededBy) || comma && /^\s*[وف]/u.test(clause.text);
      const relative = /^(?:الذي|التي|الذين)$/u.test(clause.precededBy) && subjectOnly.test(previous.text);
      if (relative || coordinated && arabicLead.test(previous.text)) carried = carriedPredicate.exec(clause.text);
      if (!carried && comma && subjectOnly.test(previous.text)) carried = arabicDefinition?.exec(clause.text);
      if (!carried && comma && arabicTopic?.test(previous.text)) carried = arabicComment.exec(clause.text);
    } else if (previous && comma) {
      if (subjectOnly.test(previous.text)) carried = carriedPredicate.exec(clause.text);
      if (!carried && englishDefinition?.test(previous.text)) carried = established.exec(clause.text);
    }
    for (const date of localDates) {
      const relation = relations.find(relation => date.at >= relation.end
        ? eventIntro.test(text.slice(clause.at, relation.at)) && linksDate(relation.end, date.at)
        : date.end <= relation.at && datePrefix.test(text.slice(clause.at, date.at))
          && leadingDateTail.test(text.slice(date.end, relation.at)));
      if (relation) return bound(date, clause.at, end, dates[0]!.at < date.at);
      if (carried && date.at >= clause.at + carried[0].length && linksDate(clause.at + carried[0].length, date.at)) {
        return bound(date, previous!.at, end, dates[0]!.at < date.at);
      }
    }
  }
  const range = rangeFor(request, text, dates, name);
  return range ? { ...bound(range, 0, text.length, false), inferredRange: true } : fallback;
}
