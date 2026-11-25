import { analyzeCompoundRequest } from '../compound-request.js';

export interface RequestPart { text: string; messageIndex: number }
export interface Claim extends RequestPart {
  subject: string;
  value: string;
  kind: 'entity' | 'number' | 'date' | 'decision';
}
export interface Commitment extends RequestPart { action: string }
export interface Correction extends RequestPart { before?: string; after?: string; answer?: string }
export interface Preference extends RequestPart {
  kind: 'name' | 'language' | 'length' | 'format' | 'units' | 'avoid';
  value: string;
  alias?: string;
  limit?: 'words' | 'sentences' | 'lines';
}

const DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const MARKS = /[\u0640\u064b-\u065f\u0670\p{Cf}]/gu;

export function comparable(text: string): string {
  return text.normalize('NFKC').replace(MARKS, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي')
    .replace(/[’‘]/gu, "'").replace(/[٠-٩۰-۹]/gu, digit => String(DIGITS.indexOf(digit) % 10))
    .replace(/٫/gu, '.').replace(/٬/gu, ',').toLowerCase();
}

export function normalizeReviewText(text: string): string {
  return comparable(text).replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

export function reviewTokens(text: string): string[] {
  return normalizeReviewText(text).split(' ').filter(Boolean);
}

const LIST_ENTRY = /^\s*(?:[-*•]|\d{1,2}[.)]|[٠-٩]{1,2}[.)])\s+/u;
const REQUEST_LEAD = /^(?:\b(?:what|where|when|who|which|why|how|could|can|would|is|are|do|does|did|please|kindly|tell|show|list|report|give|write|draft|explain|describe|compare|summari[sz]e|translate|calculate|provide|include|check|find|send|state|name|identify|share|confirm)\b|و?(?:ما|ماذا|من|متى|متي|كم|اين|لماذا|كيف|هل|اي|اعطني|اخبرني|اذكر|اكتب|اشرح|وضح|قارن|لخص|ترجم|احسب|اعرض|تحقق|ابحث|ارسل|حدد|شارك|اكد|قدم)(?!\p{L}))/u;
const ITEM_INTRO = /^(?:please\s+)?(?:list|provide|include|give(?: me)?|show(?: me)?|state|specify|tell me|what (?:are|is))(?!\p{L})|^(?:اذكر|حدد|اعطني|اخبرني|اعرض|قدم|يشمل|ما)(?!\p{L})/u;
const REQUEST_ITEM = /^(?:(?:the|a|an)\s+)?(?:date|dates|time|timing|duration|deadline|owner|budget|cost|price|location|address|venue|contact|number|amount|total|reason|status|description|benefits|risks|steps|options|schedule|distance|weight|name|title|opening hours|phone number|(?:ال)?(?:تاريخ|موعد|مدة|وقت|مالك|ميزانية|تكلفة|سعر|مكان|موقع|عنوان|رقم|كمية|مجموع|سبب|حالة|وصف|فوائد|مخاطر|خطوات|خيارات|مسافة|وزن|اسم))(?!\p{L})/u;
const SMALL_TALK = /^(?:thanks?|thank you|hi|hello|hey|ok(?:ay)?|got it|sounds good|yes|no|مرحبا|اهلا|السلام عليكم|شكرا(?: لك)?|تمام|حسنا|نعم|لا)$/u;

