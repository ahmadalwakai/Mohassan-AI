import { fold, tidy } from './hands.js';

export type ConversationEntityKind = 'person' | 'organization' | 'place' | 'date' | 'number' | 'other';
type Gender = 'masculine' | 'feminine';

export interface ConversationEntity {
  text: string;
  kind: ConversationEntityKind;
  turnId: string;
  role: 'user' | 'assistant';
  salience: number;
  gender?: Gender;
  publicLookup?: boolean;
}

export interface ConversationEntityTurn {
  text: string;
  turnId: string;
  role: ConversationEntity['role'];
  topic?: { text: string; kind?: ConversationEntityKind };
  place?: string | null;
  time?: string | null;
  publicLookup?: boolean;
}

const MAX_ENTITIES = 48;
const MAX_MENTIONS_PER_TURN = 14;
const MAX_TEXT = 2_000;
const RECENCY_DECAY = 0.78;
const WORD = String.raw`[\p{L}][\p{L}\p{M}'’\-]*`;
const NAME = String.raw`${WORD}(?:[ \t]+${WORD}){0,3}`;
const LEADING_NAME = String.raw`${WORD}(?:[ \t]+${WORD}){0,3}?`;
const CAPITALIZED = String.raw`[\p{Lu}][\p{L}\p{M}'’\-]*(?:[ \t]+[\p{Lu}][\p{L}\p{M}'’\-]*){0,3}`;
const AR_PERSON_NAME = /^[\p{Script=Arabic}]+(?:\s+[\p{Script=Arabic}]+){1,3}$/u;
const EN_PERSON_NAME = new RegExp(`^${CAPITALIZED}$`, 'u');
const NON_WORD = String.raw`(?<![\p{L}\p{N}])`;
const END_WORD = String.raw`(?![\p{L}\p{N}])`;
const LATIN_NAME_WORD = String.raw`(?=\p{Script=Latin})\p{Lu}[\p{Script=Latin}\p{M}'’\-]+`;
const LATIN_NAME = new RegExp(String.raw`${NON_WORD}(?:The\s+)?${LATIN_NAME_WORD}(?:(?:\s+(?:of|the|de|van|von))?\s+${LATIN_NAME_WORD}){1,4}${END_WORD}`, 'gu');
const NON_NAME_TITLE = /^(?:answer|assistant|click|detail|details|hello|next|notes|official|okay|overview|page|please|question|references?|related|result|results|search|see|sources?|summary|thank|thanks|title|website|welcome|yes)(?:\s|$)/u;
const NAME_STOP = new Set(['a', 'after', 'an', 'and', 'are', 'as', 'before', 'for', 'from', 'he', 'in', 'is', 'it', 'of', 'or', 'she', 'that', 'the', 'then', 'there', 'they', 'to', 'was', 'were', 'what', 'when', 'which', 'who', 'with',
  'اشهر', 'اصغر', 'اكبر', 'الذين', 'الذي', 'التي', 'ان', 'انها', 'انه', 'او', 'اي', 'اين', 'باسم', 'بعد', 'بين', 'تاسس', 'تاسست', 'تقع', 'تلك', 'توفي', 'توفيت', 'ثم', 'ذلك', 'سنه', 'عام', 'عاصمه', 'عاصمتها', 'علي', 'عن', 'في', 'فيها', 'فيه', 'قبل', 'كانت', 'كل', 'كم', 'كيف', 'لا', 'لعائله', 'لم', 'لماذا', 'ما', 'ماذا', 'متي', 'مع', 'من', 'هذا', 'هذه', 'هل', 'هم', 'هما', 'هو', 'هي', 'و', 'ولد', 'ولدت', 'يقع', 'يوم']);
