import { z } from 'zod';
import { returnedTo } from './return-to.js';
import { assessRequestScope, parseRequestScopeAssessment, requestOperationText, RequestScopeAssessmentSchema, reviewPublicProjection, parseUserRequestConstraints, maskRequestLiteralData, isEntireLiteralRequest, searchRequestText, type UserRequestConstraints, type RequestScopeAssessment } from './request-scope.js';

/**
 * A small, deterministic context boundary, not a replacement language model.
 * Only host-persisted user context belongs here. Assistant replies, page text and
 * model assertions must never be passed as earlier user turns.
 *
 * `resolved` preserves the current instruction. `query` is a separate public
 * search projection; neither it nor a pending answer grants action permission.
 */
export const REQUEST_CONTEXT_VERSION = 1;
export const MAX_CONTEXT_REQUEST = 8000;
const MAX_TOPIC = 600;
const MAX_VALUE = 240;
const MAX_SLOTS = 12;
const MAX_HISTORY = 8;

export const requestContextIntents = [
  'web_search', 'browser_command', 'news', 'memory', 'reminder', 'compute',
  'ads', 'pc', 'writing', 'planning', 'coding', 'chat', 'unsupported', 'unknown',
] as const;
export type RequestContextIntent = (typeof requestContextIntents)[number];
export const requestSlotKinds = ['place', 'time', 'budget', 'language', 'format', 'quantity', 'url'] as const;
export type RequestSlotKind = (typeof requestSlotKinds)[number];

const TurnId = z.string().min(1).max(80);
export const RequestContextSlotSchema = z.object({
  kind: z.enum(requestSlotKinds),
  value: z.string().min(1).max(MAX_VALUE),
  sourceTurnId: TurnId,
  /** Relative requests retain their explicit base; this module does no arithmetic. */
  relativeTo: z.object({ value: z.string().min(1).max(MAX_VALUE), sourceTurnId: TurnId }).strict().optional(),
}).strict();
export type RequestContextSlot = z.infer<typeof RequestContextSlotSchema>;

export const RequestContextStateSchema = z.object({
  version: z.literal(REQUEST_CONTEXT_VERSION),
  revision: z.number().int().min(1).max(1_000_000_000),
  intent: z.enum(requestContextIntents),
  scope: z.enum(['public', 'private', 'unknown']),
  topic: z.string().min(1).max(MAX_TOPIC).nullable(),
  topicSourceTurnId: TurnId.nullable(),
  slots: z.array(RequestContextSlotSchema).max(MAX_SLOTS),
  sourceAssessment: RequestScopeAssessmentSchema.optional(),
}).strict().superRefine((state, context) => {
  if ((state.topic === null) !== (state.topicSourceTurnId === null)) {
    context.addIssue({ code: 'custom', message: 'A topic and its provenance must exist together.' });
  }
  if (privateIntent(state.intent) && state.scope !== 'private') {
    context.addIssue({ code: 'custom', message: 'Private intent cannot become public context.' });
  }
  const declaredPublicDocument = state.sourceAssessment?.reasons.includes('public_document_reference')
    && assessRequestScope(state.topic ?? '').reasons.includes('public_document_reference');
  if (state.scope === 'public' && privateReference([state.topic ?? '', ...state.slots.map(slot => slot.value)].join(' ')) && !declaredPublicDocument) {
    context.addIssue({ code: 'custom', message: 'Private subject cannot become public context.' });
  }
  if (state.scope === 'public' && state.sourceAssessment?.scope === 'private') {
    context.addIssue({ code: 'custom', message: 'A private source cannot be persisted as public context.' });
  }
});
export type RequestContextState = z.infer<typeof RequestContextStateSchema>;
export type RequestContextAmbiguity =
  | 'request_too_long' | 'empty_request' | 'invalid_previous_state' | 'unsafe_previous_context'
  | 'missing_reference' | 'missing_question' | 'topic_too_long' | 'multiple_budget_values'
  | 'too_many_slots' | 'unclear_replacement';
export interface RequestContextProvenance {
  field: 'topic' | RequestSlotKind;
  sourceTurnId: string;
  relation: 'current' | 'inherited' | 'replaced';
}
export interface RequestResolution {
  version: typeof REQUEST_CONTEXT_VERSION;
  kind: 'new' | 'follow_up' | 'answer' | 'ambiguous';
  /** The bounded original is diagnostic only when request_too_long is present. */
  original: string;
  /** Complete current instruction, or null when its bounds are invalid. */
  resolved: string | null;
  /** A data-only search query, available exclusively for a public lookup. */
  query: string | null;
  intent: RequestContextIntent;
  scope: RequestContextState['scope'];
  topic: string | null;
  slots: RequestContextSlot[];
  ambiguities: RequestContextAmbiguity[];
  provenance: RequestContextProvenance[];
  nextState: RequestContextState | null;
  pendingQuestionId: string | null;
  sourceAssessment?: RequestScopeAssessment;
  constraints?: UserRequestConstraints;
}
export interface RequestContextOptions {
  turnId?: string;
  pendingQuestion?: { id: string; fields?: readonly RequestSlotKind[] };
}

