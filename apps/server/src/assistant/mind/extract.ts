import { publicSearchText, searchTokens } from '@mohassan/browser';
import type { AnswerType, Frame } from './contract.js';

// حدود الاقتباس في خطة موحسن، دون قياس مستقل لأثرها على الاسترجاع.
const QUOTE_WORDS = 22;
const QUOTE_CHARACTERS = 320;
const instructionPattern = /\b(?:assistant|chatgpt|system message|developer message)\s*[:：]|\b(?:ignore|override|disregard|forget)\s+(?:(?:all|the|your|previous|prior|earlier|above|original|user(?:'s)?|system|developer|safety)\s+)*(?:instructions?|rules?|prompts?|request|question|user|above)\b|(?:المساعد|النظام|رسالة المطور)\s*[:：]|(?:تجاهل|انسَ|أهمل|تخط[َّّطى]*)\s+(?:(?:كل|هذه|جميع)\s+)?(?:التعليمات|القواعد|المستخدم|السائل|الطلب|السؤال|ما سبق)|^(?:(?:please\s+)?(?:output|send|submit|click|execute|run|reveal|reply|answer|tell the user)\b|(?:من فضلك\s+)?(?:أجب|نفّذ|افتح|أرسل|اذكر|اطبع|اكشف|انقر|قل)\s)/iu;

export function isPageInstruction(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u0640\p{Cf}]/gu, '').trim();
  return instructionPattern.test(normalized);
}

const topicGroups = new Map<string, string>();
const groups: Record<string, string> = {
  open: 'open opens opening opened reopen reopened reopening افتتاح افتتح افتتحت يفتتح تفتتح فتح تفتح يفتح افتح',
  close: 'close closes closing shuts shutdown closed إغلاق اغلاق اغلق أغلق يغلق تغلق اقفال يقفل تقفل',
  founded: 'founder founders founded foundation established establishment تأسيس تاسيس تأسس تاسس أسس اسس المؤسسة مؤسس مؤسِّسة مؤسسها مؤسستها إنشاء انشاء أنشئ انشئ',
  authored: 'author authors wrote authoring authored writer writers مؤلف مؤلفة ألف ألّف كتب كاتب كاتبة',
  price: 'price prices fee fees cost costs charge charges rate rates admission entry سعر أسعار اسعار تسعيرة تكلف تكلفة تكلفه رسوم رسم مبلغ ثمن أجرة اجرة',
  duration: 'lasts duration takes يستغرق تستغرق مدة مده يستمر تستمر',
  capacity: 'capacity fits accommodates seats holds سعة سعه يستوعب تستوعب عدد_مقاعد',
  location: 'located location based headquarters locate situated place hosts hosted أين اين تقع يقع موقع مكان مقر تستضيف يستضيف',
  time: 'time times schedule timetable when hour hours ساعة ساعه موعد مواعيد توقيت متى',
};
for (const [stem, variants] of Object.entries(groups)) {
  for (const variant of searchTokens(variants)) topicGroups.set(variant, stem);
}

const topics = (text: string) => searchTokens(text).map(word => topicGroups.get(word) ?? word
  .replace(/ة$/u, '')
  .replace(/(?<=[a-z]{3})ies$/u, 'y')
  .replace(/(?<=[a-z]{3})s$/u, ''));

export function topicScore(text: string, focus: readonly string[]): number {
  const present = new Set(topics(text));
  return [...new Set(focus.flatMap(topics))].filter(token => present.has(token)).length;
}

const digitText = (text: string) => text.replace(/[٠-٩۰-۹]/gu, c => String(c.charCodeAt(0) & 15));
const normalizeValue = (text: string) => digitText(text.normalize('NFKC')).toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '').replace(/[أإآٱ]/gu, 'ا').trim();

export interface ExtractedQuote {
  quote: string;
  /** Literal text inside quote, used for presentation and audit. */
  value?: string;
  /** A typed comparison key, never presented as though it were a literal quote. */
  key?: string;
  score: number;
}