const NON_NAME = /^(?:(?:ال)?(?:شركه|مجموعه|موسسه|فريق|شخص|اشخاص|صاحب|احد|عده|عدد|اسم|مؤسس(?:ه|ان|ون)?|مدينه|دوله|عاصمه)|some|people|someone|anyone|team|group|company|organization|capital|city|country|founders?)(?:\s|$)/u;
const GEOGRAPHY = /^(?:(?:ال)?(?:مدينه|قريه|دوله|محافظه|ولايه|مقاطعه|قاره|جزيره|نهر|بحر|جبل|وادي|بحيره|محيط)|city|country|province|county|island|river|mount|lake)\s/u;
const ORGANIZATION = /^(?:شركه|مؤسسه|جامعه|منظمه|جمعيه|وزاره|بنك|مصرف|حزب|نادي|مجموعه|company|corporation|organization|university|ministry|bank|association|agency)\s/u;
const ORG_SUFFIX = /\s(?:inc|corp|corporation|ltd|llc|plc|university|bank|foundation|institute|ministry|party|association)$/u;
const PERSON_ROLE = String.raw`(?:ال)?(?:مخترع[ةه]?|كاتب[ةه]?|طبيب[ةه]?|دكتور[ةه]?|مهندس[ةه]?|فيزيائي[ةه]?|عالم[ةه]?|ممثل[ةه]?|شاعر[ةه]?|رئيس[ةه]?|ملك[ةه]?|رياضي[ةه]?|مغني[ةه]?|فنان[ةه]?)`;
const EN_PERSON_ROLE = String.raw`(?:inventor|writer|doctor|physician|engineer|physicist|scientist|researcher|professor|actress|actor|poet|president|queen|king|athlete|singer|artist|politician|philosopher|mathematician|soldier|journalist|founder)`;
const AR_ORG_CUE = String.raw`(?:شركة|شركه|مؤسسة|جامعة|منظمة|جمعية|وزارة|حزب|نادي|مصرف|بنك)`;
const AR_PLACE_CUE = String.raw`(?:مدينة|مدينه|قرية|دولة|محافظة|ولاية|مقاطعة|قارة|جزيرة)`;
const AR_FEATURE_CUE = String.raw`(?:نهر|بحر|جبل|وادي|بحيرة|محيط)`;
const PLACE_RELATIONS = [
  new RegExp(String.raw`^(?<city>${LEADING_NAME})\s+(?:(?:هي|هو)\s+)?(?:العاصمة|عاصمة)(?:\s+(?<country>${NAME}))?${END_WORD}`, 'u'),
  new RegExp(String.raw`^(?:العاصمة|عاصمة)\s+(?<country>${LEADING_NAME})\s+(?:هي|هو)\s+(?<city>${NAME})${END_WORD}`, 'u'),
  new RegExp(String.raw`^(?<city>${LEADING_NAME})\s+(?:is|was)\s+(?:the\s+)?capital\b(?:\s+of\s+(?<country>${NAME}))?`, 'iu'),
  new RegExp(String.raw`^(?:the\s+)?capital\s+of\s+(?<country>${LEADING_NAME})\s+(?:is|was)\s+(?<city>${NAME})${END_WORD}`, 'iu'),
];
const AR_FOUNDERS = [
  /(?:^|[^\p{L}])و?[أا]سس(?:ها|(?:\s+\p{L}+){1,4}?\s+(?:كل\s+من|على\s+يد))\s+(.+)/u,
  /(?:^|[^\p{L}])(?:ت[أا]سست|[أا]سست)\s+.*?(?:من قبل|على يد|بواسطة)\s+(.+)/u,
  new RegExp(String.raw`^(?:[أا]سس(?:ت)?\s+(.+?)|(.+?)\s+[أا]سسا)\s+${AR_ORG_CUE}\s+`, 'u'),
  /^(?:(?:تجدر الإشارة|يجدر بالذكر)\s+(?:إلى\s+)?[أا]ن\s+)?(.+?)\s+(هما المؤسسان|هم المؤسسون|هو المؤسس|هي المؤسسة)(?=\s|[،,.]|$)/u,
  /^(?:مؤسس(?:و|ا)?|مؤسسة)\s+.+?\s+(?<copula>هو|هي|هما|هم)\s+(?<names>.+)/u,
];
const EN_FOUNDERS = [
  /\bfounded by\s+(.+)/iu,
  /\bfounders?\s+(?:of .+?\s+)?(?:is|are|was|were)\s+(.+)/iu,
  /^(?:the\s+)?(.+?)\s+(?:is|are|was|were)\s+(?:the\s+)?(?:co-)?founders?\b/iu,
  new RegExp(String.raw`^(${CAPITALIZED}(?:\s+(?:and|&)\s+${CAPITALIZED})*)\s+(?:co-)?founded\s+`, 'u'),
];
const AR_PERSON_BEFORE = new RegExp(String.raw`^(${LEADING_NAME})\s+(?:(هو|هي|كان|كانت)\s+)?${PERSON_ROLE}${END_WORD}`, 'u');
const AR_PERSON_BIO = new RegExp(String.raw`(?:^|[،,])\s*(?:(?:[وأ]?(?:متى|متي)|[أا]ين|وين)\s+)?(و?ولد(?:ت)?|توفي(?:ت)?|مات(?:ت)?)\s+(${NAME})${END_WORD}`, 'u');
const EN_PERSON_BEFORE = new RegExp(String.raw`^(${CAPITALIZED})\s+(?:(?:is|was)\s+(?:the|an?)\s+(?:[\p{L}]+\s+){0,2}${EN_PERSON_ROLE}\b|(?:was\s+born|died)\b)`, 'u');
const AR_PERSON_QUESTION = new RegExp(String.raw`^(?:من|مين)\s+(هو|هي)\s+(${NAME})$`, 'u');
const EN_PERSON_QUESTION = new RegExp(String.raw`^(?:[Ww]ho\s+(?:is|was)\s+(${CAPITALIZED})|(?:[Ww]hen|[Ww]here)\s+was\s+(${CAPITALIZED})\s+born)$`, 'u');
const PLACE_SUBJECT = new RegExp(String.raw`^(${LEADING_NAME})\s+(?:(?:هو|هي)\s+)?(?:${AR_PLACE_CUE}|${AR_FEATURE_CUE})${END_WORD}|^(${CAPITALIZED})\s+(?:is|was)\s+a\s+(?:city|country|island|river|mountain|lake)\b`, 'u');
const ORG_SUBJECT = new RegExp(String.raw`^(${LEADING_NAME})\s+(?:(?:هو|هي)\s+)?${AR_ORG_CUE}${END_WORD}|^(${CAPITALIZED})\s+(?:is|was)\s+an?\s+(?:company|organization|corporation|bank|university|agency)\b`, 'u');
const AR_CONTEXT_TERMS = [
  { pattern: new RegExp(String.raw`${NON_WORD}(?:ال)?${AR_ORG_CUE}\s+(${NAME})${END_WORD}`, 'gu'), kind: 'organization' },
  { pattern: new RegExp(String.raw`${NON_WORD}(?:[بوف])?(?:ال)?${AR_PLACE_CUE}\s+(${NAME})${END_WORD}`, 'gu'), kind: 'place' },
  { pattern: new RegExp(String.raw`${NON_WORD}((?:ال)?${AR_FEATURE_CUE}\s+${NAME})${END_WORD}`, 'gu'), kind: 'place' },
  { pattern: new RegExp(String.raw`${NON_WORD}(?:ال)?(?:دكتور[ةه]?|[اأ]ستاذ[ةه]?|سيد[ةه]?)\s+(${NAME})${END_WORD}`, 'gu'), kind: 'person' },
] as const;
const EN_CONTEXT_TERMS = [
  { pattern: new RegExp(String.raw`\b(?:city|town|country|province|state|island)\s+(?:of|is)\s+(${CAPITALIZED})\b`, 'gu'), kind: 'place' },
  { pattern: new RegExp(String.raw`\b(?:born|located|based)\s+in\s+(${CAPITALIZED})\b`, 'gu'), kind: 'place' },
  { pattern: new RegExp(String.raw`\b((?:Mount|Lake|River|Island)\s+${CAPITALIZED})\b`, 'gu'), kind: 'place' },
  { pattern: new RegExp(String.raw`\b(?:[Cc]ompany|[Oo]rganization|[Cc]orporation|[Aa]gency|[Bb]ank)\s+(${CAPITALIZED})\b`, 'gu'), kind: 'organization' },
  { pattern: new RegExp(String.raw`\b(${CAPITALIZED}\s+(?:Inc|Corp|Corporation|Ltd|LLC|PLC|University|Bank|Foundation|Institute|Ministry))\b`, 'gu'), kind: 'organization' },
  { pattern: new RegExp(String.raw`\b(Mr|Ms|Mrs|Dr|Professor)\.?\s+(${CAPITALIZED})\b`, 'gu'), kind: 'person' },
] as const;

