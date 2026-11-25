import { maskRequestLiteralData } from '../request-constraints.js';

export type QuestionAnswerType = 'person' | 'place' | 'time' | 'quantity' | 'reason' | 'method' | 'definition' | 'yes/no' | 'list';

export interface QuestionShape {
  /** The canonical interrogative or auxiliary. Some questions have only a question mark. */
  questionWord: string | null;
  answerType: QuestionAnswerType;
  /** The clause left after removing the question marker and any auxiliary at the start. */
  corePhrase: string;
}

const ARABIC_DIRECT = {
  ماذا: ['ماذا', 'definition'],
  ما: ['ما', 'definition'],
  اي: ['أي', 'definition'],
  من: ['من', 'person'],
  اين: ['أين', 'place'],
  متي: ['متى', 'time'],
  كم: ['كم', 'quantity'],
  لماذا: ['لماذا', 'reason'],
  كيف: ['كيف', 'method'],
  هل: ['هل', 'yes/no'],
  اليس: ['أليس', 'yes/no'],
  الم: ['ألم', 'yes/no'],
  الن: ['ألن', 'yes/no'],
} as const satisfies Record<string, readonly [string, QuestionAnswerType]>;
type ArabicWord = keyof typeof ARABIC_DIRECT;

const ENGLISH_DIRECT = {
  who: 'person', whom: 'person', whose: 'person', where: 'place', when: 'time',
  'how many': 'quantity', 'how much': 'quantity', why: 'reason', how: 'method',
  what: 'definition', which: 'definition',
} as const satisfies Record<string, QuestionAnswerType>;
type EnglishWord = keyof typeof ENGLISH_DIRECT;

