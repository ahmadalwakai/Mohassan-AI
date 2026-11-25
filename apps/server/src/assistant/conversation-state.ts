import type { RequestUnderstandingView } from './understanding/index.js';
import { analyzeCompoundRequest } from './compound-request.js';
import { decideConversationTurn, type ConversationTurnDecision } from './conversation-state-decisions.js';
import { extendConversationEntities, type ConversationEntity } from './conversation-state-entities.js';
import { resolveRequestContext, type RequestContextState, type RequestResolution, type RequestSlotKind } from './request-context.js';

/**
 * Conversation state v2 (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, phase 1).
 * The conversation decision uses bounded transcript replay. The original understanding is retained for
 * the public follow-up helper, compatibility with earlier reports, and shadow comparison.
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
  | 'weather' | 'age' | 'height' | 'match' | 'founded' | 'inventor' | 'duration';
/** 'format', 'detail' and 'unit' are reformulations of the last answer («كجدول», «فصّل أكثر», «بالدولار»): same evidence, another shape. */
export type EditableField = 'date' | 'clock' | 'place' | 'budget' | 'language' | 'format' | 'detail' | 'unit';
/** 'country' marks properties of a state (currency, language, leader, capital): «its currency» after a capital question means the country, not the city. */
type OperandKind = 'place' | 'country' | 'person' | 'thing';

export interface TopicFrame {
  entity: string | null;
  property: PropertyName | null;
  /** A place operand kept apart from the entity. For a weather question the place is the entity itself. */
  place: string | null;
  /** A time operand («اليوم», «بكرا», «tomorrow») kept apart from the entity. */
  time: string | null;
  /** The user's own question with the entity replaced by «{}» («من هو {}؟»), so «ونيوتن؟» becomes «من هو نيوتن؟». */
  template: string | null;
  /** An arithmetic turn: its «entity» is an expression, so no property or open follow-up refers to it. */
  operation?: 'compute';
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
  entities: ConversationEntity[];
  lastAnswerTurnId: string | null;
}
interface LegacyTurnUnderstanding {
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
  /** The earlier entity a comparison is made against («وقارنها بالرياض», "compare it with Riyadh"). */
  against?: string;
  /** Closed-list words read through a one-letter typo («tomorow» → tomorrow), as written and as read. */
  corrected?: { from: string; to: string }[];
  v1: RequestResolution;
  next: ConversationStateV2;
}

export interface TurnUnderstanding extends LegacyTurnUnderstanding {
  decision: ConversationTurnDecision;
}

