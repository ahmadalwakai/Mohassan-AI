import { figureKind, hasFigureOf, statesReason } from '../answer-check.js';
import { normalizeReviewText, reviewTokens, type RequestPart } from './ledger.js';

const REQUEST_WORDS = new Set([
  'a', 'an', 'and', 'are', 'also', 'can', 'check', 'could', 'do', 'does', 'for', 'from', 'get', 'give', 'has', 'have', 'how', 'i', 'in', 'include',
  'is', 'it', 'list', 'me', 'my', 'of', 'on', 'our', 'please', 'provide', 'report', 'say', 'share', 'show', 'tell', 'the', 'their', 'them', 'then',
  'to', 'us', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'both', 'each',
  'ما', 'ماذا', 'متي', 'اين', 'من', 'كم', 'هل', 'كيف', 'لماذا', 'في', 'الي', 'علي', 'عن', 'مع', 'هو', 'هي', 'و', 'ثم', 'لي', 'اذكر',
  'ارجو', 'اعطني', 'اخبرني', 'قدم', 'اعرض', 'وضح', 'اكتب', 'ايضا', 'اريد', 'معرفه', 'اريدك', 'فضلك', 'سمحت', 'كذلك',
]);

// Common concrete attributes can be referred to by a different word in an answer.
const EQUIVALENTS = new Map(Object.entries({
  costs: 'cost', price: 'cost', prices: 'cost', fee: 'cost', fees: 'cost', expense: 'cost', expenses: 'cost',
  السعر: 'سعر', تكلفه: 'سعر', التكلفه: 'سعر', ثمن: 'سعر', الثمن: 'سعر', رسوم: 'سعر', الرسوم: 'سعر',
  owners: 'owner', responsible: 'owner', ownership: 'owner', المالك: 'مالك', مسؤول: 'مالك', المسؤول: 'مالك',
  timelines: 'timeline', schedule: 'timeline', timing: 'timeline', الموعد: 'موعد', التاريخ: 'تاريخ', المده: 'مده',
  المواقع: 'موقع', الموقع: 'موقع', المكان: 'موقع', مكان: 'موقع', locations: 'location', venue: 'location',
}));

const numberWords = /(?:^|\s)(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|dozen|hundred|thousand|million|billion|free|صفر|واحد|اثنان|اثنين|ثلاثه|اربعه|خمسه|سته|سبعه|ثمانيه|تسعه|عشره|مائه|الف|مليون|مليار|مجانا|مجاني)(?=\s|$)/u;
const numericRequest = /(?:^|\s)(?:how (?:many|much|long)|budget|cost|price|fee|count|number|quantity|distance|duration|population|كم|(?:ال)?(?:سعر|تكلفه|ثمن|ميزانيه|عدد|رقم|مده|مسافه))(?=\s|$)/u;
const dateRequest = /(?:^|\s)(?:when|date|deadline|متي|موعد|تاريخ)(?=\s|$)/u;
const dateValue = /[\p{Nd}]|(?:^|\s)(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|next week|next month|اليوم|غدا|امس|السبت|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|الاسبوع القادم)(?=\s|$)/u;
const reasonRequest = /^(?:why|explain why|لماذا|ليش|ليه|اشرح لماذا)(?=\s|$)/u;
const actionRequest = /^(?:(?:please |kindly )?(?:send|email|save|upload|publish|download|schedule|book|cancel|delete|open|attach|run|ارسل|احفظ|ارفع|انشر|نزل|جدول|احجز|الغ|احذف|افتح|ارفق|شغل|نفذ))(?=\s|$)/u;
const completedAction = /(?:^|\s)(?:done|completed|sent|emailed|saved|uploaded|published|downloaded|scheduled|booked|cancelled|canceled|deleted|opened|attached|ran|تم|ارسلت|حفظت|رفعت|نشرت|نزلت|جدولت|حجزت|الغيت|حذفت|فتحت|ارفقت|شغلت|نفذت)(?=\s|$)/u;
const deferral = /(?:^|\s)(?:i (?:cannot|can t|could not|couldn t|was unable to|do not know|don t know|have not|haven t|did not|didn t|need|will|ll)|not (?:yet|available|known|confirmed|verified|provided|finished|done)|unavailable|unknown|pending|defer(?:red)?|still (?:open|waiting|needed|missing)|unable to|لا (?:اعرف|ادري|يمكنني|استطيع|اقدر)|لم (?:اجد|احدد|اتمكن|استطع|اتحقق|اعرف|يتم)|ما زال|غير (?:متاح|معروف|محدد|مؤكد)|يحتاج الي|احتاج|سوف|موجل|قيد الانتظار|س(?:اوجل|اراجع|ابحث|اتحقق|اكمل|ارسل|اعود|اوضح|اقدم|اذكر|اكتب))(?=\s|$)/u;
const overallDeferral = /(?:^|\s)(?:any (?:part|of (?:that|this|these|those))|all (?:of|parts)|either part|none of|these (?:items|questions|requests)|your request|اي جزء|اجابه كل|جميع (?:الاجزاء|الاسئله)|هذه (?:الطلبات|الاسئله)|طلبك)(?=\s|$)/u;
const acknowledgment = /^(?:(?:yes|no|sure|okay|ok|thanks|thank you|certainly|understood|got it|نعم|لا|تمام|حسنا|اكيد|شكرا|فهمت)(?:\s+(?:i understand|لك))?)$/u;
const missingPlaceholder = /(?:^|\s)(?:todo|tbd|placeholder|not specified yet|سيحدد لاحقا|يحدد لاحقا)(?=\s|$)/u;

