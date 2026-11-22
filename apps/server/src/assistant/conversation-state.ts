import { analyzeCompoundRequest } from './compound-request.js';
import { resolveRequestContext, type RequestContextState, type RequestResolution, type RequestSlotKind } from './request-context.js';

/**
 * Conversation state v2 (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, phase 1). Shadow only:
 * no chat path reads it yet, so it cannot change a reply.
 *
 * It wraps the v1 request context and keeps v1's boundary:
 * - only user turns are instructions;
 * - results the host displayed are kept as numbered lookup operands, never as instructions;
 * - a turn that v1 finds private, or that follows a private topic, never yields a public query.
 *
 * On top of v1 it keeps the entity apart from the asked property and from the place and time operands
 * («سعر الذهب في مصر اليوم» is entity الذهب, place مصر, time اليوم; for weather the place is the entity),
 * the numbered results of the last reply, the corrections, the pending step, and the date apart from the clock time.
 *
 * Measured against v1 with `npx tsx scripts/conversation-state/eval.ts` (reports under artifacts/conversation-state-20261122/).
 */
export const CONVERSATION_STATE_VERSION = 2;
const MAX_TOPICS = 5;
const MAX_RESULTS = 20;
const MAX_CORRECTIONS = 20;
const MAX_LABEL = 200;

export type TurnType = 'new_request' | 'topic_change' | 'follow_up_property' | 'follow_up_entity' | 'reference'
  | 'correction' | 'field_edit' | 'card_answer' | 'compound' | 'small_talk' | 'ambiguous';
export type PropertyName = 'population' | 'capital' | 'area' | 'currency' | 'language' | 'leader' | 'price'
  | 'weather' | 'age' | 'height' | 'match' | 'founded';
export type EditableField = 'date' | 'clock' | 'place' | 'budget' | 'language';
/** 'country' marks properties of a state (currency, language, leader, capital): «its currency» after a capital question means the country, not the city. */
type OperandKind = 'place' | 'country' | 'person' | 'thing';

export interface TopicFrame {
  entity: string | null;
  property: PropertyName | null;
  /** A place operand kept apart from the entity. For a weather question the place is the entity itself. */
  place: string | null;
  /** A time operand («اليوم», «بكرا», «tomorrow») kept apart from the entity. */
  time: string | null;
  sourceTurnId: string;
  entityOrigin: 'user' | 'host_result';
  /** True only for a public lookup; private and action topics never feed a search query. */
  lookup: boolean;
}
export interface HostResult { index: number; label: string; kind: 'place' | 'person' | 'item' | 'news' | 'link' | 'value'; sourceTurnId: string }
export interface CorrectionRecord { field: 'entity' | EditableField; from: string | null; to: string; turnId: string }
export interface PendingStep { kind: 'question_card' | 'approval' | 'sign_in'; id: string; fields?: RequestSlotKind[] }
export interface Schedule { date: string | null; clock: string | null; sourceTurnId: string }
export interface ConversationStateV2 {
  version: typeof CONVERSATION_STATE_VERSION;
  /** The v1 state, exactly as resolveRequestContext returned it. */
  base: RequestContextState | null;
  topics: TopicFrame[];
  results: HostResult[];
  corrections: CorrectionRecord[];
  pending: PendingStep | null;
  schedule: Schedule | null;
}
export interface TurnUnderstanding {
  type: TurnType;
  entity: string | null;
  property: PropertyName | null;
  place: string | null;
  time: string | null;
  /** Public lookup projection. Always null for private turns, actions and host-result actions. */
  query: string | null;
  /** One line a reply may show after resolving an acceptable ambiguity. */
  assumption: string | null;
  /** What to ask the user instead of guessing. */
  needs: 'missing_reference' | 'missing_value' | null;
  /** The single field this turn changes: an explicit edit («عدّل التاريخ») or a slot-only follow-up («وبكرا؟», «وفي مصر؟»). */
  edit?: { field: EditableField; value: string | null };
  /** A displayed result the user pointed at. Its label is data, never an instruction. */
  reference?: { index: number; label: string };
  v1: RequestResolution;
  next: ConversationStateV2;
}

interface PropertyForms {
  name: PropertyName;
  ar: string[];
  /** Irregular pronoun forms; the regular ones (سعره, سعرها, سعرهم, عاصمتها…) are generated from `ar`. */
  arPronoun: string[];
  en: string[];
  enPronoun: RegExp;
  phraseAr: string;
  phraseEn: string;
  /** What the property is asked about; «its X» after an entity-valued property refers to the answer only when X applies to it. */
  appliesTo: OperandKind[];
  /** The answer is itself an entity of this kind (a city, a person), so «its X» after it may mean that answer. */
  answerKind?: 'place' | 'person';
  /** The place IS the entity («الطقس في لندن» asks about لندن). */
  locationValued?: boolean;
}