export function withAssistantAnswer(state: ConversationStateV2, text: string, turnId: string,
    options: { publicLookup?: boolean } = {}): ConversationStateV2 {
  if (!text.trim()) return state;
  return {
    ...state,
    lastAnswerTurnId: turnId,
    entities: extendConversationEntities(state.entities, { text, turnId, role: 'assistant', ...options }),
  };
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
  // A bare English «area» is a region in Ads sentences («area: Cardiff», real rq061), so only «area of» and the pronoun forms count.
  { name: 'area', ar: ['مساحه'], arPronoun: [], en: ['area of'], enPronoun: /\b(?:its|their) area\b|\bhow big is (?:it|that)\b/u,
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
  // «من اخترع الهاتف؟» (real rq006): the verb is the property word and what follows it is the entity.
  { name: 'inventor', ar: ['مخترع', 'اخترع', 'مؤسس', 'اسس'], arPronoun: [], en: ['inventor of', 'invented', 'founder of', 'who founded'],
    enPronoun: /\bwho (?:invented|founded|created|made) (?:it|that|them)\b|\b(?:its|their) (?:inventor|founder)\b/u,
    phraseAr: 'مخترع', phraseEn: 'inventor of', appliesTo: ['thing'] },
  // «كم تستغرق عملية المياه البيضاء؟» (real rq018).
  { name: 'duration', ar: ['مده', 'تستغرق', 'يستغرق', 'كم تاخذ', 'كم ياخذ'], arPronoun: [], en: ['duration of', 'how long does', 'how long is', 'how long will'],
    enPronoun: /\bhow long (?:does|will|did) (?:it|that) take\b|\b(?:its|their) duration\b/u, phraseAr: 'مدة', phraseEn: 'duration of', appliesTo: ['thing'] },
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

const LEADS = new Set(['طيب', 'طب', 'حسنا', 'تمام', 'اوكي', 'ok', 'okay', 'well', 'and', 'so', 'also', 'و', 'ف', 'ثم',
  // «كمان مصر؟», «برضو», «نفس الشي لمصر», "same for Egypt", "Egypt too"
  'كمان', 'برضو', 'برضه', 'ايضا', 'كذلك', 'بعدين', 'نفس', 'الشي', 'الشيء', 'same', 'thing', 'too']);
const FOLLOW_FIRST = new Set(['طيب', 'طب', 'حسنا', 'تمام', 'and', 'so', 'also', 'كمان', 'برضو', 'برضه', 'ايضا', 'كذلك', 'بعدين', 'نفس', 'same']);
const QUESTION_WORDS = new Set(['ما', 'ماذا', 'من', 'متي', 'كم', 'اين', 'هل', 'ماهي', 'ماهو', 'هو', 'هي', 'يبلغ', 'حاله', 'قل', 'لي',
  'اعطني', 'اخبرني', 'ايه', 'ايش', 'وش', 'شو', 'شنو', 'مين', 'وين', 'كام', 'ليش', 'ليه', 'لماذا', 'كيف', 'اي', 'لاي', 'which', 'يساوي', 'تساوي', 'ذاكرتي', 'ذاكرتك', 'الذاكره',
  'what', 'whats', "what's", 'who', 'whos', "who's", 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were', 'tell', 'me',
  'about', 'much', 'many', 'do', 'does', 'you', 'know', 'give', 'the', 'a', 'an']);
const PREPOSITIONS = new Set(['في', 'عن', 'ل', 'من', 'علي', 'of', 'in', 'for', 'at', 'about', 'the', 'on']);
/** Politeness around the request («من فضلك …», «… لو سمحت», "could you tell me …", "… please") says nothing about what is asked. */
const POLITE_PREFIXES = ['اريد ان اعرف', 'اريد معرفه', 'ابغي اعرف', 'بدي اعرف', 'عايز اعرف', 'هل يمكنك', 'هل تستطيع', 'هل تقدر', 'من فضلك', 'من فضلكم', 'لو سمحت', 'لو سمحتي', 'لو سمحتم',
  'ارجوك', 'ارجوكم', 'رجاء', 'ممكن', 'يمكنك', 'تقدر',
  'could you please tell me', 'can you please tell me', 'would you please tell me', 'could you tell me', 'can you tell me', 'would you tell me',
  'i would like to know', "i'd like to know", 'i want to know', 'could you please', 'can you please', 'would you please', 'could you', 'can you', 'would you',
  'tell me', 'please', 'kindly'].map(form => form.split(' ')).sort((a, b) => b.length - a.length);
const POLITE_SUFFIXES = ['من فضلك', 'لو سمحت', 'ارجوك', 'thank you', 'please', 'thanks', 'شكرا'].map(form => form.split(' ')).sort((a, b) => b.length - a.length);
/** Standalone words that point back at the topic; a noun with a ها/هم/هن suffix («معالمها») points back too. */
const POINTERS = new Set(['هي', 'هو', 'هم', 'عنها', 'عنه', 'عنهم', 'لها', 'له', 'لهم', 'فيها', 'فيه', 'منها', 'منه', 'بها', 'به', 'اليها', 'اليه',
  'it', 'its', 'that', 'this', 'there', 'them', 'him', 'her', 'his', 'their']);
const STANDALONE_PRONOUNS = new Set(['هي', 'هو', 'it', 'that', 'this', 'them', 'him', 'her']);
/** Interrogatives that make a message a question wherever they stand («وهي في أي قارة»). «ما» and «من» only when they lead it
 * («ومن اخترعه؟»), since they are also "what/that" and "from"; English ones only when they lead it. */
const ASKS_ANYWHERE = new Set(['ماذا', 'متي', 'كم', 'اين', 'هل', 'كيف', 'لماذا', 'ليش', 'ليه', 'ايش', 'وش', 'شو', 'شنو', 'مين', 'وين', 'كام', 'ايه', 'اي', 'لاي']);
const ASKS_FIRST = new Set([...ASKS_ANYWHERE, 'ما', 'من', 'ماهي', 'ماهو', 'what', 'whats', "what's", 'who', 'whos', "who's", 'when', 'where', 'why', 'how',
  'which', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'will', 'should']);
/** An open follow-up is short: «وما أشهر معالمها؟» has one content word, "is it expensive to visit?" three. */
const OPEN_FOLLOW_MAX_CONTENT = 4;
/** Verbs whose subject is the topic itself: «وأين تقع؟», «ومتى تأسست؟», "where is it located?". */
const FOLLOW_VERBS = new Set(['تقع', 'يقع', 'تاسست', 'تاسس', 'انشئت', 'انشئ', 'بنيت', 'بني', 'افتتحت', 'افتتح', 'تقام', 'يقام', 'بدات', 'بدا', 'انتهت', 'انتهي',
  'ولد', 'ولدت', 'توفي', 'توفيت', 'مات', 'ماتت', 'يعيش', 'تعيش', 'يسكن', 'تسكن', 'تشتهر', 'يشتهر', 'تنتج', 'ينتج', 'تصنع', 'يصنع', 'تبعد', 'يبعد',
  'located', 'founded', 'built', 'born', 'died', 'live', 'lives', 'famous', 'known', 'happened', 'started', 'ended', 'opened', 'closed']);
/** «وقارنها بالرياض», "compare it with Riyadh": the X after the comparison word is the new entity, the old one is kept as `against`. */
const COMPARE = /^(?:و)?(?:قارن(?:ها|ه|هم)?|مقارن[هة]|compare(?: (?:it|that|them))?)(?:\s+(?:ب|مع|بين|with|to|against|versus|vs\.?)(?=\s))?\s*/u;
/** Control words: the host's own cancel handling runs regardless; here they only keep the topic and need no lookup. */
const CANCEL = /^(?:توقف|قف|كفي|خلاص|الغ(?:ها|ه|ي)?|الغاء|لا تكمل|لا تبحث|لا تتابع|stop|cancel|never ?mind|forget it|that's enough|enough)$/u;
/** A place operand follows one of these; «الى» folds to «الي». */
const PLACE_PREPOSITIONS = new Set(['في', 'ب', 'الي', 'in', 'at', 'to']);
/**
 * Folded time words, longest first. v1 reads an unknown dialect spelling such as «بكرا» as a place; here it is a time.
 * An Arabic weekday counts only after «يوم» («صلاة الجمعة» is a subject, not a date); English weekdays count on their own.
 */
const WEEKDAYS_AR = ['السبت', 'الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه'];
const WEEKDAYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_FORMS = ['الاسبوع القادم', 'الاسبوع الجاي', 'الاسبوع الماضي', 'الشهر القادم', 'الشهر الماضي', 'السنه القادمه', 'السنه الماضيه', 'العام القادم', 'العام الماضي',
  'هذا الاسبوع', 'هذا الشهر', 'هذه السنه', 'هذا العام', 'بعد غد', 'this weekend', 'this week', 'this month', 'this year', 'next week', 'next month', 'next year',
  'last week', 'last month', 'last year', ...WEEKDAYS_AR.map(day => `يوم ${day}`), ...WEEKDAYS_EN,
  'اليوم', 'الان', 'حاليا', 'غدا', 'بكرا', 'بكره', 'الليله', 'امس', 'البارحه', 'today', 'now', 'currently', 'tomorrow', 'tonight', 'yesterday']
  .map(form => form.split(' ')).sort((a, b) => b.length - a.length);
const TIME_SET = new Set(TIME_FORMS.map(form => form.join(' ')));
/** A year («في 2020», "in 2019") or a day-month(-year) date («25 ديسمبر», "25 December 2026") is a time operand too. */
const YEAR = /^(?:19|20)\d{2}$/u;
const MONTHS = new Set(['يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر',
  'شباط', 'اذار', 'نيسان', 'ايار', 'حزيران', 'تموز', 'ايلول',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
/** Words that introduce a time and go with it: «في 2020», "on Friday", «خلال الأسبوع الماضي», «سنة 2019». */
const TIME_PREPOSITIONS = new Set(['في', 'خلال', 'سنه', 'عام', 'بتاريخ', 'in', 'on', 'at', 'for', 'during', 'year', 'since']);
const ORDINALS: Record<string, number> = {
  الاول: 1, الاولي: 1, اول: 1, اولي: 1, الثاني: 2, الثانيه: 2, ثاني: 2, ثانيه: 2, الثالث: 3, الثالثه: 3, ثالث: 3, ثالثه: 3,
  الرابع: 4, الرابعه: 4, الخامس: 5, الخامسه: 5, السادس: 6, السادسه: 6, السابع: 7, السابعه: 7, الثامن: 8, الثامنه: 8,
  التاسع: 9, التاسعه: 9, العاشر: 10, العاشره: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  // −1 is the last displayed result («الأخير», "the last one").
  الاخير: -1, الاخيره: -1, اخير: -1, last: -1,
};
const REFERENCE_NOUNS = new Set(['المدينه', 'مدينه', 'الخبر', 'خبر', 'النتيجه', 'نتيجه', 'الخيار', 'خيار', 'الرابط', 'رابط', 'العنصر',
  'البند', 'رقم', 'number', 'item', 'option', 'result', 'link', 'no']);
/** "option two", «رقم اثنين»: a number word counts only after a reference noun. */
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, واحد: 1, اثنين: 2, ثلاثه: 3, اربعه: 4, خمسه: 5 };
const CORRECTION_LEADS = ['لا', 'no', 'nope', 'غلط', 'خطا', 'wrong', 'oops', 'sorry', 'عفوا'];
const CORRECTION_VERBS = ['اقصد', 'قصدت', 'قصدي', 'اعني', 'بل', 'rather', 'actually'];
const EXCLUSIONS = new Set(['مش', 'مو', 'ليس', 'ليست', 'not']);
const SWAP_WORDS = new Set(['بدل', 'بدال', 'بديل']);
/** «خليها باريس», "make it Paris", "set it to tomorrow": the previous request again with one value changed. */
const MAKE_IT = /^(?:خليها|خليه|خلها|خله|اجعلها|اجعله|غيرها|غيره|بدلها|بدله|حولها|حوله|make it|change it to|set it to|switch (?:it )?to)(?=\s)/u;
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
/** Questions about Mohassan itself («من صنعك؟», "are you groq ai?", real rq084–rq087) go to the local conversation, never to a search. */
const ABOUT_ASSISTANT = /\b(?:who (?:made|created|built|trained|owns) you|whos? (?:create|created|made|built) you|are you (?:an? |the )?(?:ai|bot|robot|human|model|groq|chatgpt|gpt|claude)|what (?:can|do) you do|what are you|who are you|smarter,? (?:chatgpt|gpt|claude) or you|upgrade you)\b|(?:^|\s)(?:من (?:صنعك|انشاك|صممك|بناك|دربك|انت)|ما (?:هي )?قدراتك|ماذا تستطيع|هل (?:انت|تستطيع|تقدر|يمكنك)|ايش تقدر|شو بتقدر|وش تقدر)(?=\s|$)/u;
/** The whole message is a go-ahead («تابع», "go on") with no host step to answer: the code resumes or asks, and nothing is searched. */
const GO_AHEAD_ONLY = /^(?:(?:طيب|تمام|حسنا|موافق|اوكي|لا|ok|okay|yes|no|sure|fine)[،,\s]+)?(?:تابع|اكمل|كمل|استمر|واصل|امض|نفذ|continue|go on|go ahead|proceed|carry on|resume|next)(?:\s+(?:من فضلك|please))?$/u;
const CONTINUE_START = /^(?:تابع|اكمل|كمل|استمر|واصل|continue|go on|go ahead|proceed|carry on|resume)(?!\p{L})/u;
/** «فصّل أكثر», «بالإنجليزي», «كجدول»: the last answer again, from the same evidence, in another shape. The whole message must be the request. */
const REFORMULATIONS: ReadonlyArray<readonly [RegExp, { field: EditableField; value: string }]> = [
  [/^(?:(?:فصل|وضح|اشرح|زد|اعطني|قل لي|اريد)\s+)?(?:اكثر|بالتفصيل|تفاصيل(?: اكثر)?|المزيد(?: من التفاصيل)?)$|^(?:more|more details?|elaborate|expand(?: on (?:it|that))?|tell me more|in (?:more )?detail|go deeper)$/u, { field: 'detail', value: 'more' }],
  [/^(?:اختصر(?:ها|ه)?|لخص(?:ها|ه)?|باختصار|اقصر|بايجاز|مختصر)$|^(?:shorter|briefly|in short|summari[sz]e (?:it|that)|tl;?dr|make it shorter)$/u, { field: 'detail', value: 'less' }],
  [/^(?:بال(?:عربي|عربيه|فصحي)|ترجم(?:ها|ه)?(?: (?:الي|ل))? ?(?:ال)?عربي[ه]?)$|^in arabic$/u, { field: 'language', value: 'ar' }],
  [/^(?:بال(?:انجليزي|انجليزيه|انقليزي)|ترجم(?:ها|ه)?(?: (?:الي|ل))? ?(?:ال)?انجليزي[ه]?)$|^(?:in english|translate (?:it|that)(?: to english)?)$/u, { field: 'language', value: 'en' }],
  [/^(?:كجدول|في جدول|علي شكل جدول|بجدول)$|^(?:as a table|in a table|table format)$/u, { field: 'format', value: 'table' }],
  [/^(?:كقائمه|كنقاط|نقاط|بالنقاط|علي شكل نقاط)$|^(?:as a list|bullet points|as bullets|in bullets)$/u, { field: 'format', value: 'list' }],
  [/^(?:خطوات|كخطوات|خطوه بخطوه)$|^(?:as steps|step by step|in steps)$/u, { field: 'format', value: 'steps' }],
  [/^(?:اعد(?:ها|ه)?|كرر(?:ها|ه)?|مره (?:ثانيه|اخري|تانيه)|تاني|again|repeat(?: (?:that|it))?|say (?:that|it) again|once more)$/u, { field: 'detail', value: 'again' }],
  // Units and currencies: the same value, converted.
  [/^(?:بال(?:دولار|دولارات)(?: الامريكي)?|in (?:us )?dollars?|in usd)$/u, { field: 'unit', value: 'USD' }],
  [/^(?:باليورو|in euros?|in eur)$/u, { field: 'unit', value: 'EUR' }],
  [/^(?:بال(?:جنيه|جنيهات)(?: الاسترليني)?|in pounds?(?: sterling)?|in gbp)$/u, { field: 'unit', value: 'GBP' }],
  [/^(?:بال(?:ريال|ريالات)(?: السعودي)?|in (?:saudi )?riyals?|in sar)$/u, { field: 'unit', value: 'SAR' }],
  [/^(?:بال(?:درهم|دراهم)(?: الاماراتي)?|in dirhams?|in aed)$/u, { field: 'unit', value: 'AED' }],
  [/^(?:بال(?:كيلو|كيلومتر|كيلومترات)|in (?:km|kilomet(?:er|re)s?))$/u, { field: 'unit', value: 'km' }],
  [/^(?:بال(?:ميل|اميال)|in miles)$/u, { field: 'unit', value: 'mi' }],
  [/^(?:بال(?:مئويه|سيلسيوس)|in celsius)$/u, { field: 'unit', value: 'C' }],
  [/^(?:بالفهرنهايت|in fahrenheit)$/u, { field: 'unit', value: 'F' }],
];
/**
 * The owner's own file or document is not a public lookup. Live shadow, 2026-11-22 05:23: «أضف علامة مائية «سري» على آخر ملف pdf» came
 * out of v1 as a web search, and so do «ما حجم ملفي؟» and «حوّل الملف إلى وورد». A possessive or a demonstrative marks the owner's own file
 * by itself («ملفي», «هذا التقرير», "my report", "this pdf"). «آخر/الـ ملف» and "the (last) file" do so only after a leading action verb,
 * because «آخر تقرير للبنك الدولي عن التضخم» and "the latest report on inflation" are public lookups.
 */
const ARTIFACT_AR = '(?:ملف|ملفات|مستند|مستندات|تقرير|صوره|صور|جدول|pdf)';
const ARTIFACT_EN = '(?:files?|pdfs?|documents?|docs?|reports?|images?|photos?|pictures?|spreadsheets?|sheets?|slides|presentations?)';
const OWN_ARTIFACT = new RegExp(`(?:^|\\s)(?:ملفي|ملفاتي|مستندي|مستنداتي|تقريري|صورتي|صوري|جدولي)(?=\\s|$)`
  + `|(?:^|\\s)(?:هذا|هذه|ذلك|تلك|هاد|هاذا)\\s+(?:ال)?${ARTIFACT_AR}(?=\\s|$)|(?:^|\\s)ال${ARTIFACT_AR}\\s+(?:هذا|هذه|ده|دي|هاد)(?=\\s|$)`
  + `|\\b(?:my|our|this|these)\\s+(?:[a-z]+\\s+)?${ARTIFACT_EN}\\b`, 'u');
const RECENT_ARTIFACT = new RegExp(`(?:^|\\s)(?:اخر|نفس)\\s+(?:ال)?${ARTIFACT_AR}(?=\\s|$)|(?:^|\\s)ال${ARTIFACT_AR}(?=\\s|$)`
  + `|\\bthe\\s+(?:(?:last|latest|previous|same|attached|uploaded|new)\\s+)?(?:[a-z]+\\s+)?${ARTIFACT_EN}\\b`, 'u');
const ACT_VERBS = new Set(['اضف', 'ضيف', 'احذف', 'امسح', 'ازل', 'شيل', 'عدل', 'غير', 'نقح', 'ادمج', 'اضغط', 'انسخ', 'الصق', 'ارفق', 'ضع', 'حط',
  'ارسل', 'ابعث', 'ابعت', 'شارك', 'ارفع', 'نزل', 'اطبع', 'حول', 'وقع', 'افتح', 'اغلق', 'احفظ', 'ترجم', 'لخص',
  'add', 'remove', 'delete', 'erase', 'edit', 'merge', 'split', 'compress', 'convert', 'export', 'print', 'send', 'rename', 'move', 'upload',
  'download', 'attach', 'insert', 'append', 'copy', 'save', 'watermark', 'sign', 'share', 'open', 'close', 'update', 'fix', 'translate', 'summarize', 'summarise']);
/** «افتح موقعًا واعرض لي محتواه»: a browser command whose target is only a generic noun must ask which site. */
const GENERIC_TARGET = /^(?:افتح|ادخل|اعرض|زر|open|visit|go to)\s+(?:لي\s+)?(?:(?:ال)?موقعا?|(?:ال)?صفحه|(?:ال)?رابط|(?:a|the|some|any)\s+(?:website|site|web ?page|page|link))(?=$|\s+(?:ثم|and|then|لي)(?!\p{L})|\s+و(?:اعرض|اقرا|ابحث|افتح|قل|اخبرني|لخص|انسخ))/u;
const CLOCK = /(?:الساعه|الساعة)\s*\d{1,2}(?::\d{2})?(?:\s*(?:صباحا|مساء|ظهرا|عصرا|ليلا|ص|م)(?!\p{L}))?|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/iu;
const DATE_AR = /(?:يوم\s+)?(?:ال)?(?:سبت|احد|أحد|اثنين|إثنين|ثلاثاء|اربعاء|أربعاء|خميس|جمعة|جمعه)(?!\p{L})|اليوم|غدا|بكرة|بكره|بعد غد|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/u;
const DATE_EN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/iu;

// Tatweel and the harakat only: the old range ً-ٰ also swallowed the Arabic-Indic digits ٠-٩ («اقرأ الخبر ٢» lost its 2).
const clean = (text: string) => text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/[ـً-ٰٟ]/gu, '').replace(/\s+/gu, ' ').trim();
const fold = (text: string) => clean(text).normalize('NFKC').replace(/\p{Cf}/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'")
  .replace(/[٠-٩]/gu, digit => String.fromCharCode(48 + digit.charCodeAt(0) - 0x0660)).toLowerCase();
const strip = (text: string) => text.replace(/^[\s،,.!?؟:؛;«»"'()[\]]+|[\s،,.!?؟:؛;«»"'()[\]]+$/gu, '');
const wordsOf = (text: string) => clean(text).split(' ').map(strip).filter(Boolean);
const isArabic = (text: string) => /\p{Script=Arabic}/u.test(text);
const label = (text: string) => clean(text).slice(0, MAX_LABEL);
/** «وفي» → «في», «والطقس» → «طقس»: the bare word behind a leading و/ف/ب and ال. */
const bareWord = (word: string) => word.replace(/^[وفب](?=.{2})/u, '').replace(/^ال(?=.{2})/u, '');

export function emptyConversationState(): ConversationStateV2 {
  return { version: CONVERSATION_STATE_VERSION, base: null, topics: [], results: [], corrections: [], pending: null, schedule: null, entities: [], lastAnswerTurnId: null };
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

/** The words without the politeness around them; a message that is only politeness keeps its words and says so. */
function stripPoliteness(words: readonly string[], folded: readonly string[]): { words: string[]; folded: string[]; onlyPoliteness: boolean } {
  let start = 0, end = words.length;
  const matches = (forms: readonly string[][], at: number, backwards: boolean) => forms.find(form => {
    const from = backwards ? at - form.length : at;
    return from >= start && from + form.length <= end && form.every((want, offset) => folded[from + offset] === want);
  });
  for (let found = matches(POLITE_PREFIXES, start, false); found; found = matches(POLITE_PREFIXES, start, false)) start += found.length;
  for (let found = matches(POLITE_SUFFIXES, end, true); found; found = matches(POLITE_SUFFIXES, end, true)) end -= found.length;
  if (start >= end) return { words: [...words], folded: [...folded], onlyPoliteness: words.length > 0 };
  return { words: words.slice(start, end), folded: folded.slice(start, end), onlyPoliteness: false };
}
/** Names that begin with و, so «وادي رم» after a topic is not «و» + «ادي رم». */
const WAW_NAMES = new Set(['وادي', 'واشنطن', 'ويلز', 'ويكيبيديا', 'وهران', 'ولايه', 'ولايات', 'واتساب', 'ويندوز', 'وورد', 'ورزازات', 'والي', 'وجده', 'ودان']);

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
  // An English pronoun hit (start −1) comes first; otherwise the earliest property word wins, so in «ما عاصمة اليابان وعدد سكانها؟»
  // the capital is the property and the pronoun refers to اليابان inside the same sentence.
  hits.sort((a, b) => a.start - b.start || Number(b.pronoun) - Number(a.pronoun) || b.length - a.length);
  return hits[0] ?? null;
}

/** Skips connectors and question words; a leading و/ف on a function word counts as the word itself. */
function contentStart(folded: readonly string[]): number {
  let index = 0;
  while (index < folded.length) {
    const word = folded[index]!;
    const bare = /^[وف].{2,}$/u.test(word) ? word.slice(1) : word;
    if (LEADS.has(word) || LEADS.has(bare) || QUESTION_WORDS.has(word) || QUESTION_WORDS.has(bare) || PREPOSITIONS.has(bare) && bare !== word) index++;
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
  // «في 2020», "on Friday": the preposition that introduces a time goes with it.
  const dropTimePreposition = (at: number) => { if (at - 1 >= from && TIME_PREPOSITIONS.has(bareWord(folded[at - 1]!))) removed.add(at - 1); };
  for (const form of TIME_FORMS) {
    const at = findSequence(folded, form, from, removed);
    if (at < 0) continue;
    for (let offset = 0; offset < form.length; offset++) removed.add(at + offset);
    dropTimePreposition(at);
    time ??= originalSpan(words, folded, at, form.length, form[0]!);
  }
  for (let index = from; index < folded.length; index++) {
    if (removed.has(index)) continue;
    const word = folded[index]!;
    if (MONTHS.has(bareWord(word)) || MONTHS.has(word)) {
      // [day] month [year]
      let start = index, end = index;
      if (start - 1 >= from && /^\d{1,2}$/u.test(folded[start - 1]!) && !removed.has(start - 1)) start--;
      if (end + 1 < folded.length && YEAR.test(folded[end + 1]!)) end++;
      for (let offset = start; offset <= end; offset++) removed.add(offset);
      dropTimePreposition(start);
      time ??= words.slice(start, end + 1).join(' ');
      index = end;
    } else if (YEAR.test(word) && !(index > from && REFERENCE_NOUNS.has(folded[index - 1]!))) {
      removed.add(index);
      dropTimePreposition(index);
      time ??= words[index]!;
    }
  }
  for (const hint of hints) {
    const parts = fold(hint.value).split(' ').filter(Boolean);
    if (!parts.length || parts.length > 3) continue; // v1 may take half a sentence after «في» for a place; a place is one to three words
    // v1 reads «في أي قارة» as a place; a phrase with a question word in it is the question, not an operand.
    if (parts.some(part => QUESTION_WORDS.has(part))) continue;
    if (TIME_SET.has(parts.join(' '))) { time ??= hint.value; continue; }
    const at = findSequence(folded, parts, from, removed);
    if (at < 0) continue;
    for (let offset = 0; offset < parts.length; offset++) removed.add(at + offset);
    if (at - 1 >= from && PLACE_PREPOSITIONS.has(bareWord(folded[at - 1]!))) removed.add(at - 1);
    if (hint.kind === 'time') time ??= hint.value;
    else place ??= hint.value;
  }
  // A second property phrase after the first («ما عاصمة اليابان وعدد سكانها؟») is not part of the entity.
  for (const forms of PROPERTIES) {
    for (const form of [...forms.ar, ...PRONOUN_FORMS.get(forms.name)!, ...forms.en]) {
      const parts = form.split(' ');
      const at = findSequence(folded, parts, from, removed);
      if (at >= 0) for (let offset = 0; offset < parts.length; offset++) removed.add(at + offset);
    }
  }
  let rest: number[] = [];
  for (let index = from; index < words.length; index++) if (!removed.has(index)) rest.push(index);
  while (rest.length && (QUESTION_WORDS.has(folded[rest[0]!]!) || LEADS.has(folded[rest[0]!]!))) rest.shift();
  while (rest.length && (QUESTION_WORDS.has(folded[rest.at(-1)!]!) || LEADS.has(folded[rest.at(-1)!]!))) rest.pop();
  // Without a hint, a remainder that is only «في X» / «in X» names a place; so does «وفي X» whose preposition was skipped as a lead.
  if (!place && rest.length >= 2 && PLACE_PREPOSITIONS.has(bareWord(folded[rest[0]!]!)) && !QUESTION_WORDS.has(folded[rest[1]!]!)) {
    place = rest.slice(1).map(index => words[index]!).join(' ');
    rest = [];
  } else if (!place && rest.length >= 1 && rest.length <= 3 && from > 0 && PLACE_PREPOSITIONS.has(bareWord(folded[from - 1]!)) && bareWord(folded[from - 1]!) !== folded[from - 1]!
    && !rest.some(index => QUESTION_WORDS.has(folded[index]!))) {
    place = rest.map(index => words[index]!).join(' ');
    rest = [];
  } else if (!place && rest.length >= 3) {
    // «ايفون 15 في السعودية» with no hint from v1 (its regex misses a vowelled «فِي»): a final «في X» of one or two words is the place.
    // Arabic «في» only: English places come from v1's in/at hints, and in "the best time to visit Japan" (live shadow) "to" opens a verb.
    const at = rest.findIndex((index, position) => position >= 1 && position >= rest.length - 3 && folded[index] === 'في');
    if (at >= 1 && !rest.slice(at + 1).some(index => QUESTION_WORDS.has(folded[index]!) || TIME_SET.has(folded[index]!))) {
      place = rest.slice(at + 1).map(index => words[index]!).join(' ');
      rest = rest.slice(0, at);
    }
  }
  while (rest.length && PREPOSITIONS.has(folded[rest[0]!]!)) rest.shift();
  // «نفس الشي للجزائر»: a ل glued to the article is a preposition, not part of the name.
  const entity: string | null = rest.length ? rest.map((index, position) => position === 0 && /^لل.{2,}$/u.test(folded[index]!) ? `ا${words[index]!.slice(1)}` : words[index]!).join(' ') : null;
  // For weather the place is the entity. A place with no entity («كم السكان في مصر؟», «وفي الامارات؟») is left apart:
  // a new request promotes it to the entity, a follow-up reads it as the changed operand.
  if (place && locationValued) return { entity: place, place: null, time };
  return { entity, place, time };
}

/** A new request about «في مصر» with nothing else named is about مصر. */
function promotePlace(operands: Operands): Operands {
  return !operands.entity && operands.place ? { entity: operands.place, place: null, time: operands.time } : operands;
}

function startsWithFollowLead(folded: readonly string[], whole: string, question = false): boolean {
  const first = folded[0] ?? '';
  if (FOLLOW_FIRST.has(first)) return true;
  if (/^(?:what|how) about\b|^same (?:thing )?(?:for|with|about)\b|\b(?:too|as well|كمان|برضو|ايضا|كذلك)$/u.test(whole)) return true;
  if (!/^و.{2,}$/u.test(first)) return false;
  // «ونيوتن؟», «ونيوتن»: a short message that is only «و» and a name leans on the question before it.
  if (question && folded.length <= 3 || folded.length <= 2) return true;
  const bare = first.slice(1);
  return FOLLOW_FIRST.has(bare) || QUESTION_WORDS.has(bare) || PREPOSITIONS.has(bare) || TIME_SET.has(bare) || PROPERTIES.some(forms => [...forms.ar, ...PRONOUN_FORMS.get(forms.name)!]
    .some(form => [form.split(' ')[0], `ال${form.split(' ')[0]}`].includes(bare)));
}

function findOrdinal(folded: readonly string[]): number | null {
  for (let index = 0; index < folded.length; index++) {
    const word = folded[index]!.replace(/^[وفبل](?=ال)/u, '');
    if (ORDINALS[word] !== undefined) return ORDINALS[word]!;
    if (index > 0 && REFERENCE_NOUNS.has(folded[index - 1]!)) {
      if (/^\d{1,2}$/u.test(word)) return Number(word);
      if (NUMBER_WORDS[word] !== undefined) return NUMBER_WORDS[word]!;
    }
    if (/^#\d{1,2}$/u.test(word)) return Number(word.slice(1));
  }
  return null;
}

/** Whether the message is about the owner's own file (OWN_ARTIFACT), or acts on a recent one after a leading verb (RECENT_ARTIFACT). */
function actsOnArtifact(folded: readonly string[], whole: string): boolean {
  if (OWN_ARTIFACT.test(whole)) return true;
  const verb = folded[contentStart(folded)] ?? '';
  return (ACT_VERBS.has(verb) || ACT_VERBS.has(bareWord(verb))) && RECENT_ARTIFACT.test(whole);
}

/**
 * What a frame's entity is, by the property it was asked with: a place (population, capital, weather…), a thing (price, match…),
 * an arithmetic expression, or unknown (no property, or one that fits several kinds such as age or height).
 */
function frameKind(frame: TopicFrame): 'place' | 'thing' | 'value' | null {
  if (frame.operation === 'compute') return 'value';
  const forms = frame.property ? PROPERTY_BY_NAME.get(frame.property) : null;
  if (!forms) return null;
  if (forms.appliesTo.every(kind => kind === 'place' || kind === 'country')) return 'place';
  if (forms.appliesTo.every(kind => kind === 'thing')) return 'thing';
  return null;
}
function fits(forms: PropertyForms, frame: TopicFrame): boolean {
  const kind = frameKind(frame);
  if (kind === null) return true;
  if (kind === 'value') return false;
  return kind === 'place' ? forms.appliesTo.some(applies => applies === 'place' || applies === 'country') : forms.appliesTo.includes(kind);
}
/**
 * The frame a property follow-up refers to: the latest, unless its entity cannot have the property and an earlier one can.
 * «ما عاصمة اليابان؟» → «كم سعر الذهب؟» → «وكم عدد سكانها؟»: gold has no population, Japan has. Only a frame whose kind is known
 * to fit is taken, except after an arithmetic turn, where any earlier subject is better than an expression.
 */
function antecedent(topics: readonly TopicFrame[], forms: PropertyForms): { frame: TopicFrame; older: boolean; mismatch?: true } | null {
  const top = topics.at(-1);
  if (!top) return null;
  if (fits(forms, top)) return { frame: top, older: false };
  const afterArithmetic = frameKind(top) === 'value';
  for (let index = topics.length - 2; index >= 0; index--) {
    const frame = topics[index]!;
    if (!frame.entity || frame.operation === 'compute') continue;
    if (fits(forms, frame) && (afterArithmetic || frameKind(frame) !== null)) return { frame, older: true };
  }
  // Nothing said so far can have this property («وكم عدد سكانها؟» right after a gold price): ask rather than search for it.
  return { frame: top, older: false, mismatch: true };
}
/** The latest frame that names a subject; an arithmetic turn in between («كم يساوي 15 ضرب 23؟») is not one. */
function subjectFrame(topics: readonly TopicFrame[]): { frame: TopicFrame; older: boolean } | null {
  const top = topics.at(-1);
  if (!top) return null;
  if (top.operation !== 'compute') return { frame: top, older: false };
  for (let index = topics.length - 2; index >= 0; index--) {
    const frame = topics[index]!;
    if (frame.entity && frame.operation !== 'compute') return { frame, older: true };
  }
  return { frame: top, older: false };
}

/**
 * One-letter typos in closed word lists only. Live set rq036: "find train teckit from glasgow to london tomorow". A word of five
 * letters or more that no list knows is read as the one listed word that is one adjacent swap, one dropped letter or one added letter
 * away: time words and «about/meant/actually/instead» always, ordinals only while numbered results are on screen, edit fields only
 * after an edit verb, reformulations and greetings only in a message of three words or fewer. A letter added at the end is not a typo
 * (it makes «اليومي», "seconds", "Fridays", "Augusta"). Months, weekdays, property words and names are never corrected: a typo there
 * reaches the search as written, and «مسامحة» is one letter from «مساحة».
 */
const TYPO_MIN = 5;
let typoLists: { known: Set<string>; always: string[]; ordinals: string[]; fields: string[]; short: string[] } | null = null;
function typoVocab() {
  if (typoLists) return typoLists;
  const long = (list: Iterable<string>) => [...new Set(list)].filter(word => word.length >= TYPO_MIN);
  const always = long([...TIME_FORMS.filter(form => form.length === 1).map(form => form[0]!).filter(word => !WEEKDAYS_EN.includes(word)),
    'about', 'meant', 'actually', 'instead']);
  const ordinals = long(Object.keys(ORDINALS));
  const fields = long(Object.keys(EDIT_FIELDS));
  const short = long(['كجدول', 'بالجدول', 'كقائمه', 'بالدولار', 'باليورو', 'بالريال', 'بالدرهم', 'بالجنيه', 'بالانجليزي', 'بالانجليزيه', 'بالعربي',
    'بالعربيه', 'بالتفصيل', 'باختصار', 'اختصر', 'again', 'repeat', 'shorter', 'elaborate', 'مرحبا', 'اهلين', 'thanks', 'مشكور', 'يعطيك', 'العافيه', 'hello']);
  const known = new Set<string>([...always, ...ordinals, ...fields, ...short, ...QUESTION_WORDS, ...LEADS, ...FOLLOW_FIRST, ...PREPOSITIONS, ...POINTERS,
    ...FOLLOW_VERBS, ...ACT_VERBS, ...EDIT_VERBS, ...REFERENCE_NOUNS, ...CORRECTION_LEADS, ...CORRECTION_VERBS, ...ASKS_FIRST, ...Object.keys(NUMBER_WORDS),
    ...WEEKDAYS_AR, ...WEEKDAYS_AR.map(day => day.replace(/^ال/u, '')), ...WEEKDAYS_EN, ...MONTHS, ...TIME_FORMS.flat(), 'اليومي', 'اليوميه',
    ...PROPERTIES.flatMap(forms => [...forms.ar, ...forms.en].flatMap(form => form.split(' '))), ...[...PRONOUN_FORMS.values()].flat().flatMap(form => form.split(' '))]);
  typoLists = { known, always, ordinals, fields, short };
  return typoLists;
}
/** One adjacent swap, one dropped letter or one added letter, but not a letter added at the end of the listed word. */
function oneTypo(written: string, listed: string): boolean {
  if (written === listed) return false;
  if (written.length === listed.length) {
    let at = 0;
    while (at < written.length && written[at] === listed[at]) at++;
    return at < written.length - 1 && written[at] === listed[at + 1] && written[at + 1] === listed[at] && written.slice(at + 2) === listed.slice(at + 2);
  }
  if (written.length === listed.length + 1 && written.startsWith(listed)) return false;
  if (Math.abs(written.length - listed.length) !== 1) return false;
  const [shorter, longer] = written.length < listed.length ? [written, listed] : [listed, written];
  let at = 0;
  while (at < shorter.length && shorter[at] === longer[at]) at++;
  return shorter.slice(at) === longer.slice(at + 1);
}
function correctTypos(words: readonly string[], folded: readonly string[], context: { results: boolean }) {
  const lists = typoVocab();
  const editing = folded.slice(0, 2).some(word => EDIT_VERBS.has(word));
  const pool = [...lists.always, ...(context.results ? lists.ordinals : []), ...(editing ? lists.fields : []), ...(folded.length <= 3 ? lists.short : [])];
  const outWords = [...words], outFolded = [...folded];
  const corrected: { from: string; to: string }[] = [];
  folded.forEach((word, index) => {
    if (lists.known.has(word) || /\d/u.test(word)) return;
    for (const prefix of ['', 'و', 'ف']) {
      if (prefix && !word.startsWith(prefix)) continue;
      const rest = word.slice(prefix.length);
      if (rest.length < TYPO_MIN || lists.known.has(rest)) continue;
      const candidates = [...new Set(pool.filter(candidate => oneTypo(rest, candidate)))];
      if (candidates.length !== 1) continue;
      outFolded[index] = `${prefix}${candidates[0]}`;
      outWords[index] = outFolded[index]!;
      corrected.push({ from: words[index]!, to: outWords[index]! });
      return;
    }
  });
  return { words: outWords, folded: outFolded, corrected };
}

/** The displayed result an ordinal points at; −1 is the last one. */
function pointedResult(state: ConversationStateV2, ordinal: number): HostResult | null {
  const index = ordinal === -1 ? state.results.length : ordinal;
  return state.results.find(item => item.index === index) ?? null;
}

/**
 * The words that name the corrected value, or null when the turn is not a correction. Forms, by example:
 * «لا، أقصد النصر» · «غلط، النصر» · "Chelsea instead" · «مش الهلال، النصر» · «النصر مش الهلال» · «بدل الهلال النصر» ·
 * "Chelsea instead of Arsenal" · «خليها باريس» · "set it to tomorrow". The old value must be the topic's own entity, place or
 * time for the exclusion and swap forms, so an unrelated «ليس» sentence is not read as a correction.
 */
function correctionValueWords(words: readonly string[], folded: readonly string[], top: TopicFrame | null): { words: string[]; folded: string[] } | null {
  const slice = (from: number, to = words.length) => to > from ? { words: words.slice(from, to), folded: folded.slice(from, to) } : null;
  let index = 0;
  while (CORRECTION_LEADS.includes(folded[index] ?? '')) index++;
  if (folded[index] === 'i' && ['mean', 'meant'].includes(folded[index + 1] ?? '')) return slice(index + 2);
  if (CORRECTION_VERBS.includes(folded[index] ?? '')) return slice(index + 1);
  if (!top) return null;
  const whole = folded.join(' ');
  if (MAKE_IT.test(whole)) {
    const lead = MAKE_IT.exec(whole)![0].split(' ').length;
    return slice(lead);
  }
  const rest = folded.slice(index);
  const isTop = (parts: readonly string[]) => {
    const key = parts.join(' ').replace(/^ال/u, '');
    return [top.entity, top.place, top.time].some(value => value && fold(value).replace(/^ال/u, '') === key);
  };
  // "Chelsea instead", "Chelsea instead of Arsenal"
  const instead = rest.indexOf('instead');
  if (instead > 0) return slice(index, index + instead);
  // «مش الهلال، النصر» / «ليس الهلال بل النصر» → the words after the excluded old value
  if (EXCLUSIONS.has(rest[0] ?? '')) {
    for (let end = 2; end <= Math.min(rest.length - 1, 4); end++) {
      if (isTop(rest.slice(1, end))) return slice(index + end + (CORRECTION_VERBS.includes(rest[end] ?? '') ? 1 : 0));
    }
    return null;
  }
  // «النصر مش الهلال» → the words before the exclusion; «بدل الهلال النصر» / «النصر بدل الهلال»
  const exclusion = rest.findIndex((word, at) => at > 0 && EXCLUSIONS.has(word));
  if (exclusion > 0 && isTop(rest.slice(exclusion + 1))) return slice(index, index + exclusion);
  const swap = rest.findIndex(word => SWAP_WORDS.has(word));
  if (swap === 0) {
    for (let end = 2; end <= Math.min(rest.length - 1, 4); end++) if (isTop(rest.slice(1, end))) return slice(index + end);
    return null;
  }
  if (swap > 0 && isTop(rest.slice(swap + 1))) return slice(index, index + swap);
  // «لا، النصر», «غلط، في مصر»: a lead and then a short value with no question, command, thanks or go-ahead in it
  const value = rest.join(' ');
  if (index > 0 && rest.length >= 1 && rest.length <= 4 && !SMALL_TALK.test(value) && !APPROVE.test(value) && !CONTINUE.test(value)
    && !rest.some(word => QUESTION_WORDS.has(word) || EDIT_VERBS.has(word) || ACTION_VERBS.test(word) || CORRECTION_LEADS.includes(word))) {
    return slice(index);
  }
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

export function understandTurn(state: ConversationStateV2, text: string, turnId: string,
    options: { boundAnswer?: boolean; understanding?: RequestUnderstandingView } = {}): TurnUnderstanding {
  const legacy = understandLegacyTurn(state, text, turnId, options.understanding);
  const decision = decideConversationTurn({
    text, legacy, entities: state.entities, previousTopic: state.topics.at(-1),
    pending: state.pending, hasPreviousAnswer: state.lastAnswerTurnId !== null, boundAnswer: options.boundAnswer,
  });
  const topic = legacy.next.topics.at(-1);
  const ownTopic = topic?.sourceTurnId === turnId && topic.entity && topic.entityOrigin === 'user'
    && (decision.type === 'new_request' || decision.type === 'correction' || legacy.type === 'follow_up_entity') ? topic : null;
  const property = ownTopic?.property ? PROPERTY_BY_NAME.get(ownTopic.property) : null;
  const entity = ownTopic?.entity;
  const previousEntity = state.topics.at(-1)?.entity;
  const priorKind = legacy.type === 'follow_up_entity' && previousEntity
    ? state.entities.find(item => item.kind !== 'other' && fold(item.text) === fold(previousEntity))?.kind : undefined;
  const kind = property && placeEntity(property) ? 'place' : priorKind;
  const publicLookup = legacy.v1.sourceAssessment?.source === 'public_lookup' && legacy.v1.sourceAssessment.operation === 'lookup'
    && legacy.v1.sourceAssessment.publicQueryEligible;
  legacy.next.entities = extendConversationEntities(state.entities, {
    text, turnId, role: 'user', publicLookup, ...(entity ? { topic: { text: entity, kind }, place: ownTopic?.place, time: ownTopic?.time } : {}),
  });
  return { ...legacy, decision };
}

function understandLegacyTurn(state: ConversationStateV2, text: string, turnId: string,
    understanding?: RequestUnderstandingView): LegacyTurnUnderstanding {
  const parserText = understanding?.parserText ?? text;
  const pendingQuestion = state.pending?.kind === 'question_card' ? { id: state.pending.id, fields: state.pending.fields } : undefined;
  // «من فضلك»، "could you tell me" and a trailing "please" are dropped before any reading; the question mark is kept.
  const rawWords = wordsOf(parserText);
  const stripped = stripPoliteness(rawWords, rawWords.map(fold));
  const mark = /[؟?]\s*$/u.exec(text.trim())?.[0]?.trim() ?? '';
  // One-letter typos in closed word lists («tomorow», «الاثلثة» while results are shown); v1 reads the corrected words too.
  const typos = correctTypos(stripped.words, stripped.folded, { results: state.results.length > 0 });
  const polished = stripped.words.length === rawWords.length && !typos.corrected.length ? parserText : `${typos.words.join(' ')}${mark}`;
  const rawWhole = fold(strip(text));
  let v1 = resolveRequestContext(understanding ? text : polished, state.base, { turnId, pendingQuestion, understanding });
  // v1 withholds a phrase that is not phrased as a question once it ends in a question mark («آخر تقرير للبنك الدولي عن التضخم؟»,
  // "find train … tomorrow?") as missing_target, and gives the same words a query without the mark. The mark adds no meaning there.
  if (mark && v1.kind === 'new' && !v1.query && v1.sourceAssessment?.reasons.includes('missing_target')) {
    const unmarked = resolveRequestContext(polished.replace(/\s*[؟?]+\s*$/u, ''), state.base, { turnId, pendingQuestion });
    if (unmarked.kind === 'new' && unmarked.scope === 'public' && unmarked.query) v1 = unmarked;
  }
  const words = typos.words;
  const folded = typos.folded;
  const whole = fold(strip(polished));
  const arabic = isArabic(parserText);
  const top = state.topics.at(-1) ?? null;
  const topForms = top?.property ? PROPERTY_BY_NAME.get(top.property) ?? null : null;
  const next = structuredClone(state);
  next.base = v1.nextState ?? state.base;
  const privateNow = v1.scope === 'private';
  // v1 reads a follow-up after an arithmetic turn as part of that arithmetic, which it keeps private. When v2 leans past the
  // arithmetic to an earlier subject, the privacy that counts is that subject's own (its `lookup`) and the current words' own.
  const privateFor = (older: boolean) => older && top?.operation === 'compute' && v1.intent === 'compute'
    ? resolveRequestContext(polished, null, { turnId }).scope === 'private' : privateNow;
  // v1 extracted this turn's own place and time operands; they are hints for splitting the entity, never instructions.
  const hints: SlotHint[] = v1.slots.filter(slot => slot.sourceTurnId === turnId && (slot.kind === 'place' || slot.kind === 'time'))
    .map(slot => ({ kind: slot.kind as 'place' | 'time', value: slot.value }));
  const result = (type: TurnType, fields: Partial<Omit<LegacyTurnUnderstanding, 'type' | 'v1' | 'next'>> = {}): LegacyTurnUnderstanding => ({
    type, entity: null, property: null, place: null, time: null, query: null, assumption: null, needs: null,
    ...(typos.corrected.length ? { corrected: typos.corrected } : {}), ...fields, v1, next,
  });
  const frameOf = (fields: Partial<TopicFrame> & Pick<TopicFrame, 'entity' | 'property' | 'lookup'>): TopicFrame => ({
    place: null, time: null, template: null, sourceTurnId: turnId, entityOrigin: 'user', ...fields,
  });
  /** The query for a new entity under the same question: by property when one is known, else by the user's own question shape. */
  const entityQuery = (property: PropertyForms | null, frame: TopicFrame): string | null =>
    property ? composeQuery(property, frame, arabic) : frame.template && frame.entity ? frame.template.replace('{}', frame.entity) : composeQuery(null, frame, arabic);

  if (SMALL_TALK.test(whole) || CANCEL.test(whole) || stripped.onlyPoliteness) {
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
  const reformulation = REFORMULATIONS.find(([pattern]) => pattern.test(whole) || pattern.test(whole.replace(/^و(?=.{3,})/u, '')))?.[1];
  if (reformulation) {
    if (!top) return result('field_edit', { edit: reformulation, needs: 'missing_reference' });
    // The subject is unchanged: v1's reading of «اختصر» as a new writing task is not kept as the base.
    next.base = state.base;
    return result('field_edit', { edit: reformulation, entity: top.entity, property: top.property, place: top.place, time: top.time });
  }
  if (GO_AHEAD_ONLY.test(whole)) {
    next.base = state.base;
    return result('ambiguous', { needs: 'missing_reference' });
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

  const corrected = correctionValueWords(words, folded, top);
  if (corrected && (top || CORRECTION_VERBS.some(verb => folded.includes(verb)) || folded.includes('mean') || folded.includes('meant'))) {
    if (!top) return result('correction', { needs: 'missing_reference' });
    const valueWords = corrected.words;
    const valueFolded = corrected.folded;
    const ordinal = findOrdinal(valueFolded);
    const pointed = ordinal !== null ? pointedResult(state, ordinal) : null;
    if (ordinal !== null && !pointed) return result('correction', { needs: 'missing_reference' });
    const raw = operandsFrom(valueWords, valueFolded, 0, hints, Boolean(topForms?.locationValued));
    const lookup = top.lookup && !privateNow;
    if (!pointed && !raw.entity && (raw.place || raw.time) && !(raw.place && placeEntity(topForms))) {
      // «لا، في مصر», «خليها بكرا», "set it to tomorrow": one operand corrected, the entity kept.
      const field = raw.place ? 'place' as const : 'date' as const;
      const value = (raw.place ?? raw.time)!;
      pushCorrection(next, { field, from: raw.place ? top.place : top.time, to: value, turnId });
      const frame = frameOf({ entity: top.entity, property: top.property, place: raw.place ?? top.place, time: raw.time ?? top.time, entityOrigin: top.entityOrigin, lookup });
      pushTopic(next, frame);
      return result('correction', { edit: { field, value }, entity: top.entity, property: top.property, place: frame.place, time: frame.time,
        query: lookup ? composeQuery(topForms, frame, arabic) : null });
    }
    const operands = promotePlace(raw);
    const entity = pointed?.label ?? operands.entity;
    if (!entity) return result('correction', { needs: 'missing_value' });
    pushCorrection(next, { field: 'entity', from: top.entity, to: entity, turnId });
    const frame = frameOf({ entity, property: top.property, place: operands.place ?? top.place, time: operands.time ?? top.time,
      template: top.template, entityOrigin: pointed ? 'host_result' : 'user', lookup });
    pushTopic(next, frame);
    return result('correction', {
      entity, property: top.property, place: frame.place, time: frame.time, query: lookup ? entityQuery(topForms, frame) : null,
      ...(pointed ? { reference: { index: pointed.index, label: pointed.label } } : {}),
    });
  }

  let hit = findProperty(folded, whole);
  if (hit?.pronoun && hit.start > 0) {
    // «الرياض مساحتها كم؟»: the pronoun binds to the entity named before it in the same message, not to an earlier turn.
    const headFolded = folded.slice(0, hit.start);
    const head = promotePlace(operandsFrom(words.slice(0, hit.start), headFolded, contentStart(headFolded), hints, false));
    if (head.entity) hit = { ...hit, pronoun: false };
  }
  const ordinal = state.results.length ? findOrdinal(folded) : null;
  if (ordinal !== null) {
    const pointed = pointedResult(state, ordinal);
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
    // The frame the pronoun refers to: the latest, unless its entity cannot have this property and an earlier one can.
    const chosen = antecedent(state.topics, hit.forms)!;
    if (chosen.mismatch) return result('ambiguous', { property: hit.forms.name, needs: 'missing_reference' });
    const base = chosen.frame;
    const baseForms = base.property ? PROPERTY_BY_NAME.get(base.property) ?? null : null;
    // A displayed answer belongs to the latest reply only.
    const answer = !chosen.older && state.results.length === 1 ? state.results[0]! : null;
    // «وكم عدد سكانها؟» after a capital question asks about the city answered; «وشو عاصمتها؟» after a president question
    // asks about the country, because a capital is not a property of a person.
    const refersToAnswer = Boolean(baseForms?.answerKind && hit.forms.appliesTo.includes(baseForms.answerKind));
    let entity: string | null;
    let origin: TopicFrame['entityOrigin'] = base.entityOrigin;
    let assumption: string | null = null;
    if (refersToAnswer && answer) {
      entity = answer.label;
      origin = 'host_result';
      assumption = assumptionLine(entity, arabic);
    } else if (refersToAnswer && base.entity) {
      entity = compose(baseForms, base.entity, arabic);
      assumption = entity ? assumptionLine(entity, arabic) : null;
    } else {
      entity = base.entity;
      // Skipping the latest subject is a guess the reply should say in one line.
      if (chosen.older && entity) assumption = assumptionLine(entity, arabic);
    }
    if (!entity) return result('ambiguous', { property: hit.forms.name, needs: 'missing_reference' });
    // «وكم عدد سكانها في مصر؟»: a place named with a property of places is the entity asked about.
    if (current.place && placeEntity(hit.forms)) { entity = current.place; origin = 'user'; assumption = null; }
    const lookup = base.lookup && !privateFor(chosen.older);
    const frame = frameOf({ entity, property: hit.forms.name, place: placeEntity(hit.forms) ? null : current.place ?? (refersToAnswer ? null : base.place),
      time: current.time ?? base.time, entityOrigin: origin, lookup });
    pushTopic(next, frame);
    return result('follow_up_property', { entity, property: hit.forms.name, place: frame.place, time: frame.time, assumption,
      query: lookup ? composeQuery(hit.forms, frame, arabic) : null });
  }

  // «وقارنها بالرياض», "compare it with Riyadh": the same property for a new entity, with the earlier entity kept as `against`.
  if (top && !hit && COMPARE.test(whole)) {
    const lead = COMPARE.exec(whole)![0].trim().split(' ').length;
    const compared = promotePlace(operandsFrom(words, folded, lead, hints, Boolean(topForms?.locationValued)));
    // «قارنها بالرياض»: the glued ب after a comparison word is the preposition.
    if (compared.entity && /^بال.{2,}/u.test(fold(compared.entity))) compared.entity = compared.entity.slice(1);
    if (!compared.entity) return result('follow_up_entity', { needs: 'missing_value', ...(top.entity ? { against: top.entity } : {}) });
    const lookup = top.lookup && !privateNow;
    const frame = frameOf({ entity: compared.entity, property: top.property, place: compared.place ?? (topForms?.locationValued ? null : top.place),
      time: compared.time ?? top.time, template: top.template, lookup });
    pushTopic(next, frame);
    return result('follow_up_entity', { entity: compared.entity, property: top.property, place: frame.place, time: frame.time,
      query: lookup ? entityQuery(topForms, frame) : null, ...(top.entity ? { against: top.entity } : {}) });
  }

  const start = hit ? hit.start + hit.length : contentStart(folded);
  const operands = operandsFrom(words, folded, start, hints, Boolean(hit?.forms.locationValued));
  // A message made only of a place or a time («وفي مصر؟», «بكرا؟») leans on the topic before it.
  const slotOnly = Boolean(top) && !hit && operands.entity === null && Boolean(operands.place || operands.time);
  // A question: a question mark, an interrogative leading the message, or one that only asks («كم», «هل», «أي») anywhere in it.
  // «لي» and «قل» trim an entity but ask nothing: «ابنِ لي موقعاً…» (live shadow, 06:32) is a request, not a question.
  let leadWords = 0;
  while (leadWords < folded.length && (LEADS.has(folded[leadWords]!) || FOLLOW_FIRST.has(folded[leadWords]!))) leadWords++;
  const firstWord = bareWord(folded[leadWords] ?? '');
  const asksQuestion = Boolean(mark) || ASKS_FIRST.has(firstWord) || folded.some(word => ASKS_ANYWHERE.has(word) || ASKS_ANYWHERE.has(bareWord(word)));
  const followLead = startsWithFollowLead(folded, whole, asksQuestion) || slotOnly;
  // «وهي في أي قارة؟», «وما أشهر معالمها؟», «وأين تقع؟», "which continent is it in?": a question about the same entity with a
  // property the closed list does not know. A standalone pronoun is replaced by the entity; otherwise the entity is appended.
  // «ما هو الذكاء الاصطناعي؟»: هو/هي right after an identity question word (ما، من، أين…) and before a subject is the copula, not a
  // pointer, as v1 reads it. After «هل» («هل هي كبيرة؟») the pronoun is the pointer.
  const COPULA_LEADS = new Set(['ما', 'ماذا', 'من', 'مين', 'ايش', 'وش', 'شو', 'شنو', 'ايه', 'متي', 'اين', 'وين', 'كيف', 'كم', 'what', 'who', 'where', 'when', 'how']);
  const copula = (index: number) => ['هو', 'هي'].includes(bareWord(folded[index]!)) && index > 0 && COPULA_LEADS.has(bareWord(folded[index - 1]!))
    && index + 1 < folded.length && !QUESTION_WORDS.has(folded[index + 1]!) && !PREPOSITIONS.has(folded[index + 1]!);
  const isPointer = (word: string) => POINTERS.has(word) || POINTERS.has(bareWord(word)) || /^.{3,}(?:ها|هم|هن)$/u.test(word) && !TIME_SET.has(word) && !LEADS.has(word) && !QUESTION_WORDS.has(word);
  const isVerb = (word: string) => FOLLOW_VERBS.has(word) || FOLLOW_VERBS.has(bareWord(word));
  const isFunction = (word: string) => [word, bareWord(word)].some(form => LEADS.has(form) || QUESTION_WORDS.has(form) || PREPOSITIONS.has(form) || TIME_SET.has(form) || FOLLOW_FIRST.has(form));
  const explicitPointer = folded.some((word, index) => !copula(index) && isPointer(word));
  // «أين تقع باريس؟» names its own subject: the verb alone makes no follow-up. «وأين تقع؟» and «ولماذا؟» name none.
  const namesOwnEntity = folded.some(word => !isFunction(word) && !isVerb(word) && !isPointer(word));
  const pointsBack = explicitPointer || !namesOwnEntity && asksQuestion && folded.some(word => isVerb(word) || QUESTION_WORDS.has(word) || QUESTION_WORDS.has(bareWord(word)));
  // An open follow-up opens like one (a lead, a glued و/ف, an interrogative or a pronoun) and is short. A long message whose
  // pronoun points inside itself («لعيادة أسنان اسمها «ابتسامة»», «لعيادتي وأضع فيه اسمها») names its own subject.
  const opensAsFollowUp = leadWords > 0 || /^[وف].{2,}$/u.test(folded[0] ?? '') || ASKS_FIRST.has(firstWord) || POINTERS.has(firstWord);
  const contentWords = folded.filter((word, index) => !copula(index) && !isFunction(word) && !isPointer(word)).length;
  // The subject of an open follow-up: the latest frame, or the one before an arithmetic turn («كم يساوي 15 ضرب 23؟»).
  const subject = subjectFrame(state.topics);
  if (subject?.frame.entity && !hit && pointsBack && asksQuestion && !slotOnly && opensAsFollowUp && contentWords <= OPEN_FOLLOW_MAX_CONTENT) {
    const base = subject.frame;
    const lookup = base.lookup && !privateFor(subject.older);
    let lead = 0;
    while (lead < folded.length && (LEADS.has(folded[lead]!) || FOLLOW_FIRST.has(bareWord(folded[lead]!)) && !QUESTION_WORDS.has(bareWord(folded[lead]!)))) lead++;
    const asked = words.slice(lead).map((word, index) => index === 0 && /^[وف]/u.test(folded[lead]!) && !/^[وف]/u.test(fold(base.entity!)) ? word.slice(1) : word);
    const standalone = asked.findIndex(word => STANDALONE_PRONOUNS.has(fold(strip(word))));
    const content = asked.filter(word => { const key = fold(strip(word)); return key && !STANDALONE_PRONOUNS.has(key) && !LEADS.has(key); });
    // «وهو؟», "and it?": a pointer with no question in it.
    if (!content.length) return result('ambiguous', { entity: base.entity, needs: 'missing_value' });
    const question = standalone >= 0 ? asked.map((word, index) => index === standalone ? base.entity! : word).join(' ') : `${asked.join(' ').replace(/[؟?]+$/u, '')} ${base.entity}`;
    pushTopic(next, frameOf({ ...base, property: null, sourceTurnId: turnId, lookup }));
    return result('follow_up_property', { entity: base.entity, property: null, place: base.place, time: base.time,
      ...(subject.older ? { assumption: assumptionLine(base.entity!, arabic) } : {}), query: lookup ? question.trim() : null });
  }
  if (followLead && top) {
    // After an arithmetic turn a «و…» follow-up leans on the subject before it: «من هو أينشتاين؟» → «كم يساوي 2+2؟» → «ونيوتن؟».
    const lead = subject?.frame ?? top;
    const leadForms = lead.property ? PROPERTY_BY_NAME.get(lead.property) ?? null : null;
    const leadAssumption = subject?.older && lead.entity ? { assumption: assumptionLine(lead.entity, arabic) } : {};
    const property = hit?.forms ?? leadForms;
    const lookup = lead.lookup && !privateFor(Boolean(subject?.older));
    const current = hit?.forms.locationValued || !hit && leadForms?.locationValued ? operandsFrom(words, folded, start, hints, true) : operands;
    // «ونيوتن؟», «ونيوتن»: the و that made this a follow-up is not part of the name, unless the name itself begins with و («وادي رم»).
    if (current.entity && !hit && words.length <= 3 && /^و.{2,}/u.test(folded[0]!) && fold(current.entity).startsWith(folded[0]!) && !WAW_NAMES.has(folded[0]!)) current.entity = current.entity.slice(1);
    if (current.entity && (!hit || hit.forms.name === lead.property)) {
      const frame = frameOf({ entity: current.entity, property: property?.name ?? null, place: current.place ?? (property?.locationValued ? null : lead.place),
        time: current.time ?? lead.time, template: hit ? null : lead.template, lookup });
      pushTopic(next, frame);
      return result('follow_up_entity', { entity: current.entity, property: property?.name ?? null, place: frame.place, time: frame.time,
        query: lookup ? entityQuery(property, frame) : null });
    }
    if (hit && (!current.entity || fold(current.entity) === fold(lead.entity ?? ''))) {
      // «وعدد السكان؟» after a price question in between: the subject is the latest frame that can have this property.
      const chosen: { frame: TopicFrame; older: boolean; mismatch?: true } = current.entity ? { frame: lead, older: Boolean(subject?.older) } : antecedent(state.topics, hit.forms)!;
      if (chosen.mismatch) return result('ambiguous', { property: hit.forms.name, needs: 'missing_reference' });
      const base = chosen.frame;
      const baseLookup = base.lookup && !privateFor(chosen.older);
      const frame = frameOf({ entity: base.entity, property: hit.forms.name, place: current.place ?? base.place, time: current.time ?? base.time,
        entityOrigin: base.entityOrigin, lookup: baseLookup });
      pushTopic(next, frame);
      return result('follow_up_property', { entity: base.entity, property: hit.forms.name, place: frame.place, time: frame.time,
        ...(chosen.older && base.entity ? { assumption: assumptionLine(base.entity, arabic) } : {}),
        query: baseLookup ? composeQuery(hit.forms, frame, arabic) : null });
    }
    if (!hit && !current.entity && current.place && placeEntity(leadForms)) {
      // «وفي مصر؟» after the population of a city asks about مصر: for a property of places the new place is the entity.
      const frame = frameOf({ entity: current.place, property: lead.property, place: null, time: current.time ?? lead.time, lookup });
      pushTopic(next, frame);
      return result('follow_up_entity', { entity: current.place, property: lead.property, place: null, time: frame.time,
        query: lookup ? composeQuery(leadForms, frame, arabic) : null });
    }
    if (!hit && !current.entity && (current.place || current.time)) {
      // Same entity and property, one operand changed: «وفي الامارات؟» after an iPhone price, «وبكرا؟» after today's weather.
      const edit = { field: current.place ? 'place' as const : 'date' as const, value: current.place ?? current.time };
      const frame = frameOf({ entity: lead.entity, property: lead.property, place: current.place ?? lead.place, time: current.time ?? lead.time,
        entityOrigin: lead.entityOrigin, lookup });
      pushTopic(next, frame);
      return result('field_edit', { edit, entity: lead.entity, property: lead.property, place: frame.place, time: frame.time, ...leadAssumption,
        query: lookup ? composeQuery(leadForms, frame, arabic) : null });
    }
  }

  let fresh = promotePlace(operands);
  if (!fresh.entity && hit && !hit.pronoun && hit.start > 0) {
    // "Tokyo population", «الرياض مساحتها»: the entity stands before the property word.
    const head = words.slice(0, hit.start), headFolded = folded.slice(0, hit.start);
    const before = promotePlace(operandsFrom(head, headFolded, contentStart(headFolded), hints, false));
    if (before.entity) fresh = { entity: before.entity, place: fresh.place ?? before.place, time: fresh.time ?? before.time };
  }
  const entity = fresh.entity;
  if (v1.kind === 'ambiguous' && v1.ambiguities.includes('missing_reference') && !entity) return result('ambiguous', { needs: 'missing_reference' });
  if (GENERIC_TARGET.test(whole) && !/https?:\/\/|www\./iu.test(polished)) {
    next.results = [];
    pushTopic(next, frameOf({ entity: null, property: null, lookup: false }));
    return result(top ? 'topic_change' : 'new_request', { needs: 'missing_value' });
  }
  // A question about Mohassan itself, a go-ahead with more words («أكمل في Chrome») or a bare acknowledgement («موافق») is never a public lookup.
  // The owner's own file («أضف علامة مائية على آخر ملف pdf», «ما حجم ملفي؟») is not a public lookup either.
  const aboutSelf = ABOUT_ASSISTANT.test(whole) || ABOUT_ASSISTANT.test(rawWhole) || CONTINUE_START.test(whole) || APPROVE.test(whole) && words.length <= 3
    || actsOnArtifact(folded, whole);
  const publicLookup = !privateNow && !aboutSelf && v1.scope === 'public' && ['web_search', 'news'].includes(v1.intent);
  // In legacy mode, a dialect question may leave v1 without a query. A named property of a named entity can still be a public lookup.
  const composed = !privateNow && !aboutSelf && !publicLookup && Boolean(hit && !hit.pronoun && entity) && ['web_search', 'news', 'unknown'].includes(v1.intent)
    && v1.sourceAssessment?.scope !== 'private';
  const lookup = publicLookup || composed;
  next.results = [];
  next.schedule = (() => { const parsed = parseSchedule(polished); return parsed ? { ...parsed, sourceTurnId: turnId } : null; })();
  // The question shape for later «و{entity}؟» follow-ups: only when the entity appears verbatim in the user's own words.
  const cleaned = clean(polished);
  const template = entity && lookup && cleaned.includes(entity) ? cleaned.replace(entity, '{}') : null;
  const frame = frameOf({ entity, property: hit?.forms.name ?? null, place: fresh.place, time: fresh.time, template, lookup,
    ...(v1.intent === 'compute' ? { operation: 'compute' as const } : {}) });
  pushTopic(next, frame);
  // A new request searches with v1's own-words query when v1 read it as new; v1's follow-up query is not used, because v2 decided
  // this is a new subject. When v1 withheld the query («افحص المشروع ما هي الوظائف…» is not a public lookup) and no named property
  // can be composed, there is no query: v1's boundary stands.
  const own = v1.kind === 'new' && v1.query ? v1.query : null;
  return result(top ? 'topic_change' : 'new_request', { entity, property: hit?.forms.name ?? null, place: frame.place, time: frame.time,
    query: lookup ? own ?? (hit && !hit.pronoun ? composeQuery(hit.forms, frame, arabic) : null) : null });
}
