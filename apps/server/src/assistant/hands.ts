import { AgentEffectHeld, type AgentAction, type AgentElement, type AgentPage, type AgentRequestPermit } from '@mohassan/browser';
import { directRoute, namedSite, sensitiveAction, situation } from './brain.js';

/**
 * The browser's hands without a model: the owner's words become a short list of steps,
 * and each step is matched against the elements the browser actually observed.
 * Nothing here guesses free text; an unclear request returns null and the old path runs.
 */
export type HandsStep =
  | { kind: 'open'; url: string; name: string }
  /** `ask`: the owner asked a question, so the run opens the top results and quotes the sentences that answer it. */
  | { kind: 'search'; query: string; site: { url: string; name: string } | null; here?: boolean; ask?: boolean }
  | { kind: 'click'; target: string; ordinal: number | null }
  | { kind: 'type'; text: string; field: string }
  | { kind: 'read'; more: boolean }
  | { kind: 'scroll'; up: boolean }
  | { kind: 'back' }
  | { kind: 'news'; source: NewsSource; topic: string };

export interface NewsSource { url: string; name: string }

/** Front pages that open in this browser (checked live 2026-11-20); AP News sits behind a Cloudflare check. */
const NEWS_SOURCES: [RegExp, NewsSource][] = [
  [/الجزير[ةه]|jazeera/iu, { url: 'https://www.aljazeera.net/', name: 'الجزيرة نت' }],
  [/سكاي\s*نيوز|sky\s*news/iu, { url: 'https://www.skynewsarabia.com/', name: 'سكاي نيوز عربية' }],
  [/guardian|الغارديان|الجارديان/iu, { url: 'https://www.theguardian.com/international', name: 'The Guardian' }],
  [/bbc|بي\s*بي\s*سي/iu, { url: 'https://www.bbc.com/arabic', name: 'BBC News عربي' }],
];
const BBC_ENGLISH: NewsSource = { url: 'https://www.bbc.co.uk/news', name: 'BBC News' };
const NEWS_WORD = /(?:^|\s)(?:ال)?(?:[اأ]خبار|عناوين)(?=\s|$)|\b(?:news|headlines)\b/iu;
/** Words that only shape a news request; what is left names a source or a topic. */
const NEWS_FILLER = /(?:^|\s)(?:لخص|لخصلي|اعطني|أعطني|اعرض|قل|هات|ما|ماذا|هي|شو|ايش|إيش|وش|لي|أهم|اهم|آخر|اخر|أبرز|ابرز|اليوم|الآن|الان|حاليا|حاليًا|الصباح|من|في|على|عن|موقع|(?:ال)?[اأ]خبار|عناوين|العناوين|summari[sz]e|give|tell|show|me|the|what|what's|whats|is|are|top|latest|today|today's|todays|now|from|on|in|of|news|headlines|please)(?=\s|$)/giu;

/** «لخّص لي أهم أخبار اليوم», «أخبار الجزيرة», «آخر أخبار الاقتصاد», «what's the news today». */
function parseNews(text: string): HandsStep | null {
  if (!NEWS_WORD.test(text)) return null;
  let rest = ` ${text} `.replace(/[؟?،,.!]/gu, ' ');
  let source: NewsSource | null = null;
  for (const [pattern, found] of NEWS_SOURCES) if (pattern.test(rest)) { source = found; rest = rest.replace(pattern, ' '); break; }
  // Twice: fillers that sit next to each other share the space between them.
  rest = rest.replace(NEWS_FILLER, ' ').replace(NEWS_FILLER, ' ').replace(/\s+/g, ' ').trim();
  // A long remainder is a question about the news, not a request for headlines.
  if (rest.split(' ').filter(Boolean).length > 3) return null;
  const arabic = /[؀-ۿ]/u.test(text);
  return { kind: 'news', source: source ?? (arabic ? NEWS_SOURCES[3][1] : BBC_ENGLISH), topic: rest };
}

export interface HandsPlan {
  steps: HandsStep[];
  /** Index of the next step to run; advanced before a step's effect so a resume never repeats it. */
  next: number;
  /** Where the last reading stopped, so «اقرأ المزيد» continues on the same page. */
  read?: { url: string; start: number; offset: number };
  /** A question's search results, and the first page whose own sentences answer it. */
  results?: { title: string; url: string }[];
  found?: { url: string; title: string; lines: string[] };
}

const VERBS = '(?:ابحث|أبحث|إبحث|دور|فتش|اضغط|إضغط|انقر|اختر|افتح|إفتح|ادخل|اقرأ|إقرأ|اقرا|لخص|اكتب|أكتب|ارجع|إرجع|مرر|انزل|نزل)';
const SPLIT = new RegExp(`\\s*[،,؛;]\\s*(?:ثم\\s+|و\\s*)?(?=${VERBS})|\\s+(?:ثم|وبعدين|وبعدها|بعدها|and then|then)\\s+|\\s+and\\s+(?=(?:search|look up|click|tap|open|read|type|scroll|go back|summari))|\\s+و(?=${VERBS})`, 'iu');

/** Removes Arabic marks and tatweel and trailing punctuation; keeps the owner's words. */
export function tidy(text: string): string {
  return text.normalize('NFC').replace(/[ـً-ٰٟ]/gu, '').replace(/\s+/g, ' ').replace(/[\s.!؟?]+$/u, '').trim();
}

