import { figureKind, hasFigureOf, isMetaLine, isReasonQuestion, isUiText } from './answer-check.js';
import { reasonAnswers, reasonSubject, topicWords } from './hands.js';
import { matchText, normalizeRequest } from './mind/normalize.js';
import { extractQuantities, type Quantity } from './truth-agreement-quantities.js';

// Ported question rules from PR #27, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/7eb3713c42a1/apps/server/src/assistant/truth-agreement-question.ts
export type TruthAnswerType = 'date' | 'number' | 'person' | 'place' | null;
export type QuestionFinding = 'answer_type' | 'wrong_entity' | 'wrong_relation';

const DATE = /^(?:متي|امتي|ايمتي|في اي (?:عام|سنه|تاريخ|يوم)|when|(?:(?:in|on) )?what (?:year|date|day))(?=\s|$)/u;
const NUMBER = /^(?:كم|قديش|اديش|how (?:many|much|long|old|far|tall|high|big|fast|heavy|wide|deep)|what (?:is|was) the (?:number|population|price|height|area|age|cost|speed|weight|distance|length|duration|capacity|temperature|radius|diameter))(?:\s|$)/u;
const PERSON = /^(?:من|مين|who|whom)(?:\s|$)|^who['’]s(?:\s|$)/u;
const PLACE = /^(?:where|which (?:city|country|region|continent|place)|what (?:is|was) the (?:capital|address|location) of|(?:من )?اين|وين|في اي (?:مدينه|بلد|دوله|منطقه|مكان)|ما (?:هي )?عاصمه)(?=\s|$)/u;
const PLACE_ASK_SUFFIX = /(?:\s+(?:located|situated|based)|\s+(?:يقع|تقع|موقعه|موقعها))$/u;
const PLACE_ASK_VERB = /^(?:(?:is|are|was|were|do|does|did|located|situated|based|the)|(?:يقع|تقع|كان|كانت|موقع))\s+/u;

const IDENTITY = /^(?:(?:من|مين) (?:هو|هي)|who (?:is|was|are|were))(?:\s|$)/u;
const PERSON_ROLE = /\b(?:person|man|woman|people|writer|author|scientist|musician|actor|actress|historian|politician|mathematician|physicist|poet|engineer|artist|president|king|queen|founder|director|chair|mayor|professor|teacher|doctor|company|organization|organisation|association|foundation|government|team|minister|player|singer|pilot|runner|athlete|chief|CEO|agency|publisher|band)\b|(?:شخص|رجل|امراه|كاتب|مؤلف|عالم|ممثل|ممثله|مؤرخ|سياسي|رياضي|فيزيائي|شاعر|مهندس|فنان|رئيس|ملك|ملكه|مؤسس|مدير|استاذ|طبيب|شركه|مؤسسه|منظمه|جمعيه|حكومه|فريق|وزير|لاعب|مغن|طيار|وكاله)/iu;
const ROLE_NAME = /\b(?:mr|mrs|ms|dr|sir|captain|professor|president|king|queen)\.?\s+|(?:الدكتور|الدكتوره|الرئيس|المهندس|الاستاذ|الملك|الملكه|الكابتن)\s+/iu;
const NAME = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}\p{M}'’.-]+|\p{Lu})(?:[ \t]+(?:(?:de|del|van|von|of|the) )?(?:\p{Lu}[\p{L}\p{M}'’.-]+|\p{Lu})){0,5}/gu;
const NOT_NAME = /^(?:the|a|an|it|he|she|they|none|online|its|who|this|that|official|president|ceo|founder|director|king|queen|yes|no|true|false|there|last|first|several|someone|anyone|unknown|anonymous|unconfirmed|history|about|because|after|from|part|today|january|february|march|april|may|june|july|august|september|october|november|december|year|an? unknown .+|the [a-z]+)$/iu;
const ARABIC_PARTICLE = /^(?:هو|هي|كان|كانت|كتب|كتبت|الف|الفت|الذي|التي|وهو|وهي|من|في|عام|سنه|الروايه)$/u;
const ARABIC_NOT_NAME = /^(?:الكاتب|المؤلف|الشخص|الانسان|البلد|الفيلم|الكتاب|المجهول|مجهول|شخص|كاتب|كتاب|روايه|فيلم|شيء|سنه|عام|لا|نعم|تم|حسب|انه|انها|المدينه)$/u;

interface Relation {
  id: string;
  ask: RegExp;
  clues: RegExp;
}

function relation(id: string, clues: RegExp, ask = clues): Relation {
  const wordPattern = (source: string) => new RegExp(source.replace(/\p{Script=Arabic}{2,}(?: \p{Script=Arabic}{2,})*/gu,
    word => `(?<![\\p{L}])(?:و|ف)?(?:ب|ل|ك)?(?:ال)?${word}(?:ت|ه|ها|هم|ات|هَا|ا|وا|ون|يه|ي)?(?![\\p{L}])`), 'u');
  return { id, ask: wordPattern(ask.source), clues: wordPattern(clues.source) };
}

