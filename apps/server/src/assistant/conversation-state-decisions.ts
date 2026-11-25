import { shorterRequest } from './answer-reshape.js';
import type { PendingStep, TopicFrame, TurnUnderstanding } from './conversation-state.js';
import type { ConversationEntity, ConversationEntityKind } from './conversation-state-entities.js';
import { resolveRequestContext } from './request-context.js';
import { returnParts } from './return-to.js';

export type ConversationTurnType = 'new_request' | 'follow_up' | 'card_answer' | 'correction'
  | 'refinement' | 'confirmation' | 'small_talk';
export type ConversationQuestionType = 'why' | 'when' | 'where' | 'who' | 'what' | 'which' | 'how'
  | 'how_many' | 'how_much' | 'yes_no';
export type ConversationDecisionReason = 'pending_question' | 'explicit_confirmation' | 'explicit_correction'
  | 'answer_reformulation' | 'social_message' | 'explicit_reference' | 'elliptical_question' | 'compatible_entity'
  | 'unresolved_reference' | 'previous_question' | 'continued_query' | 'explicit_subject' | 'new_request';

export interface ConversationTurnDecision {
  type: ConversationTurnType;
  /** Strength of the matched rules, from 0 to 1. */
  confidence: number;
  reasons: ConversationDecisionReason[];
  reference: ConversationEntity | null;
  /** Antecedents used by the decision, including every entity inserted into the standalone request. */
  references: ConversationEntity[];
  standalone: string | null;
  questionType: ConversationQuestionType | null;
}

export interface ConversationTurnInput {
  text: string;
  legacy: Pick<TurnUnderstanding, 'type' | 'entity' | 'edit' | 'query' | 'place' | 'time' | 'property' | 'v1'>;
  entities: readonly ConversationEntity[];
  previousTopic?: TopicFrame | null;
  pending?: PendingStep | null;
  hasPreviousAnswer?: boolean;
  /** The host accepted this submission for the pending step. */
  boundAnswer?: boolean;
}