const DIGIT = '[0-9٠-٩۰-۹]';
const DAY = `${DIGIT}{1,2}`;
const YEAR = `${DIGIT}{4}`;
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|يناير|فبراير|مارس|[أا]بريل|مايو|يونيو|يوليو|[أا]غسطس|سبتمبر|[أا]كتوبر|نوفمبر|ديسمبر|كانون (?:الأول|الثاني)|شباط|[أا]ذار|نيسان|[أا]يار|حزيران|تموز|[أا]يلول|تشرين (?:الأول|الثاني))';
const DATE = new RegExp(String.raw`${NON_WORD}(?:${YEAR}-${DAY}-${DAY}|${DAY}[/-]${DAY}[/-](?:${YEAR}|${DAY})|${DAY}\s+${MONTH}(?:\s+(?:(?:من\s+)?(?:عام|سنة)\s+)?${YEAR})?|${MONTH}\s+${DAY}(?:,?\s+${YEAR})?|(?:في|عام|سنة|in|since)\s+${YEAR}|${YEAR}(?=\s*[-–—]\s*${YEAR})|(?<=[-–—] )${YEAR}|today|tomorrow|yesterday|next week|last week|اليوم|غدا|[أا]مس|بكر[هةا]|بعد غد|[اأ]ل[أا]سبوع (?:الماضي|القادم))(?=م${END_WORD}|${END_WORD})`, 'giu');
const NUMBER = new RegExp(String.raw`${NON_WORD}[+−-]?${DIGIT}+(?:[.,٫٬]${DIGIT}+)*(?:\s*[%٪]|\s+(?:hundred|thousand|million|billion|trillion|[أا]لف|[آا]لاف|مليون|ملايين|مليار|مليارات|تريليون))?${END_WORD}`, 'giu');
const SOURCE_LINE = /^(?:المصدر|المصادر|مصدر|رابط المصدر|قُرئت|قرئت|source|sources|source link|read at|retrieved|related links|للمزيد)(?:\s*[:：]|$)/iu;

