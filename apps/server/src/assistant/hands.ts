import { AgentEffectHeld, BrowserError, compileQuery, publicSearchScan, publicSearchText, safeResumeUrl, webFreshnessText, type AgentAction, type AgentElement, type AgentPage, type AgentRequestPermit, type SearchHit } from '@mohassan/browser';
import { isBareAcknowledgement, stripAcknowledgementLead } from './acknowledgements.js';
import { directRoute, namedSite, sensitiveAction } from './brain.js';
import { hostOf, readingLabel, siteName } from './activity.js';
import { checkAnswerLine, figureKind, hasAnswerNumber, isDisambiguationPage, isDisambiguationTitle, isMetaLine, isReasonQuestion, questionLanguage } from './answer-check.js';
import { releaseLines, releaseQuestion } from './releases.js';
import { isCampaignRequest } from './campaign-request.js';
import { matchesConversationPage, readConversationPageLines, type ConversationPageRead } from './conversation-state-page.js';
import { isSiteRequest } from '@mohassan/sites';
import type { WebSequel } from './web-sequence.js';
import { splitReplyDirective, type ReplyField } from './reply-directive.js';
import { returnedTo } from './return-to.js';
import { evaluatePageReasoning, isPageReasoningRequest, planComparisonPage } from './reasoning/index.js';
import { resolveUnnamedSite, type UnnamedSite } from './clarify/website.js';
import { reviewHandsRefusal, reviewRefusalControl, reviewRefusalDestination, reviewRefusalField } from './refusal/permissions.js';
import { refusalReply } from './refusal/replies.js';
import { refusalPolicyEnabled } from './refusal/settings.js';
import type { RefusalDecision } from './refusal/types.js';
import { explicitFactualEvidence, formatFactualPassage, readFactualPassage } from './factual-evidence.js';

export { returnedTo };
export { siteName };
export type { UnnamedSite } from './clarify/website.js';

/**
 * How the owner asked the reply to look (reply-directive.ts), kept apart from the search words: «in two short Arabic
 * sentences», «Return the page title and source link». `lang` is the language asked for; `fields` are what to name.
 */
export interface HandsReply { lang?: 'ar' | 'en'; sentences?: number; fields?: ReplyField[] }

/**
 * The browser's hands without a model: the owner's words become a short list of steps,
 * and each step is matched against the elements the browser actually observed.
 * Nothing here guesses free text; an unclear request returns null and the old path runs.
 */
export type HandsStep =
  | { kind: 'open'; url: string; name: string }
  /** `ask`: the owner asked a question, so the run opens the top results and quotes the sentences that answer it. */
  | { kind: 'search'; query: string; site: { url: string; name: string } | null; here?: boolean; ask?: boolean; reply?: HandsReply }
  | { kind: 'click'; target: string; ordinal: number | null }
  | { kind: 'type'; text: string; field: string }
  | { kind: 'read'; more: boolean }
  | { kind: 'scroll'; up: boolean }
  | { kind: 'back' }
  | { kind: 'news'; source: NewsSource; topic: string }
  /** «افتح X وأخبرني بـY»: after the page opens, Y is answered from that page's own text, quoted (pageAnswer). */
  | { kind: 'ask_page'; question: string; conversationPage?: ConversationPageRead };

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
function parseNews(text: string, learned = false): HandsStep | null {
  if (!learned && !NEWS_WORD.test(text)) return null;
  let rest = ` ${text} `.replace(/[؟?،,.!]/gu, ' ');
  let source: NewsSource | null = null;
  for (const [pattern, found] of NEWS_SOURCES) if (pattern.test(rest)) { source = found; rest = rest.replace(pattern, ' '); break; }
  // Twice: fillers that sit next to each other share the space between them.
  rest = rest.replace(NEWS_FILLER, ' ').replace(NEWS_FILLER, ' ').replace(/\s+/g, ' ').trim();
  // A long remainder is a question about the news, not a request for headlines.
  if (!learned && rest.split(' ').filter(Boolean).length > 3) return null;
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
  /** `readAt`: when the page was fetched (a cached page keeps its original time), shown with the source (plan §7.1).
   *  `second`: for a figure, another page's sentence on the same question, and whether its figure agrees (plan §7.4).
   *  `official`: the product's own release page (releases.ts), so no second source is asked of it; `quote` is that page's
   *  own entry, shown under the answer line. */
  found?: { url: string; title: string; lines: string[]; readAt?: string; second?: { url: string; title: string; line: string; agrees: boolean }; official?: boolean; quote?: string };
  /** The language of the owner's request; replies that are not quotes follow it, not the query's script («ابحث عن Python docs» is Arabic). */
  lang?: 'ar' | 'en';
  /** Pages the pre-send judge refused as this question's source: the search is read again past them (the chat's correction step). */
  rejected?: string[];
  /** One part of a message of several questions (web-sequence.ts): what is answered so far and what is still to ask. */
  sequel?: WebSequel;
}

const VERBS = '(?:ابحث|أبحث|إبحث|دور|فتش|اضغط|إضغط|انقر|اختر|افتح|إفتح|ادخل|اقرأ|إقرأ|اقرا|لخص|اكتب|أكتب|ارجع|إرجع|مرر|انزل|نزل)';
const SPLIT = new RegExp(`\\s*[،,؛;]\\s*(?:ثم\\s+|و\\s*)?(?=${VERBS})|\\s+(?:ثم|وبعدين|وبعدها|بعدها|and then|then)\\s+|\\s+and\\s+(?=(?:search|look up|click|tap|open|read|type|scroll|go back|summari))|\\s+و(?=${VERBS})`, 'iu');

/** Asking to see what a page says: «اقرأ», «لخص», «اعرض», «أرني», with an object pronoun («اقرأها») or not. Tidied text. */
const SHOW_PAGE_AR = '(?:اقرأ|إقرأ|اقرا|لخص|اعرض|أعرض|اظهر|أظهر|ارني|أرني|ورني)(?:ها|ه)?';
/** What is to be seen: the page, its content or its text, by name or by a pronoun («محتواه», «ما فيها»). */
const PAGE_CONTENT_AR = '(?:محتوى\\s+)?(?:هذه\\s+)?(?:الصفح[ةه]|المحتوى|النص|المقال[ةه]?|الموقع|ما فيها|ما فيه|محتواه|محتواها|محتوياته|محتوياتها|نصه|نصها)';
const SHOW_PAGE_EN = '(?:read|summari[sz]e|show|display)';
const PAGE_CONTENT_EN = "(?:me\\s+)?(?:it|(?:the|this|its)\\s+(?:page|article|content|contents|text)|the\\s+page(?:'s)?\\s+(?:content|contents|text)|what(?:'s|\\s+is)\\s+on\\s+(?:it|the\\s+page))";
/**
 * «اقرأ الصفحة», «اعرض لي محتواه», «read the page», «show me its content»: the open page read out. «محتواه» and «أرني» were
 * not read until 2026-11-23, so «اعرض لي محتواه» after an open was searched as a question.
 */
const READ_PAGE = new RegExp(`^${SHOW_PAGE_AR}(?:\\s+لي)?(?:\\s+${PAGE_CONTENT_AR})?$|^(?:ماذا|ما الذي|شو)\\s+(?:في|يوجد في|تقول|مكتوب في)\\s+(?:هذه\\s+)?(?:الصفح[ةه])$|^(?:read|summari[sz]e)(?:\\s+(?:me\\s+)?(?:the|this)\\s+(?:page|article))?$|^(?:show|display)(?:\\s+${PAGE_CONTENT_EN})$|^what(?:'s| is| does)\\s+(?:on\\s+)?(?:the|this)\\s+page(?:\\s+say)?$`, 'iu');
/**
 * «افتح X واعرض لي محتواه» (the home screen's own suggestion, with an address), «افتح X ثم اقرأها», «open X and show me its
 * content»: the page opened, then read out. In production on 2026-11-23 the page opened and the run ended «لم أؤكد إتمام هذا
 * الطلب», because nothing joined «اعرض لي محتواه» to the open. Group 1 or 2 is what comes before: the open itself.
 */
const OPEN_THEN_READ = new RegExp(`^(.+?)\\s*[،,]?\\s+(?:ثم\\s+|وبعدها\\s+|و)${SHOW_PAGE_AR}(?:\\s+لي)?(?:\\s+${PAGE_CONTENT_AR})?$|^(.+?)\\s*,?\\s+(?:and(?:\\s+then)?|then)\\s+${SHOW_PAGE_EN}(?:\\s+${PAGE_CONTENT_EN})?$`, 'iu');
/** Common top-level domains, so a bare «example.org» is an address but «node.js» stays a word to search for. */
const TLD = '(?:com|net|org|edu|gov|mil|int|info|biz|io|ai|app|dev|me|tv|co|uk|us|ca|au|de|fr|es|it|nl|se|ch|tr|ru|in|cn|jp|news|blog|site|online|store|tech|sa|ae|eg|jo|kw|qa|bh|om|ma|tn|dz|iq|sy|lb|ps|ly|sd|ye)';
/** A whole message that is one web address: «https://example.com», «www.bbc.com/arabic», «example.org». Tidied text. */
const BARE_ADDRESS = new RegExp(`^(?:https?:\\/\\/[^\\s<>"'«»]+|(?:www\\.)?(?:[a-z0-9-]+\\.)+${TLD}(?:[/?#][^\\s<>"'«»]*)?)$`, 'iu');
/** A whole message that is one web address, which has no language of its own. */
export const isBareAddress = (request: string): boolean => typeof request === 'string' && BARE_ADDRESS.test(tidy(request));

export function unnamedSite(request: string, readCurrentPage?: (plan: HandsPlan) => void): UnnamedSite | null {
  return resolveUnnamedSite(request, { openThenRead: OPEN_THEN_READ, tidy, fold }, readCurrentPage);
}

/** The card that asks which website to open, in the request's language. */
export function siteQuestion(task: UnnamedSite) {
  const ar = task.lang === 'ar';
  return {
    prompt: ar ? task.read ? 'أفتح الموقع الذي تختاره وأعرض لك محتواه من نص الصفحة نفسها. أي موقع؟' : 'أفتح الموقع الذي تختاره. أي موقع؟'
      : task.read ? "I'll open the website you choose and show you its content, from the page's own text. Which website?" : "I'll open the website you choose. Which website?",
    fields: [{ id: 'site', prompt: ar ? 'رابط الموقع أو اسمه' : "The website's address or name", suggestions: [],
      placeholder: ar ? 'مثلاً: bbc.com أو https://example.com' : 'e.g. bbc.com or https://example.com' }],
  };
}