// Forms are folded (see fold): ة→ه, أ/إ/آ→ا, ى→ي, no diacritics.
const PROPERTIES: PropertyForms[] = [
  { name: 'population', ar: ['عدد سكان', 'عدد السكان', 'تعداد سكان', 'سكان'], arPronoun: [],
    en: ['population of', 'population'], enPronoun: /\b(?:its|their) population\b|\bhow many people live (?:there|in it)\b/u,
    phraseAr: 'عدد سكان', phraseEn: 'population of', appliesTo: ['place'] },
  { name: 'capital', ar: ['عاصمه'], arPronoun: [], en: ['capital of', 'capital'], enPronoun: /\b(?:its|their) capital\b/u,
    phraseAr: 'عاصمة', phraseEn: 'capital of', appliesTo: ['country'], answerKind: 'place' },
  { name: 'area', ar: ['مساحه'], arPronoun: [], en: ['area of', 'area'], enPronoun: /\b(?:its|their) area\b|\bhow big is (?:it|that)\b/u,
    phraseAr: 'مساحة', phraseEn: 'area of', appliesTo: ['place'] },
  { name: 'currency', ar: ['عمله'], arPronoun: [], en: ['currency of', 'currency'], enPronoun: /\b(?:its|their) currency\b/u,
    phraseAr: 'عملة', phraseEn: 'currency of', appliesTo: ['country'] },
  { name: 'language', ar: ['لغه'], arPronoun: [], en: ['language of', 'language'], enPronoun: /\b(?:its|their) (?:official )?language\b/u,
    phraseAr: 'لغة', phraseEn: 'language of', appliesTo: ['country'] },
  { name: 'leader', ar: ['رئيس', 'حاكم', 'ملك'], arPronoun: [], en: ['president of', 'leader of', 'king of', 'president', 'leader'],
    enPronoun: /\b(?:its|their) (?:president|leader|king)\b|\bwho (?:leads|rules) (?:it|them)\b/u, phraseAr: 'رئيس', phraseEn: 'leader of',
    appliesTo: ['country'], answerKind: 'person' },
  { name: 'price', ar: ['سعر', 'ثمن'], arPronoun: [], en: ['price of', 'price', 'cost of'],
    enPronoun: /\b(?:its|their) (?:price|cost)\b|\bhow much is (?:it|that)\b/u, phraseAr: 'سعر', phraseEn: 'price of', appliesTo: ['thing'] },
  { name: 'weather', ar: ['طقس', 'درجه الحراره', 'حراره'], arPronoun: [], en: ['weather in', 'weather', 'temperature in'],
    enPronoun: /\bthe weather there\b/u, phraseAr: 'طقس', phraseEn: 'weather in', appliesTo: ['place'], locationValued: true },
  { name: 'age', ar: ['عمر'], arPronoun: [], en: ['age of'], enPronoun: /\bhow old is (?:he|she|it)\b|\b(?:his|her|its) age\b/u,
    phraseAr: 'عمر', phraseEn: 'age of', appliesTo: ['person', 'thing'] },
  { name: 'height', ar: ['ارتفاع', 'طول'], arPronoun: [], en: ['height of'],
    enPronoun: /\bhow tall is (?:it|he|she)\b|\b(?:its|his|her) height\b/u, phraseAr: 'ارتفاع', phraseEn: 'height of', appliesTo: ['person', 'place', 'thing'] },
  { name: 'match', ar: ['مباراه', 'ماتش'], arPronoun: [], en: ['next match of', 'match of', 'match', 'game'],
    enPronoun: /\b(?:its|their) (?:next )?(?:match|game)\b/u, phraseAr: 'مباراة', phraseEn: 'next match of', appliesTo: ['thing'] },
  { name: 'founded', ar: ['تاريخ تاسيس', 'تاسيس'], arPronoun: [], en: ['founding date of', 'founded'],
    enPronoun: /\bwhen was (?:it|she|he) founded\b/u, phraseAr: 'تاريخ تأسيس', phraseEn: 'founding date of', appliesTo: ['place', 'thing'] },
];
const PROPERTY_BY_NAME = new Map(PROPERTIES.map(forms => [forms.name, forms]));

/** سعر → سعره سعرها سعرهم…; عاصمه → عاصمتها (a final ة becomes ت before the suffix); عدد سكان → عدد سكانها. */
const AR_SUFFIXES = ['ه', 'ها', 'هم', 'هن', 'كم', 'ك'];
function arabicPronounForms(base: string): string[] {
  const parts = base.split(' ');
  const last = parts.at(-1)!.replace(/^ال/u, '');
  const stem = last.endsWith('ه') ? `${last.slice(0, -1)}ت` : last;
  return AR_SUFFIXES.map(suffix => [...parts.slice(0, -1), `${stem}${suffix}`].join(' '));
}
const PRONOUN_FORMS = new Map<PropertyName, string[]>(PROPERTIES.map(forms =>
  [forms.name, [...new Set([...forms.arPronoun, ...forms.ar.flatMap(arabicPronounForms)])]]));