type ParsedValue = { value: string; key: string };
type Unit = { key: string; words: string[]; factor?: number };
const units: Unit[] = [
  { key: 'length:m', factor: 1, words: ['m', 'metre', 'meter', 'metres', 'meters', 'متر', 'أمتار', 'مترا'] },
  { key: 'length:m', factor: 1_000, words: ['km', 'kilometre', 'kilometer', 'kilometres', 'kilometers', 'كيلومتر', 'كيلومترا'] },
  { key: 'length:m', factor: 0.01, words: ['cm', 'centimetres', 'centimeters', 'سنتيمتر'] },
  { key: 'mass:g', factor: 1, words: ['g', 'gram', 'grams', 'جرام', 'غرام', 'جراما', 'غراما'] },
  { key: 'mass:g', factor: 1_000, words: ['kg', 'kilogram', 'kilograms', 'كيلوغرام', 'كيلوجرام'] },
  { key: 'duration:s', factor: 1, words: ['s', 'second', 'seconds', 'ثانية', 'ثوان', 'ثواني'] },
  { key: 'duration:s', factor: 60, words: ['min', 'minute', 'minutes', 'دقيقة', 'دقائق'] },
  { key: 'duration:s', factor: 3_600, words: ['h', 'hr', 'hour', 'hours', 'ساعة', 'ساعات'] },
  { key: 'capacity', words: ['seat', 'seats', 'spectators', 'مقاعد', 'مقعد', 'مقعدا', 'متفرج', 'متفرجا'] },
  { key: 'percent', words: ['%', '٪', 'percent', 'per cent', 'بالمئة', 'بالمائة'] },
];
const currencies: Record<string, string[]> = {
  GBP: ['GBP', '£', 'pounds sterling', 'pound sterling', 'جنيه إسترليني'],
  EUR: ['EUR', '€', 'euros', 'euro', 'يورو'],
  USD: ['USD', 'US dollars', 'US dollar', 'دولار أمريكي'],
  SAR: ['SAR', 'Saudi riyals', 'Saudi riyal', 'ريال سعودي'],
  AED: ['AED', 'UAE dirhams', 'درهم إماراتي'],
  unspecifiedDollar: ['$', 'dollars', 'dollar', 'دولار'],
  unspecifiedRiyal: ['ريال', 'ريالًا'],
  unspecifiedDinar: ['دينار', 'دينارًا'],
  unspecifiedPound: ['جنيه', 'جنيهًا'],
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forms = (words: readonly string[]) => [...new Set(words)].sort((a, b) => b.length - a.length).map(escape).join('|');

function measurementSpellings(alias: string): string[] {
  const words = alias.normalize('NFKC').replace(/\p{M}/gu, '').split(/\s+/u);
  return words.reduce<string[]>((spellings, word) => {
    const canTakeAlif = /^(?:(?=\p{L})\p{Script=Arabic})+$/u.test(word) && !/(?:[اأإآٱىة]|اء)$/u.test(word);
    const alternatives = canTakeAlif ? [word, `${word}ا`] : [word];
    return spellings.flatMap(spelling => alternatives.map(alternative => spelling ? `${spelling} ${alternative}` : alternative));
  }, ['']);
}

function measurementWords<T>(entries: readonly { value: T; words: readonly string[] }[]): Map<string, T> {
  const values = new Map<string, T>();
  for (const entry of entries) for (const word of entry.words) {
    for (const spelling of measurementSpellings(word)) values.set(normalizeValue(spelling), entry.value);
  }
  return values;
}

function measurementForms(words: Iterable<string>): string {
  return [...words].sort((a, b) => b.length - a.length).map(word => [...word].map(character => {
    if (character === ' ') return '\\s+';
    if (/^\p{Script=Arabic}$/u.test(character) && /^\p{L}$/u.test(character)) {
      return `${character === 'ا' ? '[اأإآٱ]' : escape(character)}\\p{M}*`;
    }
    return escape(character);
  }).join('')).join('|');
}

const currencyWords = measurementWords(Object.entries(currencies).map(([value, words]) => ({ value, words })));
const unitWords = measurementWords(units.map(value => ({ value, words: value.words })));
const currencyForms = measurementForms(currencyWords.keys());
const unitForms = measurementForms(unitWords.keys());
const numberPattern = '[+−-]?\\p{Nd}+(?:[,،٬]\\p{Nd}{3})*(?:[.٫]\\p{Nd}+)?';
const wordPart = '[\\p{L}\\p{M}\\p{N}]';
const numbers = new RegExp(`(?<!${wordPart})(${numberPattern})(?:\\s*(${unitForms})(?!${wordPart}))?(?!${wordPart})`, 'giu');
const money = new RegExp(`(?<!${wordPart})(?:(${currencyForms})\\s*(${numberPattern})|(${numberPattern})\\s*(${currencyForms}))(?!${wordPart})`, 'giu');
const measurementKey = (word: string) => normalizeValue(word).replace(/\s+/gu, ' ');

function numberValue(value: string): number {
  return Number(digitText(value).replace(/[,،٬]/gu, '').replace('٫', '.').replace('−', '-'));
}

export function typedNumbers(sentence: string): (ParsedValue & { number: number; unit: string; index: number })[] {
  return [...sentence.matchAll(numbers)].flatMap(match => {
    const base = numberValue(match[1]);
    if (!Number.isFinite(base)) return [];
    const unit = match[2] ? unitWords.get(measurementKey(match[2])) : undefined;
    const number = base * (unit?.factor ?? 1);
    return [{ value: match[0], key: `${unit?.key ?? 'number'}:${number}`, number, unit: unit?.key ?? 'number', index: match.index }];
  });
}

function amount(sentence: string): ParsedValue[] {
  return [...sentence.matchAll(money)].flatMap(match => {
    const name = currencyWords.get(measurementKey(match[1] ?? match[4]));
    const number = numberValue(match[2] ?? match[3]);
    return !Number.isFinite(number) || !name ? [] : [{ value: match[0], key: `money:${name}:${number}` }];
  });
}

const iso = /(?<!\p{Nd})(\p{Nd}{4})[-/](\p{Nd}{2})[-/](\p{Nd}{2})(?!\p{Nd})/gu;
const clock = /(?<![\p{L}\p{Nd}])([0-2٠-٢۰-۲]?\p{Nd}):([0-5٠-٥۰-۵]\p{Nd})(?:\s*(AM|PM|صباحًا|مساءً))?(?!\p{Nd})/giu;
const year = /(?<![\p{L}\p{Nd}])\p{Nd}{4}(?![\p{L}\p{Nd}])/gu;
const months = [
  ['january', 'jan', 'يناير', 'كانون الثاني'], ['february', 'feb', 'فبراير', 'شباط'],
  ['march', 'mar', 'مارس', 'آذار'], ['april', 'apr', 'أبريل', 'إبريل', 'نيسان'], ['may', 'مايو', 'أيار'],
  ['june', 'jun', 'يونيو', 'حزيران'], ['july', 'jul', 'يوليو', 'تموز'], ['august', 'aug', 'أغسطس', 'آب'],
  ['september', 'sep', 'سبتمبر', 'أيلول'], ['october', 'oct', 'أكتوبر', 'تشرين الأول'],
  ['november', 'nov', 'نوفمبر', 'تشرين الثاني'], ['december', 'dec', 'ديسمبر', 'كانون الأول'],
];
const days = [
  ['monday', 'الاثنين', 'اثنين'], ['tuesday', 'الثلاثاء', 'ثلاثاء'], ['wednesday', 'الأربعاء', 'أربعاء'],
  ['thursday', 'الخميس', 'خميس'], ['friday', 'الجمعة', 'جمعة'], ['saturday', 'السبت', 'سبت'], ['sunday', 'الأحد', 'أحد'],
];
const monthForms = forms(months.flat());
const monthDate = new RegExp(`(?<![\\p{L}\\p{Nd}])(?:(\\p{Nd}{1,2})\\s+(${monthForms})\\s+(\\p{Nd}{4})|(${monthForms})\\s+(?:(\\p{Nd}{1,2})(?:st|nd|rd|th)?[,]?\\s+)?(\\p{Nd}{4}))(?![\\p{L}\\p{Nd}])`, 'giu');
const weekday = new RegExp(`(?<!\\p{L})(${forms(days.flat())})(?!\\p{L})`, 'giu');
const named = (value: string, aliases: readonly string[][]) => aliases.findIndex(words => words.some(word => normalizeValue(word) === normalizeValue(value)));

function validCalendarDay(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateKey(yearText: string, month: number, day?: number): string | undefined {
  const year = numberValue(yearText);
  if (year < 1000 || month < 1 || month > 12) return undefined;
  const first = `${year}-${String(month).padStart(2, '0')}`;
  if (day === undefined) return first;
  if (!validCalendarDay(year, month, day)) return undefined;
  return `${first}-${String(day).padStart(2, '0')}`;
}

function dates(sentence: string): ParsedValue[] {
  const values: ParsedValue[] = [];
  for (const match of sentence.matchAll(iso)) {
    const key = dateKey(match[1], numberValue(match[2]), numberValue(match[3]));
    if (key) values.push({ value: match[0], key: `date:${key}` });
  }
  for (const match of sentence.matchAll(monthDate)) {
    const day = match[1] ?? match[5];
    const month = named(match[2] ?? match[4], months) + 1;
    const key = dateKey(match[3] ?? match[6], month, day ? numberValue(day) : undefined);
    if (key) values.push({ value: match[0], key: `date:${key}` });
  }
  for (const match of sentence.matchAll(clock)) {
    const hour = numberValue(match[1]), minute = numberValue(match[2]), period = normalizeValue(match[3] ?? '');
    if (hour > 23 || minute > 59 || period && (hour < 1 || hour > 12)) continue;
    const adjusted = /pm|مساء/u.test(period) ? hour % 12 + 12 : /am|صباح/u.test(period) ? hour % 12 : hour;
    values.push({ value: match[0].trimEnd(), key: `time:${adjusted}:${minute}` });
  }
  for (const match of sentence.matchAll(weekday)) values.push({ value: match[0], key: `day:${named(match[0], days)}` });
  if (!values.length) for (const match of sentence.matchAll(year)) values.push({ value: match[0], key: `year:${numberValue(match[0])}` });
  return values;
}

export function declaredDate(value?: string): string | undefined {
  const text = value?.trim();
  if (!text || isPageInstruction(text) || /https?:\/\//iu.test(text) || publicSearchText(text) !== text) return undefined;
  const numericDate = /^(\p{Nd}{4})([-/])(\p{Nd}{2})\2(\p{Nd}{2})(?=$|[Tt\s])/u.exec(text);
  if (numericDate && !validCalendarDay(numberValue(numericDate[1]), numberValue(numericDate[3]), numberValue(numericDate[4]))) return undefined;
  if (/\p{Nd}{4}/u.test(text) && Number.isFinite(Date.parse(text))) return text;
  return dates(text).find(date => (date.key.startsWith('date:') || date.key.startsWith('year:')) && date.value === text)?.value;
}

const latinName = /(?<![\p{L}\p{N}])\p{Lu}[\p{Ll}\p{M}'’.-]+(?:\s+(?:(?:de|di|van|von|of)\s+)?\p{Lu}[\p{Ll}\p{M}'’.-]+)+(?![\p{L}\p{N}])/gu;
const latinPlace = /\b(?:located\s+in|based\s+in|hosted\s+in|in|at)\s+(\p{Lu}[\p{Ll}\p{M}'’.-]+(?:\s+\p{Lu}[\p{Ll}\p{M}'’.-]+)*)/gu;
const arabicNames = /(?:\b(?:name|founder)\s*[:：]\s*|(?:^|\s)(?:هو|هي|يديرها|تديرها|أسسها|اسسها|كتبها)\s+)([\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+)+)|(?:^|\s)(?:أسس|اسس|أنشأ|انشا|ألف|الّف|كتب)\s+([\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+)+)/gu;
const arabicPlace = /(?:تقع|يقع|توجد|يوجد|تستضيف|عنوانها|مقرها)\s+(?:(?:[\p{L}\p{M}]+\s+)*?في\s+|ب(?=\p{Script=Arabic}))([\p{Script=Arabic}\p{M}]+(?:\s+[\p{Script=Arabic}\p{M}]+)*)/gu;
const arabicRole = /(?:^|\s)(?:جمعية|شركة|دليل|مؤسسة|منظمة|كتاب|رواية|برنامج|مدينة|الذي|التي|في|عام|من)(?:\s|$)/u;

function properValues(sentence: string, type: 'name' | 'place', frame: Frame): ParsedValue[] {
  const candidates: string[] = [];
  if (frame.lang === 'en' || /\p{Lu}/u.test(sentence)) {
    if (type === 'place') for (const match of sentence.matchAll(latinPlace)) candidates.push(match[1]);
    else for (const match of sentence.matchAll(latinName)) candidates.push(match[0].replace(/^The\s+/u, ''));
  }
  if (frame.lang === 'ar') {
    if (type === 'place') for (const match of sentence.matchAll(arabicPlace)) candidates.push(match[1].split(arabicRole, 1)[0]);
    else for (const match of sentence.matchAll(arabicNames)) candidates.push((match[1] ?? match[2]).split(arabicRole, 1)[0]);
  }
  const requested = normalizeValue(frame.text);
  return candidates.map(candidate => candidate.trim().replace(/[.،,؛;]+$/u, ''))
    .filter(value => value.length > 0 && !requested.includes(normalizeValue(value)))
    .map(value => ({ value, key: `${type}:${normalizeValue(value)}` }));
}

function requestedType(frame: Frame): AnswerType | null {
  if (frame.answerType && !['text', 'definition', 'yes_no'].includes(frame.answerType)) return frame.answerType;
  if (/\b(?:published when|what (?:time|day|year)|what date|opening time|time opens)\b|(?:موعد|يوم|سنة|عام)\s+(?:إغلاق|اغلاق|افتتاح|فتح|تأسيس|النشر)/iu.test(frame.text)) return 'date';
  if (/\b(?:price|fee|charge|cost|rate)\b|(?:سعر|رسوم|أجرة|تكلفة)/iu.test(frame.text)) return 'money';
  if (/\b(?:length|weight|height|depth|capacity|duration)\b|\bhow\s+(?:deep|tall|wide|high|heavy|far|long)\b|(?:ارتفاع|عمق|طول|سعة|وزن|مدة)/iu.test(frame.text)) return 'number';
  if (/\b(?:who|which person)\b|(?:^|\s)من\s+(?:المؤسس|المدير|مؤلف|كتب|أسس)/iu.test(frame.text)) return 'name';
  if (/\b(?:what city|where)\b|(?:أين|اين)\s+(?:تقع|يقع|يوجد)/iu.test(frame.text)) return 'place';
  return frame.answerType;
}

export function boundedQuote(raw: string, value?: string): string {
  const text = raw.trim();
  const words = [...text.matchAll(/\S+/gu)];
  if (text.length <= QUOTE_CHARACTERS && words.length <= QUOTE_WORDS) return text;
  const valueOffset = value ? text.indexOf(value) : 0;
  const valueWord = words.findIndex(word => word.index + word[0].length > valueOffset);
  const startIndex = Math.max(0, valueWord - Math.floor(QUOTE_WORDS / 2));
  for (let position = startIndex; position <= Math.max(startIndex, valueWord); position++) {
    const start = words[position]?.index ?? 0;
    const endWord = words.slice(position, position + QUOTE_WORDS).at(-1);
    const end = endWord ? Math.min(endWord.index + endWord[0].length, start + QUOTE_CHARACTERS) : text.length;
    const quote = text.slice(start, end).trim();
    if (!value || quote.includes(value)) return quote;
  }
  return '';
}

function safeSentences(text: string, lang: Frame['lang']): string[] {
  const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
  return text.split(/\r?\n/u).flatMap(line => [...segmenter.segment(line)].map(segment => segment.segment.trim()))
    .filter(sentence => sentence && !isPageInstruction(sentence) && !/https?:\/\//iu.test(sentence) && publicSearchText(sentence) === sentence);
}

function contentFocus(frame: Frame): string[] {
  const direct = frame.focus.filter(word => !/^(?:https?|www|com|org|net|html|test|localhost|according|mentioned|listed|only|report|check|read|find|please)$/iu.test(word) && !/^\d+$/u.test(word));
  return direct.length ? direct : searchTokens(frame.text.replace(/https?:\/\/\S+/gu, ''));
}

function pickValue(sentence: string, frame: Frame): ParsedValue[] {
  switch (requestedType(frame)) {
    case 'date': return dates(sentence);
    case 'money': return amount(sentence);
    case 'number': return typedNumbers(sentence);
    case 'name': return properValues(sentence, 'name', frame);
    case 'place': return properValues(sentence, 'place', frame);
    default: return [];
  }
}

type Property = { kind: AnswerType; words: string; domain?: string };
const properties: Record<string, Property> = {
  height: { kind: 'number', words: 'height high tall elevation ارتفاع علو مرتفع', domain: 'length:m' },
  width: { kind: 'number', words: 'width wide breadth عرض باتساع عريض', domain: 'length:m' },
  depth: { kind: 'number', words: 'depth deep عمق عميق', domain: 'length:m' },
  length: { kind: 'number', words: 'length long distance طول مسافة يمتد امتداد', domain: 'length:m' },
  diameter: { kind: 'number', words: 'diameter قطر', domain: 'length:m' },
  mass: { kind: 'number', words: 'weight weighs weigh mass lighter heavier وزن يزن أخف أثقل', domain: 'mass:g' },
  duration: { kind: 'number', words: 'duration lasts lasted takes took مدة يستغرق تستغرق استغرق يدوم', domain: 'duration:s' },
  capacity: { kind: 'number', words: 'capacity seating seats spectators accommodates holds سعة يستوعب تستوعب مقاعد مقعد متفرج', domain: 'capacity' },
  population: { kind: 'number', words: 'population residents inhabitants سكان سكانها أهالي' },
  attendance: { kind: 'number', words: 'attendance arrivals turnout حضور حاضرون مرتادين' },
  rate: { kind: 'number', words: 'percentage percent proportion نسبة بالمائة بالمئة', domain: 'percent' },
  price: { kind: 'money', words: 'price prices fee fees charge charges charged cost costs fare fares rate rates rent priced سعر أسعار رسوم رسم تكلفة أجرة ثمن' },
  revenue: { kind: 'money', words: 'revenue revenues income turnover profit budget إيراد إيرادات أرباح ميزانية تمويل' },
  open: { kind: 'date', words: 'open opens opened opening افتتاح افتتح افتتحت يفتتح تفتتح فتح تفتح يفتح' },
  reopen: { kind: 'date', words: 'reopen reopens reopened reopening' },
  close: { kind: 'date', words: 'close closes closed closing shuts shutdown إغلاق أغلق يغلق تغلق إقفال' },
  found: { kind: 'date', words: 'founded founded foundation established establishment تأسيس تأسس أسس إنشاء أُنشئ' },
  create: { kind: 'date', words: 'created creation built constructed construction بناء بُني أنشئ' },
  complete: { kind: 'date', words: 'complete completes completed completion finished finished اكتمال اكتمل أتم' },
  publish: { kind: 'date', words: 'published publication released نشر نُشر إصدار أُصدر' },
  commence: { kind: 'date', words: 'started starts began launch launched start بدء بدأ انطلق إطلاق' },
  update: { kind: 'date', words: 'updated modified renovated remodelled reconstructed تحديث تعديل جدد رُمم' },
  born: { kind: 'date', words: 'born birth birthday مولد ميلاد ولد وُلد' },
  died: { kind: 'date', words: 'died death deceased passed-away وفاة توفي مات' },
  depart: { kind: 'date', words: 'depart departs departure departed leaves left يغادر تغادر تقلع إقلاع مغادرة انطلاق' },
  arrive: { kind: 'date', words: 'arrive arrives arrival arrived يصل تصل وصول' },
  author: { kind: 'name', words: 'author authors authored wrote writer writers مؤلف مؤلفة ألف ألّف كتب كاتب كاتبة' },
  edit: { kind: 'name', words: 'editor edited edits editing محرر حرر تحرير راجع' },
  designer: { kind: 'name', words: 'design designed designer designers architect architected صمم مصمم تصميم المعماري' },
  painter: { kind: 'name', words: 'painter painted artist رسام رسم رسمها' },
  founder: { kind: 'name', words: 'founder founded cofounder established أسس مؤسس مؤسسة مؤسسها أسسها' },
  manager: { kind: 'name', words: 'manager manages managed director directs headed head مدير مديرة يدير تدير رئيس رئيسة' },
  location: { kind: 'place', words: 'located location situated based hosted hosts تقع يقع مقر موقع تستضيف يستضيف' },
  capital: { kind: 'place', words: 'capital عاصمة' },
};
const qualifierGroups = {
  adult: 'adult adults بالغ بالغين كبار', child: 'child children kids junior juniors طفل أطفال صغار',
  weekday: 'weekday weekdays weeknights', weekend: 'weekend weekends', monthly: 'monthly شهري شهريا',
  annually: 'yearly annually annual سنوي سنويا', first: 'first original أول أولى', last: 'last final آخر أخير',
  average: 'average mean متوسط', maximum: 'maximum max أقصى', minimum: 'minimum min أدنى',
};
const descriptors = new Map(Object.entries(properties).map(([name, property]) => [name, new Set(searchTokens(property.words).flatMap(measurementSpellings))]));
const qualifiers = new Map(Object.entries(qualifierGroups).map(([name, variants]) => [name, new Set(searchTokens(variants))]));
const factScaffolding = new Set(topics('how tall much many where who what did that does has have when year years day date dates time show sources source independent independently verify confirm check read find tell results listed known official disagreement agreement differing conflicting conflict difference according report search city entity named exactly value name registered طرف مصدرين مستقلين التحقق تحقق جهتين متى يذكر ذكر المذكورة المذكور حسب وفق الوارد اعرض اختلاف اختلفت مصادر مصدرين مصدر اختلاف اختلافات حول تاريخ التاريخ موعد عام سنة يوم الاسم القيمة الرقم أين كيف يبلغ معدله اسم فقط'));
const clauseBreak = /[;؛]\s*|(?:[,،]\s*)?\b(?:and|but|while|whereas|then)\s+|(?:[,،]\s*)?(?<!\p{L})(?:بينما|لكن|غير أن|ثم)\s+|[,،](?:\s+|(?=\p{L}))/giu;
const presentationTail = /(?:[?؟،,.;؛]\s*(?:(?:and\s+|و\s*))?|\s+and\s+)(?:(?:verify|confirm|check|cite)\s+(?:\p{L}+\s+)*(?:sources?|references?|records?)\b|(?:give|return|answer|reply|state|report)\s+(?:only|just)\b|(?:show|flag|note|include|report)\s+(?:\p{L}+\s+)*(?:agreement|disagreement|differences|disputes|conflicting figures)\b|(?:تحقق|تاكد|تأكد|وثق)\s+(?:\p{L}+\s+)*(?:بمصدر|مصدر|بمرجع|مرجع)\p{L}*(?!\p{L})|(?:أجب|اجب|اعط|أعط|اذكر|اعرض|اكتب)\s+(?:فقط|بال(?:قيمة|قيمه|سنة|سنه|رقم|اسم|تاريخ))(?!\p{L})|(?:الرقم|السنة|سنة|القيمة|الاسم|التاريخ)\s+فقط(?!\p{L}))/iu;
const attribution = /\b(?:with|using|against|from)\s+(?:(?:one|two|three|multiple|several|independent|separate)\s+)*(?:sources?|references?)\b|(?<!\p{L})(?:ب|من\s+)(?:مصادر|مصدر(?:ا|ين|ان)?|مراجع|مرجع(?:ا|ين|ان)?)(?:\s+(?:مستقل(?:ين|ان|ة|ه)?|مختلف(?:ين|ان|ة|ه)?))?(?!\p{L})/giu;
const sourceAddress = /(?:(?:\b(?:according\s+to|from|at|on|in)\b|(?<!\p{L})(?:حسب|وفق|في|عند)(?!\p{L}))\s+)?https?:\/\/\S+/giu;
const sourceCountTail = /(?:[?؟،,.;؛]\s*(?:and\s+)?|\s+and\s+)how\s+many\s+(?:(?:independent|credible|separate)\s+)*(?:sources|references|publications)\s+(?:support|confirm|corroborate|verify|agree)\b/iu;
const readOnlyTail = /(?:[?؟،,.;؛]\s*(?:(?:and\s+|و\s*))?|\s+and\s+)(?:(?:do not|don['’]t|never)\s+(?:sign|register|subscribe|buy|purchase|pay|submit|send|book|order|log\s+in)\b|لا\s+(?:تسجل|تشترك|تدفع|تشتري|تحجز|ترسل|تودع|تطلب|تؤكد)\p{L}*(?!\p{L}))/iu;
const unasserted = /\b(?:not\b(?!\s+(?:only|just)\b)|never|neither|may|might|possibly|perhaps|allegedly|planned|proposed|estimated)\b|(?<!\p{L})(?:لم|لن|ليس|ليست|ربما|يُحتمل|قد\s+يكون|مقترح(?:ة)?|متوقع(?:ة)?)(?!\p{L})/iu;
const dependentClause = /^(?:\p{Nd}|[+−$£€-]\s*\p{Nd}|[A-Z]{3}\s+\p{Nd}|(?:it|its|they|their|he|she|was|were|is|are)\b|(?:هو|هي|كان|كانت)\s|\p{L}+\s+(?:in|at|to|for|on|by)\b)/iu;
const dependentProperty = /^(?:(?:a|an|the)\s+)?([\p{L}\p{M}]+)\s+(?:of|is|was)\b/iu;

function labelsOf(text: string, labels: ReadonlyMap<string, ReadonlySet<string>>) {
  const present = new Set(searchTokens(text).flatMap(word => [word, word.replace(/^[وف](?:ال)?(?=\p{Script=Arabic})/u, '')]));
  const found = [...labels].filter(([, aliases]) => [...aliases].some(word => present.has(word))).map(([label]) => label);
  if (labels.has('reopen') && /(?:إعادة|اعادة|أعيد|اعيد)\s+(?:ال)?افتتاح/u.test(text)) return [...new Set([...found.filter(label => label !== 'open'), 'reopen'])];
  return found;
}

export function evidenceKeyDomain(key: string): string {
  if (key.startsWith('date:')) return key.slice('date:'.length).split('-').length === 2 ? 'date:month' : 'date:day';
  const type = key.split(':', 1)[0];
  return ['money', 'length', 'mass', 'duration'].includes(type) ? key.slice(0, key.lastIndexOf(':')) : type;
}

function relationContext(frame: Frame, focus: readonly string[]) {
  const intentText = frame.text.replace(sourceAddress, address => /[.?؟!،؛,]+$/u.exec(address)?.[0] ?? ' ');
  const explicitQuestion = intentText.split(presentationTail, 1)[0]
    .split(sourceCountTail, 1)[0].split(readOnlyTail, 1)[0].replace(attribution, ' ');
  const kind = requestedType(frame);
  const fields = new Map([...descriptors].filter(([name]) => properties[name].kind === kind));
  const requested = labelsOf(explicitQuestion, fields);
  const requestedQualifiers = labelsOf(intentText, qualifiers);
  const excluded = new Set([...factScaffolding, ...[...fields.values(), ...qualifiers.values()].flatMap(words => [...words].flatMap(topics))]);
  const queryWords = new Set(topics(explicitQuestion));
  const subject = [...new Set(focus.flatMap(topics))].filter(word => queryWords.has(word) && !excluded.has(word) && !/^\p{Nd}+$/u.test(word));
  const scopeYears = [...intentText.matchAll(year)].map(match => normalizeValue(match[0]));
  return { fields, requested, requestedQualifiers, subject, scopeYears };
}

function relationValue(sentence: string, frame: Frame, context: ReturnType<typeof relationContext>): (ParsedValue & { scope: string }) | undefined {
  const { fields, requested, requestedQualifiers, subject, scopeYears } = context;
  if (requested.length > 1) return undefined;
  const field = requested[0];
  const supported: (ParsedValue & { scope: string })[] = [];
  let subjectScope = false;
  let previousFields: string[] = [];
  for (const part of sentence.split(clauseBreak)) {
    const clause = part.trim();
    if (!clause) continue;
    const clauseTopics = new Set(topics(clause));
    const isNamed = subject.length > 0 && subject.every(word => clauseTopics.has(word));
    const propertyPhrase = dependentProperty.exec(clause)?.[1];
    const inherited = dependentClause.test(clause) || Boolean(propertyPhrase && labelsOf(propertyPhrase, fields).length);
    if (!inherited || isNamed) subjectScope = isNamed;
    const assertedFields = labelsOf(clause, fields);
    const effectiveFields = assertedFields.length || !inherited ? assertedFields : previousFields;
    previousFields = effectiveFields;
    if (unasserted.test(clause) || !subjectScope && subject.length > 0) continue;
    const actualQualifiers = labelsOf(clause, qualifiers);
    if (requestedQualifiers.some(item => !actualQualifiers.includes(item))) continue;
    if (scopeYears.length && scopeYears.some(value => ![...clause.matchAll(year)].some(match => normalizeValue(match[0]) === value))) continue;
    if (field && (effectiveFields.length !== 1 || effectiveFields[0] !== field)) continue;
    if (!field && (effectiveFields.length > 1 || !isNamed)) continue;
    if (field === 'price' && !requestedQualifiers.length && actualQualifiers.length) continue;
    const expectedDomain = field && properties[field].domain;
    const values = pickValue(clause, frame).filter(value => !expectedDomain || evidenceKeyDomain(value.key) === expectedDomain || evidenceKeyDomain(value.key) === 'number');
    const standalone = (isNamed || !subject.length) && (!field || assertedFields.includes(field));
    supported.push(...values.map(value => ({ ...value, scope: standalone ? clause : sentence })));
  }
  const keys = new Set(supported.map(candidate => candidate.key));
  return keys.size === 1 ? supported.find(candidate => candidate.scope !== sentence) ?? supported[0] : undefined;
}

export function extractQuote(text: string, frame: Frame): ExtractedQuote | undefined {
  const focus = contentFocus(frame);
  const relation = relationContext(frame, focus);
  const ranked = safeSentences(text, frame.lang).map(sentence => {
    const score = topicScore(sentence, focus);
    const candidate = score > 0 ? relationValue(sentence, frame, relation) : undefined;
    if (!candidate && pickValue(sentence, frame).length) return { quote: '', score };
    const quote = boundedQuote(candidate?.scope ?? sentence, candidate?.value);
    const checked = candidate && quote ? quote === sentence ? candidate : relationValue(quote, frame, relation) : undefined;
    const supported = candidate && checked?.key === candidate.key && checked.value === candidate.value;
    return { quote, score, ...(supported ? { value: candidate.value, key: candidate.key } : {}) };
  }).filter(candidate => candidate.quote && candidate.score > 0);
  const grounded = ranked.filter(candidate => candidate.key);
  const best = [...(grounded.length ? grounded : ranked)].sort((a, b) => b.score - a.score)[0];
  if (best && new Set(grounded.map(candidate => candidate.key)).size > 1) return { quote: best.quote, score: best.score };
  return best;
}

export function matchMention(text: string, frame: Frame): ExtractedQuote | undefined {
  const requested = /\b(?:mention|mentions|refer to|say anything about)\s+(.+)|(?:يذكر|تذكر|مذكور|يشير إلى)\s+(.+)/iu.exec(frame.text);
  if (!requested) return undefined;
  const focus = searchTokens((requested[1] ?? requested[2]).replace(/https?:\/\/\S+/gu, ''));
  if (!focus.length) return undefined;
  const quote = safeSentences(text, frame.lang).find(sentence => topicScore(sentence, focus) === new Set(focus.flatMap(topics)).size);
  const bounded = quote && boundedQuote(quote);
  return bounded ? { quote: bounded, score: focus.length } : undefined;
}