export function splitRequest(text: string, messageIndex = 0): RequestPart[] {
  const normalized = normalizeReviewText(text);
  if (!normalized || SMALL_TALK.test(normalized)) return [];
  const analysis = analyzeCompoundRequest(text);
  const outer = analysis.outerText || text;
  const lines = outer.split('\n');
  const explicit = text.split('\n').filter((_, index) => LIST_ENTRY.test(lines[index] ?? ''));
  if (explicit.length > 1) {
    return explicit.map(line => ({ text: line.replace(LIST_ENTRY, '').trim(), messageIndex }));
  }
  if (analysis.kind === 'compound') {
    return [analysis.primary, ...analysis.pendingActions, ...analysis.forbiddenActions]
      .sort((a, b) => a.start - b.start).map(part => ({ text: part.text, messageIndex })).filter(part => part.text);
  }

  const parts: RequestPart[] = [];
  let start = 0;
  let afterQuestion = false;
  const separators = /[?؟](?=\s+\S)|[.!]\s+|[;؛]\s*|\n+|(?:[,.،]\s+)?(?:\b(?:and then|then|and also|also|and)\b\s+|(?<!\p{L})(?:ثم|كذلك|وايضا|وأيضًا|وأيضا)\s+|(?<!\p{L})و(?=\p{L}))/giu;
  const itemList = ITEM_INTRO.test(comparable(outer).trim());
  const boundaries = itemList ? new RegExp(separators.source + '|[,،]\\s*', 'giu') : separators;
  for (const separator of outer.matchAll(boundaries)) {
    const end = separator.index;
    const next = end + separator[0].length;
    const left = text.slice(start, end).trim();
    const right = comparable(outer.slice(next, next + 140)).trim();
    const independent = /^[?؟;؛\n]/u.test(separator[0]) || REQUEST_LEAD.test(right);
    const listed = itemList && (REQUEST_ITEM.test(right)
      || /^[,،]/u.test(separator[0]) && !/^(?:but|except|for|في|الا)(?!\p{L})/u.test(right)
        && /[,،].+\b(?:and|or)\b|[,،].+و\p{L}/u.test(outer));
    if (!left || !right || !independent && !listed) continue;
    if (!/^[.!]/u.test(separator[0]) || REQUEST_LEAD.test(comparable(left))) parts.push({ text: left, messageIndex });
    start = next;
    afterQuestion = /^[?؟]/u.test(separator[0]);
  }
  const tail = text.slice(start).trim();
  if (tail && (!afterQuestion || REQUEST_LEAD.test(comparable(tail)) || /[?؟]\s*$/u.test(tail))) parts.push({ text: tail, messageIndex });
  return parts;
}