const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();
const clean = (text: string) => text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/\s+/gu, ' ').trim();
const trimPunctuation = (text: string) => text.replace(/^[\s,،;؛:!?؟.]+|[\s,،;؛:!?؟.]+$/gu, '').trim();
const key = (text: string) => fold(trimPunctuation(text));
const PRIVATE = /(?:^|\s)(?:اسمي|شركتي|حسابي|عملائي|موقعي|متجري|بريدي|رسائلي|ايميلي|ملفاتي|ملاحظاتي|كلم[هة] (?:السر|المرور)|بياناتي)(?=\s|$)|\bmy (?:password|account|files|notes|email|messages|customers|company|memory)\b/iu;
const MEMORY = /(?:^|\s)(?:تذكر|تتذكر|احفظ|ذاكرتك|ذاكرتي|الذاكره|ملاحظاتي)(?=\s|$)|\b(?:remember|recall|memor(?:y|ies)|my notes)\b/iu;
// Ownership plus a storage relation denotes private retrieval regardless of the
// particular property being requested (company, booking, membership, etc.).
const STORED_PERSONAL = /\b(?:my|our)\s+(?:(?:own|personal|private)\s+)?(?:saved|stored|recorded|remembered)\s+\p{L}/iu;
const HOST_LOCAL = /\b(?:my|our|this shared|the shared)\s+(?:[\p{L}-]+\s+){0,3}(?:computer|pc|terminal|window|screen|workbook|spreadsheet|file|folder|app)\b|(?:^|\s)(?:ملف|مجلد|نافذه|شاشه|برنامج|تطبيق|طرفيه|مصنف)(?=\s)[^.!?؟]{0,100}(?:عندي|المفتوح|المشترك|جهازي)(?=\s|$)/iu;
const REMINDER = /(?:^|\s)(?:ذكرني|نبهني|تذكير|منبه)(?=\s|$)|\b(?:remind me|set (?:an? )?(?:alarm|reminder|timer))\b/iu;
const ADS = /(?:^|\s)(?:حمله|حملتي|حملات|اعلان|اعلانات)(?=\s|$)|\b(?:campaigns?|google ads|make ads|create ads)\b/iu;
const AD_PRODUCTION = /^(?:create|make|prepare|draft|write|build|design|compose|generate)\b[^.!?]{0,80}\bads?\b/iu;
const PC = /(?:^|\s)(?:جهازي|حاسوبي|كمبيوتري|نافذه|نوافذ|ملفاتي|مجلداتي)(?=\s|$)|\b(?:my (?:computer|pc)|open windows|desktop|files on my)\b/iu;
const CODING = /(?:^|\s)(?:كود|الكود|برمج|برمجه|سكريبت)(?=\s|$)|\b(?:code|coding|repository|repo|debug|refactor)\b/iu;
const CODING_ACTION = /^(?:debug|refactor|برمج)(?!\p{L})/iu;
const WRITING = /^(?:اكتب|صغ|ترجم|اعد صياغه|اختصر|لخص|صحح|write|draft|compose|translate|rewrite|summari[sz]e|shorten)\b|^(?:اكتب|صغ|ترجم|اعد صياغه|اختصر|لخص|صحح)(?=\s|$)/iu;
const PLANNING = /(?:^|\s)(?:خطط|نظم|رتب)(?:لي)?\s+(?:لي\s+)?(?:اسبوع|يوم|مهام|جدول)|\b(?:plan|organi[sz]e|schedule) my (?:week|day|tasks)\b/iu;
const COMPUTE = /[\d٠-٩]\s*(?:[+*/×÷^]|-(?=\s*[\d٠-٩])|ضرب|زائد|ناقص|قسمه? علي|plus|minus|times|divided by)\s*[\d٠-٩]|^(?:احسب|calculate|compute)(?=\s|$)/iu;
const BROWSER = /^(?:افتح|ادخل|اضغط|انقر|اختر|اقرا|ارجع|مرر)(?=\s|$)|^(?:open|visit|navigate|click|tap|scroll|go back|read (?:the|this) page)\b/iu;
const NEWS = /(?:^|\s)(?:اخبار|عناوين الاخبار)(?=\s|$)|\b(?:news|headlines)\b/iu;
const UNSUPPORTED = /^(?:ارسم|ولد صوره|انشئ صوره|generate an? image|draw|make a video|generate a video)(?=\s|$)/iu;
const SMALLTALK = /^(?:مرحبا|اهلا|هلا|شكرا|شكرا لك|السلام عليكم|كيف حالك|كيفك|من انت|ما اسمك|hi|hello|hey|thanks|thank you|who are you|what is your name)[.!?؟]*$/iu;
const CANCEL = /^(?:توقف|قف|لا تكمل|الغ(?:ها|اء)|stop|cancel|never mind|nevermind)[.!?؟]*$/iu;
const ACK = /^(?:نعم|لا|اي|ايوه|تمام|طيب|حسنا|موافق|yes|no|ok(?:ay)?|sure|fine|agreed)[.!?؟]*$/iu;
const CONTROL_TEXT = /\b(?:ignore|override|disregard) (?:all |the |any )?(?:previous |prior |system |developer )?(?:instructions?|rules?|prompts?)\b|(?:تجاهل|تخطي|تجاوز)\s+(?:كل\s+)?(?:التعليمات|القواعد|الاوامر)|\b(?:system|developer|assistant)\s*:/iu;
const FOLLOW_LEAD = /^(?:(?:طيب|طب|تمام|حسنا|اوكي|okay|ok|well)[،,\s]+)*(?:(?:و?ماذا|وش|شو|ايش)\s+عن\s+|(?:what|how) about\s+|and\s+|و(?=كم|متي|متى|ما\s|هل|في\s|بكر|غد|اليوم|الان|سعر|ايش|شو|اين|كيف|ليش|لماذا|من\s|عن\s|ال|مبارا[ةه]|طقس|نتيج|اسعار|هو|هي)|(?:طيب|طب|حسنا)[،,\s]+)/iu;
const CORRECTION = /^(?:(?:لا|no)[،,\s]+)?(?:[اأإآ]قصد|قصدي|[اأإآ]عني|بل|i mean|i meant|rather|instead)(?::|،|,|\s)+/iu;
const POINTER = /(?:^|\s)(?:سعر[هها]{1,2}|موعد[هها]{1,2}|اسم[هها]{1,2}|طول[هها]{1,2}|حالت[هها]{1,2}|تكلفت[هها]{1,2}|مدينت[هها]{1,2}|عنوان[هها]{1,2}|لون[هها]{1,2}|عنه|عنها|فيه|فيها|له|لها|هو|هي|نفسه|نفسها|اجعلها|اجعله|خليها|خليه|خلها|خله|عدلها|عدله|بدلها|بدله|اكتبها|اختصرها|ترجمها)(?=\s|$)|\b(?:it|its|that|there|them|they|he|she|his|her|same)\b/iu;
// «ما هو X» / «من هي X»: the pronoun is the question's copula when a subject follows it,
// so it is not a pointer to an earlier topic. «من هو؟» and «ما هو سعره؟» keep their pointer test.
const COPULA_QUESTION = /^(?:ما|من|ماذا|متي|متى|اين|وين|كيف|كم)\s+(?:هو|هي)\s+(?=[^\s?!؟.])/iu;
const pointsBack = (text: string) => POINTER.test(text.replace(COPULA_QUESTION, ''));
const MODIFIER = /^(?:اجعلها|اجعله|خليها|خليه|خلها|خله|عدلها|عدله|بدلها|بدله|make it|change it|change that|set it|keep it)(?=\s|$)/iu;
const QUESTION_ONLY = /^(?:و?هو|و?هي|عنه|عنها|it|that|them|what about it|how about it)[?!؟.]*$/iu;
const PROPERTY = /^(?:(?:كم|ما|ماذا|متي|متى|هل|what(?:'s| is| are)?|how (?:much|many)|when(?:'s| is)?|is|are)\s+)*(سعر|اسعار|موعد|مبارا[ةه]|مباريات|نتيج[ةه]|نتائج|طقس|درج[ةه] الحرار[ةه]|مواصفات|تكلف[ةه]|طول|ارتفاع|عمر|price|prices|cost|weather|temperature|match|matches|score|scores|specifications?|height|age)(?=\s|$)/iu;
const ASK_PREFIX = /^(?:(?:كم|ما|ماذا|متي|متى|اين|وين|هل|كيف|وش|شو|ايش|هو|هي|عن|ابحث عن|دور لي عن|ما هي|ما هو|what(?:'s| is| are)?|how (?:much|many)|when(?:'s| is)?|where(?:'s| is)?|is|are|search for|look up|tell me about|the)\s+)+/iu;
const NEW_ACTION = /^(?:انشئ|اصنع|جهز|احفظ|تذكر|ذكرني|افتح|ادخل|ابحث|اضغط|انقر|اكتب|ترجم|خطط|نظم|ارسم)(?=\s|$)|^(?:create|make|prepare|save|remember|remind|open|visit|search|click|write|translate|plan|draw)\b/iu;
const THANKS = /^(?:شكرا|شكرا لك|thanks|thank you)[.!?؟]*$/iu;
const CONTEXT_FIELD = /(?<![\p{L}\p{N}])(?:name|city|address|colou?r|price|cost|height|age|specifications?|اسم|مدين[ةه]|عنوان|لون|سعر|تكلف[ةه]|طول|ارتفاع|عمر|مواصفات)(?![\p{L}\p{N}])/giu;

/**
 * Removes discourse filler for classification only; the full instruction is retained. A return to an earlier subject
 * («ارجع إلى أينشتاين: أين ولد؟») is classified as the question it asks («أين ولد أينشتاين»), the query the hands search.
 */
export function requestActionText(text: string): string {
  let result = clean(text).replace(/^(?:(?:طيب|طب|حسنا|حسنًا|تمام|okay|ok|well)[،,\s]+)+/iu, '');
  result = returnedTo(result) ?? result;
  if (/^and\s+/iu.test(result) && startsNewAction(result.replace(/^and\s+/iu, ''))) result = result.replace(/^and\s+/iu, '');
  if (/^و/u.test(result) && startsNewAction(result.slice(1))) result = result.slice(1);
  return result;
}

function startsNewAction(text: string) {
  const normalized = fold(text);
  // Reuse the computation grammar rather than duplicating its action words in
  // the pending-answer and discourse-prefix grammars.
  return NEW_ACTION.test(normalized) || COMPUTE.test(normalized);
}

function lexicalText(text: string) {
  return fold(trimPunctuation(text)).replace(/[,،:;؛]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function privateReference(text: string) {
  const normalized = lexicalText(text);
  return PRIVATE.test(normalized) || STORED_PERSONAL.test(normalized) || HOST_LOCAL.test(normalized);
}

function privateIntent(intent: RequestContextIntent) {
  return ['memory', 'ads', 'pc', 'reminder', 'planning', 'coding'].includes(intent);
}

function classify(text: string): RequestContextIntent {
  const normalized = lexicalText(requestOperationText(requestActionText(text)));
  if (MEMORY.test(normalized)) return 'memory';
  if (HOST_LOCAL.test(normalized)) return 'pc';
  if (STORED_PERSONAL.test(normalized)) return 'memory';
  if (REMINDER.test(normalized)) return 'reminder';
  if (ADS.test(normalized) || AD_PRODUCTION.test(normalized)) return 'ads';
  if (PC.test(normalized)) return 'pc';
  if (CODING.test(normalized)) return 'coding';
  if (PLANNING.test(normalized)) return 'planning';
  if (COMPUTE.test(normalized)) return 'compute';
  if (BROWSER.test(normalized)) return 'browser_command';
  if (WRITING.test(normalized)) return 'writing';
  if (UNSUPPORTED.test(normalized)) return 'unsupported';
  if (SMALLTALK.test(normalized) || ACK.test(normalized) || CANCEL.test(normalized)) return 'chat';
  if (NEWS.test(normalized)) return 'news';
  if (CONTROL_TEXT.test(normalized)) return 'unknown';
  return 'web_search';
}

function scopeFor(intent: RequestContextIntent, text: string): RequestContextState['scope'] {
  if (privateIntent(intent) || privateReference(text)) return 'private';
  return ['web_search', 'news', 'browser_command'].includes(intent) ? 'public' : 'unknown';
}

export function parseRequestContextState(value: unknown): RequestContextState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  // Bound collection work before asking the nested schema to inspect its values.
  if (!Array.isArray(state.slots) || state.slots.length > MAX_SLOTS
    || typeof state.topic === 'string' && state.topic.length > MAX_TOPIC) return null;
  const parsed = RequestContextStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type FoundSlot = { kind: RequestSlotKind; value: string; span: string; relative?: boolean };

function explicitSlots(text: string, budgetContext = false): FoundSlot[] {
  const original = text;
  text = maskRequestLiteralData(text);
  const slots: FoundSlot[] = [];
  const add = (kind: RequestSlotKind, value: string | undefined, span: string, relative = false) => {
    const cleaned = trimPunctuation(value ?? '');
    if (cleaned && cleaned.length <= MAX_VALUE && !slots.some(slot => slot.kind === kind && key(slot.value) === key(cleaned))) {
      slots.push({ kind, value: cleaned, span, ...(relative ? { relative: true } : {}) });
    }
  };
  for (const found of text.matchAll(/https?:\/\/[^\s<>"«»]+/giu)) add('url', found[0].replace(/[.,،;؛!?؟]+$/u, ''), found[0]);
  for (const found of text.matchAll(/(?:^|\s)((?:اليوم|الآن|الان|غدًا|غدا|بكرة|بكره|الليلة|هذا الأسبوع|الأسبوع القادم|الشهر القادم)|(?:today|tomorrow|tonight|this week|next week|next month)|(?:\d{4}-\d{2}-\d{2}))(?=\s|[؟?.,،؛;!]|$)/giu)) add('time', found[1], found[0]);
  // Language/format operands have explicit types. They cannot also become
  // geographic places merely because they follow the same preposition "in".
  const typed: Array<{ start: number; end: number }> = [];
  for (const found of text.matchAll(/(?:بال(?:لغة\s+)?|in\s+)(العربية|العربيه|الإنجليزية|الانجليزية|الانجليزيه|الفرنسية|الفرنسيه|Arabic|English|French)(?=\s|[؟?.,،؛;!:：]|$)/giu)) {
    add('language', found[1], found[0]); typed.push({ start: found.index, end: found.index + found[0].length });
  }
  for (const found of text.matchAll(/(?:بصيغة|بتنسيق|على شكل|as(?: an?)?|in)\s+(JSON|CSV|جدول|قائمة|قائمه|table|list|bullet points?)(?=\s|[؟?.,،؛;!:：]|$)/giu)) {
    add('format', found[1], found[0]); typed.push({ start: found.index, end: found.index + found[0].length });
  }
  let placeText = text;
  for (const span of [...typed].sort((a, b) => b.start - a.start)) placeText = placeText.slice(0, span.start) + ' '.repeat(span.end - span.start) + placeText.slice(span.end);
  // Place markers are textual spans, not inferred geocoding or residence.
  for (const found of placeText.matchAll(/(?:^|\s)(?:في|إلى|الى|in|at)\s+([\p{L}][\p{L}\p{N}'’ -]{0,65}?)(?=\s+(?:و(?:ب|نصف|ثلث|ربع|ضعف|ميزانيه|ميزانية|اجعل|خلي|خل)|(?:اليوم|غدا|بكرة|بكره|الليلة|الآن|الان|بميزانية|بميزانيه|ميزانية|ميزانيه|tomorrow|today|tonight|with|for|and|but|instead))(?=\s|[؟?.,،؛;!]|$)|[؟?.,،؛;!]|$)/giu)) {
    const capture = found.index + found[0].indexOf(found[1]);
    const cutoff = typed.filter(span => span.start >= capture && span.start < found.index + found[0].length).reduce((end, span) => Math.min(end, span.start), found.index + found[0].length);
    const value = trimPunctuation(original.slice(capture, cutoff));
    if (!PRIVATE.test(fold(value)) && !/^(?:حسابي|ذاكرتك|ذاكرتي|الذاكره|الانترنت|الويب|المتصفح|my |the (?:web|browser|memory|account))/iu.test(fold(value))) add('place', value, original.slice(found.index, cutoff));
  }
  // Attached ب is accepted only after a clear change verb; ordinary ب-words are not places.
  const attached = /(?:اجعلها|اجعله|خليها|خليه|خلها|خله)\s+ب([\p{L}][\p{L} -]{0,45}?)(?=\s+و|[؟?.,،؛;!]|$)/iu.exec(text);
  if (attached && !/^(?:نصف|ثلث|ربع|ضعف|ميزاني)/u.test(fold(attached[1]))) add('place', attached[1], `ب${attached[1]}`);
  for (const found of text.matchAll(/(?:(?:ميزاني[ةه]|بميزاني[ةه]|budget(?: of| is| to)?|spend(?: of)?)\s*[:=]?\s*)((?:[£$€]\s*)?[\d٠-٩]+(?:[.,][\d٠-٩]+)?(?:\s*(?:£|\$|€|ريال|درهم|جنيه|دولار|SAR|AED|GBP|USD|EUR))?(?:\s*(?:يومي[ًاا]*|في اليوم|كل يوم|شهري[ًاا]*|في الشهر|per day|a day|daily|per month|monthly))?)/giu)) add('budget', found[1], found[0]);
  if (budgetContext || /ميزاني[ةه]|\b(?:budget|spend)\b/iu.test(text)) {
    for (const found of text.matchAll(/(?:[£$€]\s*[\d٠-٩]+(?:[.,][\d٠-٩]+)?|[\d٠-٩]+(?:[.,][\d٠-٩]+)?\s*(?:ريال|درهم|جنيه|دولار|GBP|USD|EUR|SAR|AED))(?:\s*(?:يومي[ًاا]*|في اليوم|كل يوم|شهري[ًاا]*|في الشهر|per day|a day|daily|per month|monthly))?/giu)) add('budget', found[0], found[0]);
  }
  for (const found of text.matchAll(/(?:نصف|ثلث|ربع|ضعف|ضعفين|نص)\s+(?:ال)?ميزاني[ةه]|\b(?:half|double|triple) (?:the |its )?budget\b/giu)) add('budget', found[0], found[0], true);
  return slots;
}

function withoutSlots(text: string, slots: readonly FoundSlot[]) {
  let rest = text;
  for (const slot of [...slots].sort((a, b) => b.span.length - a.span.length)) rest = rest.replace(slot.span, ' ');
  return trimPunctuation(rest.replace(/\s+/gu, ' ').replace(/\s+[وب]\s*$/u, ''));
}

function topicFrom(text: string, slots: readonly FoundSlot[], intent: RequestContextIntent) {
  let body = withoutSlots(text, slots);
  if (intent === 'memory') {
    body = body.replace(/^(?:(?:from|in) my (?:saved )?memory|(?:من|في) (?:ذاكرتي|ذاكرتك|الذاكر[ةه]))[\s,،:]+/iu, '')
      .replace(/\s+(?:(?:from|in) my (?:saved )?memory|(?:من|في) (?:ذاكرتي|ذاكرتك|الذاكر[ةه]))$/iu, '');
  }
  const rest = body.replace(ASK_PREFIX, '').replace(/^(?:حاله|حالة|the)\s+/iu, '');
  return trimPunctuation(rest) || null;
}

function requestedPointerField(fragment: string): string | undefined {
  const english = /\b(?:its|their|his|her|that(?:'s)?)\s+(name|city|address|colou?r|price|cost|height|age|specifications?)\b/iu.exec(fragment);
  if (english) return english[1];
  const arabic = /(?:^|\s)(سعر|موعد|اسم|طول|عنوان|لون|عمر|مدينت|تكلفت)(?:ها|ه)(?=\s|$)/u.exec(fold(trimPunctuation(fragment)));
  if (arabic) return ({ مدينت: 'مدينة', تكلفت: 'تكلفة' } as Record<string, string>)[arabic[1]] ?? arabic[1];
  return PROPERTY.exec(fold(fragment.replace(/(?:سعره|سعرها)/u, 'سعر').replace(/(?:موعده|موعدها)/u, 'موعد')))?.[1];
}

function replaceRequestedField(topic: string, field: string): string | null {
  const matches = [...topic.matchAll(CONTEXT_FIELD)];
  // A single explicit property can be replaced without guessing which of several
  // requested fields the user intended. Multi-field requests retain ambiguity.
  if (matches.length !== 1) return null;
  const match = matches[0];
  return `${topic.slice(0, match.index)}${field}${topic.slice(match.index + match[0].length)}`;
}

function followText(text: string) {
  let rest = text;
  for (let round = 0; round < 3; round += 1) {
    const next = rest.replace(FOLLOW_LEAD, '');
    if (next === rest) break;
    rest = next;
  }
  return trimPunctuation(rest.replace(CORRECTION, ''));
}

function correctiveView(text: string, previous: RequestContextState | null) {
  const eligible = FOLLOW_LEAD.test(text) || CORRECTION.test(fold(text)) || /^(?:not|ليس|ليست|مش|مو)(?=\s)/iu.test(text);
  if (!eligible || !previous) return { text: followText(text), correction: false, unbound: !previous && /^(?:not|ليس|ليست|مش|مو)(?=\s)/iu.test(text) };
  let matching = maskRequestLiteralData(text), correction = false, unbound = false;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const timeAliases = (value: string): readonly string[] => {
    for (const aliases of [['today', 'اليوم'], ['tomorrow', 'بكرة', 'بكره', 'غدا', 'غدًا'], ['tonight', 'الليلة']])
      if (aliases.some(alias => key(alias) === key(value))) return aliases;
    return [value];
  };
  const exclusions = [...matching.matchAll(/(?:^|[\s,،;؛])(?:not|instead of|rather than|ليس|ليست|مش|مو|بدل(?:ا من)?|وليس)\s+([^,،;؛!?؟]+)/giu)];
  for (const found of exclusions.toReversed()) {
    let remaining = found[1], bound = false;
    for (const slot of previous.slots) for (const alias of slot.kind === 'time' ? timeAliases(slot.value) : [slot.value]) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(alias)}(?![\\p{L}\\p{N}])`, 'giu');
      if (pattern.test(remaining)) { bound = true; pattern.lastIndex = 0; remaining = remaining.replace(pattern, ' '); }
    }
    remaining = trimPunctuation(remaining.replace(/\b(?:and|or)\b|(?:^|\s)و(?=\s|$)/giu, ' '));
    if (!bound || remaining) { unbound = true; continue; }
    correction = true;
    matching = matching.slice(0, found.index) + ' '.repeat(found[0].length) + matching.slice(found.index + found[0].length);
  }
  return { text: followText(matching.replace(/\s+/gu, ' ').trim()), correction, unbound };
}

function sourceFor(options: RequestContextOptions, revision: number) {
  const parsed = TurnId.safeParse(options.turnId);
  return parsed.success ? parsed.data : `turn-${revision}`;
}

function mergeSlots(found: readonly FoundSlot[], previous: RequestContextState | null, sourceTurnId: string) {
  const replaced = new Set(found.map(slot => slot.kind));
  const slots = (previous?.slots ?? []).filter(slot => !replaced.has(slot.kind)).map(slot => structuredClone(slot));
  for (const slot of found) {
    const base = slot.relative ? previous?.slots.find(item => item.kind === slot.kind) : undefined;
    slots.push({ kind: slot.kind, value: slot.value, sourceTurnId,
      ...(base && { relativeTo: { value: base.value, sourceTurnId: base.sourceTurnId } }) });
  }
  return slots;
}

function publicQuery(topic: string | null, slots: readonly RequestContextSlot[], intent: RequestContextIntent, scope: RequestContextState['scope']) {
  if (!topic || scope !== 'public' || !['web_search', 'news'].includes(intent)) return null;
  const parts = [topic, ...slots.filter(slot => slot.kind === 'place' || slot.kind === 'time').map(slot => slot.value)];
  return [...new Set(parts)].join(' ').trim();
}

function replaceTopic(fragment: string, previous: string): string | null {
  const own = trimPunctuation(fragment.replace(CORRECTION, '').replace(/\s+instead$/iu, ''));
  if (!own || POINTER.test(fold(own))) return null;
  // An explicit category is already a full new topic: الهلال must not survive النصر.
  if (PROPERTY.test(fold(own))) return own;
  const category = PROPERTY.exec(previous)?.[1];
  return category ? `${category} ${own}` : own;
}

function resolveRequestContextBase(request: string, previousValue?: unknown, options: RequestContextOptions = {}): RequestResolution {
  const input = typeof request === 'string' ? request : '';
  const tooLong = input.length > MAX_CONTEXT_REQUEST;
  const original = clean(input.slice(0, MAX_CONTEXT_REQUEST + 1));
  const ambiguities: RequestContextAmbiguity[] = [];
  let previous = previousValue === undefined || previousValue === null ? null : parseRequestContextState(previousValue);
  if (previous?.revision === 1_000_000_000) previous = null;
  if (previousValue != null && !previous) ambiguities.push('invalid_previous_state');
  if (previous && (CONTROL_TEXT.test(fold(previous.topic ?? '')) || previous.slots.some(slot => CONTROL_TEXT.test(fold(slot.value))))) {
    ambiguities.push('unsafe_previous_context');
    previous = null;
  }
  const revision = (previous?.revision ?? 0) + 1;
  const sourceTurnId = sourceFor(options, revision);
  const action = searchRequestText(original);
  const intent = classify(action);
  const scope = scopeFor(intent, action);
  const result: RequestResolution = {
    version: REQUEST_CONTEXT_VERSION, kind: 'new', original: original.slice(0, MAX_CONTEXT_REQUEST),
    resolved: original, query: null, intent, scope, topic: null, slots: [], ambiguities,
    provenance: [], nextState: null, pendingQuestionId: null,
  };
  if (!original || tooLong) {
    result.kind = 'ambiguous'; result.resolved = null;
    ambiguities.push(original ? 'request_too_long' : 'empty_request');
    return result;
  }
  if (CANCEL.test(fold(original))) return result;
  if (previous && (ACK.test(fold(original)) || THANKS.test(fold(original))) && !options.pendingQuestion) {
    result.nextState = { ...structuredClone(previous), revision };
    result.topic = previous.topic;
    result.slots = structuredClone(previous.slots);
    result.provenance = [
      ...(previous.topic ? [{ field: 'topic' as const, sourceTurnId: previous.topicSourceTurnId!, relation: 'inherited' as const }] : []),
      ...previous.slots.map(slot => ({ field: slot.kind, sourceTurnId: slot.sourceTurnId, relation: 'inherited' as const })),
    ];
    return result;
  }
  const correction = correctiveView(action, previous);
  if (correction.unbound || correction.correction && !correction.text) {
    result.kind = 'ambiguous'; result.scope = 'unknown'; ambiguities.push('unclear_replacement'); return result;
  }
  const found = explicitSlots(correction.text, intent === 'ads' || previous?.intent === 'ads');
  const follow = correction.correction || FOLLOW_LEAD.test(original) || CORRECTION.test(fold(original)) || pointsBack(fold(trimPunctuation(action)))
    || /^(?:بكرة|غدا|غدًا|tomorrow|tonight)(?:[؟?!.])?$/iu.test(original);
  const bareAnswer = intent !== 'compute' && !startsNewAction(requestActionText(original)) && !BROWSER.test(fold(original)) && !WRITING.test(fold(original)) && !REMINDER.test(fold(original))
    && !MEMORY.test(fold(original)) && !CODING.test(fold(original)) && !/^(?:ابحث|search|look up|ما |ماذا |كم |كيف |هل |what |when |where |how )/iu.test(fold(original));
  const pendingId = TurnId.safeParse(options.pendingQuestion?.id);
  if (pendingId.success && bareAnswer && (ACK.test(fold(original)) || found.length > 0 || original.split(' ').length <= 8)) {
    result.kind = 'answer'; result.pendingQuestionId = pendingId.data;
    result.intent = previous?.intent ?? 'unknown'; result.scope = previous?.scope ?? 'unknown';
    result.topic = previous?.topic ?? null;
    const allowed = options.pendingQuestion?.fields;
    const answers = allowed ? found.filter(slot => allowed.includes(slot.kind)) : [...found];
    // A single host-owned question provides the field name; its answer supplies
    // only the literal value. No currency, date, country or unit is filled in.
    if (allowed?.length === 1 && !answers.length && !ACK.test(fold(original)) && original.length <= MAX_VALUE) {
      const kind = allowed[0];
      if (requestSlotKinds.includes(kind) && (kind !== 'url' || /^https?:\/\/\S+$/iu.test(original))) {
        answers.push({ kind, value: trimPunctuation(original), span: original });
      }
    }
    result.slots = mergeSlots(answers, previous, sourceTurnId);
    if (result.slots.length > MAX_SLOTS || answers.filter(slot => slot.kind === 'budget').length > 1) {
      result.kind = 'ambiguous';
      ambiguities.push(result.slots.length > MAX_SLOTS ? 'too_many_slots' : 'multiple_budget_values');
      result.slots = result.slots.slice(0, MAX_SLOTS);
      return result;
    }
    result.nextState = previous ? { ...previous, revision, slots: result.slots } : null;
    result.provenance = result.slots.map(slot => ({ field: slot.kind, sourceTurnId: slot.sourceTurnId, relation: slot.sourceTurnId === sourceTurnId ? 'current' : 'inherited' }));
    return result;
  }
  // A self-contained private/new command always starts a fresh context, even after طيب/and.
  const explicitIntent = privateIntent(intent) || ['browser_command', 'writing', 'compute', 'unsupported', 'chat'].includes(intent);
  const sameIntentModification = previous && intent === previous.intent && (MODIFIER.test(fold(original)) || CORRECTION.test(fold(original)));
  const canFollow = follow && (!explicitIntent || sameIntentModification || intent === 'web_search');
  if (canFollow) {
    result.kind = 'follow_up';
    if (!previous?.topic || ['chat', 'unknown', 'unsupported'].includes(previous.intent)) {
      result.kind = 'ambiguous'; ambiguities.push('missing_reference');
      return result;
    }
    if (QUESTION_ONLY.test(fold(followText(original)))) {
      result.kind = 'ambiguous'; ambiguities.push('missing_question');
      return result;
    }
    result.intent = previous.intent;
    result.scope = previous.scope;
    result.topic = previous.topic;
    const fragment = correction.text;
    const remainder = withoutSlots(fragment, found).replace(MODIFIER, '').trim();
    const substantive = remainder.replace(ASK_PREFIX, '').replace(POINTER, '').replace(/^(?:و|ب)\s+/u, '').trim();
    const onlyModifiers = found.length > 0 && (!substantive || MODIFIER.test(fold(fragment))) && !CORRECTION.test(fold(fragment));
    const hasPointer = POINTER.test(fold(fragment));
    let contextualFound = found;
    if (!hasPointer && !onlyModifiers && substantive) {
      // For weather only, an unmarked short follow-up names a replacement place.
      if (/^(?:ال)?(?:طقس|درجه الحراره|weather|temperature)(?=\s|$)/iu.test(fold(previous.topic))
        && previous.slots.some(slot => slot.kind === 'place') && !PROPERTY.test(fold(substantive))
        && !found.some(slot => slot.kind === 'place') && !CORRECTION.test(fold(fragment)) && substantive.split(' ').length <= 4) {
        contextualFound = [...found, { kind: 'place', value: substantive, span: substantive }];
      } else {
        result.topic = replaceTopic(remainder, previous.topic);
        if (!result.topic) ambiguities.push('unclear_replacement');
      }
    } else if (hasPointer) {
      const property = requestedPointerField(fragment);
      const changed = property ? replaceRequestedField(previous.topic, property) : null;
      const oldProperty = PROPERTY.exec(fold(previous.topic))?.[0];
      if (changed) result.topic = changed;
      else if (property && oldProperty) result.topic = `${property} ${previous.topic.slice(oldProperty.length).trim()}`.trim();
    }
    result.slots = mergeSlots(contextualFound, previous, sourceTurnId);
    result.provenance = [
      { field: 'topic', sourceTurnId: result.topic === previous.topic ? previous.topicSourceTurnId! : sourceTurnId, relation: result.topic === previous.topic ? 'inherited' : 'replaced' },
      ...result.slots.map(slot => ({ field: slot.kind, sourceTurnId: slot.sourceTurnId,
        relation: slot.sourceTurnId === sourceTurnId ? previous.slots.some(old => old.kind === slot.kind) ? 'replaced' as const : 'current' as const : 'inherited' as const })),
    ];
  } else {
    result.topic = topicFrom(action, found, intent);
    result.slots = mergeSlots(found, null, sourceTurnId);
    result.provenance = [
      ...(result.topic ? [{ field: 'topic' as const, sourceTurnId, relation: 'current' as const }] : []),
      ...result.slots.map(slot => ({ field: slot.kind, sourceTurnId, relation: 'current' as const })),
    ];
  }
  if (result.topic && result.topic.length > MAX_TOPIC) ambiguities.push('topic_too_long');
  if (result.slots.length > MAX_SLOTS) ambiguities.push('too_many_slots');
  if (found.filter(slot => slot.kind === 'budget').length > 1) ambiguities.push('multiple_budget_values');
  const blocking = ambiguities.some(reason => !['invalid_previous_state', 'unsafe_previous_context'].includes(reason));
  if (blocking) {
    result.kind = 'ambiguous'; result.topic = result.topic?.slice(0, MAX_TOPIC) ?? null;
    result.slots = result.slots.slice(0, MAX_SLOTS);
    return result;
  }
  result.query = result.kind === 'new' && result.scope === 'public' && ['web_search', 'news'].includes(result.intent)
    ? action : publicQuery(result.topic, result.slots, result.intent, result.scope);
  result.nextState = {
    version: REQUEST_CONTEXT_VERSION, revision, intent: result.intent, scope: result.scope,
    topic: result.topic, topicSourceTurnId: result.topic ? result.provenance.find(item => item.field === 'topic')?.sourceTurnId ?? sourceTurnId : null,
    slots: structuredClone(result.slots),
  };
  return result;
}

function privateSource(intent: RequestContextIntent, currentText?: string): RequestScopeAssessment {
  // A private task label says nothing about whether literal data was supplied.
  // Keep an unsupported action's source unresolved rather than inventing a
  // supplied-content provenance that downstream source vetoes would trust.
  // Independently detected private/literal/credential sources bypass this
  // fallback in resolveRequestContext and retain their original assessment.
  // Only a CURRENT outer action may take this fallback. Intent keywords in a
  // report, or a legacy topic with no current instruction, do not establish an
  // action and retain the conservative private quarantine below.
  const current = currentText === undefined ? '' : requestOperationText(requestActionText(currentText));
  const currentAction = [NEW_ACTION, BROWSER, UNSUPPORTED, CODING_ACTION].some(pattern => pattern.test(current));
  if (['browser_command', 'ads', 'reminder', 'planning', 'coding', 'unsupported'].includes(intent) && currentAction) return {
    version: 1, source: 'unresolved', operation: 'act', scope: 'unknown',
    destination: intent === 'browser_command' ? 'browser_command' : 'unknown',
    publicQueryEligible: false, reasons: ['non_lookup_operation'],
  };
  return { version: 1, source: intent === 'memory' ? 'prior_conversation' : intent === 'pc' ? 'local_state' : 'supplied_content',
    operation: intent === 'memory' || intent === 'pc' ? 'lookup' : intent === 'writing' ? 'transform' : intent === 'compute' ? 'compute' : 'act',
    destination: intent === 'memory' || intent === 'pc' || intent === 'writing' || intent === 'compute' ? intent : 'unknown',
    scope: 'private', publicQueryEligible: false, reasons: ['non_lookup_operation'] };
}

function previousSource(state: RequestContextState | null): RequestScopeAssessment | undefined {
  if (!state) return undefined;
  const stored = parseRequestScopeAssessment(state.sourceAssessment);
  if (stored) return stored;
  if (state.scope === 'private') return privateSource(state.intent);
  if (state.scope === 'public') return { version: 1, source: 'public_lookup', scope: 'public',
    operation: state.intent === 'browser_command' ? 'act' : 'lookup', destination: state.intent === 'browser_command' ? 'browser_command' : 'web_search',
    publicQueryEligible: state.intent !== 'browser_command', reasons: ['public_subject'] };
  return assessRequestScope(state.topic ?? '');
}

/** Apply the shared source boundary after reference resolution, before exposing a public query. */
export function resolveRequestContext(request: string, previousValue?: unknown, options: RequestContextOptions = {}): RequestResolution {
  const constraints = parseUserRequestConstraints(request);
  const result = resolveRequestContextBase(constraints?.safeActionText ?? request, previousValue, options);
  const previous = parseRequestContextState(previousValue);
  if (isEntireLiteralRequest(request) && result.kind !== 'answer') {
    result.kind = 'ambiguous'; result.intent = 'unknown'; result.scope = 'private'; result.query = null;
    result.topic = null; result.slots = []; result.nextState = null; result.provenance = [];
    result.ambiguities.push('missing_question');
  }
  if (constraints) {
    result.constraints = constraints;
    result.original = clean(request).slice(0, MAX_CONTEXT_REQUEST);
    if (result.resolved !== null) result.resolved = clean(request);
    if (constraints.standalone || constraints.ambiguous) {
      result.kind = constraints.ambiguous ? 'ambiguous' : 'new'; result.intent = constraints.ambiguous ? 'unknown' : 'chat';
      result.scope = 'unknown'; result.query = null; result.topic = null; result.slots = []; result.provenance = [];
      result.nextState = constraints.standalone && !constraints.ambiguous ? previous : null;
      if (constraints.ambiguous) result.ambiguities.push('unclear_replacement');
    }
  }
  const priorSource = previousSource(previous);
  let source = assessRequestScope(requestActionText(result.resolved ?? ''), { contextKind: result.kind, previous: priorSource });
  const retainedAcknowledgement = result.intent === 'chat' && result.nextState !== null && result.nextState.intent !== 'chat';
  if (source.scope === 'private') {
    if (source.operation === 'transform' && source.destination === 'writing') result.intent = 'writing';
    else if (['web_search', 'unknown', 'writing'].includes(result.intent) && source.destination !== 'unknown'
      && source.destination !== 'web_search' && source.destination !== 'browser_command') result.intent = source.destination;
    result.scope = 'private'; result.query = null;
  } else if (source.reasons.includes('public_document_reference') && result.kind === 'new') {
    // Quoted titles are public lookup operands, even when their literal wording
    // contains a personal pronoun such as an article titled "My memory".
    result.intent = source.destination === 'browser_command' ? 'browser_command' : 'web_search';
    result.scope = 'public'; result.query = source.publicQueryEligible ? constraints?.safeActionText ?? result.resolved : null;
  } else if (result.scope === 'private') source = privateSource(result.intent, constraints?.safeActionText ?? result.resolved ?? undefined);
  else if (source.source === 'unresolved' && source.reasons.includes('unresolved_reference') && result.kind !== 'answer') {
    result.kind = 'ambiguous'; result.scope = 'unknown'; result.query = null; result.nextState = null;
    if (!result.ambiguities.includes('missing_reference')) result.ambiguities.push('missing_reference');
  }
  if (result.query && !reviewPublicProjection(requestActionText(result.original), result.query, { contextKind: result.kind, previous: priorSource }).eligible) {
    result.query = null;
    // A search projection being unavailable does not make a self-contained
    // instruction ambiguous. Local capabilities or a model may still handle it.
    // Only an unresolved contextual expansion needs a replacement clarification.
    if (result.kind === 'follow_up') {
      result.kind = 'ambiguous'; result.nextState = null;
      result.ambiguities.push('unclear_replacement');
    } else if (result.kind === 'new') {
      result.scope = source.scope;
    }
  }
  result.sourceAssessment = source;
  if (result.nextState && !retainedAcknowledgement) result.nextState = parseRequestContextState({
    ...result.nextState, intent: result.intent, scope: result.scope, sourceAssessment: source,
  });
  return result;
}

/** Bootstrap legacy context from user records only. Raw assistant/page strings are not accepted. */
export function bootstrapRequestContext(turns: readonly { text: string; id?: string }[]): RequestContextState | null {
  let state: RequestContextState | null = null;
  for (const turn of turns.slice(-MAX_HISTORY)) {
    const resolution = resolveRequestContext(turn.text, state, { turnId: turn.id });
    state = resolution.nextState;
  }
  return state;
}
