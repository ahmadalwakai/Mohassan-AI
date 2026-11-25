import { SafeNetwork, safeResumeUrl } from '@mohassan/browser';
import { matchText, normalizeRequest } from '../assistant/mind/normalize.js';
import { splitReplyDirective } from '../assistant/reply-directive.js';
import { assessRequestScope, isEntireLiteralRequest, maskRequestLiteralData, parseUserRequestConstraints, requestCapabilityAllowed } from '../assistant/request-scope.js';
import { externalHistory, interactiveOnly, noHistory } from '../assistant/response-policy-signals.js';

export interface MonitorBlock {
  url: string;
  reason: 'unreachable' | 'not-published';
  runId?: string;
}

export interface MonitorNeed {
  kind: 'explicit' | 'implicit' | 'agent-initiated';
  language: 'ar' | 'en';
  text: string;
  sourceText?: string;
  sourceUrl?: string;
  blocked?: MonitorBlock;
  actionRequested: boolean;
}

const URL = /https?:\/\/[^\s<>"'`«»“”]+/iu;
const WATCH = /^(?:monitor|watch|track|keep (?:an eye on|watching|checking|tracking)|check|راقب|تابع|خل(?:ك|يك) (?:تراقب|تتابع)|استمر في (?:متابعه|مراقبه|فحص)|تحقق من|افحص)(?![\p{L}\p{N}])/u;
const CHECK_ONCE = /^(?:check|افحص|تحقق من)(?![\p{L}\p{N}])/u;
const ALERT = /^(?:(?:notify|alert|ping|tell) (?:me|us)|let (?:me|us) know|نبهني|نبهن[اي]|اخبرني|خبرني|بلغني|قول لي|قل لي|اعلمني|اشعرني)(?!\p{L})/u;
const WAIT = /^(?:i(?: am|'m| have been|'ve been) |we (?:are|have been|'ve been) )?(?:still )?(?:waiting (?:for|until)|wait(?:ing)? to see (?:if|whether))\b|^(?:انا |نحن )?(?:ما زلت |لسه )?(?:انتظر|بانتظار|في انتظار|منتظر(?:ه)?|ناطر(?:ه)?|مستني(?:ه)?)(?!\p{L})/u;
const STATUS_QUESTION = /^(?:check (?:if|whether)|any updates? (?:on|for)|(?:has|have|is|are|did|does|what(?: is|'s)|how much is)\b|(?:هل|كم|ما هو|ماهي|ما هي|في تحديث|اي تحديث)(?!\p{L}))/u;
const FUTURE = /\b(?:if|when|once|as soon as|whenever|until|every|for (?:the next )?\d+|periodically|daily|hourly)\b|(?<!\p{L})(?:و?(?:اذا|لما|عندما|حينما|متي|عند|حتي|بمجرد ما|بمجرد ان|لمده|كل|يوميا|دوريا))(?!\p{L})/u;
const STATE = /\b(?:open(?:s|ed|ing)?|go(?:es|ing)? live|available|availability|sold out|on sale|in stock|restock(?:ed|s)?|appear(?:s|ed)?|disappear(?:s|ed)?|publish(?:es|ed|ing)?|post(?:s|ed)?|release(?:s|d)?|change(?:s|d)?|drop(?:s|ped)?|fall(?:s|en)?|rise(?:s|n)?|exceed(?:s|ed)?|hit(?:s)?|complete(?:s|d)?|finish(?:es|ed)?|new|below|above|reachable|unreachable)\b|(?<!\p{L})(?:يفتح(?:ون|وا)?|تفتح|فتح(?:وا|ت)?|مفتوح(?:ه)?|متاح(?:ه)?|يتاح|تتوفر|يتوفر|توفر|تنزل|ينزل|نزلت?|ينخفض|تنخفض|يرتفع|ترتفع|تحت|فوق|يتغير|تتغير|تغير|يظهر|تظهر|يختفي|تختفي|نشر|منشور|ينشر|يصدر|تصدر|جديد(?:ه)?|يكتمل|ينتهي|تشتغل|يعمل)(?!\p{L})/u;
const PRICE = /\b(?:prices?|stock status|availability|in stock|out of stock)\b|(?<!\p{L})(?:ال)?(?:سعر|اسعار|مخزون|توفر)(?!\p{L})/u;
export const CURRENCY_TOPIC = /\b(?:exchange rates?|forex|fx rates?|rate|dollars?|euros?|sterling|yen|usd|sar|jpy|eur|gbp|aed|egp|cad)\b|(?<!\p{L})(?:سعر الصرف|الدولار|دولار|اليورو|يورو|الاسترليني|ريال|درهم|الين)(?!\p{L})/u;
export const WEATHER_TOPIC = /\b(?:weather|temperatures?|rain(?:fall)?|precipitation|wind(?: speed)?)\b|(?<!\p{L})(?:الطقس|الجو|حراره|الحراره|درجه الحراره|المطر|امطار|الامطار|هطول|الرياح|رياح)(?!\p{L})/u;
const PUBLIC_TOPIC = /\b(?:public|page|website|site|link|url|ticket(?:s|ing)?|registration|enrol(?:l)?ment|application portal|listing[s]?|search results?|publication|release date|product|item|background (?:run|job|task)|run id)\b|(?<!\p{L})(?:ال)?(?:صفحه|موقع|رابط|عام|تذاكر|تذكره|تسجيل|التحاق|نتائج البحث|نتيجه بحث|اعلان(?:ات)?|منتج|عنصر|مهمه في الخلفيه|تشغيل في الخلفيه|معرف التشغيل)(?!\p{L})/u;
const SOURCE_REFERENCE = /\b(?:this|that|the same) (?:page|link|website|site|listing|item|product)\b|(?<!\p{L})(?:هذا (?:الرابط|الموقع|المنتج)|هذه (?:الصفحه|القائمه)|نفس (?:الرابط|الموقع|الصفحه))(?!\p{L})/u;
const SINGLE_CHECK = /\b(?:every|hourly|daily|periodically|until|for (?:the next )?\d+|(?:and|then) (?:(?:notify|tell|alert) (?:me|us)|let (?:me|us) know))\b|(?<!\p{L})(?:كل|يوميا|دوريا|حتي|لمده|و(?:نبهني|اخبرني|بلغني|قل لي))(?!\p{L})/u;
const WATCH_MEDIA = /^(?:watch|تابع|راقب)\s+(?:(?:this|that|the|a)\s+)?(?:video|film|movie|song|show|tutorial|recording|مقطع|فيديو|الفيديو|فيلم|الفيلم|الاغنيه|اغنيه)(?!\p{L})/u;
const PRIVATE_TOPIC = /\b(?:heart rate|blood pressure|cpu usage|private (?:page|site|listing|account|messages?|feed)|(?:my|our) (?:screen|computer|desktop|email|messages?|account|medical records?)|logged[ -]in|behind (?:a )?login)\b|(?<!\p{L})(?:حسابي|حسابنا|بريدي|رسائلي|شاشتي|جهازي|نبض القلب|معدل نبضي|ضغط دمي|الصفحه الخاصه|الموقع الخاص|خلف تسجيل الدخول)(?!\p{L})/u;
const NEGATED = /(?:^|[.!?؛;،,]\s*|\band\s+)(?:do not|don't|don’t|never|stop|avoid|لا|بلاش|بدون|توقف عن)\s*(?:monitor(?:ing)?|watch(?:ing)?|track(?:ing)?|notify(?:ing)?|alert(?:ing)?|ت?راقب|ت?تابع|ت?نبه(?:ني)?|ت?خبر(?:ني)?|المراقبه|المتابعه)(?!\p{L})/u;
const ACTION = /(?:^|[,،;؛]\s*|(?<!\p{L})(?:then|and|once|when|if|ثم|و?بعدها|وعندها|ساعتها)\s+|(?<!\p{L})[وف](?=احجز|اشتر|اشتري|ارسل|سجل|قدم|ادفع))(?:buy|purchase|book|reserve|send|email|submit|pay|place (?:an|the) order|sign (?:me|us) up|register (?:me|us)|احجز|اشتر(?:ي)?|ارسل|ابعث|قدم|سجل(?:ني)?|ادفع|اطلب)(?!\p{L})(?!\s+(?:(?:me|us)\s+(?:a |an |the )?(?:notification|alert|update)\b|(?:لي|لنا)\s+(?:تنبيه|اشعار|تحديث)))/u;
const ACTION_LEAD = /^(?:buy|purchase|book|reserve|send|email|submit|pay|place (?:an|the) order|sign (?:me|us) up|register (?:me|us)|احجز|اشتر(?:ي)?|ارسل|ابعث|قدم|سجل(?:ني)?|ادفع|اطلب)(?!\p{L})/u;
const COURTESY = /^(?:(?:please|kindly|can you|could you|would you|i (?:want|need) you to|من فضلك|لو سمحت|ممكن|اريدك ان)[,،\s]+)+/u;
const CADENCE_LEAD = /^(?:for the next|over the next|for|لمده|خلال) [^,،]{1,48}[,،]\s*/u;
const LIKELY = /\b(?:monitor|watch|track|check|keep|notify|alert|ping|tell|let|waiting|buy|purchase|book|reserve|submit|send|email|pay|sign|register|has|have|is|are|did|does|what|how|updates?)\b|راقب|تابع|تحقق|افحص|نبه|اخبر|خبرني|بلغ|انتظر|انتظار|منتظر|ناطر|مستني|قل لي|قول لي|اعلمني|اشعرني|هل|كم|تحديث|ما هو|ما هي|ماهي|احجز|اشتر|ارسل|قدم|سجل|ادفع/u;
const PAIR_ANSWER = /^[a-z]{3}\s*(?:[/→]|to|against|مقابل)\s*[a-z]{3}[.!?؟]?$/u;
const PAIR_REFERENCE = /\b([a-z]{3})\s*[/→]\s*([a-z]{3})\b/u;
const SOURCE_QUESTION = /\b(?:specify the (?:currency pair|public link)|give me (?:the|a) (?:public|https) (?:link|url))\b|حدد (?:العملتين|الرابط العام)/u;

const publicNetwork = new SafeNetwork();
const currencyCodes = new Set(Intl.supportedValuesOf('currency'));

export function monitorCurrencyPair(text: string) {
  const pair = PAIR_REFERENCE.exec(text);
  return pair && currencyCodes.has(pair[1].toUpperCase()) && currencyCodes.has(pair[2].toUpperCase()) ? pair[0] : undefined;
}

export function monitorPageUrl(text: string): string | undefined {
  const address = URL.exec(text)?.[0].replace(/[.,،;؛!?؟)\]]+$/u, '');
  if (!address) return undefined;
  try {
    return safeResumeUrl(publicNetwork.validate(address).href) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Match labels and syntax without altering the URL or literals saved in a spec. */
export function monitorMatchText(text: string): string {
  return matchText(text).replace(/[’‘]/gu, "'").replace(/٫/gu, '.').replace(/٬/gu, ',').replace(/\s+/gu, ' ').trim();
}

function outerMatch(text: string): string {
  return monitorMatchText(maskRequestLiteralData(text).replace(URL, ' ')).replace(COURTESY, '').replace(CADENCE_LEAD, '');
}

const MACHINE_LITERAL = /\b(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:z|[+-]\d{2}:\d{2}))?)\b/giu;

export function safeMonitorRequest(original: string): string | null {
  const constraints = parseUserRequestConstraints(original);
  if (constraints?.standalone || constraints?.ambiguous || !requestCapabilityAllowed(constraints, 'public_search')
    || !requestCapabilityAllowed(constraints, 'browser_navigation') || isEntireLiteralRequest(original)) return null;
  const text = constraints?.safeActionText ?? original;
  const scope = assessRequestScope(text);
  // The normal scope policy treats hyphenated numeric data as possible arithmetic.
  const scoped = scope.reasons.includes('numeric_operation') ? assessRequestScope(text.replace(MACHINE_LITERAL, ' reference ')) : scope;
  return scoped.scope === 'private' || scoped.reasons.includes('credential_material') || PRIVATE_TOPIC.test(outerMatch(text)) ? null : text;
}

function statusKey(text: string): string | null {
  if (!STATUS_QUESTION.test(text) || !(STATE.test(text) || PRICE.test(text) || CURRENCY_TOPIC.test(text) || WEATHER_TOPIC.test(text))) return null;
  return text.replace(/\b(?:already|still|yet|right now|now|today|currently|again)\b|(?<!\p{L})(?:بعد|لسه|حاليا|الان|اليوم|مره اخري)(?!\p{L})/gu, ' ')
    .replace(/[\s.!?؟،,]+$/u, '').replace(/\s+(?:at|on|in|في|علي)$/u, '').replace(/\s+/gu, ' ').trim();
}

function publicTopic(text: string): boolean {
  return PUBLIC_TOPIC.test(text) || CURRENCY_TOPIC.test(text) || WEATHER_TOPIC.test(text) || PRICE.test(text) || Boolean(monitorCurrencyPair(text));
}

/** Keep normal turns off the database history path. No network or spec generation is needed here. */
export function monitorHistoryMayMatter(text: string): boolean {
  if (!text.trim() || text.length > 8000) return false;
  const body = monitorMatchText(text);
  return PAIR_ANSWER.test(body) || /^https?:\/\/\S+$/u.test(body) || LIKELY.test(body) && (URL.test(text) || publicTopic(body));
}

function clarifiedSource(text: string, history: readonly { role: string; text: string }[]): MonitorNeed | null {
  const address = /^https?:\/\/\S+$/iu.test(text.trim()) && monitorPageUrl(text);
  const pair = PAIR_ANSWER.test(monitorMatchText(text));
  if (!address && !pair) return null;
  const previous = history.at(-1);
  const request = history.at(-2);
  if (previous?.role !== 'assistant' || request?.role !== 'user' || !SOURCE_QUESTION.test(monitorMatchText(previous.text))) return null;
  const need = detectMonitorNeed({ text: request.text });
  if (!need || need.sourceUrl || pair && !CURRENCY_TOPIC.test(monitorMatchText(need.text))) return null;
  return { ...need, ...(address ? { sourceUrl: address } : { sourceText: text }) };
}

/** Only earlier user turns can supply a public source. A blocked source is separate host evidence. */
export function detectMonitorNeed(input: {
  text: string;
  history?: readonly { role: string; text: string }[];
  blocked?: MonitorBlock;
  language?: MonitorNeed['language'];
}): MonitorNeed | null {
  if (!input.text.trim() || input.text.length > 8000) return null;
  if (!input.blocked && !monitorHistoryMayMatter(input.text)) return null;
  const clarification = input.history && clarifiedSource(input.text, input.history);
  if (clarification) return clarification;
  const framed = splitReplyDirective(input.text);
  const text = framed.body;
  const body = outerMatch(text);
  if (NEGATED.test(body) || interactiveOnly.test(body) || WATCH_MEDIA.test(body)) return null;

  const url = monitorPageUrl(text);
  if (URL.test(text) && !url) return null;
  const hasTopic = Boolean(url) || publicTopic(body);
  const future = FUTURE.test(body);
  const state = STATE.test(body);
  const actionRequested = ACTION.test(body);
  const explicit = hasTopic && (WATCH.test(body) && (!CHECK_ONCE.test(body) || SINGLE_CHECK.test(body))
    || ALERT.test(body) && future && state || ACTION_LEAD.test(body) && future && state);
  const implicit = hasTopic && WAIT.test(body) && state;
  const status = hasTopic && input.history?.length ? statusKey(body) : null;
  if (!explicit && !implicit && !status && !input.blocked) return null;
  const validatedText = safeMonitorRequest(text);
  if (!validatedText) return null;

  const prior = noHistory.test(body) || externalHistory.test(body) ? [] : (input.history ?? []).filter(turn => turn.role === 'user').slice(-8).reverse();
  const repeated = status ? prior.find(turn => statusKey(outerMatch(turn.text)) === status && (!url || !monitorPageUrl(turn.text) || monitorPageUrl(turn.text) === url)) : undefined;
  const blockedUrl = input.blocked && monitorPageUrl(input.blocked.url);
  const kind = explicit ? 'explicit' : implicit || repeated ? 'implicit' : blockedUrl ? 'agent-initiated' : null;
  if (!kind) return null;
  const latest = prior[0];
  const earlier = repeated ?? (latest && (SOURCE_REFERENCE.test(body) && monitorPageUrl(latest.text)
    || CURRENCY_TOPIC.test(body) && CURRENCY_TOPIC.test(outerMatch(latest.text))
    || WEATHER_TOPIC.test(body) && WEATHER_TOPIC.test(outerMatch(latest.text))) ? latest : undefined);
  const sourceText = earlier && safeMonitorRequest(earlier.text) || undefined;
  const sourceUrl = url ?? (sourceText && monitorPageUrl(sourceText)) ?? blockedUrl;
  return {
    kind,
    language: input.language ?? framed.directive?.lang ?? normalizeRequest(text).lang,
    text: validatedText,
    ...(sourceText && { sourceText }),
    ...(sourceUrl && { sourceUrl }),
    ...(kind === 'agent-initiated' && input.blocked && { blocked: input.blocked }),
    actionRequested,
  };
}