const LEADS = new Set(['طيب', 'طب', 'حسنا', 'تمام', 'اوكي', 'ok', 'okay', 'well', 'and', 'so', 'also', 'و', 'ف', 'ثم']);
const QUESTION_WORDS = new Set(['ما', 'ماذا', 'من', 'متي', 'كم', 'اين', 'هل', 'ماهي', 'ماهو', 'هو', 'هي', 'يبلغ', 'حاله', 'قل', 'لي',
  'اعطني', 'اخبرني', 'ايه', 'ايش', 'وش', 'شو', 'شنو', 'مين', 'وين', 'كام', 'ليش', 'ليه', 'لماذا', 'كيف',
  'what', 'whats', "what's", 'who', 'whos', "who's", 'when', 'where', 'how', 'is', 'are', 'was', 'were', 'tell', 'me',
  'about', 'much', 'many', 'do', 'does', 'you', 'know', 'give', 'the', 'a', 'an']);
const PREPOSITIONS = new Set(['في', 'عن', 'ل', 'من', 'علي', 'of', 'in', 'for', 'at', 'about', 'the', 'on']);
/** A place operand follows one of these; «الى» folds to «الي». */
const PLACE_PREPOSITIONS = new Set(['في', 'ب', 'الي', 'in', 'at', 'to']);
/** Folded time words, longest first. v1 reads an unknown dialect spelling such as «بكرا» as a place; here it is a time. */
const TIME_FORMS = ['الاسبوع القادم', 'الاسبوع الجاي', 'الشهر القادم', 'هذا الاسبوع', 'بعد غد', 'this weekend', 'this week', 'next week', 'next month',
  'اليوم', 'الان', 'حاليا', 'غدا', 'بكرا', 'بكره', 'الليله', 'امس', 'البارحه', 'today', 'now', 'currently', 'tomorrow', 'tonight', 'yesterday']
  .map(form => form.split(' ')).sort((a, b) => b.length - a.length);
const TIME_SET = new Set(TIME_FORMS.map(form => form.join(' ')));
const ORDINALS: Record<string, number> = {
  الاول: 1, الاولي: 1, اول: 1, اولي: 1, الثاني: 2, الثانيه: 2, ثاني: 2, ثانيه: 2, الثالث: 3, الثالثه: 3, ثالث: 3, ثالثه: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6, السابع: 7, السابعه: 7, الثامن: 8, الثامنه: 8,
  التاسع: 9, التاسعه: 9, العاشر: 10, العاشره: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
};
const REFERENCE_NOUNS = new Set(['المدينه', 'مدينه', 'الخبر', 'خبر', 'النتيجه', 'نتيجه', 'الخيار', 'خيار', 'الرابط', 'رابط', 'العنصر',
  'البند', 'رقم', 'number', 'item', 'option', 'result', 'link', 'no']);