const RELATIONS = [
  relation('attendance', /\b(?:attend(?:ed|ance|ing)?|turnout)\b|حضر|حضور/u),
  relation('population', /\b(?:population|populous|inhabitants?|residents?|people live)\b|سكان|تعداد|نسمه|يقطن/u),
  relation('age', /\b(?:age|aged|years? old)\b|عمر|يبلغ من العمر/u, /\b(?:how old|age)\b|عمر/u),
  relation('height', /\b(?:height|elevation|tall|high)\b|ارتفاع|مرتفع/u),
  relation('length', /\b(?:length|wide|long|kilometres? long|miles? long)\b|طول|عرض/u),
  relation('area', /\b(?:area|square kilometres?|square miles?)\b|مساحه/u),
  relation('duration', /\b(?:duration|takes?|lasts?|took|lasted)\b|مده|يستغرق|تستغرق|استغرق|تستمر|تدوم/u, /\b(?:how long (?:does|did|will)|duration)\b|مده|يستغرق|تستغرق|استغرق|تستمر/u),
  relation('cost', /\b(?:price|prices|cost|costs|costing|priced|fee|fares?)\b|سعر|تكلف|رسوم|ثمن/u),
  relation('distance', /\b(?:distance|away|far)\b|مسافه|يبعد|تبعد/u),
  relation('speed', /\b(?:speed|travel[ls]? at|travels? at|per second|per hour)\b|سرعه|كيلومتر في الساعه|متر لكل ثانيه/u),
  relation('weight', /\b(?:weighs?|weighed|weight|mass)\b|وزن|كتله/u),
  relation('capacity', /\b(?:capacity|accommodates?|seats?|holds?)\b|سعه|يتسع|تتسع|تسع|مقاعد|مقعد/u),
  relation('temperature', /\btemperatures?\b|درجه حراره|درجه الحراره|حراره/u),
  relation('radius', /\bradius\b|نصف قطر/u),
  relation('diameter', /\bdiameter\b|(?<!نصف )قطر/u),
  relation('capital', /\bcapitals?\b|عاصم/u),
  relation('found', /\b(?:found(?:s|ed|ing|ation|er|ers)|establish(?:ed|ing|ment)?|incorporat(?:ed|ion))\b|تاسيس|تاسس|اسس|انشا|انشئ/u),
  relation('open', /\b(?:open(?:s|ed|ing)?|inaugurat(?:ed|ion))\b|افتتح|افتتاح|فتح|افتتحت/u),
  relation('close', /\b(?:clos(?:e|ed|ing|ure)|shut)\b|اغلق|اغلاق/u),
  relation('start', /\b(?:begin|begins|began|beginning|start(?:s|ed|ing)?|onset|outbreak|broke out)\b|بدا|بدء|اندلع|اندلاع/u),
  relation('depart', /\b(?:depart(?:ed|ure|s|ing)?|leaves?|left|sets? off)\b|غادر|مغادره|ابحر|ابحار/u),
  relation('arrive', /\b(?:arriv(?:e|es|ed|al)|reached)\b|وصل|وصول/u),
  relation('end', /\b(?:ends?|ended|ending|concluded|ceased|dissolv(?:ed|e)|dissolution)\b|انتهي|انتهت|انتهاء|نهايه/u),
  relation('birth', /\b(?:born|birth|birthday)\b|مولد|ميلاد|ولد/u),
  relation('death', /\b(?:died|death|passed away|killed|assassinat(?:ed|ion))\b|مات|وفاه|توفي|قتل|اغتيل|اغتيال/u),
  relation('fall', /\b(?:fall|falls|fell|fallen|collapse(?:d)?|fell down)\b|سقط|سقوط|انهار|انهيار/u),
  relation('construction', /\b(?:build|built|construction|construct(?:ed|ion))\b|بنا|بني|شيد|تشييد/u),
  relation('demolition', /\b(?:demolish(?:ed)?|dismantl(?:e|ed)|demolition|torn down)\b|هدم|ازيل|ازاله/u),
  relation('independence', /\bindependen(?:ce|t)\b|استقلال|استقل/u),
  relation('reunification', /\b(?:reunif(?:ied|ication)|unif(?:ied|ication))\b|توحد|توحيد/u),
  relation('demonstration', /\b(?:demonstrat(?:ion|ions|ed)|protests?|protested|rallies)\b|مظاهرات|مظاهره|احتجاج/u),
  relation('approval', /\b(?:approve[ds]?|approval|adopt(?:s|ed))\b|وافق|موافقه|اقر|اقرار/u),
  relation('rejection', /\b(?:reject(?:s|ed|ion)?|veto(?:ed|s)?)\b|رفض|استبعد/u),
  relation('issue', /\b(?:issue[ds]?|issuance)\b|صدر|اصدار/u),
  relation('release', /\b(?:release(?:d)?|launch(?:ed)?|premiere(?:d)?|publication|publish(?:ed)?)\b|اطلاق|اطلق|نشر/u),
  relation('sign', /\b(?:sign(?:ed|ing)|signature|ratif(?:ied|ication))\b|وقع|توقيع|صادق|مصادقه/u),
  relation('discover', /\bdiscover(?:ed|s|y|ies)\b|اكتشف|اكتشاف/u),
  relation('invent', /\b(?:invent(?:ed|s|or|ion)|devised)\b|اخترع|اختراع|مخترع/u),
  relation('write', /\b(?:write|wrote|written|author(?:ed|s)?|novelist|playwright|(?:novel|book|poem|story|play|tragedy) by)\b|الف|تاليف|مؤلف|كتب/u),
  relation('direct', /\b(?:director|direct(?:ed|s|ing))\b|اخرج|اخراج|مخرج/u),
  relation('compose', /\b(?:compose(?:d|r)?|music by)\b|لحن|تلحين|ملحن/u),
  relation('design', /\b(?:design(?:ed|er|s)?|architect(?:s)?)\b|صمم|تصميم|مصمم|معماري/u),
  relation('treasurer', /\btreasurers?\b|امين صندوق/u),
  relation('secretary', /\bsecretar(?:y|ies)\b|امين سر/u),
  relation('appointment', /\bappoint(?:s|ed|ment)?\b|عين|تعيين/u),
  relation('own', /\b(?:owns?|owned|owner(?:ship)?|took over|take[ns]? over|acquir(?:e|ed|es|ing))\b|يملك|تمتلك|المالك|مالكه|ملكيه|استحوذ/u),
  relation('win', /\b(?:won|win|winner|victory)\b|فاز|فائز|حقق الفوز/u),
  relation('lead', /\b(?:president|ceo|leader|led|chair(?:person)?|chief executive)\b|الرئيس|رئيس|مدير|قاد|قياده/u),
  relation('teach', /\b(?:taught|teach(?:es)?|teacher)\b|درس|معلم/u),
  relation('name', /\b(?:named|naming|called|takes its name)\b|سمي|سميت|تسميه/u),
] as const;

