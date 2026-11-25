import { MonitorSpecSchema, type MonitorSpec } from '@mohassan/contracts';
import { reviewPublicProjection } from '../assistant/request-scope.js';
import { cityName, recognizeLiveData } from '../live-data/recognize.js';
import { recognizeMarket } from '../live-data/recognize-market.js';
import { CURRENCY_TOPIC, monitorCurrencyPair, monitorMatchText, WEATHER_TOPIC, type MonitorNeed } from './detection.js';
import { monitorTiming } from './schedule.js';

type Source = MonitorSpec['source'];
type Read = MonitorSpec['read'];
type Condition = MonitorSpec['condition'];
type Watch = Pick<MonitorSpec, 'source' | 'read' | 'condition' | 'title'>;
const ADDRESS = /https?:\/\/[^\s<>"'`«»“”]+/giu;
const NUMBER = String.raw`[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const AMOUNT = String.raw`(?:\s+|\s*[$€£¥]\s*)(${NUMBER})(?!\d|\.\d)`;
const BELOW = new RegExp(String.raw`(?:\b(?:below|under|less than)\b|(?<!\p{L})(?:تحت|اقل من|دون)(?!\p{L})|<)${AMOUNT}`, 'u');
const ABOVE = new RegExp(String.raw`(?:\b(?:above|over|greater than|more than|exceeds?)\b|(?<!\p{L})(?:فوق|اكثر من|اعلي من|يتجاوز|تتجاوز)(?!\p{L})|>)${AMOUNT}`, 'u');
const PERCENT = new RegExp(String.raw`(?:^|[\s(])(${NUMBER})\s*(?:%|٪|percent\b|بالمئه|بالمائه|في المئه)`, 'u');
const UP = /\b(?:rises?|increases?|go(?:es)? up|gains?)\b|(?<!\p{L})(?:يزيد|تزيد|يرتفع|ترتفع|ارتفاع|زياده)(?!\p{L})/u;
const DOWN = /\b(?:falls?|drops?|decreases?|go(?:es)? down|loses?)\b|(?<!\p{L})(?:ينزل|تنزل|ينخفض|تنخفض|انخفاض|نزول)(?!\p{L})/u;
const CROSSING = /\bcross(?:es|ing)?\b|(?<!\p{L})(?:يتخطي|تتخطي|يتجاوز|تتجاوز|يعبر|تعبر)(?!\p{L})/u;
const APPEARS = /\b(?:appear(?:s|ed)?|shows? up|becomes? visible|presence)\b|(?<!\p{L})(?:يظهر|تظهر|ظهور)(?!\p{L})/u;
const DISAPPEARS = /\b(?:disappear(?:s|ed)?|go(?:es)? away|no longer (?:shows?|appears?|contains?))\b|(?<!\p{L})(?:يختفي|تختفي|اختفاء|لم يعد يظهر)(?!\p{L})/u;
const CHANGE = /\bchang(?:e|es|ed|ing)\b|(?<!\p{L})(?:تغير|يتغير|تتغير|تغيير)(?!\p{L})/u;
const PRICE = /\bprice(?:s)?\b|(?<!\p{L})(?:ال)?(?:سعر|اسعار)(?!\p{L})/u;
const REGISTRATION = /\b(?:registrations?|enrol(?:l)?ment|sign[ -]?ups?|application(?:s| portal)?)\b|(?<!\p{L})(?:ال)?(?:تسجيل|التحاق|تقديم|طلبات)(?!\p{L})/u;
const TICKETS = /\btickets?\b|(?<!\p{L})(?:ال)?(?:تذاكر|تذكره)(?!\p{L})/u;
const AVAILABILITY = /\b(?:available|availab(?:ility|le)|in stock|out of stock|restock(?:s|ed)?|sold out)\b|(?<!\p{L})(?:متاح(?:ه)?|متوفر(?:ه)?|يتوفر|تتوفر|توفر|نفد|نفذت|نفاذ|المخزون)(?!\p{L})/u;
const PUBLICATION = /\b(?:publish(?:es|ed|ing)?|go(?:es)? live|release(?:s|d)?|posted)\b|(?<!\p{L})(?:نشر|ينشر|تنشر|منشور(?:ه)?|يصدر|تصدر|اصدار)(?!\p{L})/u;
const OPEN = /\b(?:open(?:s|ed)?|start(?:s|ed)?|on sale)\b|(?<!\p{L})(?:فتح(?:وا|ت)?|يفتح(?:وا|ون)?|تفتح|مفتوح(?:ه)?|يبدا|تبدا|بدا)(?!\p{L})/u;
const CLOSED = /\b(?:closed|closes?|sold out|out of stock|unavailable|unpublished|not (?:open|available|published))\b|(?<!\p{L})(?:مغلق(?:ه)?|يغلق|تغلق|غير (?:متاح|منشور|متوفر)|نفد|نفذت|نفاذ)(?!\p{L})/u;
const DATE = /\b(?:release date|opening date|application deadline|deadline|date)\b|(?<!\p{L})(?:تاريخ (?:الاصدار|الفتح|التسجيل)|اخر موعد|الموعد|التاريخ)(?!\p{L})/u;
const NEW_ITEMS = /\b(?:new (?:items?|listings?|entries|results?|jobs?|posts?)|(?:a |the )?(?:new )?listing (?:appears?|becomes? available))\b|(?<!\p{L})(?:نتائج جديده|نتيجه جديده|اعلان(?:ات)? جديد(?:ه)?|عنصر(?: جديد)?|ادر?اج جديد)(?!\p{L})/u;
const QUERY = /(?:\b(?:search results?|new (?:results?|listings?|jobs?|posts?)) (?:for|matching|about)\s+|(?:نتائج البحث|نتائج جديد[هة]|[إا]علان(?:ات)? جديد(?:[هة])?) (?:عن|لـ?|بخصوص)\s+)(.+)$/iu;
const QUERY_END = /\s+(?:and (?:tell|notify|alert|let)|(?:when|if) (?:it|they) (?:change|appear)|(?:appears?|shows up)(?=[.!?؟،\s]*$)|for (?:the next )?\d+|until \d{4}|every \d+|و?(?:نبهني|[أا]خبرني|قل لي|بلغني)|عندما تظهر|لمد[هة]|حت[ىي] \d{4}|كل \d+)(?!\p{L})/iu;
const RUN = /\b(?:background (?:run|job|task)|run id)\b|(?<!\p{L})(?:مهمه في الخلفيه|تشغيل في الخلفيه|معرف التشغيل)(?!\p{L})/u;
const RUN_ID = /(?:\brun(?: id)?|(?:معرف )?التشغيل|مهمه في الخلفيه)\s*[:#]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/u;
const TEMP = /\btemperature(?:s)?\b|(?<!\p{L})(?:درجه )?(?:الحراره|حراره)(?!\p{L})/u;
const RAIN = /\b(?:rain(?:s|fall)?|precipitation)\b|(?<!\p{L})(?:المطر|يمطر|ستمطر|امطار|الامطار|هطول)(?!\p{L})/u;
const WIND = /\bwind(?: speed)?\b|(?<!\p{L})(?:سرعه )?(?:الرياح|رياح)(?!\p{L})/u;
const MAIN_CHANGE = /\b(?:content|text|page|website|site|link)\b|(?<!\p{L})(?:ال)?(?:محتوي|نص|صفحه|موقع|رابط)(?!\p{L})/u;
const PERFECT_STATUS = /\b(?:if|when|once|until|as soon as)\b|(?<!\p{L})(?:اذا|لما|عندما|حتي|بمجرد)(?!\p{L})/u;
const ANCHOR = /(?:\b(?:under|near|in)\s+(?:(?:the\s+)?(?:section|heading|block)(?:\s+(?:called|titled|labelled|labeled))?\s*[: ]+)?|(?:تحت|بالقرب من|في قسم|عند عنوان)\s*)["«“`]([^"»”`\r\n]{1,120})["»”`]/iu;
const LITERAL = /(?:["«“`]([^"»”`\r\n]{1,180})["»”`]|(?<![\p{L}\p{N}])['‘]([^'’\r\n]{1,180})['’](?![\p{L}\p{N}]))/u;
const LABEL = /(?:\b(?:number|value|price|status|date) (?:next to|near|under|labelled|labeled|for)\s*|(?:الرقم|القيمه|السعر|الحاله|التاريخ) (?:المجاور|بجوار|عند|تحت|بعنوان)\s*)["«“`]([^"»”`\r\n]{1,120})["»”`]/iu;

const say = (language: MonitorNeed['language'], ar: string, en: string) => language === 'ar' ? ar : en;
const number = (value: string) => Number(value.replace(/,/gu, '').replace('−', '-'));

function numericCondition(text: string): Condition | undefined {
  const percentage = PERCENT.exec(text);
  if (percentage && number(percentage[1]) > 0) {
    return { kind: 'percent', direction: UP.test(text) ? 'above' : DOWN.test(text) ? 'below' : 'either', value: number(percentage[1]) };
  }
  const below = BELOW.exec(text);
  const found = below ?? ABOVE.exec(text);
  if (!found || !Number.isFinite(number(found[1]))) return undefined;
  const value = number(found[1]);
  const precision = found[1].split('.')[1]?.length ?? 0;
  // Use the precision entered by the user, with a floor for very small values.
  const hysteresis = Math.max(10 ** -precision, Number.EPSILON * Math.abs(value));
  return { kind: CROSSING.test(text) ? 'crossing' : 'threshold', direction: below ? 'below' : 'above', value, hysteresis };
}

function pageWatch(need: MonitorNeed, body: string, url: string): Watch | null {
  const language = need.language;
  const anchorMatch = ANCHOR.exec(need.text);
  const label = LABEL.exec(need.text)?.[1].trim();
  const anchor = anchorMatch?.[1].trim();
  const source = { kind: 'page', url, ...(anchor && { anchor }) } as const;
  const page = new URL(url).hostname;
  const watched = (read: Read, condition: Condition, subject: string): Watch => ({ source, read, condition, title: `${page} · ${subject}` });
  if (need.blocked) return watched({ kind: 'status' }, { kind: 'equals', value: 'reachable' }, say(language, 'توفر الصفحة', 'Page availability'));
  const numeric = numericCondition(body);
  const price = PRICE.test(body) || Boolean(need.sourceText && PRICE.test(monitorMatchText(need.sourceText)));
  const numberLabel = label ?? (price ? 'price' : undefined);
  if (numeric || price && (CHANGE.test(body) || !PERFECT_STATUS.test(body))) {
    const subject = label ?? (price ? say(language, 'السعر', 'Price') : say(language, 'القيمة', 'Value'));
    return watched({ kind: 'number', ...(numberLabel && { label: numberLabel }) }, numeric ?? { kind: 'change' }, subject);
  }

  const literalMatch = LITERAL.exec(need.text.replace(ADDRESS, ' ').replace(LABEL, ' ').replace(ANCHOR, ' '));
  const phrase = (literalMatch?.[1] ?? literalMatch?.[2])?.trim();
  if (phrase) {
    if (DISAPPEARS.test(body)) return watched({ kind: 'phrase', phrase }, { kind: 'disappears' }, phrase);
    if (APPEARS.test(body) || /\b(?:contains?|includes?)\b|يحتوي|تحتوي|يتضمن|تتضمن/u.test(body)) {
      return watched({ kind: 'phrase', phrase }, { kind: 'appears' }, phrase);
    }
    if (/\b(?:equals?|is exactly|matches?)\b|يساوي|تساوي|يطابق|تطابق/u.test(body)) {
      return watched({ kind: 'status', ...(label && { label }) }, { kind: 'equals', value: phrase }, label ?? phrase);
    }
  }

  const close = CLOSED.test(body);
  if (REGISTRATION.test(body) && (OPEN.test(body) || close)) {
    return watched({ kind: 'status', label: 'registration' }, { kind: 'contains', value: close ? 'registration closed' : 'registration open' }, say(language, 'حالة التسجيل', 'Registration status'));
  }
  if (TICKETS.test(body) && (OPEN.test(body) || AVAILABILITY.test(body) || close)) {
    return watched({ kind: 'status', label: 'tickets' }, { kind: 'contains', value: close ? 'tickets unavailable' : 'tickets available' }, say(language, 'توفر التذاكر', 'Ticket availability'));
  }
  if (AVAILABILITY.test(body)) {
    return watched({ kind: 'status', label: 'availability' }, { kind: 'contains', value: close ? 'out of stock' : 'in stock' }, say(language, 'حالة التوفر', 'Stock availability'));
  }
  if (PUBLICATION.test(body) && !DATE.test(body)) {
    return watched({ kind: 'status', label: 'publication' }, { kind: 'contains', value: close ? 'unpublished' : 'published' }, say(language, 'حالة النشر', 'Publication status'));
  }
  if (NEW_ITEMS.test(body)) return watched({ kind: 'items' }, { kind: 'new-item' }, say(language, 'عناصر جديدة', 'New items'));
  if (DATE.test(body) && (!PERFECT_STATUS.test(body) || CHANGE.test(body))) {
    const date = label ?? (language === 'en' ? DATE.exec(body)?.[0] : undefined);
    return watched({ kind: 'date', ...(date && { label: date }) }, { kind: 'change' }, date ?? say(language, 'التاريخ', 'Date'));
  }
  if (MAIN_CHANGE.test(body) && CHANGE.test(body) || !PERFECT_STATUS.test(body) && !phrase) {
    return watched({ kind: 'main' }, { kind: 'change' }, say(language, 'محتوى الصفحة', 'Page content'));
  }
  return null;
}

function marketRequest(value: string, language: MonitorNeed['language']) {
  const direct = recognizeLiveData(value);
  if (direct?.kind === 'exchange' || direct?.kind === 'exchange-quote') return direct;
  const body = monitorMatchText(value.replace(ADDRESS, ' '));
  const codedPair = monitorCurrencyPair(body);
  if (codedPair) return recognizeMarket(`exchange rate ${codedPair}`, language, value) ?? undefined;
  const split = body.split(/\s+(?:(?:drops?|falls?|rises?|cross(?:es)?|reaches?|gets?|moves?|goes?|changes?)(?:\s|$)|(?:below|above|under|over|for (?:the next )?\d+|every \d+)\b|(?:ينزل|تنزل|ينخفض|يرتفع|ترتفع|يتغير|تتغير|يتجاوز|تحت|فوق|لمده|كل)(?!\p{L}))/u)[0];
  const target = split.replace(/^.*?(?:\b(?:if|when|once|as soon as)\s+|(?<!\p{L})(?:اذا|لما|عندما|بمجرد)\s+)/u, '')
    .replace(/^(?:(?:please|kindly|monitor|watch|track|check|the|an?|راقب|تابع|سعر|سعر الصرف|صرف)\s+)+/u, '')
    .replace(/^(?:(?:the )?(?:exchange |fx )?rate (?:for|of|from)|سعر الصرف(?: من)?)\s+/u, '')
    .replace(/\s+(?:exchange rate|forex rate|rate|سعر الصرف)$/u, '')
    .replace(/[.!?؟،]+$/u, '').trim();
  if (!target) return undefined;
  return recognizeMarket(`exchange rate ${target}`, language, value) ?? undefined;
}

function currencyWatch(need: MonitorNeed, body: string): Watch | null {
  const current = marketRequest(need.text, need.language);
  const previous = need.sourceText && marketRequest(need.sourceText, need.language);
  const unit = /(?:[\d.])\s+([a-z]{3})(?:[.,!?؟،\s]|$)/u.exec(body)?.[1];
  const withUnit = current?.kind === 'exchange-quote' && unit
    ? recognizeMarket(`exchange rate ${current.from.toLowerCase()} to ${unit}`, need.language, need.text) : null;
  const rate = current?.kind === 'exchange' ? current : withUnit?.kind === 'exchange' ? withUnit
    : previous && previous.kind === 'exchange' && (!current || current.kind === 'exchange-quote' && current.from === previous.from) ? previous : null;
  if (!rate || rate.from === rate.to) return null;
  const condition = numericCondition(body);
  if (!condition && PERFECT_STATUS.test(body) && !CHANGE.test(body)) return null;
  return {
    source: { kind: 'currency', base: rate.from, quote: rate.to },
    read: { kind: 'number' }, condition: condition ?? { kind: 'change' }, title: `${rate.from}/${rate.to}`,
  };
}

function weatherPlace(text: string): string | undefined {
  const direct = recognizeLiveData(text);
  if (direct?.kind === 'weather' && direct.place) return direct.place;
  const match = /(?:weather|temperature|rain(?:fall)?|precipitation|wind(?: speed)?|طقس|جو|حرارة|الحرارة|مطر|أمطار|رياح|الرياح)\s+(?:in|at|for|في)\s+(.+)/iu.exec(text);
  if (!match) return undefined;
  const city = match[1].split(/\s+(?:falls?|drops?|rises?|cross(?:es)?|reaches?|exceeds?|gets?|goes?|is|changes?|above|below|over|under|for \d+|every \d+|until|ينزل|تنزل|ينخفض|يرتفع|ترتفع|يتغير|تتغير|يتجاوز|فوق|تحت|لمدة|كل|حتى)(?!\p{L})/iu)[0];
  return cityName(city);
}

function weatherWatch(need: MonitorNeed, body: string): Watch | null {
  const location = weatherPlace(need.text) ?? (need.sourceText ? weatherPlace(need.sourceText) : undefined);
  if (!location) return null;
  const metric = RAIN.test(body) ? 'precipitation' : WIND.test(body) ? 'wind' : 'temperature';
  const condition = numericCondition(body) ?? (metric === 'precipitation' && PERFECT_STATUS.test(body) && !CHANGE.test(body)
    ? { kind: 'threshold', direction: 'above', value: 0, hysteresis: 0.1 } as const : undefined);
  if (!condition && PERFECT_STATUS.test(body) && !CHANGE.test(body)) return null;
  const label = metric === 'precipitation' ? say(need.language, 'الهطول', 'Precipitation')
    : metric === 'wind' ? say(need.language, 'الرياح', 'Wind') : say(need.language, 'درجة الحرارة', 'Temperature');
  if (metric === 'temperature' && /(?:°\s*f|fahrenheit|فهرنهايت)(?!\p{L})/u.test(body)) return null;
  if (!TEMP.test(body) && metric === 'temperature' && numericCondition(body)) return null;
  return { source: { kind: 'weather', location, metric }, read: { kind: 'number' }, condition: condition ?? { kind: 'change' }, title: `${location} · ${label}` };
}

function searchWatch(need: MonitorNeed): Watch | null {
  const matched = QUERY.exec(need.text.replace(/\s+/gu, ' '));
  if (!matched) return null;
  const query = matched[1].split(QUERY_END)[0].replace(/^[\s"«“`]+|[\s"»”`!?؟،.]+$/gu, '');
  if (!query || query.length > 250) return null;
  const framed = say(need.language, `ابحث عن ${query}`, `Search for ${query}`);
  if (!reviewPublicProjection(framed, query).eligible) return null;
  return { source: { kind: 'search', query }, read: { kind: 'items' }, condition: { kind: 'new-item' }, title: query.slice(0, 180) };
}

function runWatch(need: MonitorNeed, body: string): Watch | null {
  const runId = RUN_ID.exec(body)?.[1];
  if (!runId) return null;
  const terminal = /\b(?:fails?|failed)\b|فشل/u.test(body) ? 'failed'
    : /\bblocked\b|تعثر|توقف/u.test(body) ? 'blocked' : 'completed';
  return { source: { kind: 'run', runId }, read: { kind: 'status' }, condition: { kind: 'equals', value: terminal }, title: say(need.language, 'تشغيل في الخلفية', 'Background run') };
}

const MINUTE_MS = 60_000;
const DURATION = String.raw`(\d+)\s*(minutes?|hours?|days?|weeks?|دقيقه|دقائق|ساعه|ساعات|يوم|ايام|اسبوع|اسابيع)(?!\p{L})`;
const LIFETIME = new RegExp(String.raw`(?:\bfor (?:the next )?|(?<!\p{L})(?:لمده|خلال) )${DURATION}`, 'u');
const INTERVAL = new RegExp(String.raw`(?:\bevery |(?<!\p{L})كل )${DURATION}`, 'u');

function duration(match: RegExpExecArray | null): number | undefined {
  if (!match) return undefined;
  const unit = /^(?:hour|ساع)/u.test(match[2]) ? 60 : /^(?:day|يوم|ايام)/u.test(match[2]) ? 1440 : /^(?:week|اسبوع|اسابيع)/u.test(match[2]) ? 10080 : 1;
  const value = Number(match[1]) * unit * MINUTE_MS;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function deadline(text: string): string | undefined {
  const literal = /(?:\b(?:until|by|deadline(?: is|:)?)\s+|(?<!\p{L})(?:حتي|قبل|اخر موعد)\s+)(\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:z|[+-]\d{2}:\d{2}))?)(?![\d+t:z-])/u.exec(text)?.[1];
  if (!literal) return undefined;
  const value = new Date(literal.includes('t') ? literal.toUpperCase() : `${literal}T23:59:59.999Z`);
  if (!Number.isFinite(value.getTime()) || !literal.includes('t') && value.toISOString().slice(0, 10) !== literal) return undefined;
  return value.toISOString();
}

export function generateMonitorSpec(need: MonitorNeed, now = new Date()): MonitorSpec | null {
  const body = monitorMatchText(need.text.replace(ADDRESS, ' '));
  const watch = need.sourceUrl ? pageWatch(need, body, need.sourceUrl) : RUN.test(body) ? runWatch(need, body)
    : WEATHER_TOPIC.test(body) ? weatherWatch(need, body) : CURRENCY_TOPIC.test(body) || monitorCurrencyPair(body) ? currencyWatch(need, body) : searchWatch(need);
  if (!watch) return null;
  const deadlineAt = deadline(body);
  if (deadlineAt && Date.parse(deadlineAt) <= now.getTime()) return null;
  const urgency = /\b(?:urgent(?:ly)?|as soon as|immediately)\b|(?<!\p{L})(?:عاجل|بسرعه|فورا|بمجرد)(?!\p{L})/u.test(body) ? 'urgent' : 'normal';
  const timing = monitorTiming(watch.source.kind, urgency, { now, deadline: deadlineAt,
    lifetimeMs: duration(LIFETIME.exec(body)), requestedIntervalMs: duration(INTERVAL.exec(body)) });
  const parsed = MonitorSpecSchema.safeParse({ ...watch, timing, language: need.language,
    message: say(need.language, `تحقّق شرط المراقبة لـ «${watch.title}».`, `The monitoring condition was met for ${watch.title}.`) });
  return parsed.success ? parsed.data : null;
}

export function monitorNeedReply(need: MonitorNeed, spec?: MonitorSpec | null): string {
  const ar = need.language === 'ar';
  let reply: string;
  if (!spec) {
    const body = monitorMatchText(need.text);
    if (!need.sourceUrl && CURRENCY_TOPIC.test(body)) reply = ar
      ? 'يمكنني مراقبة سعر الصرف. حدّد العملتين، مثل USD/SAR، والشرط الذي تريد التنبيه عند تحققه.'
      : 'I can monitor the exchange rate. Specify the currency pair, such as USD/SAR, and the condition for an alert.';
    else if (!need.sourceUrl && WEATHER_TOPIC.test(body)) reply = ar
      ? 'يمكنني مراقبة الطقس. حدّد المدينة والقيمة التي تريد متابعتها، مثل درجة الحرارة بالدرجات المئوية.'
      : 'I can monitor the weather. Specify the city and the metric to watch, such as temperature in Celsius.';
    else if (RUN.test(body)) reply = ar ? 'يمكنني مراقبة المهمة. حدّد معرّف التشغيل في الخلفية.' : 'I can monitor the task. Specify its background run ID.';
    else reply = ar ? 'يمكنني اقتراح مراقبة. حدّد الرابط العام أو استعلام البحث العام والشرط الذي تريد التنبيه عند تحققه.'
      : 'I can offer a monitor. Specify the public link or public search query and the condition for an alert.';
  } else if (need.kind === 'agent-initiated') {
    reply = ar ? 'يمكنني مراقبة المصدر وتنبيهك عندما يصبح متاحًا. بعد التنبيه، يمكننا استئناف المهمة بطلب منك.'
      : 'I can watch the source and notify you when it becomes available. After that, ask me to resume the task.';
  } else if (need.kind === 'implicit') {
    reply = ar ? 'يمكنني متابعة هذه الحالة وتنبيهك عند تحقق الشرط. راجع خطة المراقبة ووافق عليها لبدء الفحص.'
      : 'I can watch for this condition and notify you when it is met. Review and approve the monitor to start checking.';
  } else {
    reply = ar ? 'أعددت خطة المراقبة. راجع القراءة الحالية ووافق عليها لبدء الفحص.'
      : 'I prepared the monitor plan. Review the current reading and approve it to start checking.';
  }
  return need.actionRequested ? `${reply} ${ar ? 'سأرسل لك تنبيهًا، ويبقى تنفيذ الإجراء بيدك.' : 'I’ll notify you so you can take the action yourself.'}` : reply;
}