const WEEKDAY = /(?:^|\s)(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|الجمعة|السبت|الاحد)(?=$|[\s,،])/u;
const MONTH = /(?:^|\s)(?:january|february|march|april|may|june|july|august|september|october|november|december|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)(?=$|[\s,،])/u;
const DATE_LABEL = /(?:^| )(?:date|deadline|موعد|الموعد|تاريخ|التاريخ)(?: |$)/u;
const DECISION_LABEL = /(?:^| )(?:decision|choice|plan|status|قرار|القرار|خيار|الخيار|خطة|الخطة|حالة|الحالة)(?: |$)/u;
const SHORT_ENTITY = /^[\p{L}\p{M}]+(?:[\s'-]+[\p{L}\p{M}]+){0,5}$/u;
const UNKNOWN = /^(?:unknown|unavailable|pending|tbd|not (?:provided|known|available)|غير (?:متاح|معروف|محدد)|غير متوفر|لا اعرف|لم يحدد)$/u;
const DISCOURSE = /^(?:here|there|this|that|it|you|i|we|they|these|those|answer|reason|ref|source|why|example|summary|conclusion|هذا|هذه|الجواب|الاجابة|تنبيه|ملاحظة|مصدر|مثال|خلاصة)$/u;
const MARKDOWN_EDGE = /^[\s*_]+|[\s*_]+$/gu;
const EDGE = /^[\s'"“”«»‘’]+|[\s'"“”«»‘’]+$/gu;

export function replyClauses(text: string, includeQuestions = true): string[] {
  return text.split(/[\r\n]+/u).filter(line => !/^\s*>/u.test(line))
    .flatMap(line => line.match(/.*?(?:[!?؟؛;]+|\.(?=\s|$)|$)/gu) ?? [])
    .filter(clause => includeQuestions || !/[?؟]/u.test(clause))
    .map(clause => clause.replace(/(?:[!?؟؛;]+|\.)$/u, '').trim()).filter(Boolean);
}

export function stripBoundary(text: string): string {
  return text.replace(MARKDOWN_EDGE, '').replace(EDGE, '');
}

function subjectKey(text: string): string {
  const value = normalizeReviewText(text).replace(/^(?:the|a|an)\s+/u, '');
  const possessive = /^(.+?) s (.+)$/u.exec(value);
  if (possessive) return possessive[1] + ' ' + possessive[2];
  const of = /^(.+?) of (?:the )?(.+)$/u.exec(value);
  return of ? of[2] + ' ' + of[1] : value;
}

export function extractClaims(text: string, messageIndex = 0): Claim[] {
  const claims: Claim[] = [];
  for (const original of replyClauses(text, false)) {
    const clause = original.replace(LIST_ENTRY, '').replace(/^\s*#{1,6}\s+/u, '');
    const field = /^(.{1,100}?)(?:\s*[:=：]\s*|\s+(?:is|are|was|were|equals?|remains?|stands at|هو|هي|يساوي|تساوي|يبلغ|تبلغ|صار|كانت|كان)\s+)(.+)$/iu.exec(clause);
    const decision = /^(.{1,100}?)\s+(?:chose|selected|approved|decided on|opted for|اختار|اختارت|اخترنا|اعتمد|اعتمدت|اعتمدنا)\s+(.+)$/iu.exec(clause);
    const relation = field || decision;
    if (!relation) continue;
    const subject = subjectKey(stripBoundary(relation[1]!));
    const value = stripBoundary(relation[2]!.replace(/[,،]\s+(?:according to|per|بحسب|وفقا|وفقًا)(?!\p{L}).*$/iu, ''));
    if (!subject || !value || subject.split(' ').length > 10 || DISCOURSE.test(subject) || UNKNOWN.test(comparable(value))) continue;
    if (/^(?:if|when|maybe|perhaps|possibly|likely|about|approximately|around|اذا|لو|ربما|قد|حوالي|تقريبا)(?:\s|$)/u.test(normalizeReviewText(clause))
      || /^(?:maybe|perhaps|possibly|likely|about|approximately|around|ربما|قد|حوالي|تقريبا)(?:\s|$)/u.test(normalizeReviewText(value))) continue;
    const folded = comparable(value);
    let kind: Claim['kind'];
    if (WEEKDAY.test(folded) || MONTH.test(folded) && /\d/u.test(folded)
      || /^\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?$/u.test(folded) || DATE_LABEL.test(subject) && /\d/u.test(folded)) kind = 'date';
    else if (/^(?:[$€£¥]\s*)?[+-]?\d[\d.,]*(?:\s*%|\s+[\p{L}\p{M}][\p{L}\p{M}/²³.]*(?:\s+[\p{L}\p{M}]+){0,2})?$/u.test(folded)) kind = 'number';
    else if (decision || DECISION_LABEL.test(subject)) kind = 'decision';
    else if (SHORT_ENTITY.test(value) && (/\p{Lu}/u.test(value) || /\p{Script=Arabic}/u.test(value) || /[:=：]/u.test(clause))) kind = 'entity';
    else continue;
    claims.push({ subject: decision ? subject + ' decision' : subject, value, kind, text: original, messageIndex });
  }
  return claims;
}

const FUTURE = /(?:^|[,،:]\s*|\b(?:and|but)\s+)(?:\b(?:i|we)\s+(?:will|plan to|promise to)\s+|\b(?:i|we)['’]ll\s+|(?:سوف\s+|س(?=أ\p{L}|[ان](?:رسل|كتب|كمل|تحقق|راجع|نهي|عود|رفع|ضيف|شارك|قدم|رفق|حفظ|عمل|عدل))))/iu;
const NO_ACTION = /^(?:not|never|try|be|have|need|probably|لا|لن|احاول|اكون|نكون)(?:\s|$)/u;
const ACTIONS: readonly (readonly [string, RegExp])[] = [
  ['send', /^(?:send|sent|mail|mailed|email|emailed|forward|forwarded|ارسل|ارسلت|ارسلنا|ابعث|بعثت|ابعت|بعت|ارسال)$/u],
  ['upload', /^(?:upload|uploaded|attach|attached|ارفع|رفعت|ارفق|ارفقت|رفع|ارفاق)$/u],
  ['add', /^(?:add|added|include|included|insert|inserted|اضف|اضيف|اضفت|ادرج|ادرجت|اضافة)$/u],
  ['check', /^(?:check|checked|verify|verified|review|reviewed|confirm|confirmed|اتحقق|تحققت|اراجع|راجعت|اتاكد|تاكدت|تحقق)$/u],
  ['share', /^(?:share|shared|provide|provided|post|posted|اشارك|شاركت|اقدم|قدمت|انشر|نشرت)$/u],
  ['complete', /^(?:finish|finished|complete|completed|do|done|execute|executed|اكمل|اكملت|انهي|انهيت|انجز|انجزت|نفذت)$/u],
  ['save', /^(?:save|saved|store|stored|record|recorded|احفظ|حفظت|اسجل|سجلت|اخزن|خزنت|حفظ)$/u],
  ['write', /^(?:write|wrote|written|draft|drafted|prepare|prepared|make|made|create|created|اكتب|كتبت|اعد|اعددت|انشئ|انشات|اصيغ|صغت|كتابه|كتابة|اعداد)$/u],
  ['schedule', /^(?:schedule|scheduled|book|booked|remind|reminded|اجدول|جدولت|احجز|حجزت|اذكر|ذكرت|حجز)$/u],
  ['update', /^(?:update|updated|edit|edited|change|changed|correct|corrected|fix|fixed|احدث|حدثت|اعدل|عدلت|اغير|غيرت|اصحح|صححت|اصلح|اصلحت|تحديث)$/u],
  ['return', /^(?:return|returned|follow|اعود|عدت|ارجع|رجعت|اتابع|تابعت)$/u],
];
const ACTIVITY_STOP = new Set(['i', 'we', 'the', 'a', 'an', 'will', 'would', 'to', 'for', 'in', 'on', 'at', 'of', 'this', 'that',
  'you', 'it', 'them', 'your', 'our', 'my', 'here', 'is', 'later', 'next', 'now', 'tomorrow', 'today', 'after', 'before', 'by',
  'then', 'already', 'just', 'still', 'have', 'has', 'yet', 'been', 'was', 'were', 'and', 'not', 'going',
  'انا', 'نحن', 'في', 'من', 'الى', 'عن', 'مع', 'على', 'هذا', 'هذه', 'ذلك', 'ذلكم', 'سوف', 'تم', 'قد', 'غدا', 'اليوم', 'لاحقا',
  'هنا', 'هناك', 'بعد', 'قبل', 'بالفعل', 'الان', 'لم', 'ما', 'زلت', 'لا', 'لن', 'يتم']);
const REPORT = /(?:\b(?:cannot|can['’]t|couldn['’]t|haven['’]t|hasn['’]t|unable to|not (?:yet|done|sent|completed|uploaded|attached|saved|finished|written|ready|available)|still (?:pending|waiting|to do)|did not|must wait|need (?:more|your|to|the)|pending)\b|(?:^|\s)(?:لم|لن|لا (?:استطيع|يمكنني|اقدر)|لا يزال|ما زال|تعذر|بانتظار|انتظر|احتاج|قيد الانتظار)(?:\s|$))/u;
const COMPLETED = /(?:\b(?:sent|mailed|emailed|forwarded|uploaded|attached|added|included|inserted|checked|verified|reviewed|confirmed|shared|provided|posted|finished|completed|done|executed|saved|stored|recorded|wrote|written|drafted|prepared|made|created|scheduled|booked|reminded|updated|edited|changed|corrected|fixed|returned)\b|(?:^|\s)(?:ارسلت|ارسلنا|بعثت|بعت|رفعت|ارفقت|اضفت|ادرجت|تحققت|راجعت|تاكدت|شاركت|قدمت|نشرت|اكملت|انهيت|انجزت|نفذت|حفظت|سجلت|خزنت|كتبت|اعددت|انشات|صغت|جدولت|حجزت|ذكرت|حدثت|عدلت|غيرت|صححت|اصلحت|عدت|رجعت|تابعت|تم)(?:\s|$))/u;
const IN_REPLY = /(?:\bin (?:my|our|the|this|a) (?:next |event |status )*(?:reply|response|update|message)\b|(?:^|\s)في (?:[اآ]?ل)?(?:رد|اجابة|تحديث|رسالة)(?!\p{L}))/u;

export function extractCommitments(text: string, messageIndex = 0): Commitment[] {
  return replyClauses(text).flatMap(clause => {
    const match = FUTURE.exec(clause);
    if (!match) return [];
    const action = clause.slice(match.index + match[0].length).trim();
    const content = comparable(action);
    if (!content || NO_ACTION.test(content) || REPORT.test(comparable(clause))
      || /^(?:if|unless|اذا|لو)(?:\s|$)/u.test(comparable(clause))) return [];
    return [{ action, text: clause, messageIndex }];
  });
}

function objectTokens(text: string): string[] {
  return reviewTokens(text).filter(word => !ACTIVITY_STOP.has(word) && !/^\d+$/u.test(word)
    && !ACTIONS.some(([, synonyms]) => synonyms.test(word)))
    .map(word => word.replace(/^ال(?=\p{L}{3,})/u, ''));
}

export function commitmentDisposition(commitment: Commitment, reply: string): 'kept' | 'reported' | null {
  const actionWords = reviewTokens(commitment.action);
  const activity = ACTIONS.find(([, synonyms]) => synonyms.test(actionWords[0] ?? ''));
  const objects = objectTokens(commitment.action).slice(0, 8);
  for (const clause of replyClauses(reply)) {
    const words = reviewTokens(clause);
    const clauseObjects = new Set(objectTokens(clause));
    const matched = objects.filter(object => clauseObjects.has(object)).length;
    const sameActivity = activity ? words.some(word => activity[1].test(word)) : words.includes(actionWords[0] ?? '');
    const sameItem = objects.length ? matched >= Math.max(1, Math.ceil(objects.length / 2)) : sameActivity;
    if (!sameItem) continue;
    const folded = comparable(clause);
    if (REPORT.test(folded)) return 'reported';
    if (FUTURE.test(clause) || /^(?:if|when|once|اذا|لو|عندما)(?:\s|$)/u.test(folded)) continue;
    const inReply = activity?.[0] === 'upload' && /^(?:attach|ارفق)(?!\p{L})/u.test(comparable(commitment.action))
      && IN_REPLY.test(comparable(commitment.action));
    const included = (inReply || ['add', 'write', 'share'].includes(activity?.[0] ?? ''))
      && /^(?:(?:here is|here are|اليك|إليك|تفضل)(?:\s|$)|[^:：]{1,80}[:：]\s*\S)/iu.test(clause);
    if ((sameActivity && COMPLETED.test(folded)) || included) return 'kept';
  }
  return null;
}

const CORRECTION = /^(?:(?:no|actually)[,،!:\s]+)?(?:i (?:meant|said|asked (?:for|about))|what i meant (?:was|is)|that['’]s (?:wrong|incorrect|not right)|(?:that|it) (?:is |was )?(?:wrong|incorrect)|(?:correction|correct that)(?:\s*[:،,]\s*)?|you (?:got|read|spelled) .*? wrong|(?:لا[،,\s]+)?(?:قصدت|اقصد|كنت اقصد|قلت|اعني|المقصود|تصحيح|الصحيح|سؤالي عن|سال(?:ت|تك) عن)|(?:هذا|ذلك) (?:خطا|غير صحيح)|خطا)(?!\p{L})/u;
const REJECTION = /^(?:(?:no|actually|لا)[,،!:\s]+)?(?:that['’]s (?:wrong|incorrect|not what i asked)|(?:that|this|it)(?: (?:answer|option|idea|approach|plan|suggestion|response))? (?:is |was )?(?:wrong|incorrect|not what i (?:asked|wanted|meant)|doesn['’]t work|does not work|doesn['’]t suit|won['’]t work|isn['’]t suitable)|wrong answer|try again|i (?:reject(?:ed)?|don['’]t want) (?:that|this|it|the)|(?:do not|don['’]t) repeat (?:that|this)|(?:هذا|هذه|ذلك|تلك) (?:خطا|غير صحيح|ليس ما (?:طلبت|قصدت))|(?:هذا|هذه|ذلك|تلك)(?: (?:الخيار|الفكرة|الرد|الاجابة|الاقتراح|الخطة))? (?:لا يناسبني|لا تناسبني|مرفوض[ة]?|لا يصلح|لا تصلح)|رفضت|(?:اجابة|الاجابة|رد|الرد) (?:خاطئ[ةه]?|خطا|غير صحيح[ةه]?)|لا تكرر (?:ذلك|هذا)|حاول مرة اخرى)(?!\p{L})/u;
const REQUEST_ALTERNATIVE = /^(?:no|لا)[\s.,!:،]+\s*(?:(?:please\s+)?(?:try|suggest|offer|give|find|show|i want)\b.+\b(?:another|different|alternative)\b|(?:جرب|اقترح|قدم|اعطني|اريد|ابحث)(?!\p{L}).+(?:اخر|اخرى|اخري|مختلف|بديل|ثاني|ثانية))(?!\p{L})/u;
const CORRECT_PAIR = /^(.+?)(?:[,،]\s*|\s+)(?:not|instead of|rather than|وليس|وليسَ|وليست|لا|بدل(?:ا من)?|بدلًا من)(?!\p{L})\s+(.+)$/iu;

export function extractCorrections(text: string, messageIndex = 0, answer?: string): Correction[] {
  return replyClauses(text).flatMap(clause => {
    const marker = CORRECTION.exec(comparable(clause));
    if (!marker) return [];
    // Preserve the original spelling and digit shapes in the correction.
    const detail = clause.slice(originalOffset(clause, marker[0].length)).replace(/^[\s,:،]+/u, '').trim();
    const pair = CORRECT_PAIR.exec(detail);
    const after = stripBoundary(pair?.[1] ?? detail);
    const before = pair ? stripBoundary(pair[2]!) : undefined;
    return [{ text: clause, messageIndex, ...(before ? { before } : {}), ...(after ? { after } : {}), ...(answer ? { answer } : {}) }];
  });
}

export function rejectsAnswer(text: string): boolean {
  return REQUEST_ALTERNATIVE.test(comparable(text.trim())) || replyClauses(text).some(clause => REJECTION.test(comparable(clause)));
}

const PREFERENCE_CUE = /(?:\b(?:prefer|always|please|use|answer|reply|respond|write|give|keep|format|display|report|show|measure|from now on|only|no more than|at most)\b|(?:^|\s)(?:افضل|دائما|دوما|استخدم|استعمل|اجب(?:ني)?|رد|اكتب|اعرض|اذكر|اريد|خل|خلي|اجعل|من الان|فقط|بحد اقصى|لا تتجاوز|اختصر)(?!\p{L}))/u;
const NAME = /(?:^|[,،:]\s*|\bplease\s+)(?:(?:my name is(?: spelled)?|call me|address me as|i go by|spell my name(?: as)?|write my name(?: as)?|the correct spelling of my name is)(?!\p{L})|(?:اسمي(?: هو| يكتب)?|نادني(?: باسم)?|ناديني(?: باسم)?|اكتب اسمي(?: هكذا)?|تهجئة اسمي(?: هي)?)(?!\p{L}))[\s:،]+(?:(?:always|دائما|دوما)\s+)?(.+)$/u;
const NAME_VALUE = /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,3}$/u;
const NAME_CONTEXT = /\s+(?:and\s+(?:please|use|reply|answer|call|keep|write|i)|from now on|going forward|please|in (?:your|every|all) (?:reply|replies|answers|replying)|دائمًا|دائما|من الآن|من الان|لو سمحت)(?!\p{L}).*$/iu;
const AVOID = /^(?:(?:please|always|from now on)[,:\s]+)*(?:avoid|never (?:use|mention|say|include)|(?:do not|don['’]t) (?:use|mention|say|include)|no|تجنب|لا (?:تستخدم|تستعمل|تذكر|تقل|تكتب|تضف|تضع)|بلا|بدون|دون)(?!\p{L})[\s:]+(.+)$/u;
const AVOID_SCOPE = /\s+(?:in (?:your|all|every|any) (?:subsequent )?(?:repl(?:y|ies)|answers?|responses?)|from now on|ever|في (?:كل|اي|أي|جميع) (?:رد|اجابة|إجابة|ردود|الردود)|دائمًا|دائما)\s*$/iu;

const LANGUAGE_VALUES: readonly (readonly [string, RegExp])[] = [
  ['ar', /(?:^|\s)(?:in arabic|arabic (?:only|replies|answers)|بالعربية|بالعربي|باللغة العربية|العربية فقط)(?!\p{L})/u],
  ['en', /(?:^|\s)(?:in english|english (?:only|replies|answers)|بالانجليزية|بالانجليزي|باللغة الانجليزية|الانجليزية فقط)(?!\p{L})/u],
];
const FORMAT_VALUES: readonly (readonly [string, RegExp])[] = [
  ['bullets', /\b(?:bullet points?|bullets|bulleted lists?)\b|(?:^|\s)(?:نقاط|قائمة نقطية|تعداد نقطي)(?!\p{L})/u],
  ['numbered', /\b(?:numbered lists?|numbered steps?)\b|(?:^|\s)(?:قائمة مرقمة|نقاط مرقمة|خطوات مرقمة|تعداد رقمي)(?!\p{L})/u],
  ['table', /\b(?:as a table|in a table|table format|use (?:a )?tables?|prefer tables?|a markdown table)\b|(?:^|\s)(?:كجدول|بجدول|جدول|على شكل جدول)(?!\p{L})/u],
  ['plain', /\b(?:plain (?:text|prose)|(?:without|no) markdown)\b|(?:^|\s)(?:نص عادي|دون تنسيق|بدون تنسيق)(?!\p{L})/u],
  ['json', /\bjson\b|(?:^|\s)جيسون(?!\p{L})/u],
  ['paragraph', /\b(?:single paragraph|one paragraph|as a paragraph|in paragraphs?)\b|(?:^|\s)(?:فقرة واحدة|على شكل فقرة|كفقرة|بفقرة)(?!\p{L})/u],
];
const UNITS_VALUES: readonly (readonly [string, RegExp])[] = [
  ['metric', /\bmetric (?:units?|measurements?|system)\b|(?:^|\s)(?:الوحدات المترية|النظام المتري)(?!\p{L})/u],
  ['imperial', /\bimperial (?:units?|measurements?|system)\b|(?:^|\s)(?:الوحدات الامبراطورية|النظام الامبراطوري)(?!\p{L})/u],
  ['celsius', /\b(?:celsius|centigrade)\b|°\s*c\b|(?:^|\s)(?:مئوية|سيلسيوس|سلزيوس)(?!\p{L})/u],
  ['fahrenheit', /\bfahrenheit\b|°\s*f\b|(?:^|\s)(?:فهرنهايت)(?!\p{L})/u],
  ['km', /\b(?:kilomet(?:er|re)s?|km)\b|(?:^|\s)(?:(?:ب?ال)?كيلومترات?|(?:ب?ال)?كيلومتر)(?!\p{L})/u],
  ['mi', /\b(?:miles?|mi)\b|(?:^|\s)(?:(?:ب?ال)?اميال|(?:ب?ال)?ميل)(?!\p{L})/u],
  ['kg', /\b(?:kilograms?|kg)\b|(?:^|\s)(?:بالكيلوغرامات?|كيلوغرامات?|كجم|كغ)(?!\p{L})/u],
  ['lb', /\b(?:pounds?|lbs?)\b|(?:^|\s)(?:بالارطال|بالرطل|ارطال|رطل)(?!\p{L})/u],
  ['m', /\b(?:met(?:er|re)s?)\b|(?:^|\s)(?:بالامتار|بالمتر|امتار|متر)(?!\p{L})/u],
  ['ft', /\b(?:feet|foot)\b|(?:^|\s)(?:بالاقدام|بالقدم|اقدام|قدم)(?!\p{L})/u],
];
const LENGTH_VALUES: readonly (readonly [string, RegExp])[] = [
  ['short', /\b(?:brief|briefly|concise|short (?:answers?|replies|responses)|keep (?:it|the (?:answer|reply)) short)\b|(?:^|\s)(?:باختصار|مختصر[ة]?|موجز[ة]?|اختصر|الايجاز)(?!\p{L})/u],
  ['detailed', /\b(?:detailed (?:answers?|replies|responses)|in detail|thoroughly)\b|(?:^|\s)(?:بالتفصيل|مفصل[ة]?|بتفصيل)(?!\p{L})/u],
];
const NUMBER_LIMIT = /(?:\b(?:at most|no more than|within|under|up to|only|in|limit(?: it| replies| answers)? to)\s+|(?:^|\s)(?:بحد اقصى|لا تتجاوز|في حدود|في|فقط)\s+)(\d{1,4}|one|two|three|four|five|واحد|واحدة|اثنين|ثلاث|ثلاثة|اربع|اربعة|خمس|خمسة)\s+(words?|sentences?|lines?|كلمات|كلمة|جمل|جملة|اسطر|سطور|سطر)(?!\p{L})/u;
const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', واحد: '1', واحدة: '1', اثنين: '2',
  ثلاث: '3', ثلاثة: '3', اربع: '4', اربعة: '4', خمس: '5', خمسة: '5',
};
const UNIT_LIMIT: Record<string, NonNullable<Preference['limit']>> = {
  word: 'words', words: 'words', كلمة: 'words', كلمات: 'words',
  sentence: 'sentences', sentences: 'sentences', جملة: 'sentences', جمل: 'sentences',
  line: 'lines', lines: 'lines', سطر: 'lines', اسطر: 'lines', سطور: 'lines',
};

function originalOffset(original: string, foldedOffset: number): number {
  let foldedLength = 0;
  let offset = 0;
  for (const char of original) {
    foldedLength += comparable(char).length;
    if (foldedLength > foldedOffset) break;
    offset += char.length;
  }
  return offset;
}

function originalMatch(original: string, folded: string, match: RegExpExecArray): string {
  const start = match.index + match[0].lastIndexOf(folded);
  return original.slice(originalOffset(original, start), originalOffset(original, start + folded.length));
}

function expectedValue(text: string, values: readonly (readonly [string, RegExp])[]): string | undefined {
  const matches = values.flatMap(([value, pattern]) => {
    const match = pattern.exec(text);
    if (!match || /(?:\b(?:not|no|without|avoid)|(?:^|\s)(?:لا|ليس|بدون|تجنب))\s+(?:in\s+)?$/u.test(text.slice(0, match.index))) return [];
    return [{ value, index: match.index }];
  });
  return matches.sort((a, b) => b.index - a.index)[0]?.value;
}

export function extractPreferences(text: string, messageIndex = 0): Preference[] {
  const preferences: Preference[] = [];
  for (const clause of replyClauses(text)) {
    const folded = comparable(clause);
    const record = (kind: Preference['kind'], value: string, details?: Pick<Preference, 'alias' | 'limit'>) => {
      preferences.push({ kind, value, text: clause, messageIndex, ...details });
    };
    const name = NAME.exec(folded);
    if (name) {
      const setting = originalMatch(clause, name[1]!, name).replace(NAME_CONTEXT, '');
      const pair = CORRECT_PAIR.exec(setting);
      const value = stripBoundary(pair?.[1] ?? setting);
      const alias = pair && stripBoundary(pair[2]!);
      if (NAME_VALUE.test(value)) record('name', value, alias && NAME_VALUE.test(alias) ? { alias } : undefined);
    }
    const avoid = AVOID.exec(folded);
    if (avoid && !CORRECTION.test(folded) && !REJECTION.test(folded)) {
      const item = originalMatch(clause, avoid[1]!, avoid).replace(AVOID_SCOPE, '')
        .replace(/^(?:the (?:word|phrase|term)|كلمة|عبارة)\s+/iu, '');
      const quoted = /^[«“"‘']([^»”"’']+)[»”"’']\s*$/u.exec(item);
      const value = quoted?.[1] ?? stripBoundary(item);
      if (value && (quoted || reviewTokens(value).length <= 4)) record('avoid', value);
    }
    if (!PREFERENCE_CUE.test(folded) && !/^(?:بالعربي(?:ة)?|بالانجليزي(?:ة)?|in english|in arabic|english only|arabic only|كجدول|as a table|in bullets|باختصار|briefly)$/u.test(folded)) continue;
    for (const [kind, values] of [['language', LANGUAGE_VALUES], ['format', FORMAT_VALUES], ['units', UNITS_VALUES], ['length', LENGTH_VALUES]] as const) {
      const value = expectedValue(folded, values);
      if (value) record(kind, value);
    }
    const length = NUMBER_LIMIT.exec(folded);
    if (length) record('length', NUMBER_WORDS[length[1]!] ?? length[1]!, { limit: UNIT_LIMIT[length[2]!]! });
  }
  return preferences;
}

const PREFERENCE_ONLY = /^(?:(?:no|actually|please|kindly|always|from now on|من فضلك|دائما)[,،:\s]+)*(?:my name is|call me|address me|i go by|spell my name|write my name|the correct spelling of my name|i prefer|prefer|use|reply|answer|respond|keep|format|avoid|never (?:use|mention|say|include)|(?:do not|don't) (?:use|mention|say|include)|(?:english|arabic) only|in (?:english|arabic)|as a table|in bullets|briefly|no |اسمي|نادني|ناديني|اكتب اسمي|تهجئة اسمي|افضل|استخدم|استعمل|اجب(?:ني)?|رد|اجعل|خلي|خل|بالعربي(?:ة)?|بالانجليزي(?:ة)?|كجدول|تجنب|لا (?:تستخدم|تستعمل|تذكر|تقل|تكتب|تضف|تضع|تتجاوز)|بلا|بدون|دون|باختصار)(?!\p{L})/u;

export function isPreferenceOnly(text: string, knownPreferences = extractPreferences(text)): boolean {
  const folded = comparable(text);
  return knownPreferences.length > 0 && PREFERENCE_ONLY.test(folded)
    && !/\b(?:answer|reply|respond)\s+(?!in\b|with\b|briefly\b|only\b|as\b|using\b|to me\b|to us\b|in detail\b)(?:this|that|the|my|our)\s+\S/u.test(folded);
}