/** A matching key: case, hamza forms, alef maqsura and ta marbuta folded. */
export function fold(text: string): string {
  return tidy(text).toLowerCase().replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/[«»"“”'‘’]/gu, '').trim();
}

const ORDINAL_WORDS: [RegExp, number][] = [
  [/^(?:ال)?اول(?:ي)?$|^first$|^1(?:st)?$|^١$/, 1], [/^(?:ال)?ثاني(?:ه)?$|^second$|^2(?:nd)?$|^٢$/, 2], [/^(?:ال)?ثالث(?:ه)?$|^third$|^3(?:rd)?$|^٣$/, 3],
  [/^(?:ال)?رابع(?:ه)?$|^fourth$|^4(?:th)?$|^٤$/, 4], [/^(?:ال)?خامس(?:ه)?$|^fifth$|^5(?:th)?$|^٥$/, 5], [/^(?:ال)?سادس(?:ه)?$|^sixth$|^6(?:th)?$|^٦$/, 6],
  [/^(?:ال)?سابع(?:ه)?$|^seventh$|^7(?:th)?$|^٧$/, 7], [/^(?:ال)?ثامن(?:ه)?$|^eighth$|^8(?:th)?$|^٨$/, 8], [/^(?:ال)?تاسع(?:ه)?$|^ninth$|^9(?:th)?$|^٩$/, 9],
  [/^(?:ال)?عاشر(?:ه)?$|^tenth$|^10(?:th)?$|^١٠$/, 10],
];
const ORDINAL_FILLER = /(?:^|\s)(?:ال)?نتيجه|(?:^|\s)(?:ال)?رابط|(?:^|\s)(?:ال)?فيديو|(?:^|\s)(?:ال)?مقال|(?:^|\s)(?:ال)?خيار|(?:^|\s)(?:ال)?خبر|(?:^|\s)(?:ال)?عنوان|\bnews\b|\bstory\b|\barticle\b|\bheadline\b|(?:^|\s)رقم|\bresults?\b|\blinks?\b|\bvideo\b|\bthe\b|\bnumber\b|\bno\.?|\bitem\b|\boption\b|#/gu;

/** «أول نتيجة», «النتيجة الثانية», «2», «the first result» → 1, 2, 2, 1. */
export function ordinalOf(phrase: string): number | null {
  const rest = fold(phrase).replace(ORDINAL_FILLER, ' ').replace(/\s+/g, ' ').trim();
  for (const [pattern, value] of ORDINAL_WORDS) if (pattern.test(rest)) return value;
  return null;
}

const strip = (text: string) => tidy(text).replace(/^[«"“']+|[»"”']+$/gu, '').trim();
const LABEL_WORDS = /^(?:على\s+)?(?:زر|الزر|رابط|الرابط|كلم[ةه]|button|link|the)\s+|\s+(?:button|link|زر)$/iu;

/** Splits a peeled «… في/على SITE» tail off a query when the tail names a known site. */
function peelSite(query: string, joiners: RegExp): { query: string; site: { url: string; name: string } | null } {
  const words = query.split(' ');
  for (let take = Math.min(3, words.length - 2); take >= 1; take--) {
    const joiner = words[words.length - take - 1];
    if (!joiners.test(joiner)) continue;
    const site = namedSite(words.slice(-take).join(' '));
    if (site) return { query: words.slice(0, -take - 1).join(' '), site };
  }
  return { query, site: null };
}

function parseSegment(raw: string): HandsStep | HandsStep[] | null {
  const text = tidy(raw).replace(/^(?:من فضلك|لو سمحت|please)[،,\s]+/iu, '');
  if (!text) return null;
  const route = directRoute(text);
  if (route?.finishes) return { kind: 'open', url: route.url, name: route.name };
  // A named site with words after it that are not another command: not ours to guess.
  if (route) return null;

  let match = /^(?:ابحث|أبحث|إبحث|دور|فتش)(?:\s+لي)?(?:\s+(?:في|على|داخل)\s+(.+?))?\s+عن\s+(.+)$/u.exec(text);
  if (match) {
    const named = match[1] ? namedSite(match[1]) : null;
    if (match[1] && !named && !/^(?:ال)?(?:انترنت|إنترنت|نت|ويب|جوجل)$/u.test(match[1])) return null;
    const peeled = named ? { query: match[2], site: named } : peelSite(match[2], /^(?:في|على|ب)$/u);
    return peeled.query ? { kind: 'search', query: strip(peeled.query), site: peeled.site } : null;
  }
  match = /^(?:search|look up)\s+(\S+)\s+for\s+(.+)$/i.exec(text);
  if (match && namedSite(match[1])) return { kind: 'search', query: strip(match[2]), site: namedSite(match[1]) };
  match = /^(?:search(?:\s+for)?|look up)\s+(.+)$/i.exec(text);
  if (match) {
    const peeled = peelSite(match[1], /^(?:on|in|at)$/i);
    return peeled.query ? { kind: 'search', query: strip(peeled.query), site: peeled.site } : null;
  }

  match = /^(?:اكتب|أكتب|إكتب)\s+(.+?)\s+(?:في|داخل)\s+(?:ال)?(?:خان[ةه]|حقل|مربع)\s*(.*)$/u.exec(text)
    ?? /^(?:type|enter|write)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(.+?)(?:\s+(?:field|box|input))?$/i.exec(text);
  if (match) return { kind: 'type', text: strip(match[1]), field: strip(match[2] ?? '') };

  const news = parseNews(text);
  if (news) return news;
  // «اقرأ الخبر الثالث»: open that numbered item, then read it.
  match = /^(?:اقرأ|إقرأ|اقرا|لخص|read|summari[sz]e)(?:\s+لي|\s+me)?\s+(.+)$/iu.exec(text);
  const readOrdinal = match ? ordinalOf(match[1]) : null;
  if (readOrdinal) return [{ kind: 'click', target: strip(match![1]), ordinal: readOrdinal }, { kind: 'read', more: false }];

  if (/^(?:اقرأ|إقرأ|اقرا|أكمل|اكمل)\s+(?:لي\s+)?(?:المزيد|الباقي|البقي[ةه]|القراء[ةه])$|^(?:read more|continue reading|more)$/iu.test(text)) return { kind: 'read', more: true };
  if (/^(?:اقرأ|إقرأ|اقرا|لخص|اعرض)(?:\s+لي)?(?:\s+(?:محتوى\s+)?(?:هذه\s+)?(?:الصفح[ةه]|المحتوى|النص|المقال[ةه]?|الموقع|ما فيها))?$|^(?:ماذا|ما الذي|شو)\s+(?:في|يوجد في|تقول|مكتوب في)\s+(?:هذه\s+)?(?:الصفح[ةه])$|^(?:read|summari[sz]e)(?:\s+(?:me\s+)?(?:the|this)\s+(?:page|article))?$|^what(?:'s| is| does)\s+(?:on\s+)?(?:the|this)\s+page(?:\s+say)?$/iu.test(text)) return { kind: 'read', more: false };

  if (/^(?:انزل|نزل|مرر|مرّر)(?:\s+(?:لل?[أا]سفل|تحت|للتحت|الصفح[ةه]))?$|^scroll(?:\s+down)?$/iu.test(text)) return { kind: 'scroll', up: false };
  if (/^(?:اطلع|اصعد|مرر\s+لل?[أا]على)$|^scroll up$/iu.test(text)) return { kind: 'scroll', up: true };
  if (/^(?:ارجع|إرجع|رجوع|عد)(?:\s+(?:للخلف|للوراء|لل?صفح[ةه] السابق[ةه]))?$|^(?:go\s+)?back$/iu.test(text)) return { kind: 'back' };

  match = /^(?:اضغط|إضغط|انقر|اختر|افتح|إفتح|ادخل)\s+(?:لي\s+)?(?:على\s+|عل\s+|إلى\s+|الى\s+)?(.+)$/u.exec(text)
    ?? /^(?:click|tap|choose|select|open)\s+(?:on\s+)?(.+)$/i.exec(text);
  if (match) {
    const named = strip(match[1]);
    const target = named.replace(LABEL_WORDS, '').trim();
    if (!target) return null;
    const ordinal = ordinalOf(target);
    // «افتح/ادخل X» is a click only for a numbered result or a named link or button; «ادخل إلى حسابي» is a goal.
    if (/^(?:افتح|إفتح|ادخل|open)\s/iu.test(text) && !ordinal && named === target) return null;
    return { kind: 'click', target, ordinal };
  }
  return null;
}

/**
 * The owner's request as browser steps, or null when any part is not a plain browser command.
 * A lone «افتح موقع» stays with the direct route, which proves the opened destination.
 */
export function parseHands(request: string): HandsStep[] | null {
  const segments = tidy(request).split(SPLIT).map(part => part?.trim()).filter((part): part is string => Boolean(part));
  if (!segments.length || segments.length > 6) return null;
  const steps: HandsStep[] = [];
  for (const segment of segments) {
    const step = parseSegment(segment);
    if (!step) return null;
    steps.push(...(Array.isArray(step) ? step : [step]));
  }
  if (steps.length === 1 && steps[0].kind === 'open') return null;
  return steps;
}

/** Information that lives on the web and changes: prices, weather, scores, schedules, anything «today» or «latest». */
const LIVE = /(?:^|\s)(?:ب|و|ل)?(?:ال)?(?:سعر|اسعار|أسعار|طقس|حرار[ةه]|صرف|نتيج[ةه]|نتائج|مباراة|مباريات|موعد|مواعيد|دوام|ترتيب|عنوان)(?=\s|$)|(?:^|\s)(?:اليوم|الآن|الان|حاليا|حاليًا|هالأيام|هذه الأيام|غدا|غدًا|بكرة|الليلة|آخر|اخر|أحدث|احدث)(?=\s|$)|\b(?:price|prices|cost|weather|forecast|temperature|score|scores|exchange rate|fixtures?|schedule|today|tonight|tomorrow|now|current(?:ly)?|latest|this week|opening hours)\b/iu;
/** «دورلي على…», «شوفلي…»: a lookup asked without the formal verb. */
const LOOKUP = /^(?:ابحثلي|ابحث لي|دورلي|دور لي|شوفلي|شوف لي|اعرفلي|اعرف لي|جدلي|جد لي|find out|google)\s+(?:عن\s+|على\s+)?(.+)$/iu;
/**
 * The finite list of what is never a web search: memory, Ads, the PC and code, reminders,
 * arithmetic, and writing that needs a model. Everything else is searched.
 */
const NOT_WEB = /(?:^|\s)(?:[تي]?تذكر|تذكّر|احفظ|اسمي|شركتي|حسابي|عملائي|موقعي|متجري|بريدي|رسائلي|ايميلي|إيميلي|ذاكرت|ملاحظات|حمل[ةت]|حملات|إعلان|اعلان|جهازي|حاسوبي|كمبيوتري|نافذ[ةه]|ملف|مجلد|مشروع|الكود|كود|برمج)|\b(?:remember|my (?:notes|files|computer|pc|memory)|campaigns?|google ads|code|repo|window)\b|^[\d\s+\-*/×÷().,=^%]+[؟?]?$/iu;
const REMIND = /(?:^|\s)(?:ذكرني|ذكّرني|نبهني|نبّهني|فكرني|ذكرنى|منبه|تذكير)|\bremind me\b|\bset (?:an? )?(?:alarm|reminder|timer)\b/iu;
const ARITHMETIC = /[\d٠-٩]\s*(?:[+\-*/×÷^]|ضرب|زائد|ناقص|قسم[ةه]?\s+على|تقسيم|plus|minus|times|divided by)\s*[\d٠-٩]/iu;
const WRITER = /^(?:ترجم|اكتب|أكتب|إكتب|صغ|صيغ|اعد صياغ|أعد صياغ|صحح|حسن|translate|write|draft|rewrite|compose|correct)(?=\s|$)/iu;
/** Small talk, acknowledgements and questions about the assistant itself. */
const CHAT = /^(?:هلا|مرحبا|السلام|اهلا|أهلا|صباح|مساء|كيف حالك|كيفك|شلونك|شكرا|hi|hello|hey|how are you|thanks|thank you)(?=\s|$|[؟?!.,،])|^(?:تمام|اوك[يه]?|ok(?:ay)?|نعم|لا|ايوه|إيوه|اي|طيب|حسنا|حسنًا|ممتاز|رائع|جميل|good|great|nice|yes|no|cool)$|(?:^|\s)(?:انت|أنت|اسمك|تستطيع|تقدر)(?=\s|$|[؟?])|\b(?:you|your)\b/iu;

/** Why a request is not a web search, or null when it is one. */
export function notWebReason(text: string): 'memory_ads_pc' | 'reminder' | 'arithmetic' | 'writing' | 'chat' | 'address' | 'empty' | null {
  if (!text || text.length > 200) return 'empty';
  if (REMIND.test(text)) return 'reminder';
  if (NOT_WEB.test(text)) return 'memory_ads_pc';
  if (ARITHMETIC.test(text)) return 'arithmetic';
  if (WRITER.test(text)) return 'writing';
  if (URL_LIKE.test(text) || directRoute(text)) return 'address';
  if (CHAT.test(text) && !LIVE.test(text)) return 'chat';
  return null;
}

/**
 * Search is the default: a request that is not a browser command and not on the finite
 * not-the-web list becomes one browser search that reads the answer. No list of questions to grow.
 * `earlier` holds the owner's previous messages in this conversation, oldest first, for follow-ups.
 */
export function webQuestion(request: string, earlier: readonly string[] = []): HandsStep[] | null {
  const raw = request.normalize('NFC').replace(/^(?:من فضلك|لو سمحت|please)[،,\s]+/iu, '').trim();
  const text = tidy(raw);
  if (notWebReason(text)) return null;
  const lookup = LOOKUP.exec(text);
  const own = lookup ? strip(lookup[1]) : text;
  const query = withTopic(own, earlier);
  return query ? [{ kind: 'search', query, site: null, ask: true }] : null;
}

/** «وكم سعره في مصر؟», «طيب وبكرة؟», «what about Paris»: a question that leans on the one before it. */
const FOLLOW_START = /^(?:طيب|طب|طيّب|حسنا|and|what about|how about)\s+|^(?:و\s*)?(?:ماذا|ما|وش|شو|ايش)\s+عن\s+|^و(?=كم|متى|متي|ماذا|ما\s|هل|في\s|بكر|غد|اليوم|الان|الآن|سعر|ايش|شو|اين|أين|كيف|ليش|لماذا|من\s|عن\s|ال)/iu;
const POINTER = /(?:^|\s)(?:[^\s]{2,}(?:ه|ها|هم|هن))(?=\s|$)|\b(?:it|its|it's|that|there|them|they|he|she|his|her)\b/iu;
const TIME_WORDS = new Set(['اليوم', 'الان', 'الآن', 'حاليا', 'غدا', 'بكره', 'بكرة', 'الليله', 'today', 'now', 'tomorrow', 'tonight', 'current', 'latest']);

/** Whether this message leans on the one before it rather than naming its own topic. */
export function isFollowUp(text: string): boolean {
  if (FOLLOW_START.test(text)) return true;
  return text.split(' ').length <= 4 && POINTER.test(text);
}

/**
 * Adds the previous question's topic words to a follow-up; any other message is returned as it is.
 * The previous message counts only when it was itself a web search, so a command or a thanks adds nothing.
 */
export function withTopic(text: string, earlier: readonly string[]): string {
  if (!isFollowUp(text)) return text;
  let own = text;
  for (let round = 0; round < 3 && FOLLOW_START.test(own); round++) own = own.replace(FOLLOW_START, '').trim();
  const previousIndex = earlier.length - 1;
  if (previousIndex < 0) return own || text;
  const previous = tidy(earlier[previousIndex].normalize('NFC'));
  if (parseHands(previous) || notWebReason(previous)) return own || text;
  const before = withTopic(LOOKUP.exec(previous) ? strip(LOOKUP.exec(previous)![1]) : previous, earlier.slice(0, previousIndex));
  const have = fold(own);
  // «what about Paris», «وفي الأردن»: a new place or name replaces the old one rather than joining it.
  const pointer = (word: string) => POINTER.test(word);
  const replaces = own.split(' ').some(word => { const key = fold(word); return key && !ASK_WORDS.has(key) && !TIME_WORDS.has(key) && !pointer(word); });
  const slots = new Set<string>();
  if (replaces) before.split(' ').forEach((word, index, words) => {
    if (/^[A-Z][a-z]/.test(word) && index > 0) slots.add(word);
    if (index > 0 && /^(?:في|in|at|ب)$/iu.test(words[index - 1])) slots.add(word);
  });
  const topic = before.split(' ').filter(word => {
    if (slots.has(word) || /^(?:في|in|at)$/iu.test(word)) return false;
    const key = fold(word).replace(/[؟?،,]/gu, '');
    return key && !ASK_WORDS.has(key) && !TIME_WORDS.has(key) && !have.includes(key.length > 4 && key.startsWith('ال') ? key.slice(2) : key);
  });
  return [own, ...topic].filter(Boolean).join(' ').trim() || text;
}
const URL_LIKE = /https?:\/\/|\bwww\.|\b[\w-]+\.(?:com|net|org|io|co|uk|sa|ae|dev|app)\b/i;

/** Question words carry no topic: dropped before matching a page's sentences to the question. */
const ASK_WORDS = new Set(['كم', 'متي', 'وين', 'اين', 'من', 'ما', 'ماذا', 'هل', 'ليش', 'لماذا', 'كيف', 'شو', 'ايش', 'وش', 'قديش', 'اديش', 'هو', 'هي', 'في', 'عن', 'على', 'علي',
  'what', "what's", 'whats', 'when', 'where', 'who', "who's", 'how', 'which', 'is', 'are', 'does', 'do', 'did', 'why', 'the', 'in', 'of', 'for', 'a',
  'اليوم', 'الان', 'الآن', 'حاليا', 'now', 'today', 'current', 'currently', 'latest', 'اخر', 'احدث']);

/** The page's own sentences that share the question's words, best first by page order; quoted, never rewritten. */
export function relevantLines(page: AgentPage, question: string, limit = 3): string[] {
  const words = queryWords(fold(question).replace(/[؟?]/gu, ' ').split(/\s+/).filter(word => word && !ASK_WORDS.has(word)).join(' '));
  if (!words.length) return [];
  const need = Math.min(2, words.length);
  // A price, a time or a score is a number: for such questions a sentence without one does not answer.
  const wantsNumber = LIVE.test(question);
  const labels = [...new Set(page.elements.filter(element => ['link', 'button'].includes(element.role)).map(element => tidy(element.label).toLowerCase()).filter(label => label.length >= 2))]
    .sort((a, b) => b.length - a.length);
  const labelSet = new Set(labels.map(fold));
  const scored: { line: string; score: number; at: number }[] = [];
  const seen = new Set<string>();
  for (const match of page.text.matchAll(/[^.!?؟\n]+(?:[.!?؟]+|\n|$)/gu)) {
    const line = withoutChrome(match[0].replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim(), labels);
    const count = line.split(' ').length;
    const hasNumber = /[\d٠-٩]/u.test(line);
    if (count < (hasNumber ? 3 : 5) || line.length > 400 || seen.has(line) || (wantsNumber && !hasNumber)) continue;
    const folded = fold(line);
    // A run of the page's own menu labels is navigation, not an answer.
    const menuWords = labels.length ? folded.split(' ').filter(word => labelSet.has(word)).length : 0;
    if (menuWords / count > 0.3) continue;
    const hits = words.filter(word => folded.includes(word)).length;
    if (hits < need) continue;
    seen.add(line);
    // A number in the sentence is often the answer itself: a price, a time, a score.
    scored.push({ line, score: hits + (/\d/u.test(line) ? 1 : 0), at: match.index ?? 0 });
  }
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, limit)
    .sort((a, b) => a.at - b.at).map(item => item.line.length > 300 ? `${item.line.slice(0, 299)}…` : item.line);
}

const SEARCHY = /search|بحث|ابحث|query|find|look for|keywords?/i;
/** The page's own search field: a searchbox, a field labelled for search, or the only text field. */
export function findSearchBox(page: AgentPage): AgentElement | undefined {
  const fields = page.elements.filter(element => !element.disabled && (!element.field || element.field === 'text') && ['searchbox', 'textbox', 'combobox'].includes(element.role));
  const scored = fields.map(element => ({ element, score: (element.role === 'searchbox' ? 3 : 0) + (SEARCHY.test(element.label) ? 2 : 0) + (element.inViewport ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 2) return scored[0].element;
  return fields.length === 1 ? fields[0] : undefined;
}

const NAV = /^(?:skip to .*|sign in|sign up|log in|login|register|cart|basket|menu|home|help|privacy.*|terms.*|cookie.*|settings|images|videos|news|maps|shopping|more|next|previous|feedback|تسجيل الدخول|الدخول|الرئيسي[ةه]|المساعد[ةه]|الخصوصي[ةه]|الشروط.*|الإعدادات|الاعدادات|التالي|السابق|المزيد)$/i;
const AD_LINK = /duckduckgo\.com\/y\.js|\/aclk\?|googleadservices|doubleclick\.net/i;
const withoutHash = (url: string) => url.replace(/#.*$/, '');

/** The real destination behind a search engine's redirect link. */
export function realUrl(href: string): string {
  const url = URL.parse(href);
  if (!url) return href;
  if (/(?:^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname.startsWith('/l/')) return url.searchParams.get('uddg') ?? href;
  if (/(?:^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === '/url') return url.searchParams.get('q') ?? url.searchParams.get('url') ?? href;
  return href;
}

const QUERY_KEYS = ['q', 'query', 'search_query', 'search', 'keywords', 'k', 'p', 's', 'text', 'term', 'wd'];
/** The search words a results page carries in its own address, so later messages need no memory of them. */
export function queryOf(url: string): string | null {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  for (const key of QUERY_KEYS) { const value = parsed.searchParams.get(key)?.trim(); if (value) return value; }
  return null;
}

const ACCESS_KEY = /\balt-(?:shift-)?\w\b|\[alt/i;
/** Search words cut to a rough stem, so «tyres» finds «tyre» and «الخوارزمي» finds «خوارزمي». */
const queryWords = (query: string) => [...new Set(fold(query).split(/[\s,،.:;/+-]+/)
  .map(word => word.length > 4 && word.startsWith('ال') ? word.slice(2) : word)
  .filter(word => word.length >= 3 || /[؀-ۿ]{2,}/u.test(word))
  .map(word => word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word))];

/**
 * Result-like links in page order: descriptive text, a real destination, no navigation chrome or ads.
 * On a page whose address carries search words, only links sharing a word with them count as results.
 */
/**
 * Wikipedia's search page: results are article titles, often one word («اليابان»), so the length rule
 * of other engines would drop them all. An article link (no namespace, not the main page) whose title
 * shares a real search word (3+ letters) counts.
 */
function wikiResults(page: AgentPage, limit: number, words: string[]): { element: AgentElement; url: string }[] {
  const real = words.filter(word => word.length >= 3);
  const out: { element: AgentElement; url: string }[] = [], seen = new Set<string>();
  for (const element of page.elements) {
    if (element.role !== 'link' || !element.href || element.disabled) continue;
    const url = URL.parse(element.href, page.url);
    if (!url || !/(?:^|\.)wikipedia\.org$/.test(url.hostname) || !url.pathname.startsWith('/wiki/')) continue;
    let title = url.pathname.slice(6);
    try { title = decodeURIComponent(title); } catch { /* keep the raw title */ }
    if (!title || title.includes(':') || /^(?:الصفحة_الرئيسية|Main_Page)$/i.test(title)) continue;
    const key = withoutHash(url.href);
    if (seen.has(key) || !real.some(word => fold(`${tidy(element.label)} ${title.replace(/_/g, ' ')}`).includes(word))) continue;
    seen.add(key);
    out.push({ element, url: key });
    if (out.length >= limit) break;
  }
  return out;
}

export function resultLinks(page: AgentPage, limit = 10, query = queryOf(page.url)): { element: AgentElement; url: string }[] {
  const here = withoutHash(page.url), seen = new Set<string>(), titles = new Set<string>();
  const words = query ? queryWords(query) : [];
  if (/(?:^|\.)wikipedia\.org$/.test(URL.parse(page.url)?.hostname ?? '') && queryOf(page.url)) return wikiResults(page, limit, words);
  const longest = words.reduce((best, word) => word.length > best.length ? word : best, '');
  const out: { element: AgentElement; url: string }[] = [];
  for (const element of page.elements) {
    if (element.role !== 'link' || !element.href || element.disabled || !/^https?:/i.test(element.href) || AD_LINK.test(element.href)) continue;
    const label = tidy(element.label), url = realUrl(element.href), key = withoutHash(url), title = fold(label);
    if (label.length < 12 || label.split(' ').length < 2 || NAV.test(label) || ACCESS_KEY.test(label) || key === here || seen.has(key) || titles.has(title)) continue;
    if (words.length) {
      // The path only: a host such as docs.python.org would match «python» on every link.
      let path = URL.parse(url)?.pathname ?? '';
      try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
      const haystack = `${title} ${fold(path)}`;
      // Several words: two must match, or the longest one; a generic word alone («python») is navigation.
      const matched = words.filter(word => haystack.includes(word));
      if (!(matched.length >= Math.min(2, words.length) || matched.includes(longest))) continue;
    }
    seen.add(key); titles.add(title);
    out.push({ element, url });
    if (out.length >= limit) break;
  }
  return out;
}

/** An article address: a dated path, a long numeric id, /articles/ or /live/, or a long slug. */
const ARTICLE_PATH = /\/\d{4}\/(?:\d{1,2}|[a-z]{3})\/\d{1,2}\/|\/\d{5,}|\/(?:articles?|live|liveblog|story|stories)\/|\/[^/]*-[^/]*-[^/]*-[^/]{3,}\/?$/i;

/** Site service pages that look like articles: cookie and privacy notices, accounts, subscriptions. */
const SERVICE_PATH = /cookie|privacy|terms|consent|settings|usingthebbc|subscri|support|account|sign-?in|newsletter/i;

/** A front page's story links in page order: three words or more and an article address. */
export function headlines(page: AgentPage): { element: AgentElement; url: string }[] {
  return resultLinks(page, 60, null).filter(item => {
    const path = URL.parse(item.url)?.pathname ?? '';
    return tidy(item.element.label).split(' ').length >= 3 && ARTICLE_PATH.test(path) && !SERVICE_PATH.test(path);
  });
}

/** The element the owner named: an ordinal over result links, else the closest visible label. */
export function findTarget(page: AgentPage, step: Extract<HandsStep, { kind: 'click' }>): AgentElement | undefined {
  if (step.ordinal) {
    // A front page without search words numbers its stories, as the news reply listed them.
    const stories = queryOf(page.url) ? [] : headlines(page);
    if (stories.length >= 3) return stories[step.ordinal - 1]?.element;
    const results = resultLinks(page);
    // A results page with no matching links has no «first result»; another link would be a guess.
    if (results.length || queryOf(page.url)) return results[step.ordinal - 1]?.element;
    return page.elements.filter(element => element.role === 'link' && !element.disabled && element.label.trim() && /^https?:/i.test(element.href ?? ''))[step.ordinal - 1];
  }
  const want = fold(step.target);
  if (!want) return undefined;
  let best: { element: AgentElement; score: number } | undefined;
  for (const element of page.elements) {
    if (element.disabled || ['textbox', 'searchbox', 'file', 'combobox'].includes(element.role)) continue;
    const label = fold(element.label);
    if (!label) continue;
    const score = label === want ? 4 : label.startsWith(want) ? 3 : label.includes(want) ? 2 : label.length >= 4 && want.includes(label) ? 1 : 0;
    if (!score) continue;
    const ranked = score + (element.inViewport ? 0.5 : 0) - label.length / 1000;
    if (!best || ranked > best.score) best = { element, score: ranked };
  }
  return best?.element;
}

/** A plain text field by its label; secrets are never typed by this path. */
export function findField(page: AgentPage, name: string): AgentElement | undefined {
  const fields = page.elements.filter(element => !element.disabled && ['textbox', 'searchbox', 'combobox'].includes(element.role) && (!element.field || element.field === 'text' || element.field === 'identifier'));
  if (!name) return fields.find(element => element.inViewport) ?? fields[0];
  const want = fold(name);
  return fields.find(element => fold(element.label) === want) ?? fields.find(element => fold(element.label).includes(want)) ?? fields.find(element => want.includes(fold(element.label)) && fold(element.label).length >= 3);
}

const READ_WINDOW = 1200;
const FUNCTION_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'and', 'to', 'in', 'for', 'on', 'with', 'that', 'this', 'it', 'as', 'by', 'from', 'be', 'has', 'have', 'can', 'you', 'your', 'our', 'we', 'or', 'not', 'will', 'if',
  'في', 'من', 'علي', 'الي', 'عن', 'مع', 'هو', 'هي', 'التي', 'الذي', 'الذين', 'كان', 'كانت', 'قد', 'لم', 'لا', 'ان', 'ما', 'هذا', 'هذه', 'ذلك', 'تلك', 'ثم', 'او', 'كما', 'حيث', 'بعد', 'قبل', 'عند', 'وهو', 'وهي', 'وقد', 'ولا', 'وفي', 'ومن']);

/** A prose sentence, not a run of menu words: enough words, and enough of them are function words. */
function prose(sentence: string): boolean {
  const words = fold(sentence).split(' ');
  if (words.length < 6) return false;
  const glue = words.filter(word => FUNCTION_WORDS.has(word)).length;
  return glue / words.length >= 0.1;
}

/** Drops the menu words glued before a sentence: a run of the page's own link and button labels at its start. */
function withoutChrome(sentence: string, labels: string[]): string {
  let rest = sentence;
  for (let round = 0; round < 40; round++) {
    const lower = rest.toLowerCase();
    const label = labels.find(item => lower.startsWith(item) && (lower.length === item.length || lower[item.length] === ' '));
    if (!label) break;
    const after = rest.slice(label.length).trimStart();
    // «Renew or replace…»: a lowercase Latin word next means the label begins the sentence itself.
    if (/^[a-z]/.test(after)) break;
    rest = after;
  }
  return rest;
}

/** Readable sentences of the page from an offset: quoted as they are, never rewritten. */
export function excerpt(page: AgentPage, offset = 0, size = READ_WINDOW): { lines: string[]; end: number; more: boolean } {
  const text = page.text, lines: string[] = [], seen = new Set<string>();
  let used = 0, position = offset, gap = false;
  const labels = [...new Set(page.elements.filter(element => ['link', 'button'].includes(element.role)).map(element => tidy(element.label).toLowerCase()).filter(label => label.length >= 2))]
    .sort((a, b) => b.length - a.length);
  for (const match of text.slice(offset).matchAll(/[^.!?؟\n]+(?:[.!?؟]+|\n|$)/gu)) {
    const sentence = withoutChrome(match[0].replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim(), labels);
    const room = size - used;
    if (room <= 60 && lines.length) break;
    position = offset + (match.index ?? 0) + match[0].length;
    if (!prose(sentence) || seen.has(sentence)) { gap = true; continue; }
    seen.add(sentence);
    const kept = sentence.length > 400 ? `${sentence.slice(0, 399)}…` : sentence;
    const piece = kept.length > room ? `${kept.slice(0, Math.max(60, room - 1))}…` : kept;
    // Adjacent sentences stay one paragraph; skipped text between them starts a new one.
    if (lines.length && !gap) lines[lines.length - 1] += ` ${piece}`; else lines.push(piece);
    gap = false;
    used += kept.length;
  }
  return { lines, end: position, more: position < text.trim().length - 25 };
}

const DUCK = (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
/** Question words only narrow an encyclopedia search; «ما عاصمة اليابان» searches «عاصمة اليابان». */
const WIKI_ASK_LEAD = /^(?:(?:ما|ماذا|من|متى|أين|اين|كم|كيف|هل|لماذا|ما هي|ما هو|what|who|when|where|which|how|why|is|are|was|were|the|of)\s+)+/iu;
/** Wikipedia's own full-text search in the question's language: keyless and with no human check. */
export const WIKI_SEARCH = (query: string) => {
  const words = query.trim().replace(/[؟?]+$/u, '').replace(WIKI_ASK_LEAD, '').trim() || query.trim();
  return `https://${/[؀-ۿ]/u.test(query) ? 'ar' : 'en'}.wikipedia.org/w/index.php?search=${encodeURIComponent(words)}&fulltext=1&ns0=1`;
};
const SEARCH_TEMPLATES: [RegExp, (query: string) => string][] = [
  [/(?:^|\.)youtube\.com$/, query => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`],
  [/(?:^|\.)google\.com$/, query => `https://www.google.com/search?q=${encodeURIComponent(query)}`],
  [/(?:^|\.)github\.com$/, query => `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`],
];
function templateFor(siteUrl: string, query: string): string | null {
  const host = URL.parse(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`)?.hostname ?? '';
  const found = SEARCH_TEMPLATES.find(([pattern]) => pattern.test(host));
  return found ? found[1](query) : null;
}

export interface HandsIO {
  /** The conversation's live page, or null when no page is open. */
  page(): Promise<AgentPage | null>;
  act(action: AgentAction): Promise<AgentPage>;
  prepare(action: AgentAction): Promise<AgentRequestPermit | null>;
  /** Cookie banners, sign-in and human checks; null when the run paused or ended there. */
  settle(page: AgentPage): Promise<AgentPage | null>;
  step(label: string): Promise<void>;
  /** Saves the plan, then pauses for the owner's approval of this exact request. */
  approve(action: AgentAction, permit: AgentRequestPermit, label: string): Promise<void>;
  hold(held: AgentEffectHeld['held'], label: string): Promise<void>;
}

export type HandsOutcome = { kind: 'paused' } | { kind: 'done'; text: string; status: 'completed' | 'partial' | 'blocked' };

const hostOf = (url: string) => URL.parse(url)?.hostname.replace(/^www\./, '') ?? url;
const NO_PAGE = 'لا توجد صفحة مفتوحة في هذه المحادثة. قل لي أي موقع أفتح أولًا، مثل «افتح bbc.com».';

/** Runs the plan from `plan.next`. The caller persists `plan` in the run state before any pause. */
export async function runHands(plan: HandsPlan, io: HandsIO): Promise<HandsOutcome> {
  let page = await io.page();
  const go = async (action: AgentAction, label: string): Promise<AgentPage | null> => {
    let next: AgentPage;
    try { next = await io.act(action); }
    catch (error) {
      if (error instanceof AgentEffectHeld) { await io.hold(error.held, label); return null; }
      throw error;
    }
    return io.settle(next);
  };
  /** A native form: a GET is just an address to open; anything else waits for the owner. */
  const submit = async (action: AgentAction, label: string): Promise<AgentPage | null | 'none'> => {
    const permit = await io.prepare(action).catch(() => null);
    if (!permit) return 'none';
    if (permit.method === 'GET') return go({ kind: 'open', text: permit.url }, label);
    await io.approve(action, permit, label);
    return null;
  };

  /**
   * A general web search. The server's hidden browser is refused by search engines: a human check, or
   * (DuckDuckGo, 2026-11-21) an error page with no results. The owner cannot solve that from the chat,
   * so either case sends the search to Wikipedia instead of pausing. A page with results goes through
   * `settle` as before.
   */
  const engine = async (query: string): Promise<AgentPage | null> => {
    const label = `البحث عن ${query}`;
    let first: AgentPage;
    try { first = await io.act({ kind: 'open', text: DUCK(query) }); }
    catch (error) {
      if (error instanceof AgentEffectHeld) { await io.hold(error.held, label); return null; }
      throw error;
    }
    const checked = situation(first) === 'captcha';
    if (!checked) {
      // Results can be drawn after the load: look twice more before giving up on the engine.
      for (let look = 0; look < 2 && !resultLinks(first, 1, query).length; look++) first = await io.act({ kind: 'wait', text: '2000' });
      if (resultLinks(first, 1, query).length) return io.settle(first);
    }
    await io.step(`${checked ? `طلب ${hostOf(first.url)} تحققًا بشريًا` : `لم يعرض ${hostOf(first.url)} نتائج`}؛ البحث في ويكيبيديا بدلًا منه`);
    return go({ kind: 'open', text: WIKI_SEARCH(query) }, label);
  };

  while (plan.next < plan.steps.length) {
    const index = plan.next, step = plan.steps[index];
    switch (step.kind) {
      case 'open': {
        await io.step(`فتح ${step.name}`);
        plan.next = index + 1;
        const opened = await go({ kind: 'open', text: step.url }, `فتح ${step.name}`);
        if (!opened) return { kind: 'paused' };
        page = opened;
        break;
      }
      case 'search': {
        const template = step.site ? templateFor(step.site.url, step.query) : null;
        if (step.site && !template) {
          // Two effects become two steps, so a pause after opening the site never repeats or skips one.
          plan.steps.splice(index, 1, { kind: 'open', url: step.site.url, name: step.site.name }, { kind: 'search', query: step.query, site: null, here: true });
          continue;
        }
        await io.step(`البحث عن «${step.query.slice(0, 60)}»`);
        plan.next = index + 1;
        const box = !template && page ? findSearchBox(page) : undefined;
        if (!template && !box && step.here) return { kind: 'done', status: 'partial', text: page ? `لم أجد خانة بحث في ${hostOf(page.url)}. الصفحة ظاهرة في لوحة المتصفح؛ قل «ابحث عن ${step.query} في الإنترنت» لأبحث خارجها.` : NO_PAGE };
        let reached: AgentPage | null | 'none';
        if (template) reached = await go({ kind: 'open', text: template }, `البحث عن ${step.query}`);
        else if (!box) reached = await engine(step.query);
        else {
          reached = await submit({ kind: 'type', ref: box.ref, text: step.query, submit: true }, `البحث عن «${step.query}»`);
          if (reached === 'none') {
            await io.act({ kind: 'type', ref: box.ref, text: step.query });
            reached = await go({ kind: 'press', text: 'Enter' }, `البحث عن «${step.query}»`);
          }
        }
        if (!reached) return { kind: 'paused' };
        page = reached;
        // Some sites draw their results after the page loads: look again, three times at most.
        for (let look = 0; look < 3 && queryOf(page.url) && !resultLinks(page, 1, step.query).length; look++) page = await io.act({ kind: 'wait', text: '2000' });
        if (step.ask) {
          // A question wants its answer, not a list: open the top results until one page answers in its own words.
          const results = resultLinks(page, 6, step.query);
          plan.results = results.map(item => ({ title: tidy(item.element.label).slice(0, 90).replace(/[[\]]/g, ''), url: item.url }));
          for (const item of results.slice(0, 3)) {
            await io.step(`قراءة ${hostOf(item.url)}`);
            const opened = await go({ kind: 'open', text: item.url }, `فتح ${hostOf(item.url)}`);
            if (!opened) return { kind: 'paused' };
            page = opened;
            const lines = relevantLines(page, step.query);
            if (lines.length) { plan.found = { url: page.url, title: tidy(page.title) || hostOf(page.url), lines }; break; }
          }
        }
        break;
      }
      case 'click': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        const element = findTarget(page, step);
        if (!element) {
          const near = (step.ordinal ? resultLinks(page).map(item => item.element) : page.elements.filter(item => item.inViewport && ['link', 'button'].includes(item.role) && item.label.trim()))
            .slice(0, 6).map(item => `«${tidy(item.label).slice(0, 60)}»`).join('، ');
          return { kind: 'done', status: 'partial', text: `لم أجد ${step.ordinal ? `النتيجة رقم ${step.ordinal}` : `«${step.target}»`} في ${hostOf(page.url)}.${near ? ` مما أراه في الصفحة: ${near}.` : ''}` };
        }
        const label = tidy(element.label).slice(0, 80) || step.target;
        const reason = sensitiveAction(label);
        if (reason) return { kind: 'done', status: 'partial', text: `«${label}» يبدو ${reason}، فلن أضغطه بنفسي. اضغطه أنت من لوحة المتصفح إن أردت، ثم قل لي «تابع».` };
        await io.step(`الضغط على «${label.slice(0, 50)}»`);
        plan.next = index + 1;
        let reached: AgentPage | null | 'none';
        if (element.role === 'link' && element.href && !/^https?:/i.test(element.href)) return { kind: 'done', status: 'partial', text: `«${label}» ليس رابط صفحة ويب (${element.href.split(':')[0]})، فلم أفتحه.` };
        if (element.role === 'link' && element.href) reached = await go({ kind: 'open', text: realUrl(element.href) }, label);
        else {
          reached = await submit({ kind: 'click', ref: element.ref }, label);
          if (reached === 'none') reached = await go({ kind: 'click', ref: element.ref }, label);
        }
        if (!reached) return { kind: 'paused' };
        page = reached;
        break;
      }
      case 'type': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        const field = findField(page, step.field);
        if (!field) return { kind: 'done', status: 'partial', text: `لم أجد ${step.field ? `خانة «${step.field}»` : 'خانة كتابة'} في ${hostOf(page.url)}.` };
        await io.step(`كتابة «${step.text.slice(0, 40)}»`);
        plan.next = index + 1;
        page = await io.act({ kind: 'type', ref: field.ref, text: step.text });
        break;
      }
      case 'news': {
        await io.step(`فتح ${step.source.name}`);
        plan.next = index + 1;
        const opened = await go({ kind: 'open', text: step.source.url }, `فتح ${step.source.name}`);
        if (!opened) return { kind: 'paused' };
        page = opened;
        break;
      }
      case 'read': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        await io.step('قراءة الصفحة');
        plan.next = index + 1;
        const offset = step.more && plan.read?.url === page.url ? plan.read.offset : 0;
        plan.read = { url: page.url, start: offset, offset: excerpt(page, offset).end };
        break;
      }
      case 'scroll': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        await io.step(step.up ? 'التمرير للأعلى' : 'التمرير للأسفل');
        plan.next = index + 1;
        page = await io.act({ kind: 'scroll', text: step.up ? 'up' : 'down' });
        break;
      }
      case 'back': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        await io.step('الرجوع للصفحة السابقة');
        plan.next = index + 1;
        const reached = await go({ kind: 'back' }, 'الرجوع');
        if (!reached) return { kind: 'paused' };
        page = reached;
        break;
      }
    }
  }
  if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
  return { kind: 'done', ...describe(plan, page) };
}


/** The reply is built only from what the page shows: titles, links and quoted sentences. */
export function describe(plan: HandsPlan, page: AgentPage): { text: string; status: 'completed' | 'partial' } {
  const last = plan.steps[plan.steps.length - 1];
  const where = `**${tidy(page.title) || hostOf(page.url)}** (${hostOf(page.url)})`;
  let lead = `وصلت إلى ${where}:`;
  if (last.kind === 'search' && last.ask && plan.results) {
    const list = (items: { title: string; url: string }[]) => items.map((item, index) => `${index + 1}. [${item.title}](${item.url}) — ${hostOf(item.url)}`).join('\n');
    if (plan.found) {
      const others = plan.results.filter(item => withoutHash(item.url) !== withoutHash(plan.found!.url)).slice(0, 4);
      const quote = plan.found.lines.map(line => `> ${line}`).join('\n>\n');
      return { status: 'completed', text: `بحثت في الإنترنت عن «${last.query}». هذا ما تقوله **${plan.found.title}** (${hostOf(plan.found.url)}) بنصّه:\n\n${quote}\n\nالمصدر: ${plan.found.url}${others.length ? `\n\nمصادر أخرى:\n${list(others)}` : ''}\n\nالصفحة مفتوحة في لوحة المتصفح؛ قل «اقرأ الصفحة» لأقرأ أكثر.` };
    }
    if (plan.results.length) return { status: 'partial', text: `بحثت في الإنترنت عن «${last.query}» وفتحت أول النتائج، لكن لم أجد فيها جملة تجيب مباشرة. النتائج:\n\n${list(plan.results)}\n\nقل «افتح النتيجة 2» مثلًا لأفتح واحدة.` };
  }
  if (last.kind === 'search') {
    const results = resultLinks(page, 8, queryOf(page.url) ?? last.query);
    if (results.length && queryOf(page.url)) {
      const list = results.map((item, index) => `${index + 1}. [${tidy(item.element.label).slice(0, 90).replace(/[[\]]/g, '')}](${item.url}) — ${hostOf(item.url)}`).join('\n');
      return { status: 'completed', text: `بحثت عن «${last.query}» في ${hostOf(page.url)}. أول النتائج:\n\n${list}\n\nقل «افتح النتيجة 2» مثلًا لأفتحها، أو «اقرأ الصفحة».` };
    }
    // No search words in the address: the site sent the search straight to a page.
    if (!queryOf(page.url)) lead = `بحثت عن «${last.query}» فنقلني الموقع مباشرة إلى ${where}:`;
    else return { status: 'partial', text: `بحثت عن «${last.query}» ووصلت إلى ${where}، لكن لم أجد في الصفحة روابط نتائج تطابق كلمات البحث. الصفحة ظاهرة في لوحة المتصفح.` };
  }
  if (last.kind === 'news') {
    const all = headlines(page);
    const words = last.topic ? queryWords(last.topic) : [];
    const shown = all.map((item, index) => ({ ...item, number: index + 1 }))
      .filter(item => !words.length || words.some(word => fold(item.element.label).includes(word))).slice(0, 10);
    if (!shown.length) return { status: 'partial', text: all.length
      ? `فتحت ${where}، ولا يذكر أي عنوان على صفحتها الرئيسية الآن «${last.topic}». قل «أخبار اليوم» لأعرض كل العناوين.`
      : `فتحت ${where}، لكن لم أميّز روابط الأخبار في صفحتها. الصفحة ظاهرة في لوحة المتصفح.` };
    const list = shown.map(item => `${item.number}. [${tidy(item.element.label).slice(0, 110).replace(/[[\]]/g, '')}](${item.url})`).join('\n');
    const others = NEWS_SOURCES.map(([, source]) => source.name).filter(name => name !== last.source.name).slice(0, 2).map(name => `«أخبار ${name}»`).join(' أو ');
    return { status: 'completed', text: `${last.topic ? `عناوين عن «${last.topic}»` : 'أهم العناوين'} الآن على الصفحة الرئيسية لـ${where}، كما تظهر هناك دون أن أعيد صياغتها:\n\n${list}\n\nقل «اقرأ الخبر ${shown[Math.min(1, shown.length - 1)].number}» مثلًا لأفتحه وأقرأه، أو ${others} لمصدر آخر.` };
  }
  if (last.kind === 'type') return { status: 'completed', text: `كتبت «${last.text}» في ${where}. قل «اضغط على …» لأتابع.` };
  const isRead = last.kind === 'read';
  if (isRead) lead = `من ${where}:`;
  const from = isRead && plan.read?.url === page.url ? plan.read.start : 0;
  const part = excerpt(page, from, isRead ? READ_WINDOW : 500);
  const quote = part.lines.length ? `\n\n${part.lines.map(line => `> ${line}`).join('\n>\n')}` : '\n\nلم أجد نصًا مقروءًا في الجزء الظاهر من الصفحة.';
  const tail = isRead ? (part.more ? '\n\nقل «اقرأ المزيد» لأكمل.' : '') : '\n\nقل «اقرأ الصفحة» لأقرأ أكثر، أو «اضغط على …».';
  return { status: 'completed', text: `${lead}${quote}${tail}` };
}