const ARABIC_START = /^(?:[وف]\s*)?(?:(من|الي|في|علي|عن|ب)\s+)?(ماذا|ما|اي|من|اين|متي|ب?كم|لماذا|كيف|هل|اليس|الم|الن)(?=\s|$)/u;
const ENGLISH_START = /^(?:(from|in|on|by|for|to|with|at)\s+)?(how many|how much|who|whom|whose|where|when|why|how|what|which)(?:['’](?:s|re|d|ll))?(?=\s|$)/u;
const ENGLISH_AUX = /^(is|are|am|was|were|do|does|did|has|have|had|can|could|will|would|shall|should|may|might|must|won['’]t|can['’]t)(?:n['’]t)?(?=\s|$)/u;
const ARABIC_COPULA = /^(?:هو|هي|هم|هن|هما)\s+(?=\S)/u;
const ARABIC_NEGATIVE = /^(?:(?:هو|هي|هم|هن|هما)\s+(?:الا|سوي)|زال(?:ت|وا)?|دام|برح|انفك|عدا|خلا|عندي|عندنا|لدينا|لدي|معي|معنا|فيه|كان(?:ت|وا)?|عم|ادري|اعرف|اقدر|فهمت|شفت|قلت|فعلت|ابي|اريد)(?=\s|$)/u;
const ARABIC_FIRST_PERSON_PAST = /^(?:حضرت|قرات|بحثت|سمعت|عرفت|كتبت|وصلت|ذهبت|رجعت|اخذت|شاهدت|اشتريت|سالت|استلمت|اعتقدت|حفظت|تذكرت)(?=\s|$)/u;
const ARABIC_ROLE = /^(?:ال)?(?:شخص|رءيس|حاكم|ملك|امير|وزير|كاتب|مءلف|مخرج|ملحن|صاحب|مدير|بطل|فاءز|فنان|لاعب|مخترع|مكتشف|شاعر|مصمم|مءسس|مالك|قاءد|مسءول)(?=\s|$)/u;
const ARABIC_PERSON = [
  /^(?:هو|هي|هما|هم|هن|انت(?:م|ن)?|الذي|التي|الذين|كان(?:ت)?|اول|اخر)(?=\s|$)/u,
  /^(?:فاز|كتب(?:ت)?|الف(?:ت)?|اخترع|اسس|صمم|صنع|رسم|اخرج|قال|بن[يا]|حكم|قاد|لحن|اكتشف|شارك|ولد|قتل|زار|زرع|عمل|تولي|انتخب|حضر|غادر|استقال|وصل|كسب|غن[يا]|انشد|اتصل|جاء|صور|صوت)(?=\s|$)/u,
  /^[يت](?:كتب|رسم|قرا|تولي|دير|شرف|نتخب|شارك|بحث|صلح|ختار|ذهب|صل|عود|عرف|بيع|شتري|ستطيع|قدر|ملك|عمل|قوم|ساعد|مثل|بني|زرع|صنع|تكلم|حب|ريد|اخذ|غادر|رجع|سال|جيب|رغب|عد|فتح|شغل|غني|عزف|ءلف|عرض|سكن)(?:ون|ان|ن)?(?=\s|$)/u,
  ARABIC_ROLE,
];
const ARABIC_INFIX_BLOCK = /^(?:لا|لن|لم|ليس|اذا|عندما|اعرف|ادري|عرفت|اعتقد|سال|سالت|قال|قلت|تذكر|اكتب|ترجم|افتح|اقرا|لخص|اذكر|اريد|ابحث|اطبع|اعمل|اعرض)(?=\s|$)/u;
const ARABIC_INFIX = /^(\S+(?:\s+\S+){0,4}?)\s+([وف]?(?:اين|متي|كم|لماذا|كيف|من|ما))(?=\s|$)(?:\s+(.*))?$/u;
const ARABIC_INDIRECT = /(?:^|\s)(?:عن|علي|يعرف|تعرف|نعرف|علمت|عرفنا|معرفه|سال|سالت|نسال|السءال|سءال)$/u;
const ARABIC_POLAR = /^(?:انا|انت(?:م|ن)?|نحن|هو|هي|هم|هذا|هذه|ذلك|تلك|وصل|غادر|انتهي|نجح|فاز|صدر|تقدر|يمكن|ممكن|يصلح|يعمل|يقبل|تعمل|تقبل)(?=\s|$)|^\S.+\s+(?:صحيح|متاح|موجود|مفتوح|مغلق|مناسب|ممكن|وصل|نجح|انتهي|خلص)$/u;
const ENGLISH_POLAR = /^(?:you|it|he|she|they|we|this|that|these|those)\s+\S/u;
const ENGLISH_DO_IMPERATIVE = /^(?:it|this|that|(?:(?:your|the) )?(?:homework|chores|job|work|research|best))(?=\s|$)/u;
const ARABIC_LIST = /^(?:(?:اذكر|اسرد)(?:\s+لي)?|عدد\s+لي)(?=\s|$)/u;
const ENGLISH_LIST = /^(?:list|name|enumerate)(?=\s|$)/u;
const POLITE_LEAD = /^(?:(?:من فضلك|لو سمحت|رجاء|please|kindly|الرجاء)[،,\s]+)+/u;
const QUESTION_FRAME = /^(?:(?:اشرح|وضح|فسر|بين|علمني|قل لي|اخبرني)(?:\s+لي)?|(?:اريد|اود)\s+(?:(?:ان\s+)?(?:اعرف|افهم|اسال)|معرفه)|(?:explain|describe|(?:can you )?tell me|teach me)(?:\s+(?:to me|for me|briefly|simply|in simple terms))?|i (?:want|would like) to know)\s+/u;
const ARABIC_REASON = /^(?:ال)?(?:سبب|اسباب)(?:\s+|$)/u;
const ENGLISH_REASON = /^(?:(?:the\s+)?(?:(?:main|primary)\s+)?(?:reasons?|causes?)\s+(?:of|for|behind|why)|causes?|caused)(?:\s+|$)/u;

const ARABIC_EXPECTATIONS: ReadonlyArray<readonly [QuestionAnswerType, RegExp]> = [
  ['reason', ARABIC_REASON],
  ['place', /^(?:ال)?(?:عاصم[هت]|مقر|مكان|مدين[هت]|موقع|عنوان|دول[هت]|بلد|وجه[هت])(?:ها|هم|ه|ك|ي)?(?=\s|$)/u],
  ['time', /^(?:ال)?(?:تاريخ|وقت|موعد|عام|سن[هت]|يوم|شهر|ساع[هت]|توقيت)(?:ها|هم|ه|ك|ي)?(?=\s|$)/u],
  ['quantity', /^(?:ال)?(?:سعر|قيم[هت]|رقم|تكلف[هت]|تكاليف|عدد|عمر|طول|ارتفاع|عمق|مساح[هت]|سرع[هت]|نسب[هت]|ابعاد|وزن|عرض|مقدار|درج[هت]|مجموع|حجم|دخل|راتب)(?:ها|هم|ه|ك|ي)?(?=\s|$)/u],
  ['list', /^(?:ال)?(?:انواع|انماط|امثل[هت]|اشكال|اصناف|خيارات|فواءد|اضرار|اعراض|خصاءص|عناصر|مراحل|خطوات|مكونات|شروط|اسماء|ادوات|قدرات|قاءم[هت])(?:ها|هم|ه|ك|ي)?(?=\s|$)/u],
  ['person', ARABIC_ROLE],
];
const ENGLISH_EXPECTATIONS: ReadonlyArray<readonly [QuestionAnswerType, RegExp]> = [
  ['reason', ENGLISH_REASON],
  ['place', /^(?:capitals?|locations?|places?|cities|city|countries|country|addresses?|destinations?|headquarters)\b/u],
  ['time', /^(?:times?|dates?|months?|years?|days?|hours?|seasons?|centur(?:y|ies))\b/u],
  ['quantity', /^(?:(?:average|total|current)\s+)?(?:prices?|costs?|ages?|counts?|amounts?|numbers?|weights?|lengths?|heights?|widths?|depths?|speeds?|distances?|areas?|populations?|percentages?|values?|sizes?|volumes?|temperatures?|salar(?:y|ies)|rates?)\b/u],
  ['list', /^(?:(?:main|common|primary|major|possible|different|key)\s+)*(?:kinds?|types?|categories|examples?|steps?|requirements?|benefits?|risks?|symptoms?|stages?|ingredients?|elements?|components?|options?|lists?|names|branches)\b/u],
  ['person', /^(?:person|author|inventor|founder|president|prime minister|mayor|artist|actor|singer|director|player)\b/u],
];

function expected(core: string, options: ReadonlyArray<readonly [QuestionAnswerType, RegExp]>): QuestionAnswerType {
  return options.find(([, pattern]) => pattern.test(core))?.[0] ?? 'definition';
}

function arabicQuestion(text: string, punctuated: boolean): QuestionShape | null {
  const start = ARABIC_START.exec(text);
  if (!start) return null;
  const [, preposition, rawWord] = start;
  const word = (rawWord === 'بكم' ? 'كم' : rawWord) as ArabicWord;
  if (preposition && !['اين', 'ماذا', 'اي', 'من'].includes(word)) return null;
  const tail = text.slice(start[0].length).trim();
  if (!/[\p{L}\p{N}]/u.test(tail)) return null;
  if (word === 'من' && !ARABIC_PERSON.some(pattern => pattern.test(tail)) && !(punctuated && /^(?:لم|لا)\s+\S/u.test(tail))) return null;
  if (word === 'ما' && (ARABIC_NEGATIVE.test(tail) || !punctuated && ARABIC_FIRST_PERSON_PAST.test(tail))) return null;
  if (word === 'كم' && !punctuated && /^(?:من|كنت|كان)\s+/u.test(tail)) return null;
  const [questionWord, direct] = ARABIC_DIRECT[word];
  const core = direct === 'yes/no' ? tail : tail.replace(ARABIC_COPULA, '');
  const answerType = word === 'كم' && /^الساعه(?:$|\s+(?:الان|عندك)$)/u.test(core) ? 'time'
    : direct === 'definition' ? expected(core, ARABIC_EXPECTATIONS) : direct;
  const corePhrase = answerType === 'reason' ? core.replace(ARABIC_REASON, '').trim() || core : core;
  return { questionWord, answerType, corePhrase };
}

function englishQuestion(text: string, punctuated: boolean): QuestionShape | null {
  const start = ENGLISH_START.exec(text);
  const auxiliary = start ? null : ENGLISH_AUX.exec(text);
  if (!start && !auxiliary) return null;
  const tail = text.slice((start ?? auxiliary)![0].length).trim();
  if (!/[\p{L}\p{N}]/u.test(tail)) return null;
  if (auxiliary) {
    const word = auxiliary[1]!;
    if (auxiliary[0] === 'do' && !punctuated && ENGLISH_DO_IMPERATIVE.test(tail)) return null;
    const questionWord = /^won/u.test(word) ? 'will' : word.startsWith('can') ? 'can' : word;
    return { questionWord, answerType: 'yes/no', corePhrase: tail };
  }

  const word = start![2] as EnglishWord;
  const core = tail.replace(ENGLISH_AUX, '').trim() || tail;
  let answerType: QuestionAnswerType = ENGLISH_DIRECT[word];
  if (answerType === 'definition') answerType = expected(core.replace(/^(?:the|a|an|my|our|your|their|his|her)\s+/u, ''), ENGLISH_EXPECTATIONS);
  if (word === 'how') {
    if (/^(?:soon|often|long\s+(?:ago|until|before|after))\b/u.test(core) || /^long\s+(?:does|will|did)\b.+\btake\b/u.test(core)) answerType = 'time';
    else if (/^(?:old|far|fast|tall|high|deep|wide|heavy|long)\b/u.test(core)) answerType = 'quantity';
  }
  const corePhrase = answerType === 'reason' ? core.replace(ENGLISH_REASON, '').trim() || core : core;
  return { questionWord: word, answerType, corePhrase };
}

function arabicInfix(text: string, punctuated: boolean): QuestionShape | null {
  if (ARABIC_INFIX_BLOCK.test(text)) return null;
  const match = ARABIC_INFIX.exec(text);
  if (!match) return null;
  const [, before, rawWord, after] = match;
  if (after && ARABIC_INDIRECT.test(before!)) return null;
  const word = rawWord!.replace(/^[وف]/u, '') as ArabicWord;
  if (word === 'ما' || word === 'من') {
    if (after && /^(?:هو|هي)$/u.test(before!)) return arabicQuestion(`${word} ${after}`, punctuated);
    // Arabic also uses these words for negation, prepositions and relative clauses.
    if (after || !punctuated) return null;
  }
  const [questionWord, direct] = ARABIC_DIRECT[word];
  const corePhrase = [before, after].filter(Boolean).join(' ');
  const answerType = direct === 'definition' ? expected(corePhrase, ARABIC_EXPECTATIONS) : direct;
  return { questionWord, answerType, corePhrase };
}

/** Read the first question in a message. Feed it the shared normalized match text. */
export function detectQuestionShape(matchText: string): QuestionShape | null {
  let offset = 0;
  // Ignore sentence boundaries inside literal data, but retain quoted operands such as a book title.
  for (const part of maskRequestLiteralData(matchText).split(/((?<=[.?!؟])\s+|\n+)/u)) {
    const raw = matchText.slice(offset, offset + part.length);
    offset += part.length;
    if (!part.trim()) continue;
    const punctuated = /[؟?]\s*$/u.test(part);
    const text = raw.replace(/^[\s,،;؛:.!?؟]+|[\s,،;؛:!?؟.]+$/gu, '').replace(POLITE_LEAD, '');
    if (!text) continue;

    const framed = QUESTION_FRAME.exec(text);
    const clause = framed ? text.slice(framed[0].length) : text;
    const direct = arabicQuestion(clause, punctuated) ?? englishQuestion(clause, punctuated)
      ?? (framed ? englishQuestion(text, punctuated) : null);
    if (direct) return direct;
    if (framed) {
      const reason = ARABIC_REASON.exec(clause);
      const corePhrase = reason ? clause.slice(reason[0].length).trim() : '';
      if (corePhrase) return { questionWord: null, answerType: 'reason', corePhrase };
      continue;
    }

    const list = ARABIC_LIST.exec(text) ?? ENGLISH_LIST.exec(text);
    if (list) {
      const corePhrase = text.slice(list[0].length).trim();
      if (corePhrase) return { questionWord: null, answerType: 'list', corePhrase };
      continue;
    }

    if (ARABIC_START.test(text) || ENGLISH_START.test(text) || ENGLISH_AUX.test(text)) continue;
    const infix = arabicInfix(text, punctuated);
    if (infix) return infix;
    if (punctuated && (ARABIC_POLAR.test(text) || ENGLISH_POLAR.test(text))) {
      return { questionWord: null, answerType: 'yes/no', corePhrase: text };
    }
  }
  return null;
}