const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'").toLowerCase();
const bare = (text: string) => fold(text).replace(/^[\s،,.!؟?:؛;]+|[\s،,.!؟?:؛;]+$/gu, '');
function listed<T>(entries: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}
const CONFIRMATION = /^(?:(?:طيب|تمام|حسنا|موافق|اوكي|ok|okay|yes|sure)[،,\s]+)?(?:نعم|اجل|اي|ايوا|ايوه|ايه|اه|تمام|اكيد|طبعا|موافق|اوافق|صحيح|ماشي|حسنا|اوكي|يلا|لا|كمل|اكمل|تابع|واصل|نفذ|تم|خلصت|yes|yeah|yep|yup|ok(?:ay)?|sure|fine|agreed|approved|correct|exactly|no|nope|done|go ahead|go on|proceed|continue|do it|carry on|resume)(?:\s+(?:شكرا|please|thanks|من فضلك))?$/u;
const CORRECTION = /^(?:(?:لا|no|nope|عفوا|sorry)[،,\s]+)?(?:اقصد|قصدت|قصدي|اعني|بل|i mean|i meant|rather|correction)(?=$|[\s:،,])/u;
const SOCIAL = /^(?:ازيك|ازيك عامل ايه|كيفكم|كيف حالكم|شلونك|شلونكم|وش اخبارك|شو اخبارك|يا هلا|هلا والله|اهلا وسهلا|وعليكم السلام|صباح النور|مساء النور|تسلم ايدك|ميرسي|cheers|good afternoon|good night|how's it going)$/u;
const FOLLOW_LEAD = /^(?:(?:طيب|طب|تمام|حسنًا|حسنا|أوكي|اوكي|ok(?:ay)?|well|so)[،,\s]+)+|^(?:and|also)\s+|^[وف](?=(?:متي|متى|إمتى|امتى|وقتاش|ليش|ليه|لماذا|علاش|اين|أين|وين|فين|كيف|كم|كام|ما|ماذا|من|مين|هل|هي|هو|هم|فيه|فيها|عنها|عنه|العنوان|السعر|الموقع|ساعات العمل|مواعيد العمل)(?!\p{L}))/iu;
const POLITE_QUESTION_LEAD = /^(?:(?:من فضلك|لو سمحت(?:ي)?|ممكن (?:تقول(?:ي)? لي|تخبرني)|تقدر تقول(?:ي)? لي|بدي [اأإ]عرف|عايز [اأإ]عرف|please|(?:can|could|would) you (?:please )?tell me)[،,\s]+)+/iu;
const SAME = /^(?:(?:و|and\s+)?(?:نفس الشي(?:ء)?|نفس الموضوع|the same(?: thing)?|same(?: thing)?))(?=$|[\s؟?,،])/u;
const EXPLICIT_REQUEST = /^(?:افتح|احذف|ارسل|اشتر|اضغط|انقر|احفظ|ذكرني|اكتب|ارسم|خطط|ابحث|سجل|انشي|انشئ|open|delete|send|buy|click|save|remember|write|draw|plan|search|create)(?!\p{L})/u;
const MORE = /^(?:اشرح|وضح|فصل|وسع|زدني)(?:ها|ه)?\s*(?:اكثر|بالتفصيل|تفاصيل اكثر)?$|^(?:give me more detail(?:s)?|explain (?:more|further|(?:it|that) in more detail))$/u;
const PROPERTY_REFORMULATIONS = new Set(['language', 'format', 'detail', 'unit']);
const LEGACY_FOLLOW_UPS = new Set(['follow_up_property', 'follow_up_entity', 'reference']);

interface PropertyFragment {
  pattern: RegExp;
  kinds: readonly ConversationEntityKind[];
  questionType: ConversationQuestionType;
  render(entity: string, firstWord: string): string;
}
const PROPERTY_FRAGMENTS: readonly PropertyFragment[] = [
  { pattern: /^(?:ما )?(?:ال)?عنوان$/u, kinds: ['place', 'organization', 'other'], questionType: 'what',
    render: name => `ما عنوان ${name}` },
  { pattern: /^(?:اين|وين|فين) (?:ال)?عنوان$/u, kinds: ['place', 'organization', 'other'], questionType: 'where',
    render: (name, firstWord) => `${firstWord} عنوان ${name}` },
  { pattern: /^(?:ما )?(?:ساعات|اوقات|مواعيد) (?:العمل|الدوام|الفتح)$/u, kinds: ['place', 'organization', 'other'], questionType: 'what',
    render: name => `ما ساعات عمل ${name}` },
  { pattern: /^(?:(?:كم|كام|ما) )?(?:ال)?(?:سعر|ثمن|تكلفه)$/u, kinds: ['other', 'organization'], questionType: 'how_much',
    render: (name, firstWord) => `${/^(?:ما|كم|كام)$/u.test(firstWord) ? firstWord : 'كم'} سعر ${name}` },
  { pattern: /^(?:what(?: is|'s) (?:the )?|the )?address$/u, kinds: ['place', 'organization', 'other'], questionType: 'what',
    render: name => `What is the address of ${name}` },
  { pattern: /^(?:what are (?:the )?|the )?(?:(?:opening|business|working) )?hours$/u, kinds: ['place', 'organization', 'other'], questionType: 'what',
    render: name => `What are the opening hours of ${name}` },
  { pattern: /^(?:what(?: is|'s) (?:the )?|the )?(?:price|cost)$/u, kinds: ['other', 'organization'], questionType: 'what',
    render: name => `What is the price of ${name}` },
];

const AR_QUESTION: Readonly<Record<string, ConversationQuestionType>> = {
  لماذا: 'why', ليه: 'why', ليش: 'why', علاش: 'why',
  متي: 'when', امتي: 'when', امتا: 'when', ايمتي: 'when', وقتاش: 'when',
  اين: 'where', وين: 'where', فين: 'where', فينهي: 'where',
  من: 'who', مين: 'who', شكون: 'who',
  ما: 'what', ماذا: 'what', ايه: 'what', ايش: 'what', وش: 'what', شو: 'what', شنو: 'what', ماهو: 'what', ماهي: 'what',
  اي: 'which', كيف: 'how', ازاي: 'how', شلون: 'how', كيفاش: 'how', كم: 'how_many', كام: 'how_many', قديش: 'how_much',
  هل: 'yes_no',
};
const EN_QUESTION: Readonly<Record<string, ConversationQuestionType>> = {
  why: 'why', when: 'when', where: 'where', who: 'who', whom: 'who', whose: 'who', what: 'what', "what's": 'what',
  which: 'which', how: 'how', is: 'yes_no', are: 'yes_no', was: 'yes_no', were: 'yes_no', do: 'yes_no', does: 'yes_no',
  did: 'yes_no', has: 'yes_no', have: 'yes_no', can: 'yes_no', could: 'yes_no', will: 'yes_no', would: 'yes_no',
  should: 'yes_no', had: 'yes_no', may: 'yes_no',
};
const EN_AUX = new Set(['is', 'are', 'was', 'were', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will',
  'would', 'may', 'might', 'must', 'should', "wasn't", "isn't", "aren't", "weren't", 'been', 'be', "didn't", "doesn't"]);
const AR_COPULA_QUESTIONS = new Set(['ما', 'ماذا', 'من', 'مين', 'شو', 'شنو', 'ايش', 'وش', 'كم']);
const AR_PREPOSITIONS: Readonly<Record<string, string>> = {
  فيها: 'في', فيه: 'في', عنها: 'عن', عنه: 'عن', لها: 'لـ', له: 'لـ', بها: 'بـ', به: 'بـ',
  اليها: 'إلى', اليه: 'إلى', منها: 'من', منه: 'من', عليها: 'على', عليه: 'على', عندها: 'عند', عنده: 'عند',
};
const AR_POSSESSIVE_STEMS: Readonly<Record<string, string>> = {
  عاصمت: 'عاصمة', لغت: 'لغة', عملت: 'عملة', مساحت: 'مساحة', مدينت: 'مدينة', منطقت: 'منطقة', شركت: 'شركة',
  وزارت: 'وزارة', مدرست: 'مدرسة', جامعت: 'جامعة', عائلت: 'عائلة', والدت: 'والدة', قصت: 'قصة', نشات: 'نشأة',
  حيات: 'حياة', حرارت: 'حرارة', درجت: 'درجة', مدت: 'مدة', وفات: 'وفاة', ولادت: 'ولادة', وظيفت: 'وظيفة',
  جنسيت: 'جنسية', مهنت: 'مهنة', جهت: 'جهة', صنعت: 'صنعة', ثروت: 'ثروة', نتيجت: 'نتيجة', نهايت: 'نهاية',
  بدايت: 'بداية', قيمت: 'قيمة', تكلفت: 'تكلفة', ميزانيت: 'ميزانية', معرفت: 'معرفة', فائدت: 'فائدة',
  صفحت: 'صفحة', رابط: 'رابط', موقع: 'موقع', اسم: 'اسم', لون: 'لون', عمر: 'عمر', طول: 'طول', ارتفاع: 'ارتفاع',
  مؤسس: 'مؤسس', رئيس: 'رئيس', سكان: 'سكان', معالم: 'معالم', عدد: 'عدد', تاريخ: 'تاريخ', مصدر: 'مصدر',
  سبب: 'سبب', عنوان: 'عنوان', سعر: 'سعر', ثمن: 'ثمن', وزن: 'وزن', حجم: 'حجم', انجازات: 'إنجازات',
  اب: 'أب', اخ: 'أخ', زوج: 'زوج', مقر: 'مقر', اصل: 'أصل', انتاج: 'إنتاج', منتجات: 'منتجات', درجات: 'درجات',
};

interface Word { written: string; key: string; start: number; end: number }
interface Pointer {
  start: number;
  end: number;
  prefix?: string;
  possessive?: boolean;
  gender?: ConversationEntity['gender'];
  kinds?: readonly ConversationEntityKind[];
  plural?: boolean;
  token?: string;
}

function wordsOf(text: string): Word[] {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu)].map(match => ({
    written: match[0], key: fold(match[0]), start: match.index, end: match.index + match[0].length,
  }));
}

function questionType(words: readonly Word[]): ConversationQuestionType | null {
  const first = words[0]?.key ?? '';
  const second = words[1]?.key;
  if (first === 'how' && second === 'many') return 'how_many';
  if (first === 'how' && second === 'much') return 'how_much';
  if (/^(?:كم|كام)$/u.test(first) && /^(?:ال)?(?:سعر|ثمن|تكلفه|وزن|طول|مساحه|عمر)/u.test(second ?? '')) return 'how_much';
  if (first === 'what' && /^(?:date|year|time)$/u.test(second ?? '')) return 'when';
  if (first === 'في' && second === 'اي' && /^(?:عام|سنه|تاريخ|وقت)$/u.test(words[2]?.key ?? '')) return 'when';
  const leading = listed(AR_QUESTION, first) ?? listed(EN_QUESTION, first);
  if (leading) return leading;
  const last = words.at(-1)?.key ?? '';
  if (/^(?:كام|كم|قديش)$/u.test(last)) return listed(AR_QUESTION, last) ?? null;
  if (words.find((word, index) => word.key === 'اي' && words[index - 1]?.key === 'في')) return 'which';
  return null;
}

function stripFollowLead(text: string): string {
  const stripped = text.trim().replace(FOLLOW_LEAD, '').trim();
  const politeQuestion = stripped.replace(POLITE_QUESTION_LEAD, '').replace(FOLLOW_LEAD, '').trim();
  return questionType(wordsOf(politeQuestion)) ? politeQuestion : stripped;
}

function pointerAt(words: readonly Word[], index: number): Pointer | null {
  const word = words[index]!;
  const prior = words[index - 1]?.key;
  const next = words[index + 1]?.key;
  const base = { start: word.start, end: word.end };
  const key = /^[وف](?:هو|هي|هم|فيه|فيها|له|لها|عنه|عنها)$/u.test(word.key) ? word.key.slice(1) : word.key;
  const connector = key === word.key ? '' : word.written[0]!;
  const preposition = listed(AR_PREPOSITIONS, key);
  if (preposition) return { ...base, prefix: connector + preposition + (preposition.endsWith('ـ') ? '' : ' '),
    ...(preposition === 'في' ? { kinds: ['place'] } : {}) };
  if (key === 'هو' || key === 'هي') {
    if (prior && AR_COPULA_QUESTIONS.has(prior) && next && !/^(?:في|من|عن|له|لها)$/u.test(next)) return null;
    return { ...base, prefix: connector, gender: key === 'هو' ? 'masculine' : 'feminine' };
  }
  if (key === 'هم') return { ...base, prefix: connector, plural: true };
  if (/^(?:ذلك|تلك|هذا|هذه)$/u.test(key) && /^(?:التاريخ|السنه|العام|الرقم|القيمه|المبلغ)$/u.test(next ?? '')) {
    return { ...base, end: words[index + 1]!.end };
  }
  if (/^(?:ده|دي)$/u.test(key) && /^(?:التاريخ|السنه|العام|الرقم|القيمه|المبلغ)$/u.test(prior ?? '')) {
    return { ...base, start: words[index - 1]!.start };
  }
  if (key === 'ذلك' || key === 'تلك' || key === 'ده' || key === 'دي') return base;
  const suffix = /^(.{2,}?)(ها|ه|هم|هن)$/u.exec(key);
  const stem = suffix ? listed(AR_POSSESSIVE_STEMS, suffix[1]!) : undefined;
  if (stem) return { ...base, prefix: stem + ' ', ...(suffix![2]!.length === 2 && suffix![2] !== 'ها' ? { plural: true } : {}) };
  if (key === 'he' || key === 'him' || key === 'his') {
    return { ...base, kinds: ['person'], gender: 'masculine', possessive: key === 'his' };
  }
  if (key === 'she' || key === 'her') {
    const possessive = key === 'her' && Boolean(next && !/^(?:to|in|at|on|for|from|by|with|and|or|before|after|about)$/u.test(next));
    return { ...base, kinds: ['person'], gender: 'feminine', possessive };
  }
  if (key === 'there' && !(prior && EN_AUX.has(prior) && next && next !== 'to')
      && !(index === 0 && next && EN_AUX.has(next))) {
    return { ...base, prefix: 'in ', kinds: ['place'] };
  }
  if (key === 'its' || key === 'their') return { ...base, possessive: true, plural: key === 'their' };
  if (key === 'they' || key === 'them' || key === 'it') return { ...base, plural: key !== 'it', token: key };
  if (key === 'that' && !/^(?:say|said|think|thought|know|believe|believed|mean|meant|show|shows)$/u.test(prior ?? '')) {
    if (next === 'city' || next === 'country' || next === 'place') return { ...base, end: words[index + 1]!.end, kinds: ['place'] };
    if (next === 'company' || next === 'organization') return { ...base, end: words[index + 1]!.end, kinds: ['organization'] };
    if (next === 'person' || next === 'man' || next === 'woman') return { ...base, end: words[index + 1]!.end, kinds: ['person'] };
    if (/^(?:movie|film|book|novel|song|product)$/u.test(next ?? '')) return { ...base, end: words[index + 1]!.end, kinds: ['other'] };
    if (/^(?:date|year|day|number|amount|value|figure)$/u.test(next ?? '')) return { ...base, end: words[index + 1]!.end };
    return base;
  }
  return null;
}

const BIOGRAPHY = /(?<!\p{L})(?:ولد|ولدت|توفي|توفيت|مات|ماتت|ولادته|ولادتها|وعمره|وعمرها|عمره|عمرها|born|died|die|birth|death|biography)(?!\p{L})|\bhow old\b/u;
const ORGANIZATION = /(?<!\p{L})(?:تاسس|تاسست|مقرها|مقره|المقر|رئيسها التنفيذي|رئيسه التنفيذي)(?!\p{L})|\b(?:founded|headquarters|CEO|ceo|incorporated|established)\b/u;
const LOCATION = /(?<!\p{L})(?:سكانها|سكانه|مساحتها|مساحته|دوله|مدينه|قاره|بلد|العاصمه|عاصمتها|عاصمته|عملتها|عملته)(?!\p{L})|\b(?:capital|currency|population|continent)\b/u;
const COUNTRY_PROPERTY = /(?<!\p{L})(?:عاصمتها|عاصمته|عملتها|عملته|رئيسها|رئيسه|لغتها|لغته)(?!\p{L})|\b(?:its|their) (?:capital|currency|official language|president)\b/u;
const DATE_REFERENCE = /(?<!\p{L})(?:التاريخ ده|هذا التاريخ|ذلك التاريخ|السنه دي|تلك السنه|هذا العام|ذلك العام)(?!\p{L})|\bthat (?:date|year|day)\b/u;
const NUMBER_REFERENCE = /(?<!\p{L})(?:الرقم ده|هذا الرقم|ذلك الرقم|تلك القيمه|هذه القيمه|ذلك المبلغ)(?!\p{L})|\bthat (?:number|amount|value|figure)\b/u;
const AR_ELLIPSIS = /^(?:ولد|ولدت|توفي|توفيت|مات|ماتت|يعيش|تعيش|يسكن|تسكن|تاسس|تاسست|انشي|انشئ|انشات|افتتح|افتتحت|بني|بنيت|تقع|يقع|تبعد|يبعد|نشر|نشرت|حدث|صار|حصل|انتهي|انتهت|بدا|بدات)(?:\s+(?:بالضبط|اول مره|اول|اخر مره|الحين|الان|دلوقتي))?$/u;
const EN_ELLIPSIS = /^(?:born|founded|built|opened|closed|established|incorporated|published|located|started|ended)(?:\s+exactly)?$/u;
const INHERITED_QUESTION = /^(?:what about|how about|what of|وماذا عن|ماذا عن|وش عن|شو عن|ايش عن|وماذا عنهم|ما عنه|ما عنها)(?:\s+|$)/u;
const CLAIM_REFERENCE = /^(?:why|how|لماذا|ليش|ليه|ازاي|كيف)(?: (?:is|was) (?:it|that)| (?:هذا|ذلك|كده|كذا))?$|^(?:is (?:it|that) true|هل ذلك صحيح)$/u;
const SAFE_ENTITY = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'\u2019(),&-]{0,199}$/u;
const SAFE_SCALAR = /^[\p{N}][\p{L}\p{M}\p{N} :/.,%+-]{0,99}$/u;

function questionKinds(value: string, pointer: Pointer | null, question: ConversationQuestionType | null,
  property: TurnUnderstanding['property']): readonly ConversationEntityKind[] | null {
  if (pointer?.kinds) return pointer.kinds;
  if (DATE_REFERENCE.test(value)) return ['date'];
  if (NUMBER_REFERENCE.test(value)) return ['number'];
  if (BIOGRAPHY.test(value)) return ['person'];
  if (LOCATION.test(value)) return ['place'];
  if (ORGANIZATION.test(value)) return ['organization', 'place'];
  if (property === 'age') return ['person', 'other'];
  if (/(?:^|\s)(?:تقع|يقع|located)(?:\s|$)/u.test(value)) return ['place', 'organization', 'other'];
  if (question === 'where' && /(?:^|\s)(?:ه[وي]|it|that|there)(?:\s|$)/u.test(value)) return ['place', 'organization', 'other'];
  return null;
}

function selectReference(entities: readonly ConversationEntity[], kinds: readonly ConversationEntityKind[] | null,
  pointer: Pointer | null, preferred: string | null, preferUser: boolean): ConversationEntity | null {
  const candidates = entities.filter(entity => (SAFE_ENTITY.test(entity.text)
      || (entity.kind === 'date' || entity.kind === 'number') && SAFE_SCALAR.test(entity.text))
    && (kinds ? kinds.includes(entity.kind) : entity.kind !== 'number' && entity.kind !== 'date')
    && (entity.kind !== 'person' || !pointer?.gender || !entity.gender || pointer.gender === entity.gender));
  const score = (entity: ConversationEntity) => entity.salience
    + (pointer?.gender && entity.gender === pointer.gender ? 0.16 : 0)
    + (kinds?.[0] === entity.kind ? 0.12 : 0)
    + (preferUser && entity.role === 'user' ? 0.18 : 0)
    + (preferred && fold(entity.text) === fold(preferred) ? 0.18 : 0);
  return candidates.sort((left, right) => score(right) - score(left))[0] ?? null;
}

function referenceName(reference: ConversationEntity, pointer: Pointer, entities: readonly ConversationEntity[],
  used: Set<ConversationEntity>, text: string): string {
  used.add(reference);
  const companion = pointer.plural && reference.kind === 'person' && reference.role === 'assistant'
    ? entities.find(entity => entity.kind === 'person' && entity.turnId === reference.turnId && entity.role === reference.role
      && fold(entity.text) !== fold(reference.text) && SAFE_ENTITY.test(entity.text)
      && Math.abs(reference.salience - entity.salience) <= 0.2)
    : null;
  if (companion) used.add(companion);
  const name = companion ? reference.text + (/^\p{Script=Arabic}/u.test(text) ? ' و' : ' and ') + companion.text : reference.text;
  return name + (pointer.possessive ? "'s" : '');
}

function addQuestionMark(question: string, source: string): string {
  const raw = question.trim().replace(/[.؟?]+$/u, '');
  const ending = /[؟?]\s*$/u.exec(source)?.[0]?.trim();
  return raw + (ending ?? (/^\p{Script=Arabic}/u.test(source) ? '؟' : '?'));
}

function previousQuestion(topic: TopicFrame | null | undefined, entity: string | null): string | null {
  return topic?.template && entity && SAFE_ENTITY.test(entity) ? topic.template.replace('{}', () => entity) : null;
}

function rewriteQuestion(text: string, words: readonly Word[], pointers: readonly Pointer[],
  resolve: (pointer: Pointer | null) => ConversationEntity | null, entities: readonly ConversationEntity[],
  used: Set<ConversationEntity>, question: ConversationQuestionType | null, ellipsis: boolean): string | null {
  if (!question && !/[؟?]$/u.test(text) || CLAIM_REFERENCE.test(bare(text))) return null;
  if (pointers.length) {
    if (pointers[0]!.start === 0 && pointers[0]!.end >= text.replace(/[؟?]+$/u, '').trimEnd().length) return null;
    let revised = text;
    for (const pointer of [...pointers].reverse()) {
      const reference = resolve(pointer);
      if (!reference) return null;
      const name = referenceName(reference, pointer, entities, used, text);
      revised = revised.slice(0, pointer.start) + (pointer.prefix ?? '') + name + revised.slice(pointer.end);
      if (pointer.token === 'they' && name === reference.text) {
        // Singular "they" can become a named singular subject. Keep the auxiliary in agreement.
        const before = revised.slice(0, pointer.start).replace(/\b(are|were|do|have)(?=\s+$)/iu, match =>
          ({ are: 'is', were: 'was', do: 'does', have: 'has' })[match.toLowerCase()]!);
        revised = before + revised.slice(pointer.start);
      }
    }
    return addQuestionMark(revised, text);
  }
  const reference = resolve(null);
  if (!reference || !ellipsis || words.length <= 1) return null;
  used.add(reference);
  const last = words.at(-1)!;
  if (/^\p{Script=Arabic}/u.test(text)) return addQuestionMark(text.slice(0, last.end) + ' ' + reference.text, text);
  const lead = words[0]!;
  const auxiliary = words.slice(1).find(word => EN_AUX.has(word.key));
  if (auxiliary) return addQuestionMark(text.slice(0, auxiliary.end) + ' ' + reference.text + text.slice(auxiliary.end), text);
  const verb = words.find(word => word.key === 'located') ? ' is ' : ' was ';
  return addQuestionMark(lead.written + verb + reference.text + text.slice(lead.end), text);
}

/** Classifies the user turn and optionally projects a standalone question using bounded conversation data. */
export function decideConversationTurn(input: ConversationTurnInput): ConversationTurnDecision {
  const { legacy, previousTopic, entities, pending } = input;
  const returning = returnParts(input.text);
  const text = stripFollowLead(returning?.question ?? input.text);
  const words = wordsOf(text);
  const value = bare(text);
  const whole = bare(input.text);
  const fragment = PROPERTY_FRAGMENTS.find(rule => rule.pattern.test(value));
  const question = questionType(words) ?? fragment?.questionType ?? null;
  const decision = (type: ConversationTurnType, confidence: number, reasons: ConversationDecisionReason[],
    reference: ConversationEntity | null = null, standalone: string | null = null,
    kind = question, references = reference ? [reference] : []): ConversationTurnDecision => ({
    type, confidence, reasons, reference, references, standalone, questionType: kind,
  });

  if (input.boundAnswer && pending) {
    return pending.kind === 'approval' ? decision('confirmation', 1, ['explicit_confirmation'])
      : decision('card_answer', 1, ['pending_question']);
  }
  if (pending && pending.kind !== 'approval' && (legacy.v1.kind === 'answer' || legacy.type === 'card_answer')) {
    return decision('card_answer', 0.99, ['pending_question']);
  }
  const currentFocus = () => selectReference(entities, null, null, previousTopic?.entity ?? null, false);
  if (CORRECTION.test(whole) || legacy.type === 'correction') {
    const reference = currentFocus();
    const replacement = legacy.type === 'correction' && !legacy.edit && legacy.entity && reference
      && fold(legacy.entity) !== fold(reference.text) && !questionType(wordsOf(legacy.entity))
      && (!legacy.place || legacy.place === previousTopic?.place) && (!legacy.time || legacy.time === previousTopic?.time)
      && !EXPLICIT_REQUEST.test(bare(legacy.entity)) ? legacy.entity : null;
    const revised = !pending && previousTopic?.lookup && legacy.v1.scope !== 'private'
      ? previousQuestion(previousTopic, replacement) : null;
    return decision('correction', 0.97, ['explicit_correction'], reference, revised,
      revised ? questionType(wordsOf(stripFollowLead(revised))) : question);
  }
  if (CONFIRMATION.test(whole) && !(whole === 'ايه' && /[؟?]$/u.test(input.text.trim()))
      || legacy.type === 'card_answer' && pending) return decision('confirmation', 0.96, ['explicit_confirmation']);
  if (shorterRequest(input.text) || MORE.test(value) || legacy.edit && PROPERTY_REFORMULATIONS.has(legacy.edit.field)) {
    return decision('refinement', 0.97, ['answer_reformulation'], currentFocus());
  }
  if (legacy.type === 'small_talk' || SOCIAL.test(whole) || legacy.v1.intent === 'chat' && !question) {
    return decision('small_talk', 0.96, ['social_message']);
  }
  if (legacy.type === 'compound' || EXPLICIT_REQUEST.test(value) && !returning) return decision('new_request', 0.96, ['new_request']);

  const pointers = words.map((_, index) => pointerAt(words, index)).filter((pointer): pointer is Pointer => pointer !== null);
  const pointer = pointers[0] ?? null;
  const tail = words.slice(1).map(word => word.key).join(' ');
  const englishTail = words.slice(1).filter(word => !EN_AUX.has(word.key)).map(word => word.key).join(' ');
  const ellipsis = Boolean(fragment) || question !== null && (AR_ELLIPSIS.test(tail) || EN_ELLIPSIS.test(englishTail))
    || CLAIM_REFERENCE.test(value);
  const same = SAME.test(value);
  const asksPrevious = same || INHERITED_QUESTION.test(value);
  const continuing = LEGACY_FOLLOW_UPS.has(legacy.type) && (!question || legacy.type !== 'follow_up_entity' || asksPrevious)
    || legacy.type === 'field_edit' && Boolean(legacy.query);
  if (!returning && !pointer && !ellipsis && !same && !continuing) {
    return decision('new_request', question ? 0.93 : 0.83, [question ? 'explicit_subject' : 'new_request']);
  }

  if (!previousTopic && !input.hasPreviousAnswer && !entities.length) {
    const ambiguous = Boolean(pointer || ellipsis || same);
    return decision('new_request', ambiguous ? 0.55 : 0.83, [ambiguous ? 'unresolved_reference' : 'new_request']);
  }
  // A determiner or pronoun inside a newly named question is not automatically a turn-level reference.
  if (pointer && !returning && !ellipsis && !same && !continuing && !question && !/[؟?]$/u.test(text)) {
    return decision('new_request', 0.84, ['new_request']);
  }

  const reason: ConversationDecisionReason = returning || pointer ? 'explicit_reference'
    : same ? 'previous_question' : ellipsis ? 'elliptical_question' : 'continued_query';
  const preferUser = COUNTRY_PROPERTY.test(value);
  const preferred = returning?.subject ?? (preferUser || !pointer && continuing ? legacy.entity : null);
  const possible = returning ? entities.filter(entity => (' ' + fold(entity.text) + ' ').includes(' ' + fold(returning.subject) + ' ')) : entities;
  const resolve = (operand: Pointer | null) => selectReference(possible, fragment?.kinds ?? questionKinds(value, operand, question, legacy.property),
    operand, preferred, preferUser);
  const reference = resolve(pointer);
  // An explicit return supplies its own subject. An intervening private turn can
  // taint inherited v1 intent, so also check the return on its own.
  const allowed = !pending && (legacy.v1.scope !== 'private'
    || Boolean(returning && resolveRequestContext(input.text).scope !== 'private'));
  const inheritedQuestion = asksPrevious ? previousQuestion(previousTopic, legacy.type === 'follow_up_entity'
    ? legacy.entity : reference?.text ?? previousTopic?.entity ?? null) : null;
  // The legacy projection may omit the interrogative. Only use it for a fragment that does not contain one.
  const projected = (!question && continuing && !pointer || asksPrevious) ? legacy.query : null;
  const fragmentQuestion = fragment && reference ? addQuestionMark(fragment.render(reference.text, words[0]?.written ?? ''), text) : null;
  const used = new Set(reference ? [reference] : []);
  const standalone = !allowed ? null : inheritedQuestion
    ?? fragmentQuestion ?? (reference && !asksPrevious ? rewriteQuestion(text, words, pointers, resolve, possible, used, question, ellipsis) : null) ?? projected;
  const resolvedQuestion = standalone ? questionType(wordsOf(stripFollowLead(standalone))) ?? question : question;
  return decision('follow_up', reference ? (pointer || returning ? 0.95 : 0.88) : continuing ? 0.78 : 0.59,
    [reason, reference ? 'compatible_entity' : 'unresolved_reference'], reference, standalone, resolvedQuestion,
    standalone ? [...used] : reference ? [reference] : []);
}