type Mention = Pick<ConversationEntity, 'text' | 'kind' | 'salience' | 'gender'>;

function nameFrom(raw: string | undefined, requireWhole = false): string {
  const text = raw?.trim().replace(/^[«»"“”'’]+|[«»"“”'’]+$/gu, '') ?? '';
  const words = text.split(/\s+/u);
  const end = words.findIndex(word => {
    const key = fold(word);
    return NAME_STOP.has(key) || key.startsWith('و') && NAME_STOP.has(key.slice(1));
  });
  if (requireWhole && end >= 0) return '';
  const name = (end < 0 ? words : words.slice(0, end)).join(' ').replace(/\s+(?:العملاق[هة]?|العالمي[هة]?)$/u, '');
  return name.length >= 2 && name.length <= 90 && !NON_NAME.test(fold(name)) ? name : '';
}

function foundingPeople(text: string): readonly { name: string; gender?: Gender }[] {
  const arabic = AR_FOUNDERS.map(pattern => pattern.exec(text)).find(Boolean);
  const english = EN_FOUNDERS.map(pattern => pattern.exec(text)).find(Boolean);
  if (!arabic && !english) return [];
  const names = arabic ? arabic.groups?.names ?? arabic[1] ?? arabic[2] : english?.[1];
  const genderCue = arabic?.groups?.copula ?? (arabic?.[1] ? arabic[2] : undefined);
  const gender: Gender | undefined = genderCue?.startsWith('هي') ? 'feminine' : genderCue?.startsWith('هو') ? 'masculine' : undefined;
  const phrase = names?.replace(/^\s*(?:كل من\s+|both\s+)/iu, '').split(/(?<!\p{L})(?:في|عام|سنة|يوم|لتطوير|لإنشاء|in|on|during|to|to develop|before|after)(?!\p{L})|[.؛:()\p{N}]/iu, 1)[0] ?? '';
  const people = phrase.split(/\s+و\s*|\s+(?:and|&)\s+|[,،]\s*/iu)
    .map(part => nameFrom(part.replace(/^(?:and|&)\s+/iu, '')));
  const validName = (name: string) => AR_PERSON_NAME.test(name) || EN_PERSON_NAME.test(name);
  const found = people.filter(validName);
  const fullName = nameFrom(phrase);
  const selected = !found.length && validName(fullName) ? [fullName] : found;
  return selected.slice(0, 3).map(name => ({ name, ...(gender ? { gender } : {}) }));
}

function visibleLines(turn: ConversationEntityTurn): string[] {
  const text = turn.text.slice(0, MAX_TEXT).normalize('NFKC');
  return text.split(/\r?\n/u).map(line => line.trim().replace(/^(?:[*#> ]+|-\s+)/u, '').replace(/\*\*|__/gu, ''))
    .filter(line => line && !(turn.role === 'assistant' && SOURCE_LINE.test(line)))
    .map(line => line.replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\n]+\)/giu, '$1')
      .replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, ' '));
}

function inferredKind(text: string, stack: readonly ConversationEntity[]): ConversationEntityKind {
  const key = fold(text);
  const known = stack.find(entity => entity.kind !== 'other' && fold(entity.text) === key);
  if (known) return known.kind;
  if (GEOGRAPHY.test(key)) return 'place';
  if (ORGANIZATION.test(key) || ORG_SUFFIX.test(key)) return 'organization';
  return 'other';
}

function latinNameFrom(raw: string): string {
  const words = raw.replace(/['’]s$/u, '').split(/\s+/u);
  const significant = words.filter(word => /^\p{Lu}/u.test(word) && word !== 'The');
  if (significant.length < 2 || significant.some(word => NAME_STOP.has(fold(word))) || NON_NAME_TITLE.test(fold(significant.join(' ')))) return '';
  return words.join(' ');
}

/** Keeps source text and provenance for each occurrence, with a recency-weighted rank. */
export function extendConversationEntities(stack: readonly ConversationEntity[], turn: ConversationEntityTurn): ConversationEntity[] {
  const mentions = new Map<string, Mention>();
  const add = (text: string | null | undefined, kind: ConversationEntityKind, salience: number, gender?: Gender) => {
    const label = text?.trim();
    if (!label || label.length > 90 || /[:/<>@`\[\]\r\n]/u.test(label) && kind !== 'date') return;
    const key = fold(label);
    if (!key || NAME_STOP.has(key)) return;
    const previous = mentions.get(key);
    if (previous && (previous.kind !== 'other' && kind === 'other' || previous.kind === kind && previous.salience >= salience)) {
      mentions.set(key, { ...previous, salience: Math.max(previous.salience, salience),
        ...(kind === previous.kind && gender && !previous.gender ? { gender } : {}) });
      return;
    }
    if (previous && kind !== previous.kind && previous.kind !== 'other' && previous.salience > salience) return;
    mentions.set(key, { text: label, kind, salience, ...(gender ? { gender } : {}) });
  };
  for (const [lineIndex, line] of visibleLines(turn).entries()) {
    const weight = Math.max(0.28, 1 - lineIndex * 0.12);
    for (const clause of line.split(/[!?؟؛]|(?<!\b(?:Mr|Ms|Mrs|Dr))\.(?=\s|$)/u).map(tidy).filter(Boolean)) {
      for (const [index, person] of foundingPeople(clause).entries()) add(person.name, 'person', (1 - index * 0.08) * weight, person.gender);
      for (const pattern of PLACE_RELATIONS) {
        const relation = pattern.exec(clause)?.groups;
        add(nameFrom(relation?.city), 'place', 0.98 * weight);
        add(nameFrom(relation?.country), 'place', 0.76 * weight);
      }
      const unparenthesized = clause.replace(/\s*\([^()]{1,100}\)\s*/gu, ' ');
      const arPerson = AR_PERSON_BEFORE.exec(unparenthesized);
      const arBio = AR_PERSON_BIO.exec(clause);
      const enPerson = EN_PERSON_BEFORE.exec(unparenthesized);
      const arPersonAsked = turn.role === 'user' ? AR_PERSON_QUESTION.exec(clause) : null;
      const enPersonAsked = turn.role === 'user' ? EN_PERSON_QUESTION.exec(clause) : null;
      const arGender = arPerson?.[2] === 'هي' || arPerson?.[2] === 'كانت' ? 'feminine'
        : arPerson?.[2] === 'هو' || arPerson?.[2] === 'كان' ? 'masculine' : undefined;
      add(nameFrom(arPerson?.[1], true), 'person', 0.94 * weight, arGender);
      add(nameFrom(arBio?.[2]), 'person', 0.94 * weight, arBio?.[1]?.endsWith('ت') ? 'feminine' : 'masculine');
      add(nameFrom(enPerson?.[1]), 'person', 0.94 * weight);
      add(nameFrom(arPersonAsked?.[2]), 'person', 0.85 * weight, arPersonAsked?.[1] === 'هي' ? 'feminine' : 'masculine');
      add(nameFrom(enPersonAsked?.[1] ?? enPersonAsked?.[2]), 'person', 0.85 * weight);
      const place = PLACE_SUBJECT.exec(unparenthesized);
      const organization = ORG_SUBJECT.exec(unparenthesized);
      add(nameFrom(place?.[1] ?? place?.[2], true), 'place', 0.93 * weight);
      add(nameFrom(organization?.[1] ?? organization?.[2], true), 'organization', 0.93 * weight);
      for (const { pattern, kind } of [...AR_CONTEXT_TERMS, ...EN_CONTEXT_TERMS]) {
        for (const match of clause.matchAll(pattern)) {
          // A classification such as "X is a city" does not introduce a city named by the following adjective.
          if (kind === 'place' && place?.index === 0 && match.index < place[0].length) continue;
          const gender = match[1] === 'Mr' ? 'masculine' : ['Ms', 'Mrs'].includes(match[1] ?? '') ? 'feminine' : undefined;
          add(nameFrom(match[2] ?? match[1]), kind, 0.79 * weight, gender);
        }
      }
      for (const match of clause.matchAll(LATIN_NAME)) {
        const name = latinNameFrom(match[0]);
        if (name) add(name, inferredKind(name, stack), (turn.role === 'assistant' ? 0.73 : 0.69) * weight);
      }
    }
    const dates = [...line.matchAll(DATE)];
    for (const date of dates) add(date[0].replace(/^(?:في|عام|سنة|in|since)\s+/iu, ''), 'date', 0.57 * weight);
    for (const number of line.matchAll(NUMBER)) {
      if (dates.some(date => number.index >= date.index && number.index < date.index + date[0].length)) continue;
      const result = /[=≈]\s*$/u.test(line.slice(0, number.index));
      add(number[0], 'number', (result ? 0.75 : 0.47) * weight);
    }
  }
  if (turn.topic) add(turn.topic.text, turn.topic.kind ?? inferredKind(turn.topic.text, stack), turn.role === 'assistant' ? 0.89 : 0.86);
  add(turn.place, 'place', 0.67);
  add(turn.time, 'date', 0.61);
  const incoming = [...mentions.values()].sort((left, right) => right.salience - left.salience).slice(0, MAX_MENTIONS_PER_TURN)
    .map(mention => ({ ...mention, turnId: turn.turnId, role: turn.role, ...(turn.publicLookup ? { publicLookup: true } : {}) }));
  const older = stack.filter(entity => entity.turnId !== turn.turnId || entity.role !== turn.role)
    .map(entity => ({ ...entity, salience: entity.salience * RECENCY_DECAY }));
  return [...incoming, ...older].sort((left, right) => right.salience - left.salience).slice(0, MAX_ENTITIES);
}