export function coverageTokens(text: string): string[] {
  return [...new Set(reviewTokens(text.replace(/ة/gu, 'ه')).filter(word => (word.length > 1 || /\p{Nd}/u.test(word)) && !REQUEST_WORDS.has(word))
    .map(word => EQUIVALENTS.get(word) ?? word))];
}

/** Reply sections stay separate so a date in one line cannot fill another line's missing date. */
export function answerSegments(text: string): string[] {
  return text.split(/\r?\n|[!?؟؛;]+\s*|\.(?=\s|$)/u)
    .map(segment => segment.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim())
    .filter(Boolean);
}

function hasAnchors(line: Set<string>, wanted: readonly string[], distinguishing: readonly string[]): boolean {
  const anchors = distinguishing.length ? distinguishing : wanted;
  return anchors.length > 0 && anchors.some(word => line.has(word));
}

function responseShape(part: string, segment: string): boolean {
  const response = normalizeReviewText(segment.replace(/ة/gu, 'ه'));
  if (!response || missingPlaceholder.test(response)) return false;
  if (actionRequest.test(part)) return completedAction.test(response);
  if (dateRequest.test(part)) return dateValue.test(response) || hasFigureOf('date', segment);
  if (numericRequest.test(part)) return /\p{Nd}/u.test(response) || numberWords.test(response);
  if (reasonRequest.test(part)) return statesReason(segment) || coverageTokens(segment).length >= 4;
  const kind = figureKind(part);
  return kind === 'any' || hasFigureOf(kind, segment);
}

export function uncoveredParts(parts: readonly RequestPart[], draft: string, status?: string | null, requireAnchors = false): RequestPart[] {
  if (!parts.length || status?.startsWith('waiting_') && parts.length === 1 && /[?؟]\s*$/u.test(draft)) return [];
  const segments = answerSegments(draft).map(text => ({ text, normalized: normalizeReviewText(text), tokens: new Set(coverageTokens(text)) }));
  if (segments.some(segment => deferral.test(segment.normalized) && (status === 'blocked' || overallDeferral.test(segment.normalized)))) return [];

  const topics = parts.map(part => coverageTokens(part.text));
  return parts.filter((part, index) => {
    const request = normalizeReviewText(part.text.replace(/ة/gu, 'ه'));
    const wanted = topics[index]!;
    if (!wanted.length) return false;
    const distinct = wanted.filter(word => topics.every((topic, other) => other === index || !topic.includes(word)));
    return !segments.some(segment => {
      if (segment.normalized === request || acknowledgment.test(segment.normalized)) return false;
      const scoped = hasAnchors(segment.tokens, wanted, distinct);
      if (deferral.test(segment.normalized)) return scoped || !requireAnchors && parts.length === 1;
      if (!scoped && (requireAnchors || parts.length > 1)) return false;
      if (!responseShape(request, segment.text)) return false;
      // A heading or a copy of the key words names the part without supplying a value.
      return [...segment.tokens].some(word => !wanted.includes(word));
    });
  });
}