/** The website the owner named in answer to that card: an address, a known site («ويكيبيديا»), or «افتح X». */
export function siteToOpen(answer: string): { url: string; name: string } | null {
  if (typeof answer !== 'string') return null;
  const text = tidy(answer).replace(/^(?:افتح|إفتح|ادخل(?:\s+(?:على|إلى|الى))?|اذهب\s+(?:إلى|الى)|open|go to|visit)\s+(?:لي\s+)?/iu, '').trim();
  if (!text || text.length > 300) return null;
  const route = directRoute(`افتح ${text}`);
  if (route?.finishes && !route.screenshot) return { url: route.url, name: route.name };
  return namedSite(text);
}

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
  // «Search the web for X» searches for X: «the web for …» was searched as the query itself in the live test of 2026-11-23,
  // as «ابحث في الإنترنت عن X» already was not.
  match = /^(?:search|look)(?:\s+up)?\s+(?:on\s+|in\s+)?(?:the\s+)?(?:web|internet|net|online)\s+(?:for|about)\s+(.+)$/i.exec(text)
    ?? /^(?:search|look up)\s+online\s+(.+)$/i.exec(text);
  if (match) return { kind: 'search', query: strip(match[1]), site: null };
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
  // «اشرح أكثر», «تفاصيل أكثر», "tell me more": more from the page the last answer was read from. Searched as words until
  // 2026-11-23 («لم أجد … نتائج مرتبطة بسؤالك «اشرح أكثر»»).
  if (EXPLAIN_MORE.test(text)) return { kind: 'read', more: true };
  if (READ_PAGE.test(text)) return { kind: 'read', more: false };

  if (/^(?:انزل|نزل|مرر|مرّر)(?:\s+(?:لل?[أا]سفل|تحت|للتحت|الصفح[ةه]))?$|^scroll(?:\s+down)?$/iu.test(text)) return { kind: 'scroll', up: false };
  if (/^(?:اطلع|اصعد|مرر\s+لل?[أا]على)$|^scroll up$/iu.test(text)) return { kind: 'scroll', up: true };
  if (/^(?:ارجع|إرجع|رجوع|عد)(?:\s+(?:للخلف|للوراء|لل?صفح[ةه] السابق[ةه]))?$|^(?:go\s+)?back$/iu.test(text)) return { kind: 'back' };

  match = /^(?:اضغط|إضغط|انقر|اختر|افتح|إفتح|ادخل)\s+(?:لي\s+)?(?:على\s+|عل\s+|إلى\s+|الى\s+)?(.+)$/u.exec(text)
    ?? /^(?:click|tap|choose|select|open)\s+(?:on\s+)?(.+)$/i.exec(text);
  if (match) {
    if (unnamedSite(text)) return null;
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

/** «وأخبرني», «ثم اذكر», «and tell me»: a question about the page that was just opened. */
const TELL_AR = '(?:أخبرني|اخبرني|خبرني|قل لي|قللي|قلي|اذكر لي|اذكر|أعطني|اعطني|وضح لي|بين لي|انقل لي|انقل)';
// «and report the page heading…» asks about the page as «and tell me…» does (live test of 2026-11-23: the page opened and
// the run ended «not verified», because only «tell/show/give me» joined a question to the open).
const TELL_EN = '(?:tell me|show me|give me|report|state|quote|return|extract|copy|list|what(?:\'s| is| are)|which)';
const ASK_SPLIT = new RegExp(`\\s*[،,]?\\s+(?:ثم\\s+|وبعدها\\s+|و)(?=${TELL_AR}(?:\\s|$))|\\s*,?\\s+(?:and(?: then)?|then)\\s+(?=${TELL_EN}\\s)`, 'iu');
/** The question points at the page: «في الصفحة», «فيها», «المذكور», «on the page», «listed». «وقل لي نكتة» does not. */
const PAGE_REF = /(?:^|\s)(?:في|على|من)\s+(?:هذه\s+|هذا\s+)?(?:ال)?(?:صفحه|موقع)(?=\s|$)|(?:^|\s)(?:فيها|فيه|عليها|عليه|منها|منه)(?=\s|$)|(?:^|\s)(?:ال)?(?:مذكور|موجود|موجوده|مكتوب|ظاهر)(?=\s|$)|\b(?:on|in|from) (?:the|this|that) (?:(?:live|current|opened|open|same) )?(?:page|site|website)\b|\b(?:on it|in it|there|listed|mentioned|shown|written)\b/iu;
/** …or names a part of it with the definite article: «العنوان الرئيسي», «الرابط», «the version», «the page heading», «the first sentence». */
const PAGE_PART = /(?:^|\s)(?:ب|و)?ال(?:عنوان|روابط|رابط|اصدار)(?=\s|$)|(?:^|\s)(?:ب|و)?(?:ال)?جمله (?:ال)?اولي(?=\s|$)|(?:^|\s)(?:ب|و)?اول (?:جمله|فقره|سطر)(?=\s|$)|\bthe (?:page(?:'s)? )?(?:main heading|heading|headline|title|links?|first (?:sentence|paragraph|line)|(?:latest |newest |current )?version)\b/iu;

/**
 * «افتح X وأخبرني بـY» / «open X and tell me Y» as a plan of two steps: open the page, then answer Y from its own text
 * (the task cycle's planning step, without a model). Only this shape: an address or a known site, then one question.
 * Before 2026-11-22 the whole request fell to the direct route, which opened the page and then ended with «لم أؤكد إتمام
 * هذا الطلب» (artifacts/agent-gaps-2026-11-22/before, two such requests of 107).
 */
function parseOpenAndAsk(request: string): HandsStep[] | null {
  const text = tidy(request);
  const split = ASK_SPLIT.exec(text);
  if (!split || split.index === 0) return null;
  // «افتح الموقع X في المتصفح»: «الموقع» and «في المتصفح» only say where it opens.
  const head = text.slice(0, split.index).replace(/\s+(?:في|على)\s+(?:ال)?متصفح$|\s+in (?:the |a )?browser$/iu, '')
    .replace(/(?:^|\s)(?:ال)?موقع(?=\s)|\bthe (?:site|website|page)(?=\s)/iu, ' ').replace(/\s+/gu, ' ').trim();
  const open = directRoute(head);
  if (!open?.finishes || open.screenshot) return null;
  const question = text.slice(split.index + split[0].length).replace(new RegExp(`^(?:${TELL_AR}|${TELL_EN})\\s+`, 'iu'), '').trim();
  if (!question || question.length > 300 || SPLIT.test(question)) return null;
  if (!PAGE_REF.test(fold(question)) && !PAGE_PART.test(fold(question))) return null;
  return [{ kind: 'open', url: open.url, name: open.name }, { kind: 'ask_page', question }];
}

/**
 * The owner's request as browser steps, or null when any part is not a plain browser command.
 * A lone «افتح موقع» stays with the direct route, which proves the opened destination.
 */
export function parseHands(request: string, learnedNews = false): HandsStep[] | null {
  // An instruction about the reply is not a step, and a tag in front is not part of the command: «Search the web for X.
  // Return the page title and source link.» searches for X and names the found page's title and link (reply-directive.ts).
  const framing = typeof request === 'string' ? splitReplyDirective(request) : null;
  if (framing && (framing.label || framing.directive) && framing.body !== request.trim()) {
    const steps = parseCommand(framing.body);
    if (steps) {
      const directive = framing.directive;
      if (directive) for (const step of steps) if (step.kind === 'search') {
        step.reply = { ...(directive.lang ? { lang: directive.lang } : {}), ...(directive.sentences ? { sentences: directive.sentences } : {}), ...(directive.fields?.length ? { fields: directive.fields } : {}) };
        // Naming a page's title and link asks for a page that was read and found about the subject, not a bare list.
        if (directive.fields?.some(field => field === 'title' || field === 'link')) step.ask = true;
      }
      return steps;
    }
  }
  const steps = parseCommand(request);
  if (steps || !learnedNews) return steps;
  const text = tidy(framing?.body ?? request);
  const news = text && parseNews(text, true);
  return news ? [news] : null;
}

/** «افتح X واعرض لي محتواه» as two steps: open the page, then read it out. Only an address or a known site comes before. */
function parseOpenAndRead(request: string): HandsStep[] | null {
  const match = OPEN_THEN_READ.exec(tidy(request));
  // «افتح الموقع X في المتصفح»: «الموقع» and «في المتصفح» only say where it opens, as in parseOpenAndAsk.
  const head = (match?.[1] ?? match?.[2])?.replace(/\s+(?:في|على)\s+(?:ال)?متصفح$|\s+in (?:the |a )?browser$/iu, '')
    .replace(/(?:^|\s)(?:ال)?موقع(?=\s)|\bthe (?:site|website|page)(?=\s)/iu, ' ').replace(/\s+/gu, ' ').trim();
  if (!head) return null;
  const open = directRoute(head);
  if (!open?.finishes || open.screenshot) return null;
  return [{ kind: 'open', url: open.url, name: open.name }, { kind: 'read', more: false }];
}

function parseCommand(request: string): HandsStep[] | null {
  // A message that is only an address asks to see that page, as the search refusal itself promises («أرسل رابط الموقع المقصود
  // وأقرأه لك»). In production on 2026-11-23 a bare link was answered «The required search or browsing route is not fully available».
  const address = tidy(request);
  if (BARE_ADDRESS.test(address)) return [{ kind: 'open', url: address, name: address.replace(/^https?:\/\//iu, '').split(/[/?#]/u)[0] }, { kind: 'read', more: false }];
  const openAsk = planComparisonPage(request, SPLIT) ?? parseOpenAndAsk(request);
  if (openAsk) return openAsk;
  if (isPageReasoningRequest(request)) return [{ kind: 'ask_page', question: request.trim() }];
  const openRead = parseOpenAndRead(request);
  if (openRead) return openRead;
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
export function isLiveWebQuestion(question: string): boolean {
  return LIVE.test(webFreshnessText(question));
}
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
/** Greetings, extended gratitude and questions about the assistant itself. */
const CHAT = /^(?:هلا|مرحبا|السلام|اهلا|أهلا|صباح|مساء|كيف حالك|كيفك|شلونك|hi|hello|hey|how are you)(?=\s|$|[؟?!.,،])|^(?:شكرا|thanks|thank you)(?=[\s؟?!.,،])|(?:^|\s)(?:انت|أنت|اسمك|تستطيع|تقدر)(?=\s|$|[؟?])|\b(?:you|your)\b/iu;

/** Why a request is not a web search, or null when it is one. */
/** Planning a week or a day: the owner's own tasks, laid out by planner.ts, never a web search. */
export const PLANNING = /(?:^|\s)(?:خط[طّ]|نظ[مّ]|رت[بّ])(?:لي|\s+لي)?\s+(?:ل?[اأ]سبوع|ل?يوم|وقت|مهام|جدول)|(?:التخطيط|خط[ةه]|جدول|تنظيم|ترتيب)\s+(?:ل|لـ)?(?:[اأ]سبوع|يوم|وقت|مهام)|\bplan (?:out )?(?:my|the|a) (?:week|day|schedule|tasks)\b|\b(?:weekly|daily) (?:plan|schedule|planner)\b|\b(?:schedule|organi[sz]e) my (?:week|day|tasks)\b/iu;

/** A PDF to make or change (assistant/documents.ts does the work): the file word plus an action, or a .pdf path. A question about PDF stays a web question. */
const PDF_FILE = /(?<![\p{L}\p{N}])(?:pdf|بي ?دي ?[اإأ]ف)(?![\p{L}\p{N}])/iu;
const PDF_PATH = /\.pdf(?![\p{L}\p{N}])/iu;
const PDF_ACTION = /(?:^|\s)(?:انشئ|أنشئ|إنشئ|انشاء|إنشاء|اصنع|إصنع|اعمل|أعمل|سوي|سوّي|سو|سولي|جهز|جهّز|حضر|حضّر|كون|كوّن|ولد|ولّد|اكتب|أكتب|اكتبلي|صمم|صمّم|حول|حوّل|حولي|صدر|أصدر|صدّر|اطبع|احفظ|اعطني|أعطني|اعطيني|هات|اريد|أريد|ابغى|بدي|نزل|ادمج|أدمج|دمج|اجمع|ضم|وحد|وحّد|احذف|ازل|أزل|امسح|شيل|استخرج|اقتطع|اقص|افصل|قسم|قسّم|احتفظ|ابق|خذ|دور|دوّر|لف|اقلب|رقم|رقّم|اضف|أضف|ضع|غير|غيّر|عدل|عدّل|اجعل|سم|سمّ|create|make|generate|build|design|convert|export|turn|produce|write|draft|prepare|save|download|give|merge|combine|join|delete|remove|strip|extract|split|take|keep|rotate|flip|number|paginate|add|stamp|set|change|rename|update)(?=\s|$)|علام[ةه] مائي[ةه]|watermark|ترقيم|كم صفح|عدد (?:ال)?صفحات|how many pages|page count/iu;
const PDF_QUESTION = /^(?:ما ?هو|ما ?هي|ما معنى|ماذا يعني|كيف|لماذا|what is|what are|what does|how do i|how to|why)(?=\s|$)/iu;
export function isDocumentRequest(text: string): boolean {
  if (!PDF_FILE.test(text) && !PDF_PATH.test(text)) return false;
  if (PDF_QUESTION.test(text.replace(/^(?:من فضلك|لو سمحت|please)\s+/iu, ''))) return false;
  return PDF_ACTION.test(text) || PDF_PATH.test(text);
}

export function notWebReason(text: string): 'memory_ads_pc' | 'reminder' | 'arithmetic' | 'planning' | 'writing' | 'document' | 'site' | 'chat' | 'address' | 'empty' | null {
  if (!text || text.length > 200) return 'empty';
  // "ابنِ لي موقعاً" is a website to build (packages/sites), never a search and not a letter or a PDF.
  if (isSiteRequest(text)) return 'site';
  if (isDocumentRequest(text)) return 'document';
  if (REMIND.test(text)) return 'reminder';
  if (PLANNING.test(text)) return 'planning';
  if (NOT_WEB.test(text)) return 'memory_ads_pc';
  // «Advertise my removals company …», «I run a barbershop and want more bookings, £15 a day»: a campaign, not a search.
  if (isCampaignRequest(text)) return 'memory_ads_pc';
  if (ARITHMETIC.test(text)) return 'arithmetic';
  if (WRITER.test(text)) return 'writing';
  if (URL_LIKE.test(text) || directRoute(text)) return 'address';
  if (isBareAcknowledgement(text) || CHAT.test(text) && !isLiveWebQuestion(text)) return 'chat';
  return null;
}

/**
 * Search is the default: a request that is not a browser command and not on the finite
 * not-the-web list becomes one browser search that reads the answer. No list of questions to grow.
 * `earlier` holds the owner's previous messages in this conversation, oldest first, for follow-ups.
 */
export function webQuestion(request: string, earlier: readonly string[] = []): HandsStep[] | null {
  const raw = stripAcknowledgementLead(request.normalize('NFC').replace(/^(?:من فضلك|لو سمحت|please)[،,\s]+/iu, '').trim());
  const text = tidy(raw);
  if (notWebReason(text)) return null;
  // «Explain why rain falls in two short Arabic sentences.» asks «why rain falls»: «explain» only asks for the answer, and
  // the closing instruction shapes the reply (reply-directive.ts). In the live test of 2026-11-23 the whole sentence was the
  // query, and the search guard refused it as private before any search.
  const framing = splitReplyDirective(raw);
  const asked = tidy(explainedQuestion(framing.directive ? framing.body : raw));
  if (!asked || notWebReason(asked)) return null;
  const lookup = LOOKUP.exec(asked);
  const own = lookup ? strip(lookup[1]) : returnedTo(asked) ?? workQuestion(asked) ?? asked;
  const query = withTopic(own, earlier);
  const directive = framing.directive;
  const reply: HandsReply | null = directive && (directive.lang || directive.sentences || directive.fields?.length)
    ? { ...(directive.lang ? { lang: directive.lang } : {}), ...(directive.sentences ? { sentences: directive.sentences } : {}), ...(directive.fields?.length ? { fields: directive.fields } : {}) } : null;
  return query ? [{ kind: 'search', query, site: null, ask: true, ...(reply ? { reply } : {}) }] : null;
}

/**
 * «من كتب رواية البؤساء؟», «من مؤلف كتاب الأيام؟», «من ألّف مسرحية هاملت؟»: who made a work is said in the opening sentence of the
 * work's own article («البؤساء … رواية للأديب الفرنسي فيكتور هوغو…»), so the work's own name is searched: «البؤساء». On
 * 2026-11-23 the words «كتب رواية البؤساء» opened no article and the search found nothing (turn 14 of
 * artifacts/conversation-quality-2026-11-23/long-before). Only the request's own words are searched: «ما هي البؤساء» added two
 * words, and the search guard refused it after a turn that was not a public question (browser check, 13:40 UTC).
 * English "Who wrote …?" has its own path (MAKER_WORDS). Null otherwise.
 */
export function workQuestion(text: string): string | null {
  const match = /^(?:من|مين)\s+(?:هو\s+|هي\s+)?(?:كتب|كتبت|كاتب|ألف|ألّف|ألفت|الف|الفت|مؤلف|أخرج|اخرج|مخرج|لحن|لحّن|ملحن|رسم|صمم|صمّم)\s+(?:(?:ال)?(?:رواي[ةه]|كتاب|قصيد[ةه]|مسرحي[ةه]|فيلم|أغني[ةه]|اغني[ةه]|لوح[ةه]|قص[ةه]|ديوان|مسلسل)\s+)?(\S.{1,58}?)[\s؟?.!]*$/u.exec(text.trim());
  return match ? match[1]!.trim() : null;
}

/** «Explain why X» → «why X», «اشرح لماذا X» → «لماذا X»: the question an instruction to explain carries. Else the text as it is. */
export function explainedQuestion(text: string): string {
  return text.replace(/^(?:please\s+)?(?:explain|describe|tell me|teach me)(?:\s+(?:to me|for me|briefly|simply|in simple terms))?\s+(?=(?:why|how|what|when|where|which|who)\b)/iu, '')
    .replace(/^(?:من فضلك\s+)?(?:اشرح|إشرح|وضح|وضّح|فسر|فسّر|بين|بيّن|علمني)(?:\s+لي)?\s+(?=(?:لماذا|ليش|ليه|كيف|ما|ماذا|متى|متي|أين|اين|من|سبب)(?:\s|$))/u, '');
}

/** «وكم سعره في مصر؟», «طيب وبكرة؟», «what about Paris»: a question that leans on the one before it. */
const FOLLOW_START = /^(?:طيب|طب|طيّب|حسنا|and|what about|how about)\s+|^(?:و\s*)?(?:ماذا|ما|وش|شو|ايش)\s+عن\s+|^و(?=كم|متى|متي|ماذا|ما\s|هل|في\s|بكر|غد|اليوم|الان|الآن|سعر|ايش|شو|اين|أين|كيف|ليش|لماذا|من\s|عن\s|ال)/iu;
const POINTER = /(?:^|\s)(?:[^\s]{2,}(?:ه|ها|هم|هن))(?=\s|$)|\b(?:it|its|it's|that|there|them|they|he|she|his|her)\b/iu;
const TIME_WORDS = new Set(['اليوم', 'الان', 'الآن', 'حاليا', 'غدا', 'بكره', 'بكرة', 'الليله', 'today', 'now', 'tomorrow', 'tonight', 'current', 'latest']);

/** «سكانها», «سعره», "its", "it": the message points back at a thing the conversation already named. */
export const refersBack = (text: string): boolean => POINTER.test(text) || lacksSubject(text);

/** Whether this message leans on the one before it rather than naming its own topic. */
export function isFollowUp(text: string): boolean {
  if (FOLLOW_START.test(text)) return true;
  return text.split(' ').length <= 4 && POINTER.test(text) || lacksSubject(text);
}

/** «اشرح أكثر», «وضّح بالتفصيل», «أريد تفاصيل أكثر», «زدني», "tell me more": a request for more of the last answer's source. */
const EXPLAIN_MORE = /^(?:(?:اشرح|إشرح|وضح|وضّح|فصل|فصّل|فسر|فسّر)(?:\s+(?:لي|ها|ه|هذا|ذلك))?\s+(?:أكثر|اكثر|أكثر من ذلك|بالتفصيل|بتفصيل(?:\s+أكثر)?|بشكل أوسع)|(?:أريد|اريد|أعطني|اعطني)\s+(?:المزيد|تفاصيل أكثر|تفاصيل اكثر)|المزيد من التفاصيل|تفاصيل أكثر|تفاصيل اكثر|زدني)[\s.!؟?]*$|^(?:tell me more|explain (?:more|further)|more details|elaborate|go on)[\s.!?]*$/iu;

/**
 * What the last answer was about, for a follow-up that points back: the page's own title, or the narrower item the answer's
 * first line names before a colon («نهر النيل: أطول أنهار العالم.» read from the page «نهر»). On 2026-11-23 «وكم طوله؟»
 * after «ما هو أطول نهر في العالم؟» searched «كم طول نهر» and showed the Danube's length.
 */
export function answerSubject(found: { title: string; lines: readonly string[] }): string {
  const title = plainTitle(found.title);
  const label = /^([^:،,.؟?!()]{2,40}):\s/u.exec(found.lines[0] ?? '')?.[1]?.trim();
  if (label && label.split(/\s+/u).length <= 4) {
    const titleWords = topicWords(title);
    const folded = fold(label);
    if (titleWords.length && titleWords.every(word => folded.includes(word))) return label;
  }
  return title;
}

/** Verbs of an event in a life or a work, folded: the event's subject is the one the conversation is about. */
const EVENT_VERBS = new Set(['توفي', 'توفيت', 'مات', 'ماتت', 'ولد', 'ولدت', 'تزوج', 'تزوجت', 'اكتشف', 'اكتشفت', 'اخترع', 'اخترعت',
  'كتب', 'كتبت', 'الف', 'الفت', 'اسس', 'اسست', 'تاسس', 'تاسست', 'نشر', 'نشرت', 'صدر', 'صدرت', 'بني', 'بنيت', 'حكم', 'حكمت',
  'عاش', 'عاشت', 'درس', 'درست', 'فاز', 'فازت', 'انتهي', 'انتهت', 'بدا', 'بدات', 'اغتيل', 'اغتيلت', 'استقل', 'استقلت', 'اعتزل', 'اعتزلت']);

/**
 * A question with no subject, only a question word and an event verb («متى توفي؟», «أين ولد؟», «ومتى نشرت؟»): it asks about
 * the subject of the answer before it. On 2026-11-23 «متى توفي؟» after an answer on Einstein was searched alone and showed the
 * death of another man (artifacts/conversation-quality-2026-11-23/long-before). English follow-ups carry a pronoun instead.
 */
export function lacksSubject(text: string): boolean {
  const words = fold(text).replace(/[؟?،,.!]/gu, ' ').split(/\s+/u).filter(Boolean);
  if (words.length !== 2) return false;
  const ask = words[0]!.replace(/^و(?=\S{2,})/u, '');
  return ['متي', 'اين', 'وين', 'كيف', 'لماذا', 'ليش', 'كم', 'من', 'هل'].includes(ask) && EVENT_VERBS.has(words[1]!);
}

/**
 * Adds the previous question's topic words to a follow-up; any other message is returned as it is.
 * The previous message counts only when it was itself a web search, so a command or a thanks adds nothing.
 */
export function withTopic(text: string, earlier: readonly string[]): string {
  if (!isFollowUp(text)) return text;
  let own = text;
  for (let round = 0; round < 3 && FOLLOW_START.test(own); round++) own = own.replace(FOLLOW_START, '').trim();
  const previousIndex = earlier.findLastIndex(turn => !isBareAcknowledgement(turn));
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
  // The topic now names what the pronoun pointed at: «وكم عدد سكانها؟» after «اليابان» asks «كم عدد سكان اليابان».
  const asked = topic.length ? own.split(' ').map(withoutPronoun).join(' ') : own;
  return [asked, ...topic].filter(Boolean).join(' ').trim() || text;
}
const URL_LIKE = /https?:\/\/|\bwww\.|\b[\w-]+\.(?:com|net|org|io|co|uk|sa|ae|dev|app)\b/i;

/** Question words carry no topic: dropped before matching a page's sentences to the question. */
const ASK_WORDS = new Set(['كم', 'متي', 'وين', 'اين', 'من', 'ما', 'ماذا', 'هل', 'ليش', 'لماذا', 'كيف', 'شو', 'شنو', 'ايش', 'وش', 'قديش', 'اديش', 'هو', 'هي', 'في', 'عن', 'على', 'علي',
  'what', "what's", 'whats', 'when', 'where', 'who', "who's", 'how', 'which', 'is', 'are', 'was', 'were', 'does', 'do', 'did', 'why', 'the', 'in', 'of', 'for', 'a',
  'اليوم', 'الان', 'الآن', 'حاليا', 'now', 'today', 'current', 'currently', 'latest', 'اخر', 'احدث']);

/** Words that ask about a topic without naming it: «أعراض المياه البيضاء» is about «المياه البيضاء». Folded forms. */
const FRAME_WORDS = new Set(['اعراض', 'علامات', 'اسباب', 'سبب', 'علاج', 'عمليه', 'عمليات', 'جراحه', 'تستغرق', 'يستغرق', 'مده', 'مدة', 'تعريف', 'معني', 'معنى',
  'فوائد', 'اضرار', 'مخاطر', 'عدد', 'نسبه', 'طريقه', 'انواع', 'نوع', 'مراحل', 'تكلفه', 'هل', 'يمكن', 'بعد', 'قبل', 'خلال', 'مع', 'او', 'و',
  'symptoms', 'signs', 'causes', 'cause', 'treatment', 'surgery', 'operation', 'long', 'take', 'takes', 'many', 'much', 'risks', 'types', 'definition', 'meaning', 'and', 'or', 'to', 'after', 'before',
  'benefits', 'benefit',
  // Verbs that only carry the measure: «كم يبلغ ارتفاع جبل إيفرست» is about «جبل إيفرست». Kept as a topic word, «يبلغ» made the
  // subject «يبلغ جبل إيفرست», no article has that name, and the question ended in «لم أجد صفحة» (live 2026-11-22 22:36,
  // artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json).
  'يبلغ', 'تبلغ', 'بلغ', 'بلغت', 'يساوي', 'تساوي']);

/** Words that name the kind of thing a definition question asks about, not the thing: «عملية» in «ما هي عملية الليزك». Folded. */
const KIND_WORDS = new Set(['عمليه', 'عمليات', 'جراحه', 'surgery', 'operation', 'procedure']);

/** The question's topic words, folded and without «ال», for matching page titles. */
export function topicWords(question: string): string[] {
  return [...new Set(fold(question).replace(/[؟?،,.!]/gu, ' ').split(/\s+/)
    .filter(word => word.length >= 2 && !ASK_WORDS.has(word) && !FRAME_WORDS.has(word))
    .map(word => word.length > 4 && word.startsWith('ال') ? word.slice(2) : word))];
}

/** How many topic words a page title holds. */
export function titleScore(title: string, topic: string[]): number {
  // «البيضا» and «البيضاء» are one word: a final hamza is often dropped.
  const folded = fold(title).replace(/ء/gu, '');
  return topic.filter(word => folded.includes(word.replace(/ء/gu, ''))).length;
}
/** How many topic words a sentence holds, counting the feminine ending before a suffix: «وعاصمتها» holds «عاصمة». */
export function topicCoverage(text: string, topic: readonly string[]): number {
  const folded = fold(text).replace(/ء/gu, '');
  return topic.filter(word => {
    const bare = word.replace(/ء/gu, '');
    return folded.includes(bare) || bare.length > 3 && bare.endsWith('ه') && folded.includes(`${bare.slice(0, -1)}ت`);
  }).length;
}

/** Questions whose answer is a number: a count, a length of time, a price, a date. */
const WANTS_NUMBER = /(?:^|\s)(?:كم|قديش|اديش|متى|متي)(?=\s|$)|\bhow (?:many|much|long|old|far|tall|big)\b|\bwhen\b/iu;
/**
 * The figure a sentence states, as plain Latin digits without grouping marks: «105 مليون» → "105", "299,792,458" → "299792458".
 * A year («في 2024 بلغ عدد السكان 105 ملايين») is skipped when the sentence holds another number.
 */
export function firstFigure(text: string): string | null {
  const figures = [...text.matchAll(/[\d٠-٩](?:[\d٠-٩,٬]|\.(?=[\d٠-٩]))*/gu)]
    .map(match => match[0].replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660)).replace(/[,٬]/gu, ''));
  if (!figures.length) return null;
  return figures.find(figure => !/^(?:1[89]|20)\d\d$/u.test(figure)) ?? figures[0]!;
}
/** Two sentences name the same figure when their first figures are equal. */
export const sameFigure = (first: string, second: string): boolean => firstFigure(first) !== null && firstFigure(first) === firstFigure(second);

/** Words that name what is asked about a subject, not the subject: «سكان» in «كم عدد سكان مصر». Folded, without «ال». */
const ATTRIBUTE_WORDS = new Set(['سكان', 'يعيش', 'يعيشون', 'شخص', 'اشخاص', 'عاصمه', 'مساحه', 'عمله', 'رئيس', 'ملك', 'لغه', 'ديانه', 'تاسيس', 'ارتفاع', 'طول', 'عمر', 'وزن', 'سعر', 'ميلاد', 'وفاه', 'مؤسس', 'مالك', 'موقع', 'علم', 'نشيد', 'ناتج',
  'population', 'people', 'live', 'lives', 'inhabitants', 'residents', 'capital', 'area', 'currency', 'president', 'king', 'language', 'religion', 'founded', 'height', 'length', 'age', 'weight', 'price', 'born', 'died', 'founder', 'owner', 'location', 'gdp', 'size']);
/**
 * A question about one aspect of a subject: its benefits, symptoms, causes, treatment, risks, types. Its answer is on a page
 * about the subject: «ما فوائد الشاي الأخضر» was answered from «دبس الرمان» in the full runs since 04:48 on 2026-11-22
 * (rq030; the 02:17 baseline had read a green-tea page). The subject is the name without the aspect and place words.
 */
export const ASPECT_QUESTION = /(?:^|\s)(?:فوائد|أضرار|اضرار|أعراض|اعراض|أسباب|اسباب|علاج|مخاطر|أنواع|انواع|مراحل|علامات)(?=\s|$)|\b(?:benefits|symptoms|causes|treatment|risks|types|signs) of\b/iu;
export const aspectSubject = (question: string): string[] => ASPECT_QUESTION.test(question) ? topicWords(wikiTerms(question)) : [];
/**
 * A sentence answers a reason question only in one of two shapes, both measured on live pages on 2026-11-23
 * (artifacts/agent-gaps-2026-11-22/after-cycle-fixes/why-probe-after-2.json), where a causal word anywhere in the line still
 * let through «… known as the albicelestes due to the sky blue…» for "Why is the sky blue?" and a line about the Moon's
 * orbit for «ليه القمر بيتغير شكله؟»:
 *   the cause follows what is asked about, in one clause: «تبدو السماء زرقاء بسبب…», "The sky appears blue because…";
 *   or the noun of a cause comes right before it: «إن سبب ظهور السماء بألوان…», «سبب انقراض الديناصورات», "the reason the sky is blue".
 * What is asked about is the question's own words apart from its subject («زرقاء», «تهاجر», "blue"); a question that is
 * only its subject («ما أسباب الحرب العالمية الأولى؟») is matched by the subject. Folded text.
 */
const AFTER_CAUSE = /بسبب|(?:^|\s)(?:و|ف)?لان(?:ه|ها|هم|هما|نا|ك)(?=[\s،.]|$)|(?:^|\s)(?:و|ف)?لان\s+ال|نتيجه\s+(?:ل|عن)|وذلك\s+ل|(?:يعود|تعود|يرجع|ترجع|يعزي|تعزي)\s+(?:(?:ذلك|هذا|السبب)\s+)?الي|(?:^|\s)نسبه\s+(?:الي|ل)|\bbecause\b|\bdue to\b|\bcaused by\b|\bas a result of\b|\bresult(?:s|ing|ed)? from\b|\bowing to\b/u;
const CAUSE_NOUN = /(?:^|\s)(?:و|ف)?(?:ال)?(?:سبب|اسباب)(?=\s)|\bthe (?:main |primary |chief |real )?(?:reason|cause)s?\b/gu;
const REASON_FILLER = new Set(['ليه', 'بهذا', 'هذا', 'هذه', 'قبل', 'بعد', 'ان', 'جدا', 'كثيرا', 'دائما', 'so', 'very', 'always', 'often', 'much', 'reason', 'reasons', 'cause', 'causes', 'caused']);
/**
 * What is asked, narrowed to one place, season or case before the cause: «… وتسقط به الأمطار في فصل الشتاء … بسبب هبوب
 * الرياح الغربية» gives the cause of winter rain in one climate, not why rain falls. It was shown as the answer to «اشرح
 * لماذا تسقط الأمطار» in the live check of 2026-11-23. A question that names such a case itself is not narrowed by it.
 */
const RESTRICTED_CASE = /(?:^|\s)(?:في|خلال)\s+(?:فصل|موسم|فصول|الشتاء|الصيف|الربيع|الخريف|المناطق|منطقه|مناطق|غرب|شرق|شمال|جنوب|بعض|هذه|تلك|اغلب|معظم)(?=\s|$)|(?:^|\s)(?:به|بها|فيه|فيها)(?=\s|$)|\b(?:in|during)\s+(?:winter|summer|spring|autumn|(?:the\s+)?(?:tropics|monsoon|north|south|east|west)|some|these|those|this\s+region|that\s+region|parts\s+of|most\s+of)\b|\b(?:within|across|throughout)\s+\S/u;
/**
 * Where a word of the question is found in a sentence word. Arabic words carry their clitics («وتسقط», «بالأمطار»), so the
 * stem may sit inside the word. An English word starts with it («falls», «falling»): inside a word, «rainfall» held both
 * «rain» and «fall», and «Within Asia, rainfall is favored … due to the monsoon» was shown for «Explain why rain falls»
 * (live check of 2026-11-23).
 */
const holds = (word: string, stem: string) => /\p{Script=Arabic}/u.test(stem) ? word.includes(stem) : word.replace(/^[^\p{L}\p{N}]+/u, '').startsWith(stem);
export function reasonAnswers(question: string, line: string): boolean {
  const narrowedQuestion = RESTRICTED_CASE.test(fold(question));
  const subject = topicWords(reasonSubject(question));
  const stem = (word: string) => word.length > 4 ? word.slice(0, 4) : word;
  const asked = topicWords(question).filter(word => !subject.includes(word) && !REASON_FILLER.has(word)).map(stem);
  const wanted = asked.length ? asked : subject.map(stem);
  if (!wanted.length) return false;
  const near = [...new Set([...subject.map(stem), ...asked])];
  const text = fold(line);
  // The sentence names the subject, or opens with what is asked of it («وسُميت بهذا الاسم نسبةً إلى…», the page's subject
  // understood). «حافة الفول سُميت بهذا الاسم نسبةً إلى زهرة عطرية», read on the Cairo page, is about another name.
  const names = !subject.length || subject.some(word => text.includes(stem(word)));
  for (const clause of text.split(/[،,؛;]|\.(?!\d)/u)) {
    const cause = AFTER_CAUSE.exec(clause);
    if (cause && !narrowedQuestion && RESTRICTED_CASE.test(clause.slice(0, cause.index))) continue;
    if (cause) {
      // What is asked and the subject stand together before the cause («انقرضت الديناصورات نتيجةً لـ…», "the sky is blue due
      // to…"): «الديناصورات ساهمت في تسريع وتيرة انقراض الحيوانات الأخرى بسبب…» is about other animals' extinction.
      const before = clause.slice(0, cause.index).trim().split(/\s+/);
      const at = (stems: readonly string[]) => before.flatMap((word, index) => stems.some(item => holds(word, item)) ? [index] : []);
      const stated = at(wanted), subjects = at(subject.map(stem));
      const opens = before.slice(0, 2).some(first => asked.some(word => holds(first, word)));
      if (stated.length && (!asked.length || (subjects.length ? stated.some(i => subjects.some(j => Math.abs(i - j) <= 3)) : names || opens))) return true;
    }
    for (const noun of clause.matchAll(CAUSE_NOUN)) {
      const after = clause.slice(noun.index + noun[0].length).trim().split(/\s+/).slice(0, 6).join(' ');
      if (near.some(word => after.includes(word))) return true;
    }
  }
  return false;
}
/** Words written with «ال» that name nothing: a relative pronoun or a time word is never the subject of a question. */
const DEFINITE_FILLER = new Set(['الذي', 'التي', 'الذين', 'اللذان', 'اللتان', 'اللي', 'الان', 'الآن', 'اليوم', 'الا', 'الي', 'الى']);
/**
 * The thing a reason is asked about, as the question writes it: «السماء» in «لماذا السماء زرقاء؟», «القاهرة» in «ما سبب تسمية
 * القاهرة بهذا الاسم؟», "sky" in "Why is the sky blue?", "Roman Empire" in "Why did the Roman Empire fall?". The rest of such
 * a question is what needs explaining, not a name: taken together as the subject, «السماء زرقاء» opened the film «السماء
 * الزرقاء» (live 2026-11-23, artifacts/agent-gaps-2026-11-22/after-cycle-fixes/why-probe-after.json).
 * Arabic: the first run of words written with «ال». English: a run of capitalised words, or the first word after the
 * auxiliary and its article. Empty when the question does not ask for a reason or names no such word.
 */
export function reasonSubject(question: string): string {
  if (!isReasonQuestion(question)) return '';
  const words = question.trim().replace(/[؟?،,.!:«»"“”]/gu, ' ').split(/\s+/).filter(Boolean);
  if (/\p{Script=Arabic}/u.test(question)) {
    const definite = (word: string) => /^ال\p{L}{2,}$/u.test(fold(word)) && !DEFINITE_FILLER.has(fold(word)) && !DEFINITE_FILLER.has(word);
    const start = words.findIndex((word, at) => at > 0 && definite(word) && !/^(?:ال)?(?:سبب|اسباب)$/u.test(fold(word)));
    if (start < 0) return '';
    let end = start + 1;
    while (end < words.length && end < start + 3 && definite(words[end]!)) end++;
    return words.slice(start, end).join(' ');
  }
  const rest = words.join(' ').replace(/^why\s+(?:(?:is|are|was|were|do|does|did|can|could|has|have|had|will|would|should)\s+)?/iu, '')
    .replace(/^what\s+(?:(?:is|are|was|were)\s+the\s+(?:reasons?|causes?)\s+(?:for|of|behind)\s+|cause[sd]?\s+)/iu, '').replace(/^(?:the|a|an)\s+/iu, '');
  // A name wherever it stands («the fall of Rome» is about Rome), else the first word («sky», «birds»).
  const named = /(?:^|\s)([A-Z][\p{L}'’-]*(?:\s+(?:of\s+(?:the\s+)?)?[A-Z][\p{L}'’-]*)*)/u.exec(rest);
  return named?.[1] ?? /^[\p{L}][\p{L}'’-]*/u.exec(rest)?.[0] ?? '';
}
/** Attached pronouns that are never part of a folded noun: «سكانها», «سكانهم». */
const PRONOUN_SUFFIXES = ['هما', 'هم', 'هن', 'ها'];
/**
 * Stems after which a bare «ه» is always a pronoun («سكانه», «طوله»). Elsewhere it may be a folded ta marbuta: «عمره» is also
 * «عمرة», «ملكه» «ملكة», «سعره» «سعرة», «موقعه» «موقعة», «رئيسه» «رئيسة», «مؤسسه» «مؤسسة», so those stay as they are.
 */
const BARE_HA_STEMS = new Set(['سكان', 'طول', 'ارتفاع', 'ميلاد', 'تاسيس', 'نشيد']);
/**
 * An attribute word, also with an attached pronoun: «سكانها» is «سكان», «عاصمتها» and «عاصمته» are «عاصمه» (a ta marbuta is
 * written ta before a pronoun). Folded topic words. Without the pronoun forms, «وكم عدد سكانها؟» after «ما عاصمة اليابان؟» named
 * no attribute, so the subject check passed any page and the reply showed «ناكادوماري… 10,577 نسمة», a town's population
 * (all three repetitions of artifacts/perf/2026-11-22/route-latency-after-lever1-2026-11-22T07-43-25; 1-hands-http.md §5.2).
 */
export function isAttributeWord(word: string): boolean {
  if (ATTRIBUTE_WORDS.has(word)) return true;
  const known = (stem: string) => stem.length >= 2 && (ATTRIBUTE_WORDS.has(stem) || stem.endsWith('ت') && ATTRIBUTE_WORDS.has(`${stem.slice(0, -1)}ه`));
  if (PRONOUN_SUFFIXES.some(suffix => word.endsWith(suffix) && known(word.slice(0, -suffix.length)))) return true;
  if (!word.endsWith('ه')) return false;
  const stem = word.slice(0, -1);
  return stem.endsWith('ت') && known(stem) || BARE_HA_STEMS.has(stem);
}
/**
 * Words that name what happened to a subject, when a date question asks when it happened: «سقط» in «متى سقط جدار برلين»,
 * "fall" in "When did the Berlin Wall fall?". Folded, without «ال». Kept in the subject, they made it «سقط جدار برلين»: no
 * article has that name, and the search answered with a film about the night the wall fell (live 2026-11-22 13:35, c9 in
 * artifacts/plan-2026-11-22/wrong-answers-fix/live-check-commit-2026-11-22T13-35-11.json). «بني» is left out: it is also
 * «sons of» («بني أمية»).
 */
const EVENT_WORDS = new Set(['سقط', 'سقطت', 'سقوط', 'تاسس', 'تاسست', 'انشئ', 'انشئت', 'انشات', 'انشاء', 'بدا', 'بدات', 'بدء', 'بدايه',
  'انتهي', 'انتهت', 'انتهاء', 'نهايه', 'اندلع', 'اندلعت', 'اندلاع', 'استقل', 'استقلت', 'استقلال', 'ولد', 'ولدت', 'توفي', 'توفيت', 'مات', 'ماتت',
  'اغتيل', 'اغتيلت', 'اغتيال', 'افتتح', 'افتتحت', 'افتتاح', 'حدث', 'حدثت', 'وقع', 'وقعت', 'قام', 'قامت', 'اكتشف', 'اكتشفت', 'اكتشاف',
  'اخترع', 'اخترعت', 'اختراع', 'صدر', 'صدرت', 'انهار', 'انهارت', 'انهيار', 'توحد', 'توحدت', 'توحيد', 'احتل', 'احتلت', 'احتلال', 'فتح', 'فتحت',
  'هدم', 'هدمت', 'تحرر', 'تحررت', 'تحرير', 'اعلن', 'اعلنت', 'انضم', 'انضمت',
  'fall', 'fell', 'fallen', 'start', 'started', 'begin', 'began', 'begun', 'end', 'ended', 'happen', 'happened', 'occur', 'occurred',
  'invent', 'invented', 'discover', 'discovered', 'build', 'built', 'open', 'opened', 'die', 'establish', 'established', 'collapse', 'collapsed',
  'release', 'released', 'launch', 'launched', 'sign', 'signed', 'create', 'created', 'form', 'formed', 'dissolve', 'dissolved', 'become', 'became']);
/**
 * Words that name who made a work, when an English question asks who did: "wrote" in "Who wrote Pride and Prejudice?". Kept
 * in the subject, they left the question with no subject at all, so no article was opened by name and the search's first hit
 * answered: the page of the screenwriter adapting the novel (live 2026-11-22 22:36,
 * artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json).
 * Works only, and English only, both by measurement the same day: an invention's own article tells a history of several
 * names («A communication device for sailing vessels, called telephone, was invented by Captain John Taylor in 1844» led the
 * answer to "Who invented the telephone?"), and «من اخترع الهاتف» is answered from the search's «اختراع الهاتف», a better
 * page for it than the article «هاتف» that the subject's name opens. Those questions keep the search path.
 */
const MAKER_WORDS = new Set(['wrote', 'written', 'write', 'author', 'authored', 'painted', 'directed', 'composed']);
/** How a work's own article names its maker: «is a tragedy written by William Shakespeare», «is a novel by English author Jane Austen». */
const MAKER_FORMS = ['wrote', 'written', 'author', 'playwright', 'novelist', 'painted', 'painter', 'painting by', 'directed', 'director', 'composed', 'composer'];
const MAKER_STATEMENT = /\b(?:written|painted|directed|composed|authored)\s+by\b|\b(?:novel|novella|play|tragedy|comedy|book|poem|painting|portrait|film|opera|symphony|song|album)\b[^.]{0,40}?\bby\b/u;
const WHO_ASK = /^(?:who|whom)(?=\s)/iu;
/** The subject itself, for a question about one of its attributes: «كم عدد سكان مصر» → ['مصر']; empty when the question names no attribute. */
export function entityWords(question: string): string[] {
  const topic = topicWords(question);
  const asksWhen = figureKind(question) === 'date';
  const asksWho = WHO_ASK.test(question.trim());
  const entity = topic.filter(word => !isAttributeWord(word) && !(asksWhen && EVENT_WORDS.has(word)) && !(asksWho && MAKER_WORDS.has(word)));
  return entity.length && entity.length < topic.length ? entity : [];
}
/** Small words that may sit between the parts of a name: «Pride and Prejudice», «Lord of the Rings». Folded. */
const JOINING_WORDS = new Set(['and', 'of', 'the', 'de', 'la', 'le', 'و', 'بن', 'ابن']);
/**
 * The subject as the question writes it, joining words included: «Pride and Prejudice», where the subject words alone give
 * «Pride Prejudice», a name no article has. Another kind of word between the parts is left out, as before.
 */
export function entitySurface(question: string, entity: readonly string[]): string {
  const words = question.replace(/[؟?،,.!]/gu, ' ').split(/\s+/).filter(Boolean);
  const named = words.map(word => entity.includes(topicWords(word)[0] ?? ''));
  const first = named.indexOf(true), last = named.lastIndexOf(true);
  if (first < 0) return '';
  const span = words.slice(first, last + 1);
  const joined = span.every((word, at) => named[first + at] || JOINING_WORDS.has(fold(word)));
  return (joined ? span : words.filter((_, at) => named[at])).join(' ');
}
/**
 * The attribute without its pronoun, once the follow-up names what the pronoun pointed at: «سكانها» → «سكان», «عاصمتها» →
 * «عاصمة», «مساحته» → «مساحة». Any other word is returned as it is. «كم عدد سكانها اليابان» missed the line «يبلغ عدد سكان
 * اليابان 123 مليون نسمة» that «كم عدد سكان اليابان» ranks second (live 2026-11-22 08:15).
 */
export function withoutPronoun(word: string): string {
  const key = fold(word).replace(/^ال(?=\S{3})/u, '');
  if (ATTRIBUTE_WORDS.has(key) || !isAttributeWord(key)) return word;
  for (const suffix of [...PRONOUN_SUFFIXES, 'ه']) {
    if (!key.endsWith(suffix) || !word.endsWith(suffix)) continue;
    const stem = key.slice(0, -suffix.length), kept = word.slice(0, -suffix.length);
    if (ATTRIBUTE_WORDS.has(stem) || suffix === 'ه' && BARE_HA_STEMS.has(stem)) return kept;
    if (stem.endsWith('ت') && ATTRIBUTE_WORDS.has(`${stem.slice(0, -1)}ه`)) return `${kept.slice(0, -1)}ة`;
  }
  return word;
}
/**
 * A figure stated for the past: a year before 1950 in the line («حول 1340»، «سنة 1905») or «في ذلك الوقت»، «آنذاك»، "at the time".
 * Only a population question prefers a line without one; a date question asks for the past.
 */
export function pastFigure(line: string): boolean {
  const western = line.replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));
  return /(?<!\d)(?<!\d[.,،٬])1(?:[0-8]\d\d|9[0-4]\d)(?!\d)(?![.,،٬]\d)/u.test(western)
    || /في ذلك الوقت|آنذاك|حينذاك|\bat the time\b|\bback then\b/iu.test(line);
}
/**
 * A figure for a year still to come: a projection, not today's count. «Japan's population is expected to drop to around 88
 * million by 2065» passes every check of a population line (Japan article, read 2026-11-22).
 */
export function projectedFigure(line: string): boolean {
  const western = line.replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));
  return [...western.matchAll(/(?<!\d)(20\d\d|21\d\d)(?!\d)/gu)].some(found => Number(found[1]) > THIS_YEAR);
}
/** A page whose title is the subject itself («مصر», «المغرب - ويكيبيديا»), so its sentences may name it by a pronoun. */
export function isOwnArticle(title: string, entity: readonly string[]): boolean {
  if (!entity.length) return false;
  const bare = plainTitle(title).replace(/\s+[-–—|:]\s+[^-–—|:]{1,40}$/u, '').trim();
  // A name made of letters only: «.مصر» (the country's internet domain) or «مصر (توضيح)» is not the country.
  if (!/^[\p{L}\p{M}\s'’-]+$/u.test(bare)) return false;
  const own = topicWords(bare);
  return own.length === entity.length && own.every(word => entity.includes(word));
}
/**
 * A sentence about the subject names it, unless the page is the subject's own article. A name in parentheses is a
 * disambiguator («صباح (المغرب)» is a village), not the subject.
 */
export function namesEntity(line: string, entity: readonly string[], ownArticle: boolean): boolean {
  if (ownArticle || !entity.length) return true;
  const folded = fold(line.replace(/\([^)]*\)/gu, ' ')).replace(/ء/gu, '');
  return entity.every(word => folded.includes(word.replace(/ء/gu, '')));
}
/**
 * For a subject's attribute, only a page about the subject may answer: its own article, or a page whose title holds every
 * topic word («التركيبة السكانية في مصر»). «القصير (مصر)» and «عرب» hold Egypt's name and someone else's figures.
 */
export function aboutSubject(title: string, topic: readonly string[], entity: readonly string[]): boolean {
  return !entity.length || isOwnArticle(title, entity) || (topic.length > 0 && titleScore(title, [...topic]) >= topic.length);
}

/** Health questions get a plain reminder that a page is not a diagnosis. */
const MEDICAL = /عين|عيون|العين|بصر|نظر|ليزك|ليزر|المياه البيضاء|المياه الزرقاء|جلوكوما|شبكية|قرنية|عملي[ةه]|جراح|أعراض|اعراض|علاج|مرض|دواء|أدوية|ادوية|طبيب|مستشفى|حمل|سكري|ضغط الدم|سرطان|\b(?:eye|eyes|vision|lasik|cataract|glaucoma|retina|surgery|symptoms?|treatment|disease|medicine|doctor)\b/iu;
export const MEDICAL_NOTE = 'ملاحظة: هذه معلومات عامة منقولة من المصدر، وليست تشخيصًا. للتشخيص والعلاج راجع طبيبًا مختصًا.';
export const MEDICAL_NOTE_EN = 'Note: this is general information quoted from the source, not a diagnosis. For diagnosis and treatment, see a doctor.';
export const isMedical = (question: string) => MEDICAL.test(question);

/**
 * Page text arrives on one line (the browser folds all whitespace), so a site's menus, infobox cells and
 * footer templates glue onto real sentences. Cut what is known to be chrome before splitting:
 * Wikipedia's header (up to «From Wikipedia…»), its footer (navigation templates, authority control,
 * categories), and «edit» links, which mark section headings and so become sentence breaks.
 */
const WIKI_HEAD = /From Wikipedia, the free encyclopedia|من ويكيبيديا، الموسوعة الحرة/u;
const WIKI_FOOT = /(?:Authority control databases|Authority control|Retrieved from "|This page was last edited|Categories:|ضبط استنادي|تصنيفات:|استرجع من «|آخر تعديل لهذه الصفحة)/u;
/** Reference-list lines: archive notes and broken-link marks are sources, not answers. */
const CITATION = /نسخة محفوظة|وصلة مكسورة|واي باك مشين|Archived from|Retrieved \d|Wayback Machine|ISBN|doi:/iu;
const OVERVIEW_QUESTION = /\b(?:documentation|docs|overview|introduction)\b|(?:^|\s)(?:وثائق|توثيق|مقدمة|نظرة عامة)(?=\s|$)|^(?:what is|what are|ما هو|ما هي|ما معنى)\s/iu;
/** Questions asking what or who something is: their answer is a definition sentence. */
const DEFINE_QUESTION = /^(?:ما هو|ما هي|من هو|من هي|ما معنى|ما المقصود ب|ماذا يعني|what is|what are|what was|who is|who was|who were)\s/iu;
const ARABIC_DEFINITION_LEAD = /^(?:(?:ما معنى|ماذا يعني)\s+|ما المقصود\s+ب\s*)/iu;
const ERROR_QUESTION =/\b(?:traceback|stack\s*trace|exception|debug|error)\b|خطأ|اخطاء|أخطاء|تتبع/iu;
const TRACEBACK_FRAGMENT = /\bTraceback\s*\(|\bFile\s+["'][^"']+["'],?\s+line\s+\d+\b/iu;
const WIKI_INFOBOX = /معلومات عامة|تعديل مصدري|Edit this at Wikidata|edit on Wikidata/u;
const WIKI_APPEARANCE = /(?:تلقائي فاتح داكن|Automatic Light Dark)/u;
/** Redirect notes and maintenance banners: about the article, never part of an answer. */
const WIKI_BANNERS = /\((?:بالتحويل من|Redirected from)[^)]*\)|هذه المقالة (?:بحاجة|تحتاج|يتيمة|لا تحتوي|قد تحتوي)[^.]*\.|This article (?:needs|may|has multiple|relies)[^.]*\./gu;
const EDIT_MARK =/(?:عدل)+(?: المصدر)?|\[edit\]|\[عدل\]/gu;
/** Footer navigation boxes repeat «show/إظهار» toggles and portal links: never an answer. */
const NAVBOX = /(?:إظهار|بوابة|\bshow\b|\bv t e\b)/giu;
export function readableText(text: string): string {
  let body = text;
  const head = body.match(WIKI_HEAD);
  if (head?.index !== undefined && head.index < 4000) body = body.slice(head.index + head[0].length);
  else {
    // Without the tagline, the toolbar ends at the appearance menu («تلقائي فاتح داكن» / «Automatic Light Dark»).
    const menu = body.match(WIKI_APPEARANCE);
    if (menu?.index !== undefined && menu.index < 4000) body = body.slice(menu.index + menu[0].length);
  }
  body = body.replace(WIKI_BANNERS, ' ');
  // The infobox ends in its edit links, glued to the article's first sentence on a folded page.
  // Near the top, everything before them is the infobox (photo caption, cells): drop it whole,
  // so the definition sentence is the article's first; later ones still become a sentence break.
  const infoboxEnd = body.match(/تعديل مصدري\s*-\s*تعديل|Edit this at Wikidata/u);
  if (infoboxEnd?.index !== undefined && infoboxEnd.index < 8000) body = body.slice(infoboxEnd.index + infoboxEnd[0].length);
  body = body.replace(/(تعديل مصدري)\s*-\s*تعديل|(Edit this at Wikidata)/gu, (_, ar, en) => `${ar ?? en}.\n`);
  const foot = body.search(WIKI_FOOT);
  if (foot > 0) body = body.slice(0, foot);
  return body.replace(EDIT_MARK, '. ');
}

/** The page's own sentences that share the question's words, best first by page order; quoted, never rewritten. */
export function relevantLines(page: AgentPage, question: string, limit = 3, bestFirst = false): string[] {
  const overview = OVERVIEW_QUESTION.test(question) && !ERROR_QUESTION.test(question);
  let matchingQuestion = question;
  try {
    const compiled = compileQuery(question);
    if (compiled.intent === 'technical') matchingQuestion = compiled.retrievalQuestion;
  } catch { /* Local matching still accepts a question that does not compile as a public search. */ }
  // The definition cue is not part of the subject; «بـ» may be attached to its first word.
  matchingQuestion = matchingQuestion.trim().replace(ARABIC_DEFINITION_LEAD, '');
  // «ما هي عملية الليزك»: «عملية» names the kind of thing, not the thing, and the article's own definition («تعنى كلمة الليزك…»)
  // never says it. Required as a match word, it kept that definition out (measured on «ليزك», 2026-11-22).
  const definitionAsk = DEFINE_QUESTION.test(question.trim()) || ARABIC_DEFINITION_LEAD.test(question.trim());
  const asked = fold(matchingQuestion).replace(/[؟?]/gu, ' ').split(/\s+/).filter(word => word && !ASK_WORDS.has(word));
  const kindless = asked.filter(word => !KIND_WORDS.has(word));
  // The question's own words in a row («عدد سكان المغرب»): a sentence that holds the phrase is about the question itself.
  const phraseWords = definitionAsk && kindless.length && kindless.length < asked.length ? kindless : asked;
  const words = queryWords(phraseWords.join(' '));
  if (!words.length) return [];
  const need = Math.min(2, words.length);
  const phrase = phraseWords.length >= 2 ? phraseWords.join(' ') : '';
  // «ما هو الذكاء الاصطناعي»: the sentence «الذكاء الاصطناعي (AI) هو …» is the definition itself.
  const subject = phraseWords.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definition = definitionAsk && subject
    ? new RegExp(`^(?:\\S+\\s){0,2}?(?:ال)?${subject}(?:\\s*\\([^)]*\\))?\\s+(?:هو|هي|يعد|تعد|يعرف|تعرف|عباره عن|(?:is|are|was|were)\\s+(?:a|an|the|one of|defined as|known as|called)|refers to|means)(?=\\s)`, 'u')
    : null;
  // «تعنى كلمة الليزك …»: Arabic articles also define a term by its meaning, verb first.
  const wordMeans = definition ? new RegExp(`^(?:تعني|يعني)\\s+(?:كلمه|مصطلح|لفظ|لفظه|عباره)\\s+(?:ال)?${subject}(?=[\\s(،,:]|$)`, 'u') : null;
  // Without a definition, a sentence that opens with the subject is about it, not a passing mention.
  const aboutSubject = definition ? new RegExp(`^(?:ال)?${subject}(?=[\\s(،,:]|$)`, 'u') : null;
  // Some sources explain a process first, then name it in the next sentence.
  const namesSubject = definition ? new RegExp(`^this (?:process|reaction|method|technique|phenomenon) (?:(?:is )?called|is known as) ${subject}$`, 'u') : null;
  // A price, a time or a score is a number: for such questions a sentence without one does not answer.
  const wantsNumber = isLiveWebQuestion(question);
  const numberAnswer = wantsNumber || WANTS_NUMBER.test(question);
  const kind = figureKind(question);
  // "How many people live in Japan?": the article says «population» or «inhabitants» ("With a population of almost 123 million
  // as of 2026, it is the world's 11th most populous country"), so those words match «people», and a sentence that names a
  // population outranks one that only counts people. Live on 2026-11-22 the answers were «…Greater Tokyo Area… with 37.4
  // million people» and «a 2014 ruling sentencing 529 people to death» (p1, p2 in date-questions-2026-11-22T13-44-22.json).
  // English only: an Arabic population question already names «سكان», the article's own word.
  const peopleAsk = kind === 'people' && questionLanguage(question) === 'en';
  // "Who wrote Hamlet?": the article says «written by», so the maker's forms match «wrote». Without that the opening «…
  // often shortened to Hamlet, is a tragedy written by William Shakespeare» held one question word, was dropped, and «In 1936
  // Andrew Cairncross suggested … Shakespeare wrote the Ur-Hamlet» led the answer (live 2026-11-22 23:53).
  // A reason question prefers the sentence that states a cause («… بسبب تبعثر ضوء الشمس»).
  const reasonAsk = isReasonQuestion(question);
  const makerAsk = questionLanguage(question) === 'en' && /^(?:who|whom)\s/iu.test(question.trim()) && topicWords(question).some(word => MAKER_WORDS.has(word));
  // An event verb of the question («ولد», «توفي», «نشر») counts only as a whole word, with «و/ف» before it and «ت/وا» after:
  // as part of a word, «ولد» matched «ولديهم» and «المولد», and «أين ولد ألبرت أينشتاين» led with a sentence about his letter
  // on the Japanese («… ولديهم إحساس حقيقي بالفن», 2026-11-23).
  const verbs = new Map(words.filter(word => EVENT_VERBS.has(word)).map(word => [word, new RegExp(`(?:^|[^\\p{L}])[وف]?${word}(?:ت|وا)?(?![\\p{L}])`, 'u')]));
  const has = (text: string, word: string) => (verbs.get(word)?.test(text) ?? text.includes(word)) || peopleAsk && PEOPLE_STEMS.has(word) && PEOPLE_FORMS.some(form => text.includes(form))
    || makerAsk && MAKER_STEMS.has(word) && (MAKER_STATEMENT.test(text) || MAKER_FORMS.some(form => text.includes(form)));
  // A date question is answered by the dates its subject's article opens with: «الحرب العالمية الثانية هي حرب دولية بدأت في
  // الأول من سبتمبر من عام 1939…», "World War II … (1 September 1939 – 2 September 1945)". Later sentences carry the dates of
  // other events, and the newest of them ranked first: «upon his death in 2016, the German Foreign Office tweeted…» for "When
  // did the Berlin Wall fall?", a prize first awarded in 1996 for «متى ولد نجيب محفوظ» (measured 2026-11-22 on the articles).
  // The opening counts only on a page whose subject the question names, and only as a sentence: the name, its asides, then
  // its verb («… (الألمانية: Berliner Mauer…) كان جدارا…»). A caption also opens with the name («Berlin Wall Berliner Mauer
  // From the West Berlin side, Berlin Wall graffiti art in 1986.»), and so does another subject («The United Nations Security
  // Council Resolution 1244…»).
  // "Who wrote Pride and Prejudice?" is answered by the same opening on the work's own page: «Pride and Prejudice is a novel by
  // English author Jane Austen». Infobox cells glue onto it («… Author Jane Austen Working title … at Wikisource Pride and
  // Prejudice is a novel by …», measured on the article 2026-11-22), so for these questions the sentence starts at the subject.
  const whoMade = makerAsk;
  const rawSubject = whoMade ? plainTitle(page.title ?? '').replace(/\s+[-–—|:]\s+[^-–—|:]{1,40}$/u, '').trim() : '';
  const subjectStart = rawSubject.length >= 3
    ? new RegExp(`(?<=\\s)(?:The\\s+)?${rawSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\([^)]*\\))?\\s+(?:is|was|are|were|هو|هي|كان|كانت)\\s`, 'giu') : null;
  const pageSubject = kind === 'date' || whoMade ? fold(plainTitle(page.title ?? '')) : '';
  const opensWithSubject = pageSubject && queryWords(pageSubject).length && queryWords(pageSubject).every(word => words.includes(word))
    ? new RegExp(`^(?:the\\s+)?${pageSubject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*\\[[^\\]]*\\]|\\s*\\([^)]*\\)|\\s*[،,])*\\s+(?:is|was|are|were|or|هو|هي|كان|كانت|عرفت|عرف|يعد|تعد|يعتبر|تعتبر)(?=\\s)`, 'u') : null;
  const labels = [...new Set(page.elements.filter(element => ['link', 'button'].includes(element.role)).map(element => tidy(element.label).toLowerCase()).filter(label => label.length >= 2))]
    .sort((a, b) => b.length - a.length);
  const labelSet = new Set(labels.map(fold));
  const pageTitle = fold(page.title ?? '');
  const titled = words.filter(word => has(pageTitle, word));
  const scored:{ line: string; score: number; at: number; year: number; glued: boolean; lead: boolean }[] = [];
  const seen = new Set<string>();
  // Citation marks may carry spaces inside the brackets («[ 5 ] [ 28 ] ويبلغ عدد سكانها…», measured 2026-11-22 on «المغرب»).
  // A page read over HTTP is one line of words joined by spaces, so the full run of 07:06 sent first lines that began with a
  // stray «]» (4 of 23), carried «[لغات أخرى]» or a leading «ويكي بيانات», and put a space before every «.» and «،».
  const cleanSentence = (text: string) => withoutChrome(text
    .replace(/\[\s*(?:\d+|Note \d+|note \d+|ملحوظة \d+|ْ?\s*\d+|[ا-ي]|[a-z])\s*\]/gu, '')
    .replace(/\[\s*(?:لغات أخرى|عدل|تعديل|عدل المصدر|بحاجة لمصدر|بحاجة إلى مصدر|edit|citation needed)\s*\]/giu, '')
    .replace(/[​‎‏]/gu, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[\])]+\s*/u, '')
    .replace(/^(?:ويكي بيانات|Wikidata)\s+/iu, '')
    .replace(/\s*\[\s*([.!?؟])$/u, '$1')
    .replace(/\s+([.،,؛;:!?؟)\]»])/gu, '$1')
    .replace(/([(\[«])\s+/gu, '$1'), labels);
  // Keep decimal points, name initials and common title and calendar abbreviations inside their sentence.
  const text = readableText(page.text);
  const sentences = [...text.matchAll(/(?:[^.!?؟\n]|(?<=\p{Nd})\.(?=\p{Nd})|(?<=(?<!\p{L})(?:\p{Lu}|Dr|Prof|Mr|Mrs|Ms|St|Maj|Gen|Lt|Col))\.(?=[ \t]+\p{Lu})|(?<=(?<!\p{L})ق)\.(?=[ \t]*(?:هـ|م)(?!\p{L})))+(?:[.!?؟]+|\n|$)/gu)];
  for (const [index, match] of sentences.entries()) {
    let line = cleanSentence(match[0]);
    const opening = subjectStart ? [...line.matchAll(subjectStart)].at(-1) : undefined;
    if (opening?.index) line = line.slice(opening.index).trim();
    let pairedDefinition = false, at = match.index ?? 0;
    if (/[.!]$/u.test(line) && namesSubject?.test(fold(line)) && index > 0) {
      const previousMatch = sentences[index - 1], previous = cleanSentence(previousMatch[0]);
      const pair = `${previous} ${line}`;
      const gap = text.slice((previousMatch.index ?? 0) + previousMatch[0].length, at);
      // Keep only a short, adjacent declarative explanation, never a question,
      // contents/link label or a clipped quote that would lose the naming sentence.
      if (/[.!]$/u.test(previous) && !/[?؟]/u.test(previous) && prose(previous)
        && !/^(?:contents|table of contents|index|overview|navigation)\b/iu.test(previous)
        && !labelSet.has(fold(previous.replace(/[.!]+$/u, '')))
        && !WIKI_INFOBOX.test(previous) && !CITATION.test(previous) && !TRACEBACK_FRAGMENT.test(previous)
        && (previous.match(NAVBOX) ?? []).length < 2 && !/\n[ \t]*\n/u.test(gap)
        && pair.length <= 300 && pair.split(' ').length <= 40) {
        line = pair; pairedDefinition = true; at = previousMatch.index ?? at;
      }
    }
    // A code example's filenames can match the topic; they do not explain the module to an overview request.
    if (overview && TRACEBACK_FRAGMENT.test(line)) continue;
    // An infobox glued before an article's first sentence: the sentence is the tail of the run.
    let glued = line.split(' ').length > 40 || line.length > 400;
    let lead = false;
    if (glued) {
      const parts = line.split(' ');
      const tail = `… ${parts.slice(-40).join(' ')}`.slice(0, 400);
      // An encyclopedia's own long first sentence names its subject only at the start
      // («ألبرت أينشتاين (…) عالم فيزياء …»): keep that start when the tail misses the question.
      const head = `${parts.slice(0, 40).join(' ')} …`.slice(0, 400);
      const matched = (text: string) => words.filter(word => has(fold(text), word)).length;
      // A definition's head is the answer even when its tail repeats the subject: «تعنى كلمة الليزك …» runs 74 words on «ليزك».
      const definesAtHead = Boolean(definition?.test(fold(head)) || wordMeans?.test(fold(head)));
      lead = definesAtHead || matched(tail) < need && matched(head) >= need;
      // The lead is shown whole when it fits (leadSentence), not cut at 40 words in mid-clause as it was until 2026-11-23.
      line = lead ? leadSentence(parts) : tail;
      // A sentence that opens with the subject is the article's own lead, not infobox cells: no penalty,
      // so a later photo caption («ألبرت أينشتاين عام 1893») does not outrank the definition.
      if (lead) glued = false;
    }
    const count = glued ? 40 : line.split(' ').length;
    const hasNumber = hasAnswerNumber(line);
    const folded = fold(line);
    // A short, complete sentence can state a fact when it names both the page's subject and the requested property.
    const shortStatement = count >= 3 && count < 5 && /[.!]$/u.test(line) && titled.length > 0
      && titled.length < words.length && words.every(word => has(folded, word));
    if (count < (hasNumber || shortStatement ? 3 : 5) || line.length > (lead ? LEAD_MAX_CHARS : 400) || seen.has(line) || (wantsNumber && !hasNumber)) continue;
    // A sentence that asks («ما تاريخ الذكاء الاصطناعي؟») is a heading or a contents entry, never an answer.
    if (/[؟?]\s*$/u.test(line)) continue;
    // Lines about the page, not the subject: hatnotes, bylines, headers (plan §7.4; 0-baseline §8.3 sent these as answers).
    if (isMetaLine(line)) continue;
    if ((line.match(NAVBOX) ?? []).length >= 2) continue;
    // Infobox cells («معلومات عامة … تعديل مصدري - تعديل») read like a sentence once the toolbar is gone.
    if (WIKI_INFOBOX.test(line) || CITATION.test(line)) continue;
    // A run of the page's own menu labels is navigation, not an answer.
    const menuWords = labels.length ? folded.split(' ').filter(word => labelSet.has(word)).length : 0;
    if (menuWords / count > 0.3) continue;
    // The page's own subject («أستراليا» on its article) is implied in its sentences («عاصمتها كانبرا»),
    // but only once the sentence holds another question word: the title alone answers nothing.
    const own = words.filter(word => !titled.includes(word) && has(folded, word)).length;
    // A date sentence names its subject: on «الجزائر», «بنى عاصمته القلعة عام 1007 م … واستقل بالحكم» is about a dynasty.
    const implied = kind !== 'date' || titled.some(word => has(folded, word));
    const hits = own && implied ? own + titled.length : words.filter(word => has(folded, word)).length;
    if (hits < need) continue;
    seen.add(line);
    // A number in the sentence is often the answer itself: a price, a time, a score. A run past 40 words
    // is usually table cells glued to a sentence (an infobox), so it ranks below a plain sentence.
    // Among equals, the newest year wins: «إحصاء 2024» answers «كم عدد السكان» better than «إحصاء 2014».
    // A year still to come is a projection, not the newest figure: «Japan's population is expected to drop to around 88
    // million by 2065» outranked «With a population of almost 123 million as of 2026» (Japan article, 2026-11-22).
    const year = Math.max(0, ...[...line.matchAll(/(?<!\d)(1[89]\d\d|20\d\d)(?!\d)/g)].map(found => Number(found[1])).filter(value => value <= THIS_YEAR));
    // On the subject's own page, a question word carrying a pronoun is the Arabic answer form
    // («عاصمتها كانبرا»: its capital is Canberra), stronger than a name that repeats the phrase.
    const answerForm = titled.length > 0 && own > 0 && words.some(word => !titled.includes(word)
      && new RegExp(`(?:^|\\s)[وف]?(?:ال)?${word}(?:\\p{L}{0,2}(?:ها|هم)|\\p{L}{1,2}ه)(?=[\\s،,:]|$)`, 'u').test(folded));
    scored.push({ line, score: hits + (numberAnswer && /\d/u.test(line) ? 1 : 0) - (glued ? 1 : 0) + (phrase && folded.includes(phrase) ? 2 : 0) + (answerForm ? 3 : 0) + (pairedDefinition || definition?.test(folded) || wordMeans?.test(folded) ? 3 : 0) + (aboutSubject?.test(folded) ? 1 : 0)
      + (peopleAsk && POPULATION_NOUN.test(folded) ? 2 : 0) + (opensWithSubject?.test(folded) ? 2 : 0) + (makerAsk && MAKER_STATEMENT.test(folded) ? 2 : 0) + (reasonAsk && reasonAnswers(question, line) ? 3 : 0), at, year, glued, lead });
  }
  // «كم تستغرق …» is answered by a number: sentences without one only look related.
  if (numberAnswer && !scored.some(item => hasAnswerNumber(item.line))) return [];
  // Among equals the newest year wins («إحصاء 2024» over «إحصاء 2014»), except for a date: there it is the page order.
  const best = scored.sort((a, b) => b.score - a.score || (numberAnswer && kind !== 'date' ? b.year - a.year : 0) || a.at - b.at).slice(0, limit);
  return (bestFirst ? best : best.sort((a, b) => a.at - b.at)).map(item => item.lead ? item.line : wholeWords(item.line, 300));
}

/** The longest opening sentence shown whole (measured 2026-11-23 on ar Wikipedia: Einstein 73 words / 490 characters). */
const LEAD_MAX_WORDS = 80, LEAD_MAX_CHARS = 560;

/**
 * An article's long opening sentence as the answer's first line: whole when it fits, else up to its last clause break («،»,
 * «؛», ",", ";") from the 25th word on, else its first 40 words. Until 2026-11-23 it was always cut at 40 words, so the
 * answers on Einstein, LASIK and cataract ended in mid-clause with «…» (5 of 25 sourced replies on the 107 real requests).
 */
export function leadSentence(parts: readonly string[]): string {
  const whole = parts.join(' ');
  if (parts.length <= LEAD_MAX_WORDS && whole.length <= LEAD_MAX_CHARS) return whole;
  let cut = -1, length = -1;
  for (let index = 0; index < Math.min(parts.length, LEAD_MAX_WORDS); index++) {
    length += parts[index]!.length + 1;
    if (length > LEAD_MAX_CHARS - 2) break;
    if (index >= 24 && /[،,؛;]$/u.test(parts[index]!)) cut = index;
  }
  return cut > 0 ? `${parts.slice(0, cut + 1).join(' ').replace(/[،,؛;]$/u, '')} …` : `${parts.slice(0, 40).join(' ')} …`;
}

/** A line cut to `max` characters on a word boundary, with «…»; it was cut inside a word before 2026-11-23. */
function wholeWords(line: string, max: number): string {
  if (line.length <= max) return line;
  const space = line.lastIndexOf(' ', max - 2);
  return `${(space > max / 2 ? line.slice(0, space) : line.slice(0, max - 1)).replace(/[\s،,؛;:\-–—]+$/u, '')} …`;
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
/** An English population question's own words (cut as queryWords cuts them) and the forms an article uses for them. */
const PEOPLE_STEMS = new Set(queryWords('people population inhabitants residents persons'));
const PEOPLE_FORMS = ['peop', 'popul', 'inhabit', 'resident', 'person'];
/** The maker words of a "who wrote …" question, cut as queryWords cuts them. */
const MAKER_STEMS = new Set(queryWords([...MAKER_WORDS].join(' ')));
/** A sentence that names a population, not only a number of people. Folded text. */
const POPULATION_NOUN = /\b(?:population|populous|populated|inhabitants|residents)\b/u;
const THIS_YEAR = new Date().getUTCFullYear();

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

/** Question words only narrow an encyclopedia search; «ما عاصمة اليابان» searches «عاصمة اليابان». */
const WIKI_ASK_LEAD = /^(?:(?:ما|ماذا|من|متى|أين|اين|كم|كيف|هل|لماذا|ما هي|ما هو|what|who|when|where|which|how|why|is|are|was|were|the|of)\s+)+/iu;
/** The question's subject words alone: no question lead, no frame words, no place tail. «كم تستغرق عملية المياه البيضاء» → «المياه البيضاء». */
export function wikiTerms(query: string): string {
  const asked = query.trim().replace(/[؟?]+$/u, '').replace(WIKI_ASK_LEAD, '').trim() || query.trim();
  // «كم تستغرق عملية المياه البيضاء» searches «المياه البيضاء»: frame words pull in unrelated articles.
  const kept = asked.split(/\s+/).filter(word => !FRAME_WORDS.has(fold(word)));
  let words = kept.length && kept.some(word => !ASK_WORDS.has(fold(word))) ? kept.join(' ').replace(/^(?:في|عن|of|the)\s+|\s+(?:في|عن|of)$/giu, '') : asked;
  // «المياه البيضاء في العين» searches «المياه البيضاء»: the place part pulls in «العين السخنة».
  const head = words.split(/\s+(?:في|عند|لدى|in)\s+/iu)[0];
  if (head !== words && head.split(/\s+/).length >= 2) words = head;
  // «من هو ألبرت أينشتاين» → «ألبرت أينشتاين»: a pronoun or question word left after the lead names no subject.
  const subject = words.split(/\s+/).filter(word => !ASK_WORDS.has(fold(word)));
  return subject.length ? subject.join(' ') : words;
}
/** A subject's Wikipedia article by its name, in the question's language: «ألبرت أينشتاين» → ar.wikipedia.org/wiki/ألبرت_أينشتاين. */
export const articleUrl = (name: string, lang: 'ar' | 'en'): string =>
  `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(name.trim().replace(/[؟?!،,]+$/u, '').replace(/\s+/gu, '_'))}`;
/** Wikipedia's own full-text search in the question's language, for an explicit «ابحث في ويكيبيديا»: keyless and with no human check. */
export const WIKI_SEARCH = (query: string) => `https://${/[؀-ۿ]/u.test(query) ? 'ar' : 'en'}.wikipedia.org/w/index.php?search=${encodeURIComponent(wikiTerms(query))}&fulltext=1&ns0=1`;
const SEARCH_TEMPLATES: [RegExp, (query: string) => string][] = [
  [/(?:^|\.)wikipedia\.org$/, WIKI_SEARCH],
  [/(?:^|\.)youtube\.com$/, query => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`],
  [/(?:^|\.)google\.com$/, query => `https://www.google.com/search?q=${encodeURIComponent(query)}`],
  [/(?:^|\.)github\.com$/, query => `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`],
];
function templateFor(siteUrl: string, query: string): string | null {
  const host = URL.parse(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`)?.hostname ?? '';
  const found = SEARCH_TEMPLATES.find(([pattern]) => pattern.test(host));
  return found ? found[1](query) : null;
}

/** Expand deterministic site navigation before the host admits and persists the whole plan. */
export function normalizeHandsPlan(plan: HandsPlan): HandsPlan {
  if (!Array.isArray(plan.steps) || !plan.steps.length || !Number.isSafeInteger(plan.next) || plan.next < 0 || plan.next > plan.steps.length) {
    throw new BrowserError('ASSISTANT_HANDS_PLAN_INVALID', 'تعذر التحقق من خطة المتصفح المحفوظة؛ اطلب المهمة من جديد.', 409);
  }
  const expanded: HandsStep[] = [];
  let next = 0;
  for (const [index, step] of plan.steps.entries()) {
    if (index === plan.next) next = expanded.length;
    if (step.kind === 'search' && step.site && !templateFor(step.site.url, step.query)) {
      expanded.push({ kind: 'open', url: step.site.url, name: step.site.name }, { ...step, site: null, here: true });
    } else expanded.push(step);
  }
  if (plan.next === plan.steps.length) next = expanded.length;
  plan.steps = expanded;
  plan.next = next;
  return plan;
}

/** A public page read over HTTP without the browser; `unreadable` (no text, not HTML, timeout) falls back to the browser, `disallowed` (robots) is skipped. */
export type HandsRead = { kind: 'page'; page: AgentPage } | { kind: 'unreadable' } | { kind: 'disallowed' };

export interface HandsIO {
  /** The conversation's live page, or null when no page is open. */
  page(): Promise<AgentPage | null>;
  /** The same public web search used by the model, with topic relevance and source ranking. */
  search?(query: string, limit: number): Promise<SearchHit[]>;
  /** Reads a search result over HTTP, so a question is answered without opening the browser. */
  read?(url: string): Promise<HandsRead>;
  act(action: AgentAction): Promise<AgentPage>;
  prepare(action: AgentAction): Promise<AgentRequestPermit | null>;
  /** Cookie banners, sign-in and human checks; null when the run paused or ended there. */
  settle(page: AgentPage): Promise<AgentPage | null>;
  /** Durable execution admission, separate from display labels; rejection prevents this step's effects. */
  begin?(index: number): Promise<void>;
  /** Called only after this exact step returns its observation, never from a progress label or cursor move. */
  complete?(index: number, status: 'completed' | 'partial'): Promise<void>;
  step(label: string): Promise<void>;
  /** The live line only («ينتظر ظهور نتائج البحث»); nothing is recorded as a step. */
  progress?(label: string): Promise<void>;
  /** Waits before a second search; tests pass a no-op. Defaults to a real timer. */
  pause?(ms: number): Promise<void>;
  /** Saves the plan, then pauses for the owner's approval of this exact request. */
  approve(action: AgentAction, permit: AgentRequestPermit, label: string): Promise<void>;
  hold(held: AgentEffectHeld['held'], label: string): Promise<void>;
}

export type HandsOutcome = { kind: 'paused' } | { kind: 'done'; text: string; status: 'completed' | 'partial' | 'blocked' };

/** The shared search engine's spacing between two calls to one provider (1000 ms), with a margin. */
export const PROVIDER_SPACING_MS = 1100;

/** A page fetched over HTTP whose body is only a JavaScript notice (or nothing) is read in the browser instead. */
const JS_ONLY = /enable javascript|javascript is (?:required|disabled|turned off|not enabled)|please enable js|يجب تفعيل (?:جافا|javascript)|فعّل جافا/iu;
export function readableOverHttp(text: string): boolean {
  const body = text.trim();
  return body.length >= 40 && !JS_ONLY.test(body.slice(0, 600));
}

/** No source answered a changing fact; do not substitute an encyclopedia's old figure. */
export const noLiveSource = (query: string, lang: 'ar' | 'en' = /[؀-ۿ]/u.test(query) ? 'ar' : 'en') => lang === 'ar'
  ? `لم أتمكن من الوصول إلى مصدر حديث ومرتبط بسؤالك «${query}» بعد تجربة البحث في الويب. إن أرسلت رابط موقع مناسب أفتحه وأقرأ المعلومة منه.`
  : `I could not reach a current source relevant to “${query}” after trying web search. Send a suitable website link and I can open it and read the information there.`;

/**
 * The search request itself failed: the providers that read the question did not answer (`detail` names each one and how,
 * as the shared engine reports it). Not the same as a search that answered with nothing relevant.
 */
export const searchFailed = (query: string, detail: string, lang: 'ar' | 'en' = /[؀-ۿ]/u.test(query) ? 'ar' : 'en') => lang === 'ar'
  ? `تعذّر البحث عن «${query}»: مصادر البحث لم تستجب الآن (${detail}). هذا فشل في الطلب، لا بحث بلا نتائج. أعد المحاولة بعد قليل.`
  : `The search for “${query}” failed: the search sources did not answer just now (${detail}). This is a failed request, not a search without results. Please try again shortly.`;

const noSearchSource = (query: string, lang: 'ar' | 'en' = /[؀-ۿ]/u.test(query) ? 'ar' : 'en') => isLiveWebQuestion(query) ? noLiveSource(query, lang) : lang === 'ar'
  ? `لم أجد في المصادر المتاحة لي (ويكيبيديا والواجهات الموثقة) نتائج مرتبطة بسؤالك «${query}». أرسل رابط موقع مناسب أو حدد اسم الجهة التي تريد البحث لديها.`
  : `I found no results relevant to “${query}” in the sources available to me (Wikipedia and documented APIs). Send a suitable website link or name the organization to search.`;


/** A page title without the site's own suffix («… - ويكيبيديا») and without link brackets. */
export function plainTitle(title: string): string {
  return tidy(title).replace(/\s+[-–—|]\s+(ويكيبيديا|Wikipedia|BBC News عربي|BBC News|الجزيرة نت)$/iu, '').replace(/[[\]]/g, '').slice(0, 90) || title;
}

/** The browser keeps the first 90 characters of an element's text (packages/browser agent-browser.ts, `label`). */
const ELEMENT_LABEL_CAP = 90;
/**
 * A link's text as a reply lists it: whole words only, and «…» where the text was cut. A headline the browser kept only 90
 * characters of was listed «… ولقاء أمريكي قطري في وا» in production on 2026-11-23. `max` is the longest text shown.
 */
export function shownLabel(label: string, max = ELEMENT_LABEL_CAP): string {
  const text = tidy(label).replace(/[[\]]/g, '');
  const cut = label.length >= ELEMENT_LABEL_CAP;
  if (!cut && text.length <= max) return text;
  const room = Math.max(1, max - 1);
  let kept = text.slice(0, room);
  // The cut went through a word when a letter or digit follows it, or when the browser had already cut the text there.
  const throughWord = text.length > room ? /[\p{L}\p{N}]/u.test(text.charAt(room)) && /[\p{L}\p{N}]/u.test(kept.slice(-1)) : cut;
  if (throughWord && kept.includes(' ')) kept = kept.slice(0, kept.lastIndexOf(' '));
  return `${kept.replace(/[\s،,.:;!?؟\-–—]+$/u, '')}…`;
}
/** A page title in a list of links: plainTitle(), with «…» when it is as long as the browser keeps a label. */
const shownTitle = (title: string): string => {
  const plain = plainTitle(title);
  return plain.length >= ELEMENT_LABEL_CAP ? shownLabel(plain) : plain;
};
const NO_PAGE = 'لا توجد صفحة مفتوحة في هذه المحادثة. قل لي أي موقع أفتح أولًا، مثل «افتح bbc.com».';

/** Runs the plan from `plan.next`. The caller persists `plan` in the run state before any pause. */
export async function runHands(plan: HandsPlan, io: HandsIO): Promise<HandsOutcome> {
  normalizeHandsPlan(plan);
  const enforceRefusal = refusalPolicyEnabled();
  const refused = (decision: RefusalDecision): HandsOutcome => ({ kind: 'done', status: 'blocked',
    text: refusalReply(decision, plan.lang === 'en' ? '' : 'العربية').text });
  const planRefusal = enforceRefusal && reviewHandsRefusal(plan.steps);
  if (planRefusal) return refused(planRefusal);
  const first = plan.steps[0];
  const publicPageRead = plan.steps.length === 1 && first?.kind === 'ask_page' && first.conversationPage?.readPublic;
  let page = publicPageRead ? null : await io.page();
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
  const submit = async (action: AgentAction, label: string): Promise<AgentPage | null | 'none' | RefusalDecision> => {
    const permit = await io.prepare(action).catch(() => null);
    if (!permit) return 'none';
    const effectRefusal = enforceRefusal && reviewRefusalDestination(permit.url, permit.method);
    if (effectRefusal) return effectRefusal;
    if (permit.method === 'GET') return go({ kind: 'open', text: permit.url }, label);
    await io.approve(action, permit, label);
    return null;
  };

  /**
   * General questions search over HTTP through the shared engine (documented APIs; nothing is opened in
   * the browser). The result is a list; reading comes next. When the question's own words find nothing,
   * its subject words alone are tried («المياه البيضاء» for «كم تستغرق عملية المياه البيضاء»), because
   * the engine keeps a few hits per site by lexical score and can drop the subject's own article.
   * The scraped engines that used to run in the browser are gone: bing.com/robots.txt forbids /search,
   * and html.duckduckgo.com answers with a human check (both measured 2026-11-22; they took ~7 s of every
   * 13 s web question). An encyclopedia never answers a changing fact: a price, the weather or a score.
   */
  /** Articles opened by the subject's own name (Wikipedia resolves its redirects): the subject's article whatever its title. */
  const ownUrls = new Set<string>();
  const ownPage = (page: { url: string; title: string }, entity: readonly string[]) => ownUrls.has(withoutHash(page.url)) || isOwnArticle(page.title, entity);
  type SearchResult = { title: string; url: string };
  type SearchBatch = { results: SearchResult[]; retrySubject?: () => Promise<SearchResult[]> };
  const engine = async (query: string, ask = false): Promise<SearchBatch | { failed: string } | 'unavailable'> => {
    const publicQuery = query.normalize('NFKC').replace(/\p{Cf}/gu, '');
    const decoded = publicSearchScan(publicQuery);
    if (publicSearchText(publicQuery) !== publicQuery || publicSearchText(decoded) !== decoded || (decoded.match(/https?:\/\/\S+/gi) ?? []).some(url => safeResumeUrl(url) === null)) {
      throw new BrowserError('RESEARCH_QUERY_SECRET', 'أزل بيانات الاعتماد من الاستعلام قبل البحث العام.', 400);
    }
    try { compileQuery(query); } catch { throw new BrowserError('RESEARCH_QUERY_INVALID', 'اكتب موضوعًا محددًا للبحث، واستخدم site: مع اسم نطاق صالح فقط.', 400); }
    if (!io.search) return 'unavailable';
    const live = isLiveWebQuestion(query);
    const topic = topicWords(query);
    // The search providers did not answer (unavailable, rate limited, invalid answer): a failed request, told apart from a
    // search that answered with nothing about the question.
    let providerFailure: string | null = null;
    const lookup = async (words: string) => {
      let hits: SearchHit[] = [];
      try { hits = await io.search!(words, 6); }
      catch (error) {
        if (error instanceof BrowserError && error.code === 'RESEARCH_PROVIDERS_FAILED') providerFailure = error.message;
        // Cancellation, rejected query policy and lost execution authority must stop the run.
        else if (!(error instanceof BrowserError) || error.code !== 'RESEARCH_SEARCH_UNAVAILABLE') throw error;
      }
      const seen = new Set<string>();
      const ranked = hits.flatMap((hit, at) => {
        const url = URL.parse(hit.url);
        if (!url || !/^https?:$/.test(url.protocol) || seen.has(withoutHash(url.href))) return [];
        seen.add(withoutHash(url.href));
        return [{ title: tidy(hit.title), url: url.href, at, score: titleScore(`${hit.title} ${hit.snippet}`, topic), wiki: /(?:^|\.)wikipedia\.org$/.test(url.hostname) }];
      });
      // Preserve the shared engine's authority and relevance ranking; a topic-specific site comes before the encyclopedia.
      return ranked.filter(hit => (!topic.length || hit.score > 0) && !(live && hit.wiki))
        .sort((a, b) => Number(a.wiki) - Number(b.wiki) || a.at - b.at)
        .map(({ title, url }) => ({ title, url }));
    };
    // A question about a subject's attribute («كم عدد سكان مصر») is answered from the subject's own article first. The shared
    // ranking keeps only pages whose title and snippet repeat every question word, which dropped «مصر» for «القصير (مصر)» and
    // «عرب» (artifacts/plan-2026-11-22/two-sources-2026-11-22T06-00-31.json).
    // Every attribute, not only figures: in the full run of 07:06 (real-answers-2026-11-22T07-06-58.jsonl) the subject's
    // article turned «ما عاصمة فرنسا» from an embassy page into Paris and «ما عاصمة أستراليا» from a line about Washington
    // into Canberra; «ما عاصمة اليابان» now quotes the Japan article, not Tokyo's.
    // «من هو ألبرت أينشتاين», «ما هي الطاقة الشمسية»: the subject is the whole topic, and its own article is the source (plan
    // §7.2). In the full runs since 04:48 the search returned only his sons' pages for «من هو ألبرت أينشتاين», so the reply
    // quoted Eduard Einstein's article (rq025, rq079; the 02:17 baseline had quoted Albert's).
    // A reason is asked about one thing («السماء» in «لماذا السماء زرقاء؟»): that thing's article is the source, whatever else the question says.
    const reason = reasonSubject(query);
    const entity = reason ? [] : entityWords(query);
    const searchable = reason ? topicWords(reason) : entity.length ? entity : DEFINE_QUESTION.test(query.trim()) ? topicWords(query) : aspectSubject(query);
    // A figure with no attribute word («كم تستغرق عملية المياه البيضاء») has its subject opened by name too, never searched for.
    const subject = searchable.length ? searchable : WANTS_NUMBER.test(query) ? topicWords(wikiTerms(query)) : [];
    const surface = !subject.length ? '' : reason ? reason : entity.length ? entitySurface(query, entity) : wikiTerms(query);
    // Wikipedia opens a subject's article by its name and follows its redirects («المياه البيضاء» → «الساد», «الشاي الأخضر»
    // → «شاي أخضر», measured 2026-11-22), so the article is read while the search runs, not searched for after it: the search
    // lookup cost 1.1 to 1.9 s a question (the engine's one-second spacing, then the search). The page reader caches it.
    const direct = subject.length && !live && surface.trim() && io.read
      ? io.read(articleUrl(surface, questionLanguage(query))).catch((): HandsRead => ({ kind: 'unreadable' })) : null;
    let results = await lookup(query);
    const openedByName = direct ? await direct : null;
    const named = openedByName?.kind === 'page' && readableOverHttp(openedByName.page.text) && !isDisambiguationPage(openedByName.page) ? openedByName.page : null;
    if (named) {
      const title = tidy(named.title) || hostOf(named.url);
      ownUrls.add(withoutHash(named.url));
      // Listed under the name it was opened by when Wikipedia's title differs («المياه البيضاء» for the article «الساد»): that
      // name is the search's title for it, and the reply's source line keeps the page's own title.
      const listed = plainTitle(title) === plainTitle(surface) ? title : surface.trim();
      results = [{ title: listed, url: named.url }, ...results.filter(hit => withoutHash(hit.url) !== withoutHash(named.url) && plainTitle(hit.title) !== plainTitle(title))];
    }
    // The shared engine keeps one second between two calls to the same provider (packages/browser/src/search/engine.ts,
    // `health.next`) and answers an earlier call with no hits. A second lookup waits that second out, or it is always empty:
    // measured on 2026-11-22 (artifacts/plan-2026-11-22/two-sources-2026-11-22T06-17-27.json), the subject lookup and the
    // narrower-terms fallback both came back empty when sent at once.
    const pause = io.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    // Words already searched in this round are not searched again: the same words return the same results.
    const looked = new Set([fold(query)]);
    const narrower = wikiTerms(query);
    if (!results.length && !live && fold(narrower) !== fold(query) && topicWords(narrower).length) {
      await io.step(`لم يُجب البحث الأول؛ البحث عن «${narrower.slice(0, 60)}»`);
      await pause(PROVIDER_SPACING_MS);
      results = await lookup(narrower);
      looked.add(fold(narrower));
    }
    // A subject-name retry can recover its article when the first hits don't answer. Read the
    // existing hits first for questions, so a relevant source can save another provider round trip.
    if (!named && searchable.length && !live && surface && !looked.has(fold(surface))
      && !results.some(hit => isOwnArticle(hit.title, searchable))) {
      const retrySubject = async () => {
        await io.step(`البحث عن مقالة «${surface.slice(0, 60)}»`);
        await pause(PROVIDER_SPACING_MS);
        return (await lookup(surface)).filter(hit => isOwnArticle(hit.title, searchable));
      };
      if (ask && results.length) return { results, retrySubject };
      const own = await retrySubject();
      if (own.length) results = [...own, ...results.filter(hit => !own.some(item => withoutHash(item.url) === withoutHash(hit.url)))];
    }
    return results.length ? { results } : providerFailure ? { failed: providerFailure } : 'unavailable';
  };

  while (plan.next < plan.steps.length) {
    const index = plan.next, step = plan.steps[index];
    if (io.begin) {
      // Persist the advanced cursor with the started ledger step before any effect. A crash cannot replay it by guessing.
      plan.next = index + 1;
      await io.begin(index);
    }
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
        await io.step(`البحث عن «${step.query.slice(0, 60)}»`);
        plan.next = index + 1;
        delete plan.results;
        delete plan.found;
        // A new question is a web search even if the previous answer left an encyclopedia open.
        const scoped = step.here || index > 0 && plan.steps[index - 1].kind === 'open';
        const box = !template && page && scoped ? findSearchBox(page) : undefined;
        if (!template && !box && step.here) return { kind: 'done', status: 'partial', text: page ? `لم أجد خانة بحث في ${hostOf(page.url)}. الصفحة ظاهرة في لوحة المتصفح؛ قل «ابحث عن ${step.query} في الإنترنت» لأبحث خارجها.` : NO_PAGE };
        let searched: SearchResult[] | undefined;
        let retrySubject: SearchBatch['retrySubject'];
        // «What is the latest version of Node.js?» is read from the product's own release page first (releases.ts): the
        // search only finds old forum threads for it. When that page cannot be read or no longer states a version, the
        // general search runs as before.
        const release = !template && !box && step.ask && io.read ? releaseQuestion(step.query) : null;
        if (release) {
          await io.step(readingLabel([release.page]));
          const read = await io.read!(release.page).catch((): HandsRead => ({ kind: 'unreadable' }));
          const official = read.kind === 'page' ? read.page : null;
          const fact = official ? release.parse(official.text) : null;
          if (official && fact) {
            const lang = plan.lang ?? (/[؀-ۿ]/u.test(step.query) ? 'ar' : 'en');
            plan.results = [{ title: release.title[lang], url: official.url }, ...(release.more ? [{ title: release.more.title[lang], url: release.more.url }] : [])];
            plan.found = { url: official.url, title: release.title[lang], lines: releaseLines(release, fact, lang), readAt: official.observedAt, official: true, quote: fact.evidence };
            break;
          }
        }
        if (!template && !box) {
          // The shared engine over HTTP: a results list and no browser page.
          const found = await engine(step.query, step.ask);
          if (found === 'unavailable') return { kind: 'done', status: 'blocked', text: noSearchSource(step.query, plan.lang) };
          if ('failed' in found) return { kind: 'done', status: 'blocked', text: searchFailed(step.query, found.failed, plan.lang) };
          searched = found.results;
          retrySubject = found.retrySubject;
        } else {
          let reached: AgentPage | null | 'none' | RefusalDecision;
          if (template) reached = await go({ kind: 'open', text: template }, `البحث عن ${step.query}`);
          else {
            reached = await submit({ kind: 'type', ref: box!.ref, text: step.query, submit: true }, `البحث عن «${step.query}»`);
            if (reached === 'none') {
              await io.act({ kind: 'type', ref: box!.ref, text: step.query });
              reached = await go({ kind: 'press', text: 'Enter' }, `البحث عن «${step.query}»`);
            }
          }
          if (!reached) return { kind: 'paused' };
          if ('code' in reached) return refused(reached);
          page = reached;
          // Some sites draw their results after the page loads: look again, three times at most.
          for (let look = 0; look < 3 && queryOf(page.url) && !resultLinks(page, 1, step.query).length; look++) {
            if (look === 0) await io.progress?.('ينتظر ظهور نتائج البحث');
            page = await io.act({ kind: 'wait', text: '2000' });
          }
        }
        if (searched) plan.results = searched;
        const tried = new Set<string>();
        const extracted = new Map<string, NonNullable<HandsPlan['found']>>();
        const readResults = async (results: SearchResult[], candidates = results) => {
          // A question wants its answer, not a list: read the top results until one page answers in its own words.
          // A page the judge already refused for this question is neither read again nor offered again (plan.rejected, set by the
          // chat's correction step).
          const refused = new Set((plan.rejected ?? []).map(withoutHash));
          const eligible = results.filter(item => !refused.has(withoutHash(item.url)));
          plan.results = eligible;
          const unread = candidates.filter(item => !refused.has(withoutHash(item.url)) && !tried.has(withoutHash(item.url)));
          // Open only the results whose titles name the question's topic best: «إمداد المياه» is not «المياه البيضاء».
          const topic = topicWords(step.query);
          const ranked = unread.map((item, at) => ({ item, at, score: topic.length ? titleScore(item.title, topic) : 1 }));
          const top = Math.max(0, ...ranked.map(entry => entry.score));
          const best = top > 0 ? ranked.filter(entry => entry.score === top).sort((a, b) => a.at - b.at).map(entry => entry.item) : [];
          // The subject's own article («أستراليا» for «ما عاصمة أستراليا») comes first, even when another
          // title repeats more question words («سفارة أستراليا في واشنطن العاصمة»).
          // Among titles made only of question words, the one naming most of them is the subject:
          // «طاقة شمسية» for «ما هي الطاقة الشمسية», not «طاقة».
          // A site's own suffix («Cataract surgery - NHS») is not part of the subject.
          const bare = (title: string) => plainTitle(title).replace(/\s+[-–—|:]\s+[^-–—|:]{1,40}$/u, '');
          const pure = ranked.map(entry => ({ entry, own: topicWords(bare(entry.item.title)) }))
            .filter(({ own }) => own.length > 0 && own.every(word => topic.includes(word)));
          const widest = Math.max(0, ...pure.map(({ own }) => own.length));
          const subject = pure.filter(({ own }) => own.length === widest).map(({ entry }) => entry.item);
          // Engine results keep the engine's order, except that the subject's own article comes first: the engine ranks
          // lexically and can list «سفارة أستراليا في واشنطن» before «أستراليا». A results page's links are ranked by title.
          // A disambiguation page lists subjects and answers none.
          // The article opened by the subject's own name (engine) is read first, whatever its title («الساد» for «المياه البيضاء»).
          const byName = unread.filter(item => ownUrls.has(withoutHash(item.url)));
          const fitting = [...new Set(searched ? [...byName, ...subject, ...unread] : [...subject, ...best])].filter(item => !isDisambiguationTitle(item.title)).slice(0, 3);
          // Engine results are read over HTTP, all together, so no browser opens for a question. A page that
          // gives no readable text (built by JavaScript, not HTML, timed out) is opened in the hidden browser instead.
          const reads: (HandsRead | null)[] = searched && io.read && fitting.length
            ? (await io.step(readingLabel(fitting.map(item => item.url))), await Promise.all(fitting.map(item => io.read!(item.url).catch((): HandsRead => ({ kind: 'unreadable' })))))
            : fitting.map(() => null);
          for (const [index, item] of fitting.entries()) {
            tried.add(withoutHash(item.url));
            const read = reads[index];
            if (read?.kind === 'disallowed') continue;
            const explicit = read?.kind === 'page' && !isLiveWebQuestion(step.query) && !isDisambiguationPage(read.page)
              ? explicitFactualEvidence(read.page, step.query) : undefined;
            if (explicit?.kind === 'unanswered') continue;
            if (explicit?.kind === 'answer' && read?.kind === 'page') {
              const { url, title, observedAt } = read.page;
              plan.found = { url, title: tidy(title) || hostOf(url), lines: [explicit.quote], readAt: observedAt };
              break;
            }
            let opened: AgentPage;
            const readPassage = read?.kind === 'page' && !isLiveWebQuestion(step.query)
              ? readFactualPassage(read.page, step.query) : undefined;
            if (read?.kind === 'page' && (readPassage || readableOverHttp(read.page.text))) opened = read.page;
            else {
              await io.step(read ? `فتح ${hostOf(item.url)} في المتصفح` : `قراءة ${hostOf(item.url)}`);
              const current = page;
              const shown = searched && current && withoutHash(current.url) === withoutHash(item.url) ? current : await go({ kind: 'open', text: item.url }, `فتح ${hostOf(item.url)}`);
              if (!shown) return false;
              page = shown;
              opened = shown;
            }
            if (isDisambiguationPage(opened)) continue;
            const passage = read?.kind === 'page' && read.page === opened ? readPassage
              : !isLiveWebQuestion(step.query) ? readFactualPassage(opened, step.query) : undefined;
            const extract = passage ? formatFactualPassage(passage) : undefined;
            if (extract && passage) extracted.set(passage.value.toLowerCase(), {
              url: opened.url, title: tidy(opened.title) || hostOf(opened.url), lines: [extract], readAt: opened.observedAt,
            });
            // The answer line must carry what the question asks for (a number, a name, the question's language), or the next page is tried.
            // For a subject's attribute («كم عدد سكان مصر») the line names the subject, unless the page is the subject's own article:
            // «عدد سكان المدينة … 1500 نسمة» from «القصير (مصر)» is not Egypt's population.
            // A figure is taken only from a page about the subject: a village's or a people's page carries someone else's
            // numbers beside the country's name. A capital or a definition may come from any page whose sentence names the
            // subject («Tokyo is the capital of Japan»), and a live price from any price page.
            const reasonWords = topicWords(reasonSubject(step.query));
            const entity = reasonWords.length ? [] : entityWords(step.query);
            const byOwnName = ownUrls.has(withoutHash(opened.url));
            if (WANTS_NUMBER.test(step.query) && !isLiveWebQuestion(step.query) && !byOwnName && !aboutSubject(opened.title, topic, entity)) continue;
            // An aspect («فوائد الشاي الأخضر») is read only from a page about its subject, not from one that mentions it.
            // A reason («لماذا السماء زرقاء؟») is read the same way, from a page about the thing asked about.
            const aspect = reasonWords.length ? reasonWords : entity.length ? [] : aspectSubject(step.query);
            if (aspect.length && !byOwnName && !isOwnArticle(opened.title, aspect) && titleScore(opened.title, aspect) < aspect.length) continue;
            // The answer line is the best-scored sentence that passes the checks; the others stay as details. When none passes,
            // the next page is tried. (Earlier the details were kept even when the first line failed, so an unchecked sentence
            // became the answer: artifacts/plan-2026-11-22/two-sources-2026-11-22T06-11-30.json, rq015.)
            // A population reads further down its page and is today's figure: «كم عدد سكان فرنسا» ranked a share of Catholics, a 1999
            // census list and «حول 1340، كانت فرنسا يبلغ عدد سكانها حوالي 17 مليون نسمة» above «68.6 مليون نسمة في يناير 2025» (live
            // 2026-11-22 08:15, artifacts/plan-2026-11-22/wrong-answers-fix/). Every other question reads its top three lines as before.
            const people = figureKind(step.query) === 'people';
            // A reason sits further down its page too: the sentence that states the cause is rarely among the first three that share the question's words.
            const ranked = relevantLines(opened, step.query, people || reasonWords.length ? 6 : 3, true);
            // A reason is quoted only from a sentence that states the cause of what was asked (reasonAnswers), not from any sentence with a causal word in it.
            const reasoned = isReasonQuestion(step.query);
            const passing = ranked.flatMap((line, at) => checkAnswerLine(step.query, line).ok && namesEntity(line, entity, ownPage(opened, entity)) && (!reasoned || reasonAnswers(step.query, line)) ? [at] : []);
            // A population is today's count or nothing. When the page states only a forecast («ستكون … 42 مليون نسمة في 2050»,
            // the answer to «كم عدد سكان أستراليا؟» in the 13:50 audit of 2026-11-22) or an old census, the next page is tried.
            const answerAt = people ? passing.find(at => !pastFigure(ranked[at]!) && !projectedFigure(ranked[at]!)) ?? -1 : passing[0] ?? -1;
            const lines = answerAt < 0 ? [] : [ranked[answerAt]!, ...ranked.filter((_, at) => at !== answerAt)].slice(0, 3);
            // A page whose title names none of the question's words answers only with a sentence that carries nearly all of them:
            // «The trio visit Misumi again, this time…» from the film «The Third Murder» shares only «visit» and «time» with «What is
            // the best time to visit Japan?» (live 2026-11-22 06:13 and 07:44). Measured on the 208 sourced answers of the eight full
            // runs of 2026-11-22 and the live judge log: it rejects 4, all wrong pages (that film three times, «CrossCountry» for a
            // train ticket), and none of the right ones («طوكيو» for «ما عاصمة اليابان» carries both of its words). The title is
            // the page's own or the search's for it: some sites give every page a generic title.
            if (lines.length && topic.length >= 2 && titleScore(opened.title, topic) === 0 && titleScore(item.title, topic) === 0
              && topicCoverage(lines[0]!, topic) < Math.max(2, topic.length - 1)) continue;
            if (lines.length) {
              if (extract && passage && lines[0] !== passage.quote) lines.unshift(extract);
              plan.found = { url: opened.url, title: tidy(opened.title) || hostOf(opened.url), lines, readAt: opened.observedAt };
              // A figure is shown with a second page's figure when another fitting page was already read (plan §7.4): the
              // reply says whether the two agree, and shows both when they differ. No extra fetch: the pages came together.
              // The other page must be about the same subject: its title holds every topic word, or is the subject itself.
              if (WANTS_NUMBER.test(step.query) || isLiveWebQuestion(step.query)) {
                for (const [other, otherRead] of reads.entries()) {
                  if (other === index || otherRead?.kind !== 'page' || !readableOverHttp(otherRead.page.text) || isDisambiguationPage(otherRead.page)) continue;
                  const ownArticle = ownPage(otherRead.page, entity);
                  if (!ownArticle && topic.length && titleScore(otherRead.page.title, topic) < topic.length) continue;
                  const [line] = relevantLines(otherRead.page, step.query, 1, true)
                    .filter(candidate => checkAnswerLine(step.query, candidate).ok && namesEntity(candidate, entity, ownArticle));
                  if (line) { plan.found.second = { url: otherRead.page.url, title: tidy(otherRead.page.title) || hostOf(otherRead.page.url), line, agrees: sameFigure(lines[0], line) }; break; }
                }
              }
              break;
            }
          }
          return true;
        };
        if (step.ask) {
          const results = searched ?? resultLinks(page!, 6, step.query).map(item => ({
            title: tidy(item.element.label).slice(0, 90).replace(/[[\]]/g, ''), url: item.url,
          }));
          if (!await readResults(results)) return { kind: 'paused' };
          if (!plan.found && extracted.size === 1) plan.found = extracted.values().next().value;
          if (!plan.found && retrySubject) {
            const own = await retrySubject();
            if (own.length) {
              const retryUrls = new Set(own.map(item => withoutHash(item.url)));
              const combined = [...own, ...results.filter(item => !retryUrls.has(withoutHash(item.url)))];
              if (!await readResults(combined, own)) return { kind: 'paused' };
              if (!plan.found && extracted.size === 1) plan.found = extracted.values().next().value;
            }
          }
        }
        break;
      }
      case 'click': {
        if (step.ordinal && plan.results?.length) {
          // The numbered results came from the HTTP search, so no page needs to be open yet.
          const chosen = plan.results[step.ordinal - 1];
          if (!chosen) return { kind: 'done', status: 'partial', text: `لم أجد النتيجة رقم ${step.ordinal} ضمن نتائج البحث السابقة.` };
          await io.step(`فتح النتيجة ${step.ordinal}: ${chosen.title.slice(0, 60)}`);
          plan.next = index + 1;
          const opened = page && withoutHash(page.url) === withoutHash(chosen.url) ? page : await go({ kind: 'open', text: chosen.url }, `فتح ${hostOf(chosen.url)}`);
          if (!opened) return { kind: 'paused' };
          page = opened;
          break;
        }
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        const element = findTarget(page, step);
        if (!element) {
          const near = (step.ordinal ? resultLinks(page).map(item => item.element) : page.elements.filter(item => item.inViewport && ['link', 'button'].includes(item.role) && item.label.trim()))
            .slice(0, 6).map(item => `«${tidy(item.label).slice(0, 60)}»`).join('، ');
          return { kind: 'done', status: 'partial', text: `لم أجد ${step.ordinal ? `النتيجة رقم ${step.ordinal}` : `«${step.target}»`} في ${hostOf(page.url)}.${near ? ` مما أراه في الصفحة: ${near}.` : ''}` };
        }
        const label = tidy(element.label).slice(0, 80) || step.target;
        const effectRefusal = enforceRefusal && (reviewRefusalControl(label)
          || (element.role === 'link' && element.href ? reviewRefusalDestination(element.href) : null));
        if (effectRefusal) return refused(effectRefusal);
        const reason = sensitiveAction(label);
        if (reason) return { kind: 'done', status: 'partial', text: `«${label}» يبدو ${reason}، فلن أضغطه بنفسي. اضغطه أنت من لوحة المتصفح إن أردت، ثم قل لي «تابع».` };
        await io.step(`الضغط على «${label.slice(0, 50)}»`);
        plan.next = index + 1;
        let reached: AgentPage | null | 'none' | RefusalDecision;
        if (element.role === 'link' && element.href && !/^https?:/i.test(element.href)) return { kind: 'done', status: 'partial', text: `«${label}» ليس رابط صفحة ويب (${element.href.split(':')[0]})، فلم أفتحه.` };
        if (element.role === 'link' && element.href) reached = await go({ kind: 'open', text: realUrl(element.href) }, label);
        else {
          reached = await submit({ kind: 'click', ref: element.ref }, label);
          if (reached === 'none') reached = await go({ kind: 'click', ref: element.ref }, label);
        }
        if (!reached) return { kind: 'paused' };
        if ('code' in reached) return refused(reached);
        page = reached;
        break;
      }
      case 'type': {
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        const field = findField(page, step.field);
        if (!field) return { kind: 'done', status: 'partial', text: `لم أجد ${step.field ? `خانة «${step.field}»` : 'خانة كتابة'} في ${hostOf(page.url)}.` };
        const effectRefusal = enforceRefusal && reviewRefusalField(field.label, step.text);
        if (effectRefusal) return refused(effectRefusal);
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
        if (!page) {
          // The last answer was read over HTTP, so «اقرأ المزيد» opens that page in the browser first.
          if (!plan.found?.url) return { kind: 'done', status: 'blocked', text: NO_PAGE };
          await io.step(`فتح ${hostOf(plan.found.url)}`);
          const opened = await go({ kind: 'open', text: plan.found.url }, `فتح ${hostOf(plan.found.url)}`);
          if (!opened) return { kind: 'paused' };
          page = opened;
        }
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
      case 'ask_page': {
        const context = step.conversationPage;
        if (publicPageRead && context?.expectedUrl && safeResumeUrl(context.expectedUrl) === context.expectedUrl && io.read) {
          const result = await io.read(context.expectedUrl);
          page = result.kind === 'page' ? result.page : null;
        }
        if (context && page && !matchesConversationPage(page, context)) page = null;
        if (context && !page) return { kind: 'done', status: 'blocked', text: plan.lang === 'en'
          ? 'I could not verify the page this question refers to. Send its link to continue.'
          : 'لم أتحقق من الصفحة التي يشير إليها السؤال. أرسل رابطها للمتابعة.' };
        if (!page) return { kind: 'done', status: 'blocked', text: NO_PAGE };
        await io.step(plan.lang === 'en' ? 'Reading the answer on the page' : 'قراءة الجواب من الصفحة');
        if (context) {
          delete plan.found;
          const text = page.text;
          const lines = structuralPageQuestion(step.question, context)
            ? pageAnswer(page, step.question, plan.lang ?? 'ar').parts.flatMap(part => part.quotes).filter(line => text.includes(line)).slice(0, 5)
            : readConversationPageLines(page, step.question);
          if (lines.length) plan.found = { url: page.url, title: page.title, lines, readAt: page.observedAt };
        }
        plan.next = index + 1;
        break;
      }
    }
    if (io.complete) {
      const ranked = step.kind === 'ask_page' && page ? evaluatePageReasoning(page, step.question, plan.lang ?? 'ar') : null;
      const answer = !ranked && step.kind === 'ask_page' && page ? plannedPageAnswer(plan, page, step) : null;
      const missing = step.kind === 'search' && (step.ask ? !plan.found?.lines.length
        : !plan.results?.length && (!page || !resultLinks(page, 1, step.query).length))
        || answer !== null && (!answer.parts.length || answer.missing.length > 0);
      await io.complete(index, missing || ranked?.status === 'blocked' ? 'partial' : 'completed');
    }
  }
  return { kind: 'done', ...describe(plan, page) };
}

/** What a question about an opened page asks for, beside ordinary sentences: its main heading, its links' text, a version. */
const HEADING_ASK = /(?:^|\s)(?:ب|و)?(?:ال)?(?:عنوان|عناوين)(?=\s|$)|\b(?:main heading|heading|headline|title|h1)\b/iu;
/** «the first sentence», «the opening paragraph», «أول جملة», «الجملة الأولى» (folded). */
const FIRST_SENTENCE_ASK = /\b(?:first|opening|1st) (?:sentence|line|paragraph)\b|(?:^|\s)(?:ب|و)?اول (?:جمله|سطر|فقره)(?=\s|$)|(?:^|\s)(?:ب|و)?(?:ال)?(?:جمله|فقره) (?:ال)?اولي(?=\s|$)/iu;
/**
 * The first sentence of the page's own text after its heading: the browser joins a page into one line, so the sentence is
 * found by its end mark. Navigation runs and lines of fewer than four words are not sentences.
 */
function firstSentence(text: string, heading: string | null): string | null {
  let body = text.replace(/\s+/gu, ' ').trim();
  if (heading) {
    const at = body.toLowerCase().indexOf(heading.toLowerCase());
    if (at >= 0 && at <= 300) body = body.slice(at + heading.length).trim();
  }
  for (const candidate of body.split(/(?<=[.!?؟])\s+/u).slice(0, 12)) {
    const sentence = candidate.trim();
    if (sentence.split(/\s+/u).length >= 4 && /[.!?؟]$/u.test(sentence) && sentence.length <= 400) return sentence;
  }
  return null;
}
const LINK_ASK = /(?:^|\s)(?:ب|و)?(?:ال)?(?:رابط|روابط)(?=\s|$)|\blinks?\b/iu;
const VERSION_ASK = /(?:^|\s)(?:ب|و)?(?:ال)?(?:اصدار|اصدارات|نسخه)(?=\s|$)|\b(?:version|versions|release)\b/iu;
/**
 * A version as a page states it: a release word, then within a few words a number («Latest: Python 3.14.0», «version 2.4.1»).
 * The browser joins a page's text into one line (agent-browser.ts `clean`), so versions are found as short spans, not lines.
 */
const VERSION_SPAN = /\b(?:latest|newest|current|stable|release[sd]?|version|download)\b[^.!?؟\n]{0,40}?\b\d+\.\d+(?:\.\d+)?\b|(?:^|\s)(?:أحدث|احدث|آخر|اخر|الإصدار|الاصدار|إصدار|اصدار|النسخة|نسخة)[^.!?؟\n]{0,40}?\d+\.\d+(?:\.\d+)?/giu;
const LATEST = /\b(?:latest|newest|current)\b|(?:أحدث|احدث|آخر|اخر)/iu;

export interface PageAnswerPart { label: string | null; quotes: string[] }
export interface PageAnswer { parts: PageAnswerPart[]; /** What the question asked of the page's structure that the page does not show. */ missing: string[] }

function structuralPageQuestion(question: string, context: ConversationPageRead): boolean {
  if (context.readPublic) return false;
  const asked = fold(question);
  return [HEADING_ASK, FIRST_SENTENCE_ASK, LINK_ASK, VERSION_ASK].some(pattern => pattern.test(asked));
}

function plannedPageAnswer(plan: HandsPlan, page: AgentPage, step: Extract<HandsStep, { kind: 'ask_page' }>): PageAnswer {
  const context = step.conversationPage;
  if (!context) return pageAnswer(page, step.question, plan.lang ?? 'ar');
  if (!matchesConversationPage(page, context)) return { parts: [], missing: [] };
  if (structuralPageQuestion(step.question, context)) return pageAnswer(page, step.question, plan.lang ?? 'ar');
  const lines = plan.found?.url === page.url ? plan.found.lines.filter(line => page.text.includes(line)) : [];
  return { parts: lines.length ? [{ label: null, quotes: lines }] : [], missing: [] };
}
/**
 * The answer to a question about an opened page, in the page's own words: each quote is text found on the page. A heading,
 * links or a version are read from the page's structure, so an Arabic question about an English page still finds them; any
 * other question takes the page's sentences that share its words (relevantLines). What was asked and not found is named.
 */
export function pageAnswer(page: AgentPage, question: string, lang: 'ar' | 'en'): PageAnswer {
  const asked = fold(question);
  const ar = lang === 'ar';
  const text = page.text;
  const lines = text.split('\n').map(line => tidy(line)).filter(Boolean);
  const parts: PageAnswerPart[] = [], missing: string[] = [];
  if (HEADING_ASK.test(asked)) {
    // The main heading is the page's title where the page's own text shows it: a line of its own, or the opening words of the
    // text when the browser joined the page into one line. A title the text never shows is not quoted.
    const plain = plainTitle(page.title);
    const title = fold(plain);
    let heading = title ? lines.find(line => line.length <= 120 && fold(line) === title) : undefined;
    if (!heading && plain.length >= 3) {
      const at = text.toLowerCase().indexOf(plain.toLowerCase());
      if (at >= 0 && at <= 300) heading = text.slice(at, at + plain.length);
    }
    if (heading) parts.push({ label: ar ? 'العنوان الرئيسي:' : 'Main heading:', quotes: [heading] });
    else missing.push(ar ? 'العنوان الرئيسي' : 'the main heading');
  }
  if (FIRST_SENTENCE_ASK.test(asked)) {
    const sentence = firstSentence(text, plainTitle(page.title) || null);
    if (sentence) parts.push({ label: ar ? 'أول جملة في الصفحة:' : 'First sentence on the page:', quotes: [sentence] });
    else missing.push(ar ? 'أول جملة في الصفحة' : 'the first sentence');
  }
  if (LINK_ASK.test(asked)) {
    const labels = [...new Set(page.elements.filter(item => item.role === 'link' && item.href && tidy(item.label)).map(item => tidy(item.label)))]
      .filter(label => text.includes(label)).slice(0, 5);
    if (labels.length) parts.push({ label: ar ? labels.length > 1 ? 'نصوص الروابط:' : 'نص الرابط:' : labels.length > 1 ? 'Link texts:' : 'Link text:', quotes: labels });
    else missing.push(ar ? 'نص الرابط' : 'the link text');
  }
  if (VERSION_ASK.test(asked)) {
    const spans = [...text.matchAll(VERSION_SPAN)].map(match => tidy(match[0]));
    // «Latest: Python 3.14.0» before a list of older releases.
    const quotes = [...new Set([...spans.filter(span => LATEST.test(span)), ...spans])].slice(0, 2);
    if (quotes.length) parts.push({ label: ar ? 'الإصدار المذكور في الصفحة:' : 'The version the page names:', quotes });
    else missing.push(ar ? 'رقم الإصدار' : 'a version number');
  }
  if (!parts.length && !missing.length) {
    const sentences = relevantLines(page, question, 3, true);
    if (sentences.length) parts.push({ label: null, quotes: sentences });
  }
  return { parts, missing };
}


/**
 * A detail worth its own bullet under the answer: not a run cut at both ends («… أستراليا إلى ست ولايات … ولايات ومقاطعات …»),
 * and seven words or more, or four with a number; shorter lines are section headings («الذكاء الاصطناعي القائم على المعرفة.»).
 * The end of a long sentence («… وجعلوا عاصمتهم القاهرة التي أسسها المعز …، والعراق.») stays: the judge may make it the
 * answer (measured on «ما عاصمة مصر؟», 2026-11-23, long-after turn 1).
 */
export function isWholeDetail(line: string): boolean {
  const text = line.trim();
  if (text.startsWith('…') && text.endsWith('…')) return false;
  const words = text.split(/\s+/u).filter(Boolean).length;
  return /[\d٠-٩]/u.test(text) ? words >= 4 : words >= 7;
}

/** The reply is built only from what the pages show: titles, links and quoted sentences. A question answered over HTTP needs no open page. */
export function describe(plan: HandsPlan, page: AgentPage | null): { text: string; status: 'completed' | 'partial' | 'blocked' } {
  const last = plan.steps[plan.steps.length - 1];
  if (last.kind === 'search' && last.ask && plan.results) {
    const list = (items: { title: string; url: string }[]) => items.map((item, index) => `${index + 1}. [${shownTitle(item.title)}](${item.url}) — ${siteName(item.url)}`).join('\n');
    // The frame around the quotes follows the owner's language (plan §7.3); the quotes themselves stay as the page wrote them.
    // A reply asked in another language («in two short Arabic sentences») is said not to be met below, in this same language.
    const reply = last.reply;
    const en = (plan.lang ?? (/[؀-ۿ]/u.test(last.query) ? 'ar' : 'en')) === 'en';
    const note = isMedical(last.query) ? `\n\n${plan.found ? en ? MEDICAL_NOTE_EN : MEDICAL_NOTE : en ? 'For diagnosis and treatment, see a doctor.' : 'للتشخيص والعلاج راجع طبيبًا مختصًا.'}` : '';
    if (plan.found) {
      // Plain layout for anyone: the answer first, then the rest, then a short named source. Sentences stay as the page wrote them.
      // «للمزيد» lists only results whose titles carry the question's topic (one of its words, two when it has three or more):
      // the engine ranks lexically, and the 107 real requests of 2026-11-23 listed «فيصل محمد الطبيقي» under LASIK and «عرب»
      // under the population of Egypt. One word is enough for a short topic, since a plural title («أسعار») does not hold «سعر».
      const topic = topicWords(last.query);
      const others = plan.results.filter(item => withoutHash(item.url) !== withoutHash(plan.found!.url)
        && topic.length > 0 && titleScore(plainTitle(item.title), topic) >= (topic.length >= 3 ? 2 : 1)).slice(0, 3);
      // «in two sentences»: no more of the page's sentences than were asked for.
      const shownLines = reply?.sentences ? plan.found.lines.slice(0, Math.max(1, reply.sentences)) : plan.found.lines;
      // «Return the page title and source link»: the page that was read and found about the question, named first.
      const named = reply?.fields?.some(field => field === 'title' || field === 'link')
        ? `**${en ? 'Page title:' : 'عنوان الصفحة:'}** ${plainTitle(plan.found.title)}\n**${en ? 'Source link:' : 'رابط المصدر:'}** ${plan.found.url}\n\n` : '';
      // A reply asked in a language the page is not written in: the page's own sentences, and that said plainly.
      const quotedArabic = /\p{Script=Arabic}/u.test(shownLines.join(' '));
      const otherLanguage = reply?.lang && (reply.lang === 'ar') !== quotedArabic;
      const asked = reply?.lang === 'ar' ? en ? 'Arabic' : 'العربية' : en ? 'English' : 'الإنجليزية';
      const written = quotedArabic ? en ? 'Arabic' : 'العربية' : en ? 'English' : 'الإنجليزية';
      const languageNote = otherLanguage ? `\n\n${en
        ? `You asked for the answer in ${asked}, but the source I read is written in ${written}, and I do not translate text without a language model; these are the source’s own sentences.`
        : `طلبت الجواب بـ${asked}، لكن المصدر الذي قرأته مكتوب بـ${written}، ولا أترجم النصوص دون نموذج لغوي؛ فهذه جمل المصدر كما كُتبت.`}` : '';
      // «the official IANA documentation»: an encyclopedia article is not the organisation's own page. The search sources have
      // no general web index (no engine without a human check or a paid key), so the official page may not be reachable here.
      const officialAsked = /\bofficial\b|(?:^|\s)(?:ال)?رسمي(?:ة|ه)?(?=\s|$)/iu.test(last.query);
      const notOfficial = officialAsked && /(?:^|\.)wikipedia\.org$/iu.test(URL.parse(plan.found.url)?.hostname ?? '');
      const officialNote = notOfficial ? `\n\n${en
        ? 'This is not the organisation’s own page: the search sources available to me (Wikipedia and documented APIs, with no general web index) returned no page from its own site. Send the official page’s link and I will read it.'
        : 'هذه ليست صفحة الجهة نفسها: مصادر البحث المتاحة لي (ويكيبيديا والواجهات الموثقة، بلا فهرس عام للويب) لم تُرجع صفحة من موقعها. أرسل رابط الصفحة الرسمية وأقرأها لك.'}` : '';
      const [first, ...lines] = shownLines;
      // A detail is a whole sentence: a run cut at both ends («… ست ولايات ومقاطعتين…») or a heading that reads as a sentence
      // («الذكاء الاصطناعي القائم على المعرفة.») is left out (6 of 44 details on the 107 real requests of 2026-11-23).
      const rest = lines.filter(line => isWholeDetail(line));
      const more = rest.length ? `\n\n**${en ? 'More from the same source:' : 'تفاصيل أخرى من نفس المصدر:'}**\n${rest.map(line => `- ${line}`).join('\n')}` : '';
      // The read time names the evidence's age; a page served from the cache keeps the time it was really fetched.
      const readAt = plan.found.readAt && !Number.isNaN(Date.parse(plan.found.readAt)) ? ` · ${en ? 'read' : 'قُرئت'} ${new Date(plan.found.readAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
      const source = `**${en ? 'Source:' : 'المصدر:'}** [${siteName(plan.found.url)} — ${plainTitle(plan.found.title)}](${plan.found.url})${readAt}`;
      const also = others.length ? `\n\n**${en ? 'See also:' : 'للمزيد:'}** ${others.map(item => `[${shownTitle(item.title)}](${item.url})`).join(' · ')}` : '';
      // A second page on the same figure: named when it agrees, quoted when it differs, so a lone number is never presented as settled.
      // With no second page, the reply says so (plan §7.1: «المصدر يقول…، ولم أتحقق منه في مصدر ثانٍ»).
      const wantsFigure = WANTS_NUMBER.test(last.query) || isLiveWebQuestion(last.query);
      const second = plan.found.second ? plan.found.second.agrees
        ? `\n\n**${en ? 'A second source agrees:' : 'مصدر ثانٍ يؤكد:'}** [${siteName(plan.found.second.url)} — ${plainTitle(plan.found.second.title)}](${plan.found.second.url})`
        : `\n\n**${en ? 'A second source differs:' : 'مصدر ثانٍ يختلف:'}** ${en ? `“${plan.found.second.line}”` : `«${plan.found.second.line}»`} — [${siteName(plan.found.second.url)} — ${plainTitle(plan.found.second.title)}](${plan.found.second.url})`
        : wantsFigure && !plan.found.official ? `\n\n${en ? 'I did not check this figure against a second source.' : 'لم أتحقق من هذا الرقم في مصدر ثانٍ.'}` : '';
      // A line composed from a page's data shows the page's own words under it («> node-v26.13.1-… 11-Nov-2026 16:41»).
      const quoted = plan.found.quote ? `\n\n> ${plan.found.quote}` : '';
      return { status: otherLanguage || notOfficial ? 'partial' : 'completed', text: `${named}${first}${quoted}${more}\n\n${source}${second}${also}${note}${languageNote}${officialNote}` };
    }
    if (plan.results.length) return { status: 'partial', text: en
      ? `I found no page that answers “${last.query}” directly, and I will not pass you an answer from a page that is not about your question. These pages came up in the search:\n\n${list(plan.results)}\n\nSay “open result 2”, for example, and I will read it for you.${note}`
      : `لم أجد صفحة تجيب مباشرة عن «${last.query}»، ولن أنقل لك جوابًا من صفحة لا تخص سؤالك. هذه الصفحات التي ظهرت في البحث:\n\n${list(plan.results)}\n\nاكتب «افتح النتيجة 2» مثلًا وأقرأها لك.${note}` };
    return { status: 'partial', text: en ? `I found no page that answers “${last.query}”. Try a shorter question that names the same subject.${note}` : `لم أجد صفحة تجيب عن «${last.query}». جرّب سؤالًا أقصر يذكر الموضوع نفسه.${note}` };
  }
  if (last.kind === 'search' && plan.results?.length) {
    const list = plan.results.slice(0, 8).map((item, index) => `${index + 1}. [${shownTitle(item.title)}](${item.url}) — ${siteName(item.url)}`).join('\n');
    // The list's frame follows the owner's language: an English request got an Arabic frame until 2026-11-23.
    if ((plan.lang ?? (/[؀-ۿ]/u.test(last.query) ? 'ar' : 'en')) === 'en') return { status: 'completed', text: `I searched the web for “${last.query}”. Results related to the subject:\n\n${list}\n\nSay “open result 2”, for example, and I will open it.` };
    return { status: 'completed', text: `بحثت في الويب عن «${last.query}». النتائج المرتبطة بالموضوع:\n\n${list}\n\nقل «افتح النتيجة 2» مثلًا لأفتحها.` };
  }
  if (!page) return { status: 'blocked', text: NO_PAGE };
  if (last.kind === 'ask_page') {
    // The page's own words as quotes under the host's labels: the judge checks every quote against the page (kind «quote»).
    const en = (plan.lang ?? (/[؀-ۿ]/u.test(last.question) ? 'ar' : 'en')) === 'en';
    const ranked = !last.conversationPage || matchesConversationPage(page, last.conversationPage)
      ? evaluatePageReasoning(page, last.question, en ? 'en' : 'ar') : null;
    if (ranked) return { status: ranked.status, text: ranked.text };
    const title = plainTitle(page.title) || hostOf(page.url);
    const name = last.conversationPage ? `[${shownTitle(title)}](${page.url})` : `**${title}** (${hostOf(page.url)})`;
    const { parts, missing } = plannedPageAnswer({ ...plan, lang: en ? 'en' : 'ar' }, page, last);
    if (!parts.length && last.conversationPage) return { status: 'partial', text: en
      ? `I read ${name} and found no matching answer.`
      : `قرأت ${name} ولم أجد جوابًا مطابقًا.` };
    if (!parts.length) return { status: 'partial', text: en
      ? `I opened ${name}, but found nothing on the page that answers “${last.question}”. The page is in the browser panel; say “read the page” and I will show its text.`
      : `فتحت ${name}، ولم أجد في نص الصفحة ما يجيب عن «${last.question}». الصفحة ظاهرة في لوحة المتصفح؛ قل «اقرأ الصفحة» لأعرض نصها.` };
    const body = parts.map(part => `${part.label ? `${part.label}\n` : ''}${part.quotes.map(quote => `> ${quote}`).join('\n>\n')}`).join('\n\n');
    // Part of the question unanswered is said, and the task is partial: never a complete-looking reply that drops what was asked.
    const gap = missing.length ? `\n\n${en ? `Not found in the page's text: ${missing.join(', ')}.` : `لم أجد في نص الصفحة: ${missing.join('، ')}.`}` : '';
    return { status: missing.length ? 'partial' : 'completed', text: `${en ? 'From' : 'من'} ${name}:\n\n${body}${gap}` };
  }
  const where = `**${tidy(page.title) || hostOf(page.url)}** (${hostOf(page.url)})`;
  let lead = `وصلت إلى ${where}:`;
  if (last.kind === 'search') {
    const results = resultLinks(page, 8, queryOf(page.url) ?? last.query);
    if (results.length && queryOf(page.url)) {
      const list = results.map((item, index) => `${index + 1}. [${shownLabel(item.element.label)}](${item.url}) — ${hostOf(item.url)}`).join('\n');
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
    const list = shown.map(item => `${item.number}. [${shownLabel(item.element.label, 110)}](${item.url})`).join('\n');
    const others = NEWS_SOURCES.map(([, source]) => source.name).filter(name => name !== last.source.name).slice(0, 2).map(name => `«أخبار ${name}»`).join(' أو ');
    return { status: 'completed', text: `${last.topic ? `عناوين عن «${last.topic}»` : 'أهم العناوين'} الآن على الصفحة الرئيسية لـ${where}، كما تظهر هناك دون أن أعيد صياغتها:\n\n${list}\n\nقل «اقرأ الخبر ${shown[Math.min(1, shown.length - 1)].number}» مثلًا لأفتحه وأقرأه، أو ${others} لمصدر آخر.` };
  }
  if (last.kind === 'type') return { status: 'completed', text: `كتبت «${last.text}» في ${where}. قل «اضغط على …» لأتابع.` };
  const isRead = last.kind === 'read';
  // The frame of a reading follows the owner's language («open X and show me its content» was framed in Arabic until 2026-11-23);
  // the page's own sentences stay as the page wrote them. A search's frame above stays as it was.
  const en = plan.lang === 'en' && last.kind !== 'search';
  if (isRead) lead = en ? `From ${where}:` : `من ${where}:`;
  else if (en) lead = `I reached ${where}:`;
  const from = isRead && plan.read?.url === page.url ? plan.read.start : 0;
  const part = excerpt(page, from, isRead ? READ_WINDOW : 500);
  const quote = part.lines.length ? `\n\n${part.lines.map(line => `> ${line}`).join('\n>\n')}` : en ? '\n\nI found no readable text in the visible part of the page.' : '\n\nلم أجد نصًا مقروءًا في الجزء الظاهر من الصفحة.';
  const tail = isRead ? (part.more ? en ? '\n\nSay “read more” and I will go on.' : '\n\nقل «اقرأ المزيد» لأكمل.' : '')
    : en ? '\n\nSay “read the page” to read more, or “click …”.' : '\n\nقل «اقرأ الصفحة» لأقرأ أكثر، أو «اضغط على …».';
  return { status: 'completed', text: `${lead}${quote}${tail}` };
}