const STATISTIC = /\b(?:median|average|mean|minimum|maximum|lowest|highest|total|net|gross)\b|الوسيط|وسيط|المتوسط|متوسط|ادني|اعلي|الحد الادني|الحد الاعلي|صافي|اجمالي/u;

const FILLER = new Set([
  'date', 'year', 'month', 'day', 'happened', 'occur', 'occurred', 'event', 'who', 'whom', 'has', 'had', 'have', 'been', 'it',
  'does', 'did', 'do', 'get', 'go', 'went', 'what', 'which', 'number', 'total', 'as', 'at', 'per', 'approximately', 'is', 'was', 'are',
  'were', 'many', 'much', 'tall', 'fast', 'old', 'big', 'heavy', 'high', 'deep', 'tell', 'me', 'please', 'known', 'called',
  'عام', 'سنه', 'تاريخ', 'شهر', 'يوم', 'حدث', 'حدثت', 'وقع', 'وقعت', 'تم', 'كان', 'كانت', 'الذي', 'التي', 'سن', 'يدعي', 'يعرف',
  'يقدر', 'تقدر', 'يسمي', 'تسمي', 'مقدار', 'مجموع', 'اجمالي', 'زمن', 'وقت', 'تحديدا', 'تقريبا', 'تبلغ', 'يبلغ', 'استنادا', 'ال', 'مجموع', 'كل', 'صار', 'بالغ', 'لتذكره', 'تذكره', 'تذاكر', 'ticket',
]);
const NOT_ENTITIES = /^(?:the|and|for|with|in|on|by|from|of|which|what|when|where|who|how|why|an?|latest|current|today|please)$/iu;
const GENERIC_COUNT = /^(?:how many\s+([\p{L}-]+)|كم (?:عدد\s+)?(\p{L}+))/u;
const PROSPECTIVE = /\b(?:projected|forecast|expected|planned|plans to|plan to|would|could|may (?:be|have|assume|mean|show|appear)|suggested|speculated|predict(?:ed|ion)?)\b|متوقع|يتوقع|من المتوقع|من المقرر|توقعات|تخطط|يخطط|من المخطط|اقترح|من المحتمل/u;
const NEGATION = /\b(?:not|never|without|neither|no|didn't|wasn't|isn't)\b|(?:^|\s)(?:لم|لن|ليس|ليست|غير)(?:\s|$)/u;
const RELATIVE = /(?:\b(?:son|daughter|brother|sister|father|mother|wife|husband|nephew|niece) of\s+|(?:ابن|ابنه|ابنه|نجل|ابنه|ابنته|بنت|شقيق|شقيقه|والد|والده|زوج|زوجه)\s+)/u;
const POSSESSIVE_RELATIVE = /(?:^\s*['’]s\s+(?:son|daughter|brother|sister|father|mother|wife|husband)\b|^\s+(?:ابنه|ابنته|نجله|شقيقه|زوجته|والده)(?=\s|$|[،,.]))/u;
const ALIAS = /(?:\bcalled\s+|\bknown as\s+|(?:سمي|يسمي|يعرف باسم|يدعي)\s+)$/u;
const FORMER_NAME = /\b(?:former|formerly|old|ancient) name\b|(?:اسم[هه]?\s+القديم|اسمه السابق|سابقا باسم)/u;
const QUALIFIED_NAME = /\b(?:previously|formerly|former name|old name|ancient name)\b|قديما|السابق|القديم|سابقا/u;
const BASE_PRONOUN = /^(?:\W*(?:it|he|she|they|its|his|her|their|with (?:a|the) population)\b|[وف]?(?:هو|هي|كان|كانت)(?:\s|$)|[وف]?(?:تبلغ|يبلغ|عدد)?\s*(?:سكانها|سكانه|عمرها|عمره|عاصمتها|ارتفاعه))/u;
const UNIT_ONLY = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|واحد|واحده|اثنان|اثنتان|ثلاثه|اربعه|خمسه|سته|سبعه|ثمانيه|تسعه|عشره)$/u;
const CLAUSE_DIVIDER = /[;؛]|[,،](?![\d٠-٩۰-۹])|\b(?:whereas|while|but|then|though|although|and)\b|(?:^|\s)(?:لكن|بينما|اما|ثم|حيث)(?=\s)/gu;

export interface TruthQuestion {
  text: string;
  answerType: TruthAnswerType;
  entity: string[];
  relation: Relation | null;
  count: string | null;
  countUnit: string | null;
  countQualifier: string | null;
  statistic: string | null;
  identity: boolean;
  reason: boolean;
  qualifiedName: boolean;
  prospective: boolean;
}

function words(text: string): string[] {
  return matchText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

const ARABIC = /\p{Script=Arabic}/u;
const arabicWord = (word: string) => word.replace(/^(?:و|ف|ب|ل)?ال(?=\p{L}{3})/u, '');
const plural = (word: string) => word.length > 3 ? word.replace(/(?:ies|(?<!s)s)$/u, ending => ending === 'ies' ? 'y' : '') : word;
const term = (word: string) => ARABIC.test(word) ? arabicWord(word) : plural(word);
const stripQuestionJoin = (text: string) => text.replace(/^[وف](?=(?:من|مين|كم|متي|امتي|ايمتي|اين|وين|ما|ماذا|لماذا)\s)/u, '');
const stripAsk = (text: string) => text
  .replace(DATE, '')
  .replace(/^(?:(?:(?:من|مين) (?:هو|هي|الذي|التي|اللي)|who (?:is|was|were|are)|who['’]s|how (?:many|much|long|old|far|tall|high|big|fast|heavy|wide|deep)|كم|قديش|اديش|من|مين)\s+)/u, '')
  .replace(/\b(?:do|does|did|is|was|are|were|have|has|had|will|would|could|should|can|been|be|in|to|on|with|at|of|the|what|a|an|has)\b|(?:^|\s)(?:هو|هي|تم|الذي|التي|في|من|عن|علي)(?=\s|$)/gu, ' ');

function explicitDateEvent(normalized: string): Relation | null {
  // A named English subject can leave an explicit event verb the relation table does not cover.
  // Only infer a predicate from an auxiliary-led question, where the verb's position is constrained.
  const active = DATE.test(normalized) && /^\s+(?:did|does|do|was|were|will)\b/u.test(normalized.replace(DATE, ''));
  if (!active) return null;
  const remaining = words(stripAsk(normalized)).filter(word => !FILLER.has(word) && !NOT_ENTITIES.test(word));
  const event = remaining.at(-1);
  if (!event || !/^[a-z]{4,}$/u.test(event)) return null;
  const stem = event.replace(/(?:ed|ing|e)$/u, '');
  if (stem.length < 3) return null;
  return relation('explicit_event', new RegExp(`\\b${stem}(?:e|ed|es|ing|s)?\\b`, 'u'));
}

function entityWords(question: string, normalized: string, relation: Relation | null, count: string | null, reason: boolean): string[] {
  const englishNames = Array.from(question.matchAll(NAME)).flatMap(found => {
    if (found.index === 0 && NOT_ENTITIES.test(found[0])) return [];
    return words(found[0]).filter(word => !NOT_ENTITIES.test(word) && !FILLER.has(word) && !relation?.ask.test(word)).map(term);
  });
  if (englishNames.length) return [...new Set(englishNames)];
  const asked = reason ? reasonSubject(question) : stripAsk(normalized);
  const rest = relation && !reason ? asked.replace(new RegExp(relation.ask.source, 'gu'), ' ') : asked;
  return [...new Set(topicWords(rest.replace(/[^\p{L}\p{N}\s]/gu, ' ')).map(term)
    .filter(word => word.length > 1 && !FILLER.has(word) && !NOT_ENTITIES.test(word) && word !== count && !STATISTIC.test(word) && !UNIT_ONLY.test(word)))];
}

export function buildTruthQuestion(question: string): TruthQuestion {
  const original = normalizeRequest(question).text;
  const normalized = stripQuestionJoin(matchText(original).replace(/[?!؟.,،:;]/gu, ' ').replace(/\s+/gu, ' ').trim());
  let answerType: TruthAnswerType = null;
  if (DATE.test(normalized)) answerType = 'date';
  else if (NUMBER.test(normalized) || /(?:^|\s)(?:كم|قديش)(?=\s|$)/u.test(normalized)) answerType = 'number';
  else if (PLACE.test(normalized)) answerType = 'place';
  else if (PERSON.test(normalized) && !/^(?:من الذاكره|من فضلك|من اين|من متي)(?:\s|$)/u.test(normalized)) answerType = 'person';
  const identity = answerType === 'person' && IDENTITY.test(normalized);
  const reason = isReasonQuestion(original);
  const countMatch = answerType === 'number' ? GENERIC_COUNT.exec(normalized) : null;
  const initialCount = (countMatch?.[1] ?? countMatch?.[2])?.trim();
  const following = countMatch ? normalized.slice(countMatch[0].length).trimStart() : '';
  const englishAdjective = countMatch?.[1] && /^(?:public|private|paid|registered|active|available|empty|open|new|existing|permanent|temporary|full-time|part-time)$/u.test(initialCount ?? '');
  const followingWord = /^\p{L}+/u.exec(following)?.[0] ?? null;
  const countWord = englishAdjective ? followingWord : initialCount;
  const count = countWord ? countTerm(countWord) : null;
  const countUnit = countWord ? extractQuantities(`1 ${countWord}`)[0]?.unit ?? null : null;
  const arabicAdjective = countMatch?.[2] && /^(?:عامه|خاصه|مدفوعه|متاحه|دائم[هه]|مؤقت[هه]|[\p{Script=Arabic}]+يا)$/u.test(followingWord ?? '');
  const countQualifier = englishAdjective ? initialCount ?? null
    : arabicAdjective ? followingWord!.replace(/(?<=ي)ا$/u, '') : null;
  const matches = RELATIONS.filter(item => item.ask.test(normalized) && (answerType !== 'date' || !NON_EVENT_RELATIONS.has(item.id)));
  let relation = matches.sort((a, b) => normalized.search(a.ask) - normalized.search(b.ask))[0] ?? null;
  if (!relation && answerType === 'date') {
    const event = explicitDateEvent(normalized);
    const capitalized = [...original.matchAll(NAME)].filter(item => item.index > 0);
    if (event && capitalized.length && !capitalized.some(item => event.clues.test(matchText(item[0])))) relation = event;
  }
  const statistic = STATISTIC.exec(normalized)?.[0] ?? null;
  const placeSubject = answerType === 'place' ? normalized.replace(PLACE, '').trim()
    .replace(PLACE_ASK_VERB, '').replace(PLACE_ASK_SUFFIX, '') : normalized;
  const entity = entityWords(original, placeSubject, relation, initialCount ? term(initialCount) : count, reason)
    .filter(word => word !== count && word !== countQualifier && (!countQualifier || word !== followingWord) && word !== term(statistic ?? ''));
  return { text: original, answerType, entity, relation, count, countUnit, countQualifier, statistic,
    identity, reason, qualifiedName: QUALIFIED_NAME.test(normalized), prospective: PROSPECTIVE.test(normalized) };
}

export function entityMention(text: string, entity: readonly string[]): boolean {
  if (!entity.length) return true;
  const bare = text.replace(/\([^)]*\)/gu, ' ').replace(/\p{L}+(?:[-‐‑]\p{L}+)+/gu, compound =>
    words(compound).every(word => entity.includes(term(word))) ? compound : ' ');
  const terms = words(bare).map(term);
  let cursor = 0;
  for (const word of entity) {
    const index = terms.indexOf(word, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

const COMPARISON = /\b(?:inspired by|compared (?:with|to)|adapted from|pays tribute to|similar to|a parody of|inspired|in reference to|relating to)\b|(?:مستوح[ياه] من|مقارنه ب|مقتبس من|اقتباس من|محاكاه ل)/u;
const RELATING_POPULATION = /\b(?:population|inhabitants?|residents?)\b|سكان|تعداد/u;
const LOCATIVE = /(?:\bin|\bwithin|\blocated in|في|ضمن)\s+$/u;
const ONLY_POPULATION = /\b(?:live|lives|living|residing|reside)\s+in\s+$|(?:يقيم|يعيش|يقطن)\p{L}*\s+في\s+$/u;

function entityInClause(clause: string, asked: TruthQuestion, inferredSubject: boolean): boolean {
  if (!asked.entity.length) return true;
  if (entityMention(clause, asked.entity)) {
    const comparison = COMPARISON.exec(clause);
    if (comparison && !entityMention(clause.slice(0, comparison.index), asked.entity)) return false;
    const masked = clause.replace(new RegExp(`(?:${RELATIVE.source})[^,،;؛]{1,45}`, 'gu'), ' ');
    if (!entityMention(masked, asked.entity)) return false;
    return !asked.entity.some(word => {
      const at = clause.search(new RegExp(`(?<![\\p{L}])(?:ال)?${word}(?![\\p{L}])`, 'u'));
      if (at < 0) return false;
      const before = clause.slice(0, at);
      const match = /^(?:ال)?\p{L}+/u.exec(clause.slice(at));
      const after = clause.slice(at + (match?.[0].length ?? word.length));
      if (POSSESSIVE_RELATIVE.test(after) || ALIAS.test(before)) return true;
      // A location can qualify another place's population. Require the people themselves to live there.
      return asked.relation?.id === 'population' && LOCATIVE.test(before) && RELATING_POPULATION.test(before)
        && !ONLY_POPULATION.test(before);
    });
  }
  return inferredSubject && BASE_PRONOUN.test(clause);
}

/** Split a list of event/figure clauses without losing a date written with a comma. */
function clauseAt(text: string, offset: number, asked: TruthQuestion): string {
  let start = 0;
  let end = text.length;
  for (const mark of text.matchAll(CLAUSE_DIVIDER)) {
    const next = mark.index + mark[0].length;
    const before = text.slice(start, mark.index);
    const after = text.slice(next);
    if (!before.trim() || !after.trim()) continue;
    // A name can itself contain "and", and a comma may separate the appositive from its subject.
    const adjacentDateClause = asked.answerType === 'date'
      && /^(?:it|he|she|they|we|the)\b|^(?:هو|هي|هم|وقد)(?:\s|$)/u.test(after.trim())
      && /\d{3,4}/u.test(before) && /\d{3,4}/u.test(after);
    const eventIn = (piece: string) => asked.relation?.clues.test(piece) || RELATIONS.some(item => item.clues.test(piece));
    if (!adjacentDateClause && (!eventIn(before) || !eventIn(after))) continue;
    if (entityMention(text, asked.entity) && !entityMention(before, asked.entity) && !entityMention(after, asked.entity)) continue;
    if (mark.index >= offset) {
      end = mark.index;
      break;
    }
    start = next;
  }
  return text.slice(start, end);
}

const NON_EVENT_RELATIONS = new Set(['population', 'attendance', 'temperature', 'radius', 'diameter', 'age', 'height', 'length', 'area', 'duration', 'cost', 'distance', 'speed', 'weight', 'capacity', 'capital']);
const NON_EVENT_DESCRIPTION = /\b(?:son|daughter|century|centuries|city|country|company|novel|film|museum|book|painting)\b|(?:الابن|الابنه|القرن|مدينه|دوله|شركه|روايه|فيلم|متحف|كتاب|لوحه)/u;
const NOT_CURRENT_POPULATION = /\b(?:sentenced|sentence|killed|death|religion|catholics|employ(?:ed|ees)|workers|percent|density|urban area|metro area|metropolitan area|greater)\b|اعدام|عاملين|يعملون|كثافه|نسبه|منطقه حضريه|منطقه كبري/u;
const NON_WHO_OBJECT = /\b(?:film|novel|book|city|country|year|date|month|unnamed|unknown)\b|(?:مجهول|لا احد|روايه|مدينه|دوله|سنه|عام|كتاب)/u;

function closestRelation(before: string, after: string, asked: TruthQuestion): Relation | null {
  const relations = asked.answerType === 'date' ? RELATIONS.filter(item => !NON_EVENT_RELATIONS.has(item.id)) : [...RELATIONS];
  if (asked.relation?.id === 'explicit_event') relations.push(asked.relation);
  let best: { item: Relation; distance: number } | null = null;
  for (const item of relations) {
    for (const hit of before.matchAll(new RegExp(item.clues.source, 'gu'))) {
      const distance = words(before.slice(hit.index + hit[0].length)).length;
      if (!best || distance < best.distance) best = { item, distance };
    }
    for (const hit of after.matchAll(new RegExp(item.clues.source, 'gu'))) {
      const distance = words(after.slice(0, hit.index)).length + 2;
      if (!best || distance < best.distance) best = { item, distance };
    }
  }
  return best?.item ?? null;
}

function relationMatches(text: string, asked: TruthQuestion, quantity?: Quantity): boolean {
  const clause = matchText(text);
  if (asked.reason) {
    return reasonAnswers(asked.text, text) && (asked.qualifiedName || !FORMER_NAME.test(clause));
  }
  if (!asked.relation) {
    if (asked.answerType === 'date' && quantity && !NON_EVENT_DESCRIPTION.test(clause)) return true;
    return asked.answerType !== 'date' || !!closestRelation(matchText(text.slice(0, quantity?.start)), '', asked);
  }
  if (asked.relation.id === 'population') {
    if (NOT_CURRENT_POPULATION.test(clause) || !hasFigureOf('people', text)) return false;
  }
  if (asked.statistic && term(STATISTIC.exec(clause)?.[0] ?? '') !== term(asked.statistic)) return false;
  if (!quantity || asked.answerType === null || asked.answerType === 'person') return asked.relation.clues.test(clause);
  const before = matchText(text.slice(0, quantity.start));
  const after = matchText(text.slice(quantity.end));
  const local = clauseAt(clause, before.length, asked);
  const leadAt = clause.indexOf(local);
  const preceding = clause.slice(leadAt, before.length);
  const following = clause.slice(clause.length - after.length, leadAt + local.length);
  const nearby = closestRelation(preceding, following, asked);
  return asked.relation.clues.test(local) && (nearby?.id === asked.relation.id
    || nearby === null && asked.relation.clues.test(matchText(text.slice(quantity.start, quantity.end))));
}

function candidateName(text: string, asked: TruthQuestion): boolean {
  const key = matchText(text).replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').trim();
  if (!key || NOT_NAME.test(key) || entityMention(key, asked.entity) && words(key).every(word => asked.entity.includes(term(word)))) return false;
  if (PERSON_ROLE.test(key) || ROLE_NAME.test(text)) return true;
  if (!ARABIC.test(key)) {
    if (NON_WHO_OBJECT.test(key)) return false;
    return [...text.matchAll(NAME)].some(item => !NOT_NAME.test(item[0]) && !entityMention(item[0], asked.entity));
  }
  const names = words(key).filter(word => !ARABIC_NOT_NAME.test(word) && !ARABIC_PARTICLE.test(word) && !asked.entity.includes(term(word)));
  return names.length >= 2 && !NON_WHO_OBJECT.test(key);
}

const PASSIVE = /\b(?:by|author is|director is|founder is|winner is|owner is|CEO is|treasurer is|secretary is)\s+|(?:من\s+(?:تاليف|اخراج|تلحين|تصميم)\s+|(?:المؤلف|المخترع|المخرج|الرئيس|الفائز)\s+(?:هو|هي)\s+)/iu;
const ACTIVE_ARTICLE = /^(?:the|a|an|it|he|she|they|has|was|is|were|are)\s+/iu;

/** A typed name is only accepted in the answering slot, away from an entity being asked about. */
export function namedAnswers(text: string, asked: TruthQuestion): string[] {
  if (asked.answerType !== 'person') return [];
  const key = matchText(text);
  const displayed = ARABIC.test(text) ? key : text;
  if (asked.identity && PERSON_ROLE.test(key) && (!asked.relation || asked.relation.id === 'lead')) {
    if (!asked.relation) return [text];
  }
  const by = PASSIVE.exec(key);
  const cue = asked.relation?.clues.exec(key);
  const candidates: string[] = [];
  if (by) candidates.push(displayed.slice(by.index + by[0].length).split(/[،,;؛.!?؟()]/u)[0]!.trim());
  if (cue) {
    const before = displayed.slice(0, cue.index).trim();
    const rest = displayed.slice(cue.index + cue[0].length).replace(ACTIVE_ARTICLE, '').trim();
    if (ARABIC.test(text)) {
      const upToEntity = words(rest).findIndex(word => asked.entity.includes(term(word)));
      candidates.push(rest.split(/\s+/u).slice(0, upToEntity < 0 ? 4 : upToEntity).join(' '));
    }
    candidates.push(before);
    if (asked.identity || asked.relation?.id === 'lead' || asked.relation?.id === 'win' || asked.relation?.id === 'own' || ['treasurer', 'secretary'].includes(asked.relation?.id ?? '')) candidates.push(rest);
  }
  return candidates.filter(value => candidateName(value, asked));
}

const PLACE_CUE = /\b(?:(?:is|are|was|were) (?:located|situated|based) (?:in|at|on)|(?:is|are|was|were) (?:in|at|on)|(?:lies?|stands?) (?:in|at|on)|(?:is|was) (?:a|an|the) (?:city|town|village|mountain|island) in|(?:is|was) (?:a|the) capital(?: city)? of)\s+|(?<!\p{L})(?:تقع|يقع|توجد|يوجد|يتمركز|تتمركز)\s+|(?<!\p{L})(?:هو|هي)\s+عاصمه\s+/gu;
const PLACE_SLOT = /(?:^|\s)(?:في|ضمن|عند|قرب|بجانب|شمال|جنوب|شرق|غرب|in|at|on|within|near|from|to)\s+/gu;
const CAPITAL_SLOT = /(?:\b(?:is|was)\s+(?:a|the)\s+capital(?: city)?\s+of\s+|(?<!\p{L})(?:هو|هي)\s+عاصمه\s+)/u;
const PLACE_VALUE_STOP = /^(?:unknown|not known|somewhere|there|here|nowhere|online|private|unspecified|unannounced|a place|an unknown place|مكان|موقع|المنطقه|هناك|هنا|مجهول|غير |لم )(?=\s|$)/u;
const reducedSubject = (text: string) => words(text).filter(word => word !== 'the').map(term);
const exactSubject = (text: string, entity: readonly string[]) => {
  const terms = reducedSubject(text);
  return terms.length === entity.length && terms.every((word, index) => word === entity[index]);
};

export function placeValue(text: string): boolean {
  const value = text.trim().replace(/[.!؟?]+$/u, '');
  const normalized = matchText(value);
  if (PLACE_VALUE_STOP.test(normalized) || !/^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}\s'’,-]*$/u.test(value)) return false;
  const tokens = words(value);
  if (tokens.length > 8 || !tokens.some(word => /\p{L}/u.test(word))) return false;
  if (ARABIC.test(value)) return !/(?:^|\s)(?:غير|جدا|مجهول|غيرها|مكان ما|الذي|التي|وكان|كانت|ويبلغ)(?=\s|$)/u.test(normalized);
  return /^(?:(?:the|north(?:east|west)?|south(?:east|west)?|east|west|central|northern|southern|eastern|western)\s+)?(?:\p{Lu}|\d+\s+\p{Lu})/u.test(value);
}

/** Read the location after a locative predicate owned by the asked subject. */
export function placeAnswers(text: string, asked: TruthQuestion): string[] {
  if (asked.answerType !== 'place' || !asked.entity.length) return [];
  const key = matchText(text);
  const displayed = ARABIC.test(text) ? key : text;
  if (NEGATION.test(key) || !asked.prospective && PROSPECTIVE.test(key)) return [];
  const cap = asked.relation?.id === 'capital' ? CAPITAL_SLOT.exec(key) : null;
  if (asked.relation?.id === 'capital') {
    if (!cap || !exactSubject(key.slice(cap.index + cap[0].length), asked.entity)) return [];
    const name = displayed.slice(0, cap.index).trim();
    return placeValue(name) ? [name] : [];
  }

  const places: string[] = [];
  const beforeLocation = (input: string) => input.split(/[,،;؛]|\band (?:it|the|is|was|contains)\b|\s+(?:وهو|وهي|وتقع|ويقع)(?=\s)/u)[0]!.trim();
  for (const cue of asked.relation ? [] : key.matchAll(PLACE_CUE)) {
    const after = cue.index + cue[0].length;
    if (exactSubject(key.slice(0, cue.index), asked.entity)) {
      const value = beforeLocation(displayed.slice(after)).replace(/^(?:في|ضمن|عند|قرب|بجانب)\s+/u, '');
      if (placeValue(value)) places.push(value);
    }
    // Arabic may put the subject after the verb rather than before it.
    if (ARABIC.test(cue[0])) {
      for (const slot of key.slice(after).matchAll(PLACE_SLOT)) {
        if (!exactSubject(key.slice(after, after + slot.index), asked.entity)) continue;
        const value = beforeLocation(displayed.slice(after + slot.index + slot[0].length));
        if (placeValue(value)) places.push(value);
      }
    }
  }
  const event = asked.relation?.clues.exec(key);
  if (event) {
    const after = event.index + event[0].length;
    for (const slot of key.slice(after).matchAll(PLACE_SLOT)) {
      if (asked.relation?.id === 'depart' && !/^(?:from|من)$/u.test(slot[0].trim())) continue;
      const before = key.slice(0, event.index).replace(/\s+(?:was|were|is|are)\s*$/u, '');
      const between = key.slice(after, after + slot.index);
      if (!(exactSubject(before, asked.entity) && !between.trim() || !before.trim() && exactSubject(between, asked.entity))) continue;
      const value = beforeLocation(displayed.slice(after + slot.index + slot[0].length));
      if (placeValue(value)) places.push(value);
    }
  }
  return places;
}

export function quantityCanAnswer(text: string, quantity: Quantity, asked: TruthQuestion): boolean {
  if (quantity.kind !== asked.answerType || quantity.kind === 'number' && !quantity.unit) return false;
  if (quantity.kind === 'number') {
    const kind = figureKind(asked.text);
    if (kind !== 'date' && kind !== 'any' && !(kind === 'duration' && asked.relation?.id === 'length')
      && !(kind === 'people' && asked.relation?.id === 'attendance' && quantity.unit === 'people')
      && !(kind === 'price' && ['dollars', 'pounds', 'dinars', 'riyals', 'dirhams'].includes(quantity.unit ?? '')) && !hasFigureOf(kind, text)) return false;
    if (asked.relation?.id === 'age' && !['year', 'years', 'months', 'days'].includes(quantity.unit ?? '')) return false;
    if (!asked.relation && asked.count && quantity.unit !== asked.count && quantity.unit !== asked.countUnit && plural(quantity.unit ?? '') !== asked.count
      && !words(text.slice(quantity.start, quantity.end)).some(word => countTerm(word) === asked.count)) return false;
    if (asked.countQualifier) {
      const literal = text.slice(quantity.start, quantity.end);
      const next = /^\s+([\p{L}\p{M}]+)(?![\p{L}\p{M}])/u.exec(text.slice(quantity.end))?.[1];
      const local = [...words(literal), ...(next ? words(next) : [])];
      if (!local.some(word => word.replace(/(?<=ي)ا$/u, '') === asked.countQualifier)) return false;
    }
  }
  return relationMatches(text, asked, quantity);
}

export function checkTruthQuestion(text: string, quantities: readonly Quantity[], asked: TruthQuestion, ownTitle: boolean): QuestionFinding | null {
  const key = matchText(text);
  const isPublication = ['release', 'issue'].includes(asked.relation?.id ?? '') && entityMention(text, asked.entity);
  if (isUiText(text) || isMetaLine(text) && !isPublication) return 'wrong_relation';
  if (!asked.entity.length) return 'wrong_entity';
  if (asked.answerType === 'date' || asked.answerType === 'number') {
    const typed = quantities.filter(item => item.kind === asked.answerType && (item.kind === 'date' || item.unit));
    if (!typed.length) return 'answer_type';
    if (!typed.some(item => entityInClause(clauseAt(key, matchText(text.slice(0, item.start)).length, asked), asked, ownTitle))) return 'wrong_entity';
    if (!typed.some(item => entityInClause(clauseAt(key, matchText(text.slice(0, item.start)).length, asked), asked, ownTitle) && quantityCanAnswer(text, item, asked))) return 'wrong_relation';
  } else if (asked.answerType === 'place') {
    if (!entityInClause(key, asked, false)) return 'wrong_entity';
    if (!placeAnswers(text, asked).length) return 'answer_type';
  } else {
    if (!entityInClause(key, asked, ownTitle)) return 'wrong_entity';
    if (!relationMatches(text, asked)) return 'wrong_relation';
    if (asked.answerType === 'person' && !namedAnswers(text, asked).length) return 'answer_type';
  }
  if (asked.answerType && (NEGATION.test(key) || !asked.prospective && PROSPECTIVE.test(key))) return 'wrong_relation';
  return null;
}

export function sameAskedEntity(asked: TruthQuestion, title: string | undefined): boolean {
  if (!title || !asked.entity.length || /[()]/u.test(title)) return false;
  const bare = title.replace(/\s+[-–—|:]\s+[^-–—|:]{1,40}$/u, '');
  return words(bare).length === asked.entity.length && entityMention(bare, asked.entity);
}

const countTerm = (word: string) => term(word.replace(/(?<=[\p{Script=Arabic}])ا$/u, ''));

export function questionQuantities(text: string, asked: TruthQuestion): Quantity[] {
  return extractQuantities(text.replace(/(?<=\s)و(?=[\d٠-٩۰-۹])/gu, ' ')).map(quantity => {
    if (quantity.kind !== 'number' || quantity.unit) return quantity;
    const suffix = /^\s+([\p{L}\p{M}]+)/u.exec(text.slice(quantity.end));
    if (suffix && asked.count && countTerm(matchText(suffix[1]!)) === asked.count) {
      return { ...quantity, unit: asked.countUnit ?? asked.count, end: quantity.end + suffix[0].length };
    }
    const qualified = /^\s+(\p{L}+(?:-\p{L}+)?)\s+(\p{L}+)/u.exec(text.slice(quantity.end));
    if (qualified && asked.count && asked.countQualifier && matchText(qualified[1]!) === asked.countQualifier && countTerm(matchText(qualified[2]!)) === asked.count) {
      return { ...quantity, unit: asked.countUnit ?? asked.count, end: quantity.end + qualified[0].length };
    }
    const prefix = text.slice(0, quantity.start);
    if (asked.relation?.id === 'population' && /\bpopulation\b|سكان|تعداد/u.test(matchText(prefix))
      && /(?:million|billion|thousand|مليون|مليار|ألف)$/iu.test(text.slice(quantity.start, quantity.end))
      && !/^\s*(?:%|٪|per\b|each\b|لكل)/iu.test(text.slice(quantity.end))) {
      return { ...quantity, unit: 'people' };
    }
    return quantity;
  });
}
