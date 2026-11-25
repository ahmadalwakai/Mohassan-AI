import { maskRequestLiteralData } from '../../assistant/request-scope.js';
import { splitReplyDirective } from '../../assistant/reply-directive.js';
import { parseReminderTime } from '../../reminders/time.js';
import { CURRENCY_TOPIC, monitorMatchText, monitorPageUrl, WEATHER_TOPIC } from '../detection.js';

export const MAX_MONITOR_TURN_CHARS = 8_000; // Limit used by detectMonitorNeed.

const URL = /https?:\/\/[^\s<>"'`«»“”]+/giu;
const COURTESY = /^(?:(?:please|kindly|okay|ok|well|can you|could you|would you|من فضلك|لو سمحت|طيب|حسنا|تمام|ممكن)[,،\s]+)+/u;
const ACKNOWLEDGEMENT = /^(?:ok(?:ay)?|i see|understood|thanks|thank you|حسنا|تمام|طيب|فهمت|شكرا)[.!؟?،\s]*$/u;
const QUESTION = /^(?:and\s+)?(?:is|are|has|have|did|does|when|any updates?|check (?:if|whether)|how much|what(?:'s| is)|و?(?:هل|متي|امتي|كم|ما هو|ما هي|اي تحديث|في تحديث))(?=$|[^\p{L}])/u;
const ONE_OFF = /\b(?:right now|currently|now|today|at the moment|this time)\b|(?<!\p{L})(?:حاليا|الان|اليوم|دلوقتي|هسه|الحين)(?!\p{L})/u;
const CONTINUATION = /\b(?:yet|still|again|any updates?|any news)\b|(?<!\p{L})(?:بعد|لسه|ما زال|ما زالت|من جديد|اي تحديث|في تحديث)(?!\p{L})/u;
const WAITING = /^(?:(?:i(?: am|'m|'ve been| have been)|we(?: are|'re|'ve been| have been)) (?:still )?waiting(?: for| until| to see)?|(?:still )?waiting (?:for|until)|(?:انا |نحن )?(?:ما زلت |لسه )?(?:انتظر|بانتظار|في انتظار|منتظر(?:ه)?|ناطر(?:ه)?|مستني(?:ه)?))(?=$|[^\p{L}])/u;
const REFERS_BACK = /\b(?:it|they|that|this|same|there)\b|(?<!\p{L})(?:هذا|هذه|ذاك|ذلك|تلك|نفس|انه|انها|انهم|يفتحوه[ا]?|يفتحونها|تفتح|يفتحوا)(?!\p{L})/u;
const FUTURE_CHANGE = /\b(?:open(?:s|ing)?|reopen(?:s|ing)?|go(?:es)? (?:live|online|on sale)|comes? back|loads?|available|in stock|restock(?:s|ed)?|publish(?:es|ed)?|release(?:s|d)?|appear(?:s|ed)?|change(?:s|d)?|drop(?:s|ped)?|fall(?:s|en)?|rise(?:s|n)?|exceed(?:s|ed)?|below|above|complete(?:s|d)?|finish(?:es|ed)?)\b|(?<!\p{L})(?:يفتح(?:وا|ون|وه[ا]?|ونها)?|تفتح|فتح|مفتوح(?:ه)?|متاح(?:ه)?|تتوفر|يتوفر|توفر|نزول|ينخفض|تنخفض|ينزل|تنزل|يرتفع|ترتفع|تحت|فوق|يتغير|تتغير|يظهر|تظهر|اختفاء|يختفي|تختفي|ينشر|يصدر|منشور|يتاح|يكتمل|ينتهي|تشتغل|يشتغل|تعمل|يعمل)(?!\p{L})/u;
const TIME = /\b(?:today|tonight|tomorrow|yesterday|daily|weekly|monthly|next (?:week|month|year)|(?:in|after|every) (?:\d+|an?|one|two|three) (?:seconds?|minutes?|hours?|days?|weeks?|months?)|at \d{1,2}(?::\d{2})?(?:\s?[ap]m)?|\d{4}-\d{2}-\d{2})\b|(?<!\p{L})(?:اليوم|غدا?|بكره?|الليله|امس|يوميا|اسبوعيا|شهريا|(?:بعد|كل) (?:\d+\s+)?(?:ثانيه|ثوان|دقيقه|دقائق|ساعه|ساعتين|ساعات|يوم|ايام|اسبوع|اسابيع)|(?:الساعه|ساعه) \d{1,2}(?::\d{2})?)(?![\p{L}\p{N}])/gu;

// Use the existing reminder time parser for scheduling expressions. These leads
// distinguish requests to schedule an alert from queries that merely mention a date.
const NOTIFICATION = /^(?:(?:remind|notify|alert|ping|tell) (?:me|us)|let (?:me|us) know|نبهني|نبهن[اي]|ذكرني|اخبرني|خبرني|بلغني|قول لي|قل لي|اعلمني|اشعرني)(?=$|[^\p{L}])\s*/u;
const SCHEDULE_NOTIFICATION = /^(?:remind|notify|alert|ping|نبهني|نبهن[اي]|ذكرني|بلغني|اشعرني)(?=$|[^\p{L}])/u;
const TIME_REQUEST = /^(?:(?:set|create|schedule|start|cancel|stop|delete|snooze|change|show|list) (?:me )?(?:(?:a|an|the|my) )?(?:alarms?|timers?|reminders?|calendar (?:event|appointment))|(?:add|schedule|cancel|reschedule|delete|move) (?:a |an |the |my )?(?:meeting|appointment|event)(?: (?:for|on|to|at|in|tomorrow|today|next)|$)|wake (?:me|us) up|اضبط (?:لي )?(?:ال)?(?:منبه|مؤقت|تذكير)|(?:اضف|جدول|الغ|احذف|اوقف|غير|عدل|اعرض) (?:لي )?(?:ال)?(?:منبه|مؤقت|تذكير|تذكيراتي|موعد|مواعيد)|تذكيري|ايقظني)(?=$|[^\p{L}])/u;
const CONDITION = /^(?:(?:if|when|once|whenever|as soon as|every time)\b|(?:اذا|لما|عندما|حينما|بمجرد(?: ما| ان)?|كلما)(?!\p{L}))\s+/u;
const REFERENCE_CONDITION = /^(?:(?:it|they|that(?: page| site| link)?|this (?:page|site|link)) (?:opens?|reopens?|goes? live|loads?|becomes? (?:available|reachable)|comes? back online|is (?:available|published|released))|(?:ان |ما )?(?:يفتح(?:وا|ون|وه[ا]?|ونها)?|تفتح|يشتغل|تشتغل|تتوفر|يتوفر|تنشر|ينشر|يصدر|تصدر)(?: (?:الموقع|الصفحه|الرابط))?)[.!?؟\s]*$/u;

const DECLINE = /^(?:no(?:[, ]+thanks| please)?|not now|no need|don't (?:monitor|watch|track)(?: (?:it|this|that|the page))?|do not (?:monitor|watch|track)(?: (?:it|this|that|the page))?|لا(?:[، ]+شكرا)?|لا داعي|لا اريد|ليس الان|لا (?:تراقب|تتابع)(?: (?:هذا|الرابط|الصفحه))?)[.!?؟\s]*$/u;
const ACCEPT = /^(?:yes(?:[, ]+please)?|go ahead|please do|ok(?:ay)?|نعم(?:[، ]+من فضلك)?|ايه|موافق(?:ه)?|تمام)[.!?؟\s]*$/u;
const ASKS_TO_OFFER = /(?:\b(?:would you like me to|do you want me to|should i) (?:watch|monitor|track)\b|(?:اتريد|هل تريد|تحب) ان (?:اراقب|اتابع))/u;

export type StatusTopic = 'registration' | 'tickets' | 'availability' | 'publication' | 'page' | 'currency' | 'weather';
export type PendingStatus = Exclude<StatusTopic, 'currency' | 'weather'>;

// The statuses used by the v2 offer rules and page spec. The extra page and
// publication statuses are already supported by the monitor spec.
const TOPICS = [
  ['registration', /\b(?:registration|enrol+l?ment|sign[ -]?ups?|applications?)\b|(?<!\p{L})(?:ال)?(?:تسجيل|التحاق|تقديم)(?!\p{L})/u],
  ['tickets', /\btickets?\b|(?<!\p{L})(?:ال)?(?:تذاكر|تذكره)(?!\p{L})/u],
  ['publication', /\b(?:publication|unpublished|release date|publish(?:es|ed|ing)?)\b|(?<!\p{L})(?:ال)?(?:نشر|اصدار|منشور(?:ه)?)(?!\p{L})/u],
  ['availability', /\b(?:in stock|out of stock|sold out|restock(?:ed)?|product|availability)\b|(?<!\p{L})(?:ال)?(?:مخزون|منتج|نفدت? الكميه)(?!\p{L})/u],
  ['currency', CURRENCY_TOPIC],
  ['weather', WEATHER_TOPIC],
  ['page', /\b(?:page|website|site|link|url)\b|(?<!\p{L})(?:ال)?(?:صفحه|موقع|رابط)(?!\p{L})/u],
] as const satisfies ReadonlyArray<readonly [StatusTopic, RegExp]>;

const UNCONFIRMED = /\b(?:might|may|could|possibly|probably|if|unless|reportedly|unconfirmed|used to|no longer|unable|cannot|can't|couldn't|didn't (?:verify|confirm))\b|(?<!\p{L})(?:ربما|يحتمل|قد يكون|قد تكون|اذا كان|لم يتاكد|لم اتمكن|لم اتحقق|لا استطيع|لا يمكنني|لم يعد|لم تعد)(?!\p{L})/u;
const PENDING = [
  ['registration', /\b(?:registration|enrol+l?ment|sign[ -]?ups?|applications?) (?:is |are )?(?:still |currently )?(?:closed|not (?:yet )?open|coming soon|(?:will )?opens? (?:on|at|in|soon))\b|(?:التسجيل|التقديم|الالتحاق) (?:ما زال |مازال )?(?:مغلق|غير مفتوح|قريبا|(?:سيفتح|يفتح|يبدا|سيبدا) (?:في|يوم|قريبا))/u],
  ['tickets', /\btickets? (?:are )?(?:currently |still )?(?:sold out|unavailable|coming soon|go on sale (?:on|at|in|soon))\b|(?:نفدت? التذاكر|التذاكر (?:نفدت?|غير متوفره|غير متاحه|قريبا))/u],
  ['availability', /\b(?:sold out|out of stock|available soon)\b|(?:نفدت? (?:ال)?كميه|(?:المنتج|العنصر) غير (?:متوفر|متاح))/u],
  ['publication', /\b(?:unpublished|not (?:yet |been )?published|publication (?:is )?pending)\b|(?<!\p{L})(?:لم ينشر|لم تنشر|غير منشور|النشر معلق)(?!\p{L})/u],
  ['page', /\b(?:page|website|site|link) (?:is |was )?(?:still |currently )?(?:unreachable|down|offline|not (?:online|loading|reachable)|won't load)\b|(?:الصفحه|الموقع|الرابط) (?:غير متاح|غير قابل للوصول|لا (?:يفتح|تفتح|يعمل|تعمل)|متعطل)/u],
] as const satisfies ReadonlyArray<readonly [PendingStatus, RegExp]>;
const RESOLVED = [
  ['registration', /\b(?:registration|enrol+l?ment|sign[ -]?ups?|applications?) (?:is |are )?(?:now )?open\b|(?:التسجيل|التقديم|الالتحاق) (?:مفتوح|متاح|فتح)|(?:فتح|افتح) (?:باب )?(?:التسجيل|التقديم)/u],
  ['tickets', /\btickets? (?:are )?(?:now )?(?:available|on sale)\b|(?:التذاكر (?:متوفره|متاحه)|توفر التذاكر)/u],
  ['availability', /\b(?:in stock|back in stock)\b|(?:المنتج|العنصر) (?:متوفر|متاح)/u],
  ['publication', /\b(?:now published|has been published)\b|(?:تم النشر|نشر بالفعل)/u],
  ['page', /\b(?:page|website|site|link) (?:is )?(?:now )?(?:back online|available|reachable|loading)\b|(?:الصفحه|الموقع|الرابط) (?:متاح|يعمل|تعمل|يفتح|تفتح)/u],
] as const satisfies ReadonlyArray<readonly [PendingStatus, RegExp]>;

export interface MonitorContextTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  normalized: string;
  links: readonly string[];
  timeExpressions: readonly string[];
  topic: StatusTopic | null;
  pending: PendingStatus | null;
  resolved: PendingStatus | null;
  statusQuestion: boolean;
  oneOff: boolean;
  continuing: boolean;
  waiting: boolean;
  refersBack: boolean;
}

export function monitorContextTurn(role: MonitorContextTurn['role'], text: string, id: string): MonitorContextTurn {
  const action = splitReplyDirective(text).body;
  const scopeText = maskRequestLiteralData(action).replace(URL, url => ` ${url.match(/[.!?؟]+$/u)?.[0] ?? ''}`);
  const normalized = role === 'user' ? monitorMatchText(scopeText).replace(COURTESY, '') : monitorMatchText(scopeText);
  const links = [...new Set([...action.matchAll(URL)].slice(0, 8).flatMap(match => monitorPageUrl(match[0]) ?? []))];
  const timeExpressions = [...normalized.matchAll(TIME)].slice(0, 8).map(match => match[0]);
  const topic = TOPICS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? (links.length ? 'page' : null);
  const statusQuestion = role === 'user' && QUESTION.test(normalized) && (Boolean(topic) || CONTINUATION.test(normalized) || REFERS_BACK.test(normalized));
  const statements = UNCONFIRMED.test(normalized) ? [] : (scopeText.match(/[^.!?؟\n؛;]+[.!?؟]?/gu) ?? []).slice(0, 32)
    .map(monitorMatchText).filter(part => !/[?؟]$/u.test(part) && !QUESTION.test(part));
  const pending = statements.map(part => PENDING.find(([, pattern]) => pattern.test(part))?.[0]).find(Boolean) ?? null;
  const resolved = statements.map(part => RESOLVED.find(([, pattern]) => pattern.test(part))?.[0]).find(Boolean) ?? null;
  return { id, role, text, normalized, links, timeExpressions, topic, pending, resolved, statusQuestion,
    oneOff: ONE_OFF.test(normalized), continuing: CONTINUATION.test(normalized),
    waiting: role === 'user' && WAITING.test(normalized) && FUTURE_CHANGE.test(normalized), refersBack: REFERS_BACK.test(normalized) };
}

export function noticeTrigger(turn: MonitorContextTurn, now: Date) {
  const notice = NOTIFICATION.exec(turn.normalized);
  const body = notice ? turn.normalized.slice(notice[0].length) : '';
  const condition = CONDITION.exec(body);
  const predicate = condition ? body.slice(condition[0].length) : '';
  const conditionNotification = Boolean(predicate && FUTURE_CHANGE.test(predicate));
  const referenceCondition = conditionNotification && REFERENCE_CONDITION.test(predicate);
  const strongNotice = Boolean(notice && SCHEDULE_NOTIFICATION.test(notice[0]));
  // “Tell me the weather tomorrow” asks about tomorrow's forecast. With a
  // general speech verb, a clock/date leading the clause is the timed trigger.
  const leadingTime = turn.timeExpressions.some(expression => body.startsWith(expression)
    && (body.length === expression.length || /[\s,،]/u.test(body[expression.length])));
  const span = notice && !conditionNotification && parseReminderTime(body, { now, timeZone: 'UTC' }).span;
  const timeRequest = TIME_REQUEST.test(turn.normalized) || Boolean(notice && !conditionNotification
    && (leadingTime || span && (strongNotice || span.start === 0) || strongNotice && turn.timeExpressions.length));
  return { timeRequest, conditionNotification, referenceCondition };
}

export const isMonitorAcknowledgement = (turn: MonitorContextTurn) => ACKNOWLEDGEMENT.test(turn.normalized);
export const isMonitorOfferQuestion = (turn: MonitorContextTurn) => ASKS_TO_OFFER.test(turn.normalized);
export const monitorOfferReply = (turn: MonitorContextTurn) => DECLINE.test(turn.normalized) ? 'declined'
  : ACCEPT.test(turn.normalized) ? 'accepted' : null;