const ACTION_VERBS = /^(?:افتح|اقرا|اعرض|ادخل|شغل|open|read|show|play|visit)$/u;
const EDIT_VERBS = new Set(['عدل', 'غير', 'بدل', 'حدث', 'خلي', 'اجعل', 'change', 'edit', 'update', 'set', 'make', 'move']);
const EDIT_FIELDS: Record<string, EditableField> = {
  التاريخ: 'date', تاريخ: 'date', اليوم: 'date', يوم: 'date', الموعد: 'date', موعد: 'date',
  الوقت: 'clock', وقت: 'clock', الساعه: 'clock', ساعه: 'clock',
  المكان: 'place', مكان: 'place', المدينه: 'place', مدينه: 'place',
  الميزانيه: 'budget', ميزانيه: 'budget', اللغه: 'language', لغه: 'language',
  date: 'date', day: 'date', time: 'clock', hour: 'clock', place: 'place', city: 'place', location: 'place', budget: 'budget', language: 'language',
};
const EDIT_FILLERS = new Set(['فقط', 'بس', 'لي', 'only', 'just', 'the', 'to', 'الي', 'ل', '=', ':', 'please']);
const SMALL_TALK = /^(?:شكرا(?: لك| جزيلا| كثيرا)?|مشكور|تسلم|يعطيك العافيه|الله يعطيك العافيه|ممتاز|رائع|حلو|جميل|مرحبا|اهلا|اهلين|هلا|السلام عليكم|صباح الخير|مساء الخير|كيف حالك|كيفك|شخبارك|كيف الحال|عامل ايه|thanks|thank you|thx|great|cool|nice|perfect|awesome|hi|hello|hey|good morning|good evening|how are you|what's up)(?:\s+(?:يا\s+)?(?:موحسن|mohassan))?$/u;
/** A yes or a no to the host's own approval or sign-in step; the code decides what follows, never the text. */
const APPROVE = /^(?:نعم|اي|ايوه|ايوا|اجل|تمام|طيب|حسنا|موافق|اوافق|اكيد|ماشي|يلا|لا|yes|yeah|yep|ok(?:ay)?|sure|fine|agreed|approved?|no|nope)(?!\p{L})/u;
const CONTINUE = /(?:^|[\s،,])(?:تابع|اكمل|كمل|استمر|امض|واصل|نفذ|go ahead|continue|proceed|carry on|do it|resume)(?!\p{L})/u;
const DONE = /(?:^|[\s،,])(?:تم|خلصت|انتهيت|سجلت(?: الدخول)?|دخلت|done|finished|logged in|signed in|i'm in|im in)(?!\p{L})/u;
/** «افتح موقعًا واعرض لي محتواه»: a browser command whose target is only a generic noun must ask which site. */
const GENERIC_TARGET = /^(?:افتح|ادخل|اعرض|زر|open|visit|go to)\s+(?:لي\s+)?(?:(?:ال)?موقعا?|(?:ال)?صفحه|(?:ال)?رابط|(?:a|the|some|any)\s+(?:website|site|web ?page|page|link))(?=$|\s+(?:ثم|and|then|لي)(?!\p{L})|\s+و(?:اعرض|اقرا|ابحث|افتح|قل|اخبرني|لخص|انسخ))/u;
const CLOCK = /(?:الساعه|الساعة)\s*\d{1,2}(?::\d{2})?(?:\s*(?:صباحا|مساء|ظهرا|عصرا|ليلا|ص|م)(?!\p{L}))?|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/iu;
const DATE_AR = /(?:يوم\s+)?(?:ال)?(?:سبت|احد|أحد|اثنين|إثنين|ثلاثاء|اربعاء|أربعاء|خميس|جمعة|جمعه)(?!\p{L})|اليوم|غدا|بكرة|بكره|بعد غد|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/u;
const DATE_EN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/iu;

const clean = (text: string) => text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/[ـً-ٰٟ]/gu, '').replace(/\s+/gu, ' ').trim();
const fold = (text: string) => clean(text).normalize('NFKC').replace(/\p{Cf}/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'").toLowerCase();
const strip = (text: string) => text.replace(/^[\s،,.!?؟:؛;«»"'()[\]]+|[\s،,.!?؟:؛;«»"'()[\]]+$/gu, '');
const wordsOf = (text: string) => clean(text).split(' ').map(strip).filter(Boolean);
const isArabic = (text: string) => /\p{Script=Arabic}/u.test(text);
const label = (text: string) => clean(text).slice(0, MAX_LABEL);
/** «وفي» → «في», «والطقس» → «طقس»: the bare word behind a leading و/ف/ب and ال. */
const bareWord = (word: string) => word.replace(/^[وفب](?=.{2})/u, '').replace(/^ال(?=.{2})/u, '');

export function emptyConversationState(): ConversationStateV2 {
  return { version: CONVERSATION_STATE_VERSION, base: null, topics: [], results: [], corrections: [], pending: null, schedule: null };
}

/** Host-owned data from the reply just shown (answer entity, list items). Never treated as an instruction. */
export function withHostResults(state: ConversationStateV2, items: readonly { label: string; kind: HostResult['kind'] }[],
  turnId: string): ConversationStateV2 {
  const next = structuredClone(state);
  next.results = items.slice(0, MAX_RESULTS).map((item, index) => ({ index: index + 1, label: label(item.label), kind: item.kind, sourceTurnId: turnId }))
    .filter(item => item.label.length > 0);
  return next;
}

export function withPending(state: ConversationStateV2, pending: PendingStep | null): ConversationStateV2 {
  const next = structuredClone(state);
  next.pending = pending ? structuredClone(pending) : null;
  return next;
}

/** Index of the folded word sequence `form` in `folded`; و/ف/ب may lead the first word and ال any word. */
function findSequence(folded: readonly string[], form: readonly string[], from = 0, skip?: ReadonlySet<number>): number {
  outer: for (let start = from; start + form.length <= folded.length; start++) {
    for (let offset = 0; offset < form.length; offset++) {
      if (skip?.has(start + offset)) continue outer;
      const want = form[offset]!;
      const variants = [want, `ال${want}`];
      if (offset === 0) variants.push(`و${want}`, `ف${want}`, `ب${want}`, `وال${want}`, `بال${want}`, `فال${want}`);
      if (!variants.includes(folded[start + offset]!)) continue outer;
    }
    return start;
  }
  return -1;
}

interface PropertyHit { forms: PropertyForms; start: number; length: number; pronoun: boolean }

function findProperty(folded: readonly string[], whole: string): PropertyHit | null {
  const hits: PropertyHit[] = [];
  for (const forms of PROPERTIES) {
    if (forms.enPronoun.test(whole)) hits.push({ forms, start: -1, length: 0, pronoun: true });
    for (const [list, pronoun] of [[PRONOUN_FORMS.get(forms.name)!, true], [forms.ar, false], [forms.en, false]] as const) {
      for (const form of list) {
        const parts = form.split(' ');
        const start = findSequence(folded, parts);
        if (start >= 0) hits.push({ forms, start, length: parts.length, pronoun });
      }
    }
  }
  hits.sort((a, b) => Number(b.pronoun) - Number(a.pronoun) || a.start - b.start || b.length - a.length);
  return hits[0] ?? null;
}

/** Skips connectors and question words; a leading و/ف on a function word counts as the word itself. */
function contentStart(folded: readonly string[]): number {
  let index = 0;
  while (index < folded.length) {
    const word = folded[index]!;
    const bare = /^[وف].{2,}$/u.test(word) ? word.slice(1) : word;
    if (LEADS.has(word) || QUESTION_WORDS.has(word) || QUESTION_WORDS.has(bare) || PREPOSITIONS.has(bare) && bare !== word) index++;
    else break;
  }
  return index;
}

interface Operands { entity: string | null; place: string | null; time: string | null }
interface SlotHint { kind: 'place' | 'time'; value: string }

/** The original words of folded[at..at+length), without the و/ف/ب or ال that the match allowed on the first word. */
function originalSpan(words: readonly string[], folded: readonly string[], at: number, length: number, first: string): string {
  const extra = folded[at]!.length - first.length;
  return [words[at]!.slice(Math.max(0, extra)), ...words.slice(at + 1, at + length)].join(' ');
}

/**
 * Splits the words after the property into the entity and its place and time operands, with v1's slot values as hints.
 * «ايفون 15 في السعودية» → entity ايفون 15, place السعودية. For a location-valued property the place is the entity.
 */
function operandsFrom(words: readonly string[], folded: readonly string[], from: number, hints: readonly SlotHint[], locationValued: boolean): Operands {
  const removed = new Set<number>();
  let time: string | null = null;
  let place: string | null = null;
  for (const form of TIME_FORMS) {
    const at = findSequence(folded, form, from, removed);
    if (at < 0) continue;
    for (let offset = 0; offset < form.length; offset++) removed.add(at + offset);
    time ??= originalSpan(words, folded, at, form.length, form[0]!);
  }
  for (const hint of hints) {
    const parts = fold(hint.value).split(' ').filter(Boolean);
    if (!parts.length) continue;
    if (TIME_SET.has(parts.join(' '))) { time ??= hint.value; continue; }
    const at = findSequence(folded, parts, from, removed);
    if (at < 0) continue;
    for (let offset = 0; offset < parts.length; offset++) removed.add(at + offset);
    if (at - 1 >= from && PLACE_PREPOSITIONS.has(bareWord(folded[at - 1]!))) removed.add(at - 1);
    if (hint.kind === 'time') time ??= hint.value;
    else place ??= hint.value;
  }
  let rest: number[] = [];
  for (let index = from; index < words.length; index++) if (!removed.has(index)) rest.push(index);
  while (rest.length && (QUESTION_WORDS.has(folded[rest[0]!]!) || LEADS.has(folded[rest[0]!]!))) rest.shift();
  while (rest.length && (QUESTION_WORDS.has(folded[rest.at(-1)!]!) || LEADS.has(folded[rest.at(-1)!]!))) rest.pop();
  // Without a hint, a remainder that is only «في X» / «in X» names a place.
  if (!place && rest.length >= 2 && PLACE_PREPOSITIONS.has(bareWord(folded[rest[0]!]!))) {
    place = rest.slice(1).map(index => words[index]!).join(' ');
    rest = [];
  }
  while (rest.length && PREPOSITIONS.has(folded[rest[0]!]!)) rest.shift();
  const entity: string | null = rest.length ? rest.map(index => words[index]!).join(' ') : null;
  // For weather the place is the entity. A place with no entity («كم السكان في مصر؟», «وفي الامارات؟») is left apart:
  // a new request promotes it to the entity, a follow-up reads it as the changed operand.
  if (place && locationValued) return { entity: place, place: null, time };
  return { entity, place, time };
}

/** A new request about «في مصر» with nothing else named is about مصر. */
function promotePlace(operands: Operands): Operands {
  return !operands.entity && operands.place ? { entity: operands.place, place: null, time: operands.time } : operands;
}

function startsWithFollowLead(folded: readonly string[], whole: string): boolean {
  const first = folded[0] ?? '';
  if (['طيب', 'طب', 'حسنا', 'تمام', 'and', 'so', 'also'].includes(first)) return true;
  if (/^(?:what|how) about\b/u.test(whole)) return true;
  if (!/^و.{2,}$/u.test(first)) return false;
  const bare = first.slice(1);
  return QUESTION_WORDS.has(bare) || PREPOSITIONS.has(bare) || TIME_SET.has(bare) || PROPERTIES.some(forms => [...forms.ar, ...PRONOUN_FORMS.get(forms.name)!]
    .some(form => [form.split(' ')[0], `ال${form.split(' ')[0]}`].includes(bare)));
}

function findOrdinal(folded: readonly string[]): number | null {
  for (let index = 0; index < folded.length; index++) {
    const word = folded[index]!.replace(/^[وفبل](?=ال)/u, '');
    if (ORDINALS[word] !== undefined) return ORDINALS[word]!;
    if (/^\d{1,2}$/u.test(word) && index > 0 && REFERENCE_NOUNS.has(folded[index - 1]!)) return Number(word);
    if (/^#\d{1,2}$/u.test(word)) return Number(word.slice(1));
  }
  return null;
}

function correctionValueStart(folded: readonly string[]): number | null {
  let index = ['لا', 'no'].includes(folded[0] ?? '') ? 1 : 0;
  if (folded[index] === 'i' && ['mean', 'meant'].includes(folded[index + 1] ?? '')) return index + 2;
  if (['اقصد', 'قصدت', 'قصدي', 'اعني', 'بل', 'rather', 'actually'].includes(folded[index] ?? '')) return index + 1;
  return null;
}

function fieldEdit(words: readonly string[], folded: readonly string[]): { field: EditableField; value: string | null } | null {
  let index = 0;
  while (['please', 'لو', 'سمحت', 'فضلك', 'من'].includes(folded[index] ?? '')) index++;
  if (!EDIT_VERBS.has(folded[index] ?? '')) return null;
  index++;
  while (['only', 'just', 'the', 'لي'].includes(folded[index] ?? '')) index++;
  const field = EDIT_FIELDS[folded[index] ?? ''];
  if (!field) return null;
  index++;
  while (index < folded.length && EDIT_FILLERS.has(folded[index]!)) index++;
  const value = words.slice(index).join(' ').trim();
  return { field, value: value || null };
}

function parseSchedule(text: string): { date: string | null; clock: string | null } | null {
  const plain = clean(text);
  const clock = CLOCK.exec(plain)?.[0]?.trim() ?? null;
  const withoutClock = clock ? plain.replace(clock, ' ') : plain;
  const english = DATE_EN.exec(withoutClock);
  const date = DATE_AR.exec(withoutClock)?.[0]?.trim() ?? (english ? (english[1] ?? english[0]).trim() : null);
  return date || clock ? { date, clock } : null;
}

function compose(property: PropertyForms | null, entity: string | null, arabic: boolean): string | null {
  if (!entity) return null;
  if (!property) return entity;
  return arabic ? `${property.phraseAr} ${entity}` : `${property.phraseEn} ${entity}`;
}

/** «سعر الذهب مصر اليوم»: the property phrase, the entity, then the place and time operands when there are any. */
function composeQuery(property: PropertyForms | null, operands: Operands, arabic: boolean): string | null {
  const head = compose(property, operands.entity, arabic);
  return head ? [head, operands.place, operands.time].filter(Boolean).join(' ') : null;
}

/** A property of places or states (population, capital, weather…): a place named with it is the entity, not an operand. */
function placeEntity(property: PropertyForms | null): boolean {
  return Boolean(property?.appliesTo.some(kind => kind === 'place' || kind === 'country'));
}

function assumptionLine(entity: string, arabic: boolean): string {
  return arabic ? `فهمتُ أن المقصود ${entity}.` : `I took this to mean ${entity}.`;
}

function pushTopic(next: ConversationStateV2, frame: TopicFrame): void {
  next.topics = [...next.topics, frame].slice(-MAX_TOPICS);
}

function pushCorrection(next: ConversationStateV2, record: CorrectionRecord): void {
  next.corrections = [...next.corrections, record].slice(-MAX_CORRECTIONS);
}

export function understandTurn(state: ConversationStateV2, text: string, turnId: string): TurnUnderstanding {
  const pendingQuestion = state.pending?.kind === 'question_card' ? { id: state.pending.id, fields: state.pending.fields } : undefined;
  const v1 = resolveRequestContext(text, state.base, { turnId, pendingQuestion });
  const words = wordsOf(text);
  const folded = words.map(fold);
  const whole = fold(strip(text));
  const arabic = isArabic(text);
  const top = state.topics.at(-1) ?? null;
  const topForms = top?.property ? PROPERTY_BY_NAME.get(top.property) ?? null : null;
  const next = structuredClone(state);
  next.base = v1.nextState ?? state.base;
  const privateNow = v1.scope === 'private';
  // v1 extracted this turn's own place and time operands; they are hints for splitting the entity, never instructions.
  const hints: SlotHint[] = v1.slots.filter(slot => slot.sourceTurnId === turnId && (slot.kind === 'place' || slot.kind === 'time'))
    .map(slot => ({ kind: slot.kind as 'place' | 'time', value: slot.value }));
  const result = (type: TurnType, fields: Partial<Omit<TurnUnderstanding, 'type' | 'v1' | 'next'>> = {}): TurnUnderstanding => ({
    type, entity: null, property: null, place: null, time: null, query: null, assumption: null, needs: null, ...fields, v1, next,
  });
  const frameOf = (fields: Partial<TopicFrame> & Pick<TopicFrame, 'entity' | 'property' | 'lookup'>): TopicFrame => ({
    place: null, time: null, sourceTurnId: turnId, entityOrigin: 'user', ...fields,
  });

  if (SMALL_TALK.test(whole)) {
    next.base = state.base;
    return result('small_talk');
  }
  if (state.pending) {
    const acknowledged = state.pending.kind === 'question_card' ? v1.kind === 'answer'
      : state.pending.kind === 'approval' ? APPROVE.test(whole) || CONTINUE.test(whole)
        : DONE.test(whole) || APPROVE.test(whole) || CONTINUE.test(whole);
    if (acknowledged) {
      next.pending = null;
      return result('card_answer');
    }
  }
  if (analyzeCompoundRequest(text).kind === 'compound') {
    next.results = [];
    return result('compound');
  }

  const edit = fieldEdit(words, folded);
  if (edit) {
    if (!edit.value) return result('field_edit', { edit, needs: 'missing_value' });
    if (edit.field === 'date' || edit.field === 'clock') {
      if (!state.schedule) return result('field_edit', { edit, needs: 'missing_reference' });
      next.schedule = { ...state.schedule, [edit.field]: edit.value, sourceTurnId: turnId };
      pushCorrection(next, { field: edit.field, from: state.schedule[edit.field], to: edit.value, turnId });
      return result('field_edit', { edit });
    }
    if (edit.field === 'place' && top) {
      const lookup = top.lookup && !privateNow;
      // The place is the entity itself for weather, or when the topic never had a place apart from its entity.
      const asEntity = Boolean(topForms?.locationValued) || !top.place;
      pushCorrection(next, { field: 'place', from: asEntity ? top.entity : top.place, to: edit.value, turnId });
      const frame = frameOf({ ...top, entity: asEntity ? edit.value : top.entity, place: asEntity ? null : edit.value, sourceTurnId: turnId, entityOrigin: 'user', lookup });
      pushTopic(next, frame);
      return result('field_edit', { edit, entity: frame.entity, property: top.property, place: frame.place, time: frame.time,
        query: lookup ? composeQuery(topForms, frame, arabic) : null });
    }
    return result('field_edit', { edit, needs: top ? null : 'missing_reference' });
  }

  const correctionStart = correctionValueStart(folded);
  if (correctionStart !== null && top) {
    const valueWords = words.slice(correctionStart);
    const valueFolded = folded.slice(correctionStart);
    const ordinal = findOrdinal(valueFolded);
    const pointed = ordinal !== null ? state.results.find(item => item.index === ordinal) ?? null : null;
    if (ordinal !== null && !pointed) return result('correction', { needs: 'missing_reference' });
    const operands = promotePlace(operandsFrom(valueWords, valueFolded, 0, hints, Boolean(topForms?.locationValued)));
    const entity = pointed?.label ?? operands.entity;
    if (!entity) return result('correction', { needs: 'missing_value' });
    const lookup = top.lookup && !privateNow;
    pushCorrection(next, { field: 'entity', from: top.entity, to: entity, turnId });
    const frame = frameOf({ entity, property: top.property, place: operands.place ?? top.place, time: operands.time ?? top.time,
      entityOrigin: pointed ? 'host_result' : 'user', lookup });
    pushTopic(next, frame);
    return result('correction', {
      entity, property: top.property, place: frame.place, time: frame.time, query: lookup ? composeQuery(topForms, frame, arabic) : null,
      ...(pointed ? { reference: { index: pointed.index, label: pointed.label } } : {}),
    });
  }

  const hit = findProperty(folded, whole);
  const ordinal = state.results.length ? findOrdinal(folded) : null;
  if (ordinal !== null) {
    const pointed = state.results.find(item => item.index === ordinal);
    if (!pointed) return result('reference', { needs: 'missing_reference' });
    const reference = { index: pointed.index, label: pointed.label };
    const verb = folded[contentStart(folded)] ?? folded[0] ?? '';
    if (ACTION_VERBS.test(verb) || ACTION_VERBS.test(folded[0] ?? '')) {
      // The host acts on its own result after its own checks; the label is never run as a command.
      return result('reference', { reference, entity: pointed.label });
    }
    const forms = hit?.forms ?? topForms;
    const lookup = (top?.lookup ?? v1.scope === 'public') && !privateNow;
    pushTopic(next, frameOf({ entity: pointed.label, property: forms?.name ?? null, entityOrigin: 'host_result', lookup }));
    return result('reference', { reference, entity: pointed.label, property: forms?.name ?? null, query: lookup ? compose(forms, pointed.label, arabic) : null });
  }

  if (hit?.pronoun) {
    if (!top) return result('ambiguous', { property: hit.forms.name, needs: 'missing_reference' });
    const current = operandsFrom(words, folded, hit.start >= 0 ? hit.start + hit.length : contentStart(folded), hints, false);
    const answer = state.results.length === 1 ? state.results[0]! : null;
    // «وكم عدد سكانها؟» after a capital question asks about the city answered; «وشو عاصمتها؟» after a president question
    // asks about the country, because a capital is not a property of a person.
    const refersToAnswer = Boolean(topForms?.answerKind && hit.forms.appliesTo.includes(topForms.answerKind));
    let entity: string | null;
    let origin: TopicFrame['entityOrigin'] = top.entityOrigin;
    let assumption: string | null = null;
    if (refersToAnswer && answer) {
      entity = answer.label;
      origin = 'host_result';
      assumption = assumptionLine(entity, arabic);
    } else if (refersToAnswer && top.entity) {
      entity = compose(topForms, top.entity, arabic);
      assumption = entity ? assumptionLine(entity, arabic) : null;
    } else {
      entity = top.entity;
    }
    if (!entity) return result('ambiguous', { property: hit.forms.name, needs: 'missing_reference' });
    // «وكم عدد سكانها في مصر؟»: a place named with a property of places is the entity asked about.
    if (current.place && placeEntity(hit.forms)) { entity = current.place; origin = 'user'; assumption = null; }
    const lookup = top.lookup && !privateNow;
    const frame = frameOf({ entity, property: hit.forms.name, place: placeEntity(hit.forms) ? null : current.place ?? (refersToAnswer ? null : top.place),
      time: current.time ?? top.time, entityOrigin: origin, lookup });
    pushTopic(next, frame);
    return result('follow_up_property', { entity, property: hit.forms.name, place: frame.place, time: frame.time, assumption,
      query: lookup ? composeQuery(hit.forms, frame, arabic) : null });
  }

  const start = hit ? hit.start + hit.length : contentStart(folded);
  const operands = operandsFrom(words, folded, start, hints, Boolean(hit?.forms.locationValued));
  // A message made only of a place or a time («وفي مصر؟», «بكرا؟») leans on the topic before it.
  const slotOnly = Boolean(top) && !hit && operands.entity === null && Boolean(operands.place || operands.time);
  const followLead = startsWithFollowLead(folded, whole) || slotOnly;
  if (followLead && top) {
    const property = hit?.forms ?? topForms;
    const lookup = top.lookup && !privateNow;
    const current = hit?.forms.locationValued || !hit && topForms?.locationValued ? operandsFrom(words, folded, start, hints, true) : operands;
    if (current.entity && (!hit || hit.forms.name === top.property)) {
      const frame = frameOf({ entity: current.entity, property: property?.name ?? null, place: current.place ?? (property?.locationValued ? null : top.place),
        time: current.time ?? top.time, lookup });
      pushTopic(next, frame);
      return result('follow_up_entity', { entity: current.entity, property: property?.name ?? null, place: frame.place, time: frame.time,
        query: lookup ? composeQuery(property, frame, arabic) : null });
    }
    if (hit && (!current.entity || fold(current.entity) === fold(top.entity ?? ''))) {
      const frame = frameOf({ entity: top.entity, property: hit.forms.name, place: current.place ?? top.place, time: current.time ?? top.time,
        entityOrigin: top.entityOrigin, lookup });
      pushTopic(next, frame);
      return result('follow_up_property', { entity: top.entity, property: hit.forms.name, place: frame.place, time: frame.time,
        query: lookup ? composeQuery(hit.forms, frame, arabic) : null });
    }
    if (!hit && !current.entity && current.place && placeEntity(topForms)) {
      // «وفي مصر؟» after the population of a city asks about مصر: for a property of places the new place is the entity.
      const frame = frameOf({ entity: current.place, property: top.property, place: null, time: current.time ?? top.time, lookup });
      pushTopic(next, frame);
      return result('follow_up_entity', { entity: current.place, property: top.property, place: null, time: frame.time,
        query: lookup ? composeQuery(topForms, frame, arabic) : null });
    }
    if (!hit && !current.entity && (current.place || current.time)) {
      // Same entity and property, one operand changed: «وفي الامارات؟» after an iPhone price, «وبكرا؟» after today's weather.
      const edit = { field: current.place ? 'place' as const : 'date' as const, value: current.place ?? current.time };
      const frame = frameOf({ entity: top.entity, property: top.property, place: current.place ?? top.place, time: current.time ?? top.time,
        entityOrigin: top.entityOrigin, lookup });
      pushTopic(next, frame);
      return result('field_edit', { edit, entity: top.entity, property: top.property, place: frame.place, time: frame.time,
        query: lookup ? composeQuery(topForms, frame, arabic) : null });
    }
  }

  const fresh = promotePlace(operands);
  const entity = fresh.entity;
  if (v1.kind === 'ambiguous' && v1.ambiguities.includes('missing_reference') && !entity) return result('ambiguous', { needs: 'missing_reference' });
  if (GENERIC_TARGET.test(whole) && !/https?:\/\/|www\./iu.test(text)) {
    next.results = [];
    pushTopic(next, frameOf({ entity: null, property: null, lookup: false }));
    return result(top ? 'topic_change' : 'new_request', { needs: 'missing_value' });
  }
  const publicLookup = !privateNow && v1.scope === 'public' && ['web_search', 'news'].includes(v1.intent);
  // «ايه هي عاصمة كندا؟»: v1 knows no dialect question word and leaves no query, but a named property of a named entity is a public lookup.
  const composed = !privateNow && !publicLookup && Boolean(hit && !hit.pronoun && entity) && ['web_search', 'news', 'unknown'].includes(v1.intent)
    && v1.sourceAssessment?.scope !== 'private';
  const lookup = publicLookup || composed;
  next.results = [];
  next.schedule = (() => { const parsed = parseSchedule(text); return parsed ? { ...parsed, sourceTurnId: turnId } : null; })();
  const frame = frameOf({ entity, property: hit?.forms.name ?? null, place: fresh.place, time: fresh.time, lookup });
  pushTopic(next, frame);
  return result(top ? 'topic_change' : 'new_request', { entity, property: hit?.forms.name ?? null, place: frame.place, time: frame.time,
    query: lookup ? v1.query ?? composeQuery(hit?.forms ?? null, frame, arabic) : null });
}
