import { normalizeLookupKey } from './normalize.ts';
import {
  KNOWLEDGE_PROPERTIES, knowledgePropertyPattern, mapKnowledgeProperty, type KnowledgePropertyKey,
} from './qa-properties.ts';
import type { KnowledgeMention, KnowledgeProperty, KnowledgeQuestion, KnowledgeTime } from './qa-types.ts';
import type { EntityCategory, Language } from './types.ts';

type Mentions = readonly [KnowledgeMention, KnowledgeMention, ...KnowledgeMention[]];
type Direction = 'min' | 'max';

const LEAD = {
  en: '(?:(?:what|which)(?: is| was| are| were| s)?|who(?: is| was| are| were| s)?|tell me|give me|name|list)',
  ar: '(?:ما(?: هو| هي| هم)?|ماهو|ماهي|ماذا|اي|من(?: هو| هي| هم)?|مين(?: هو| هي)?|شو(?: هو| هي)?|شنو(?: هو| هي)?|وش(?: هو| هي)?|اش|ايش|ايه|كم(?: يبلغ| تبلغ)?|كام|قديش|اخبرني|اذكر لي|اعطني|قل لي|قلي)',
};
const ARTICLE = '(?:the )?';
const ALL_PROPERTIES = { en: knowledgePropertyPattern('en'), ar: knowledgePropertyPattern('ar') };

function property(key: KnowledgePropertyKey): KnowledgeProperty {
  return KNOWLEDGE_PROPERTIES[key].property;
}

function questionBase(language: Language, rule: KnowledgeProperty, time: KnowledgeTime | undefined) {
  return { language, property: rule, expected: rule.answerType, ...(time && { time }) };
}

const SUBJECT_PREFIXES: Record<Language, readonly (readonly [RegExp, EntityCategory])[]> = {
  en: [
    [/^(?:the )?(?:country|nation) of /u, 'countries'],
    [/^(?:the )?city of /u, 'places'],
    [/^(?:the )?(?:book|novel|film|movie|song|album|poem|play|painting|tv (?:series|show)|video game) /u, 'works'],
    [/^the (?:company|organization|organisation|university) /u, 'organizations'],
  ],
  ar: [
    [/^(?:دوله|بلد) /u, 'countries'],
    [/^مدينه /u, 'places'],
    [/^(?:روايه|كتاب|فيلم|مسلسل|اغنيه|قصيده|لعبه) /u, 'works'],
    [/^(?:شركه|جامعه|منظمه) /u, 'organizations'],
  ],
};

function mention(text: string, language: Language, defaultCategory?: EntityCategory): KnowledgeMention | undefined {
  const name = text.trim();
  if (!/[\p{L}\p{N}]/u.test(name) || name.length > 180) return;
  let category = defaultCategory;
  let alternative: string | undefined;
  for (const [prefix, hint] of SUBJECT_PREFIXES[language]) {
    if (!prefix.test(name)) continue;
    alternative = name.replace(prefix, '');
    category = hint;
    break;
  }
  if (!alternative && language === 'en' && /^the .+ (?:tv (?:show|series)|movie|film|novel)$/u.test(name)) {
    alternative = name.replace(/^the | (?:tv (?:show|series)|movie|film|novel)$/gu, '');
    category = 'works';
  }
  const withoutArticle = language === 'en' && name.startsWith('the ') ? name.slice(4) : undefined;
  const alternatives = [...new Set([withoutArticle, alternative].filter((item): item is string => !!item))];
  return { text: name, ...(category && { category }), ...(alternatives.length && { alternatives }) };
}

function mentions(text: string, language: Language, category?: EntityCategory): Mentions | undefined {
  const alternative = language === 'ar' ? / (?:ام|او|لو|مقابل) /u : / (?:or|versus) /u;
  let parts = text.split(alternative);
  if (parts.length === 1) parts = text.split(language === 'ar' ? / و /u : / and /u);
  if (language === 'ar' && parts.length === 1) {
    const attached = [...text.matchAll(/ و(?=\S)/gu)];
    if (attached.length === 1) {
      const boundary = attached[0].index;
      parts = [text.slice(0, boundary), text.slice(boundary + 2)];
    }
  }
  if (parts.length < 2 || parts.length > 4) return;
  const names: KnowledgeMention[] = [];
  for (const part of parts) {
    const name = mention(part, language, category);
    if (!name) return;
    names.push(name);
  }
  const [first, second, ...others] = names;
  return [first, second, ...others];
}

const YEAR_PHRASE = {
  en: '(?:in(?: the year)?|as of|during) (\\d{1,4})(?: (?:ad|ce))?',
  ar: '(?:(?:في|خلال)(?: عام| سنه)?|سنه|عام) (\\d{1,4})(?: (?:م|ميلاديه|ميلادي))?',
};
const YEAR = {
  en: { start: new RegExp(`^${YEAR_PHRASE.en} `, 'u'), end: new RegExp(` ${YEAR_PHRASE.en}$`, 'u') },
  ar: { start: new RegExp(`^${YEAR_PHRASE.ar} `, 'u'), end: new RegExp(` ${YEAR_PHRASE.ar}$`, 'u') },
};
const ORDER: Record<Language, readonly (readonly [KnowledgeTime['order'], RegExp])[]> = {
  en: [
    ['latest', /(?:^| )(?:latest|most recent)(?= |$)/u],
    ['earliest', /(?:^| )(?:earliest|first recorded|oldest recorded)(?= |$)/u],
  ],
  ar: [
    ['latest', /(?:^| )(?:احدث|الاحدث)(?= |$)/u],
    ['earliest', /(?:^| )(?:اقدم|الاول المسجل|الاولي المسجله)(?= |$)/u],
  ],
};
const ARABIC_PROPERTY_HEAD = new RegExp(`^${LEAD.ar} (?:${ALL_PROPERTIES.ar})$`, 'u');
const TEMPORAL_PREFIX = {
  en: new RegExp(`^${LEAD.en}(?: the)?$`, 'u'),
  ar: new RegExp(`^${LEAD.ar}$`, 'u'),
};
const PROPERTY_PREFIX = {
  ar: new RegExp(`^(?:${ALL_PROPERTIES.ar}) .+$`, 'u'),
  en: new RegExp(`^(?:${ALL_PROPERTIES.en}) (?:of|for|in) .+$`, 'u'),
};

function timeConstraint(text: string, language: Language): { body: string; time?: KnowledgeTime } | undefined {
  const yearStart = YEAR[language].start.exec(text);
  const yearEnd = YEAR[language].end.exec(text);
  if (yearStart && yearEnd) return;
  const dated = yearStart ?? yearEnd;
  const year = dated && Number(dated[1]);
  if (dated && !year) return;
  let body = yearStart ? text.slice(yearStart[0].length) : yearEnd ? text.slice(0, yearEnd.index) : text;
  let order: KnowledgeTime['order'];
  for (const [candidate, pattern] of ORDER[language]) {
    const match = pattern.exec(body);
    if (match) {
      const afterModifier = body.slice(match.index + match[0].length).trim();
      const beforeModifier = body.slice(0, match.index).trim();
      // A temporal word inside the subject name does not constrain the fact.
      const modifiesProperty = TEMPORAL_PREFIX[language].test(beforeModifier) && PROPERTY_PREFIX[language].test(afterModifier);
      const followsArabicProperty = language === 'ar' && ARABIC_PROPERTY_HEAD.test(beforeModifier);
      if (afterModifier && !modifiesProperty && !followsArabicProperty) continue;
      if (order) return;
      order = candidate;
      body = `${body.slice(0, match.index)} ${body.slice(match.index + match[0].length)}`.trim().replace(/ +/gu, ' ');
    }
  }
  return { body, ...((year || order) && { time: { ...(year && { year }), ...(order && { order }) } }) };
}

const NOUN_QUESTION = {
  en: new RegExp(`^${LEAD.en} ${ARTICLE}(${ALL_PROPERTIES.en}) (?:of|for|in) (.+)$`, 'u'),
  ar: new RegExp(`^${LEAD.ar} (${ALL_PROPERTIES.ar}) (.+)$`, 'u'),
};
const POSSESSIVE_QUESTION = new RegExp(`^${LEAD.en} (.+) s (${ALL_PROPERTIES.en})$`, 'u');
const NESTED_NOUN = {
  en: new RegExp(`^${ARTICLE}(${ALL_PROPERTIES.en}) of (.+)$`, 'u'),
  ar: new RegExp(`^(${ALL_PROPERTIES.ar}) (.+)$`, 'u'),
};
const BIRTH_COUNTRY = {
  en: /^(?:the )?country (?:where|in which) (.+) was born$/u,
  ar: /^(?:ال)?(?:بلد|دوله) (?:الذي|التي|اللي) (?:انولد|اتولد|ولد)(?:ت)? فيه(?:ا)? (.+)$/u,
};
const BIRTH_COUNTRY_SUBJECT_FIRST = /^(?:ال)?(?:بلد|دوله) (?:الذي|التي|اللي) (.+) (?:انولد|اتولد|ولد)(?:ت)? فيه(?:ا)?$/u;
const ARABIC_POSSESSIVE_CONSTRUCT = /^(?:ل|ب|في) (.+)$/u;
const ARABIC_SUFFIX_QUESTION = new RegExp(`^(${ALL_PROPERTIES.ar}) (.+) (?:ايه|شو|وش|ايش|شنو|اش|كام|كم)$`, 'u');
const FIRST_PUBLICATION = {
  en: /^(?:when|in (?:what|which) year) (?:was|were) (.+?) (?:first (?:published|released)|(?:published|released) for the first time)$/u,
  ar: /^(?:متي|امتي|ايمتي|امته) (?:(?:تم|جري) )?(?:صدر(?:ت)?|نشر(?:ت)?|اطلق(?:ت)?) (.+?) (?:لاول مره|اول مره|اولا)$/u,
};

function relationQuestion(language: Language, rule: KnowledgeProperty, subject: string, time?: KnowledgeTime,
  category?: EntityCategory, multiple = false, nested = false): KnowledgeQuestion | undefined {
  const base = questionBase(language, rule, time);
  const relationSubject = language === 'ar'
    ? (ARABIC_POSSESSIVE_CONSTRUCT.exec(subject)?.[1] ?? subject).replace(/^في /u, '') : subject;
  if (nested) {
    const birthCountry = BIRTH_COUNTRY[language].exec(relationSubject)
      ?? (language === 'ar' ? BIRTH_COUNTRY_SUBJECT_FIRST.exec(relationSubject) : null);
    if (birthCountry) {
      if (time?.year !== undefined) return;
      const entity = mention(birthCountry[1], language, 'people');
      if (entity) {
        return { ...base, kind: 'path', entity, hops: [property('birthPlace')], countryOfBirth: true, ...(multiple && { multiple }) };
      }
    }
    const path = NESTED_NOUN[language].exec(relationSubject);
    if (path) {
      const hop = mapKnowledgeProperty(path[1], language);
      if (hop?.answerType === 'entity' && hop.id !== property('country').id) {
        if (time?.year !== undefined) return;
        const entity = mention(path[2], language);
        if (entity) return { ...base, kind: 'path', entity, hops: [hop], ...(multiple && { multiple }) };
      }
    }
  }
  const entity = mention(relationSubject, language, category);
  if (entity) return { ...base, kind: 'lookup', entity, ...(multiple && { multiple }) };
}

type LookupRule = readonly [
  pattern: RegExp,
  property: KnowledgePropertyKey,
  subjectCategory?: EntityCategory,
  multiple?: boolean,
];
const LOOKUPS: Record<Language, readonly LookupRule[]> = {
  en: [
    [/^when (?:was|were) (.+) (?:born|birthed)$/u, 'birthDate', 'people'],
    [/^where (?:was|were) (.+) born$/u, 'birthPlace', 'people'],
    [/^when did (.+) (?:die|pass away)$/u, 'deathDate', 'people'],
    [/^where did (.+) die$/u, 'deathPlace', 'people'],
    [/^(?:when|in (?:what|which) year) (?:was|were) (.+) (?:founded|established|formed|incorporated|created|built)$/u, 'inception'],
    [/^when did (.+) (?:start|begin|open)$/u, 'inception'],
    [/^who (?:founded|established|co founded) (.+)$/u, 'founder', undefined, true],
    [/^who (?:wrote|authored) ((?:(?:the )?(?:film|movie|tv series|tv show) .+)|(?:the .+ (?:movie|film|tv show|tv series)))$/u, 'screenwriter', 'works', true],
    [/^who (?:wrote|authored) (.+)$/u, 'author', 'works', true],
    [/^who (?:directed|was the director (?:of|for)) (.+)$/u, 'director', 'works', true],
    [/^who (?:composed|wrote the music for) (.+)$/u, 'composer', 'works', true],
    [/^who (?:invented|discovered) (.+)$/u, 'inventor', undefined, true],
    [/^who (?:created|designed) (.+)$/u, 'creator', undefined, true],
    [/^who published (.+)$/u, 'publisher', 'works', true],
    [/^what did (.+) (?:die|pass away) (?:of|from)$/u, 'causeOfDeath', 'people'],
    [/^which (?:disease|illness) (?:caused the death of|killed) (.+)$/u, 'causeOfDeath', 'people'],
    [/^(?:who|what) (?:owns|owned) (.+)$/u, 'owner', undefined, true],
    [/^which (?:kingdom|organization|organisation|work) preceded (.+)$/u, 'predecessor'],
    [/^(?:on which|which) stock exchanges? (?:are|were) (.+?) shares traded(?: on)?$/u, 'stockExchange', 'organizations', true],
    [/^what percentage of (.+) is covered (?:by|with) water$/u, 'waterArea'],
    [/^(?:when|in (?:what|which) year) (?:was|were) (.+) (?:published|released)$/u, 'publication', 'works'],
    [/^when did (.+) (?:come out|premiere)$/u, 'publication', 'works'],
    [/^who (?:is|was) (.+) married to$/u, 'spouse', 'people'],
    [/^who did (.+) marry$/u, 'spouse', 'people'],
    [/^who (?:starred|acted) in (.+)$/u, 'cast', 'works', true],
    [/^(?:what|which) currency (?:does|did|do) (.+) use$/u, 'currency'],
    [/^(?:what|which) currency (?:is|was) used in (.+)$/u, 'currency'],
    [/^where (?:is|are|was|were) (?:the )?(?:headquarters|head office) of (.+)$/u, 'headquarters', 'organizations'],
    [/^where (?:is|are|was|were) (.+) (?:headquartered|based)$/u, 'headquarters', 'organizations'],
    [/^(?:where|in (?:what|which) country) is (.+?)(?: located| found)?$/u, 'country'],
    [/^in (?:what|which) country was (.+?) located$/u, 'country'],
    [/^what country (?:is|was) (.+) a citizen of$/u, 'citizenship', 'people'],
    [/^what awards (?:did|has) (.+) (?:win|won|receive|received)$/u, 'awards', undefined, true],
    [/^how many (?:people|inhabitants|residents) (?:live|lived|are there|were there) in (.+)$/u, 'population'],
    [/^how many (?:employees|staff) (?:does|did) (.+) (?:have|employ)$/u, 'employees', 'organizations'],
    [/^how many (?:pages) (?:does|did) (.+) have$/u, 'pages', 'works'],
    [/^how (?:large|big) is (.+)$/u, 'area'],
    [/^how (?:high|tall) (?:is|was) (.+)$/u, 'height'],
    [/^how long (?:is|was) (.+)$/u, 'length'],
  ],
  ar: [
    [/^(?:متي|باي سنه|اي سنه|اي عام|في اي عام|في اي سنه) (?:ولد|انولد|اتولد)(?:ت)? (.+)$/u, 'birthDate', 'people'],
    [/^(?:متي|امتي|ايمتي|امته) (.+) (?:انولد|اتولد|ولد)(?:ت)?$/u, 'birthDate', 'people'],
    [/^(?:امتي|ايمتي|امته) (?:انولد|اتولد|ولد)(?:ت)? (.+)$/u, 'birthDate', 'people'],
    [/^(?:اين|وين|فين) (?:ولد|انولد|اتولد)(?:ت)? (.+)$/u, 'birthPlace', 'people'],
    [/^(?:اين|وين|فين) (.+) (?:انولد|اتولد|ولد)(?:ت)?$/u, 'birthPlace', 'people'],
    [/^(.+) (?:انولد|اتولد|ولد)(?:ت)? (?:وين|فين|اين)$/u, 'birthPlace', 'people'],
    [/^(?:متي|امتي|ايمتي|امته) (?:توفي|توفت|مات|ماتت) (.+)$/u, 'deathDate', 'people'],
    [/^(?:اين|وين|فين) (?:توفي|توفت|مات|ماتت) (.+)$/u, 'deathPlace', 'people'],
    [/^(?:متي|امتي|ايمتي|امته|في اي عام|في اي سنه) (?:(?:تم|جري) )?(?:تاسس(?:ت)?|تاسيس|اسس(?:ت)?|انشا(?:ت)?|انشئ(?:ت)?|بني(?:ت)?|افتتح(?:ت)?) (.+)$/u, 'inception'],
    [/^(?:متي|امتي|ايمتي|امته) (.+) (?:تاسس(?:ت)?|انشئ(?:ت)?|بني(?:ت)?|افتتح(?:ت)?)$/u, 'inception'],
    [/^(?:تاسس(?:ت)?|انشئ(?:ت)?|بني(?:ت)?|افتتح(?:ت)?) (.+) (?:متي|امتي|ايمتي|امته)$/u, 'inception'],
    [/^(?:من|مين|شكون) (?:اسس(?:ت)?|انشا(?:ت)?|قام بتاسيس) (.+)$/u, 'founder', undefined, true],
    [/^(?:من|مين|شكون) (?:كتب(?:ت)?|الف(?:ت)?) ((?:فيلم|مسلسل) .+)$/u, 'screenwriter', 'works', true],
    [/^(?:من|مين|شكون) (?:كتب(?:ت)?|الف(?:ت)?) (.+)$/u, 'author', 'works', true],
    [/^(?:من|مين|شكون) اخرج(?:ت)? (.+)$/u, 'director', 'works', true],
    [/^(?:من|مين|شكون) لحن(?:ت)? (.+)$/u, 'composer', 'works', true],
    [/^(?:من|مين|شكون) (?:اخترع(?:ت)?|اكتشف(?:ت)?) (.+)$/u, 'inventor', undefined, true],
    [/^(?:من|مين|شكون) (?:ابتكر(?:ت)?|صمم(?:ت)?) (.+)$/u, 'creator', undefined, true],
    [/^(?:من|مين|شكون) نشر(?:ت)? (.+)$/u, 'publisher', 'works', true],
    [/^(?:من|مين|شكون) (?:يملك|يمتلك|ملك) (.+)$/u, 'owner', undefined, true],
    [/^(?:متي|امتي|ايمتي|امته|في اي عام|في اي سنه) (?:(?:تم|جري) )?(?:صدر(?:ت)?|نشر(?:ت)?|اصدر(?:ت)?|اصدار|اطلق(?:ت)?) (.+)$/u, 'publication', 'works'],
    [/^(?:من|مين|شكون) (?:تزوج(?:ت)?|هو زوج(?:ه)?) (.+)$/u, 'spouse', 'people'],
    [/^(?:من|مين|شكون) (?:مثل|شارك|لعب دورا) في (.+)$/u, 'cast', 'works', true],
    [/^(?:ما(?: هي)?|وش|شو|شنو|ايش|ايه) (?:هي )?(?:ال)?عمله (?:التي|اللي) (?:يستخدمونها|بيستخدموها|يستعملونها|متداوله|تستخدم|تستعمل) (?:في|ب) (.+)$/u, 'currency'],
    [/^(?:ما(?: هي)?|وش|شو|شنو|ايش|ايه) (?:هي )?(?:ال)?عمله (?:التي|اللي) (?:يستخدمها|تستخدمها|يستعملها|تستعملها) (.+)$/u, 'currency'],
    [/^(?:اين|وين|فين) (?:(?:يقع|تقع|يوجد|توجد) )?(?:ال)?مقر (?:الرئيسي )?(?:ل )?(.+)$/u, 'headquarters', 'organizations'],
    [/^(?:اين|وين|فين) (?:يقع|تقع|موجود(?:ه)?|يوجد|توجد) (.+)$/u, 'country'],
    [/^(?:اين|وين|فين) (?:هو |هي )?(.+)$/u, 'country'],
    [/^(?:في اي) (?:دوله|بلد) (?:(?:يقع|تقع|يوجد|توجد) )?(.+)$/u, 'country'],
    [/^(?:ما(?: هي)?|وش|شو|شنو) الجوائز (?:التي|اللي) (?:فاز بها|حصل عليها|نالها) (.+)$/u, 'awards', undefined, true],
    [/^(?:كم|كام|قديش) (?:شخصا?|نسمه|فردا?) (?:يعيشون|يعيش|يسكنون|يسكن) في (.+)$/u, 'population'],
    [/^(?:كم|كام|قديش) (?:موظفا?|عاملا?) (?:يعمل|يشتغل) (?:في|لدي) (.+)$/u, 'employees', 'organizations'],
  ],
};

const COUNT_RELATIONS: Record<Language, readonly LookupRule[]> = {
  en: [
    [/^how many (?:children|kids) (?:does|did) (.+) have$/u, 'childCount', 'people'],
    [/^how many (?:recorded |listed )?awards (?:does|did|has) (.+) (?:win|won|have|receive|received)$/u, 'awards'],
    [/^how many (?:recorded |listed )?spouses (?:does|did|has) (.+) (?:have|had)$/u, 'spouse', 'people'],
    [/^how many (?:recorded |listed )?authors (?:(?:does|did) (.+) have|(?:are there in|are listed for) (.+))$/u, 'author', 'works'],
    [/^how many official languages (?:are there|are spoken|are listed) in (.+)$/u, 'officialLanguage'],
    [/^how many (?:recorded |listed )?(?:parts|components) (?:does|did) (.+) have$/u, 'parts'],
  ],
  ar: [
    [/^(?:كم|كام|قديش) (?:ولد|ابن|طفل|اطفال|اولاد|ابناء) (?:لدي|عند|كان لدي|كان عند) (.+)$/u, 'childCount', 'people'],
    [/^(?:كم|كام|قديش) (?:عدد )?(?:الجوايز|الجوائز|جاءزه) (?:(?:التي|اللي) )?(?:فاز بها|حصل عليها|نالها|فاز) (.+)$/u, 'awards'],
    [/^(?:كم|كام|قديش) (?:عدد )?(?:ازواج|الازواج) (.+)$/u, 'spouse', 'people'],
    [/^(?:كم|كام|قديش) (?:عدد )?(?:المولفين|مولفين|مولفو|مولفي|مؤلفين|مؤلفي|مؤلفو) (.+)$/u, 'author', 'works'],
    [/^(?:كم|كام|قديش) (?:عدد )?(?:اللغات الرسميه|لغات رسميه|لغه رسميه) (?:في |لدي )?(.+)$/u, 'officialLanguage'],
    [/^(?:كم|كام|قديش) عدد (?:اجزاء|مكونات) (.+)$/u, 'parts'],
  ],
};

function verbLookup(body: string, language: Language, time: KnowledgeTime | undefined): KnowledgeQuestion | undefined {
  const firstPublication = FIRST_PUBLICATION[language].exec(body);
  if (firstPublication) {
    if (time?.order !== 'latest') {
      return relationQuestion(language, property('publication'), firstPublication[1], { ...time, order: 'earliest' }, 'works');
    }
    return;
  }
  for (const [pattern, key, category] of COUNT_RELATIONS[language]) {
    const found = pattern.exec(body);
    if (!found) continue;
    const rule = property(key);
    const entity = mention(found[1] ?? found[2], language, category);
    if (entity) {
      const base = questionBase(language, rule, time);
      return rule.answerType === 'quantity' ? { ...base, kind: 'lookup', entity }
        : { ...base, kind: 'count', expected: 'quantity', entity };
    }
  }
  for (const [pattern, key, category, multiple] of LOOKUPS[language]) {
    const match = pattern.exec(body);
    if (!match) continue;
    if (key === 'spouse' && time?.year === undefined && /^who is /u.test(body)) return;
    if (key === 'population' && time?.year === undefined && /^how many .+ (?:lived|were there) in /u.test(body)) return;
    return relationQuestion(language, property(key), match[1], time, category, multiple);
  }
}

const CATEGORIES: Record<Language, Readonly<Record<string, EntityCategory>>> = {
  en: { country: 'countries', countries: 'countries', nation: 'countries', nations: 'countries', city: 'cities', cities: 'cities' },
  ar: { دوله: 'countries', الدوله: 'countries', بلدان: 'countries', بلد: 'countries', البلد: 'countries',
    الدول: 'countries', مدينه: 'cities', المدينه: 'cities', المدن: 'cities', مدن: 'cities' },
};
const METRIC = {
  en: '(?:by|in terms of) (?:the )?(?<metric>population|area|total area|length|total length|height|elevation)',
  ar: '(?:من حيث|حسب|ب(?:حسب|النسبه ل)) (?<metric>عدد السكان|السكان|المساحه|الارتفاع|الطول الكلي|الطول|طوله الكلي)',
};
const EXTREME = {
  en: 'largest|biggest|smallest|most populous|least populous|highest|lowest|longest|shortest',
  ar: 'اكبر|الاكبر|اصغر|الاصغر|اكثر سكانا|الاكثر سكانا|اقل سكانا|الاقل سكانا|اعلي|الاعلي|ادني|الادني|اطول|الاطول|اقصر|الاقصر',
};
const COMPARATIVE = {
  en: 'larger|bigger|smaller|more populous|less populous|higher|lower|longer|shorter|more populated|less populated',
  ar: EXTREME.ar,
};
const CATEGORY_SUPERLATIVES: Record<Language, readonly RegExp[]> = {
  en: [
    new RegExp(`^(?:what|which)(?: is| was| s) (?:the )?(?<extreme>${EXTREME.en}) (?<category>country|city|nation)(?: ${METRIC.en})?(?: in the world)?$`, 'u'),
    new RegExp(`^(?:what|which) (?<category>country|city|nation) (?:is|was) (?:the )?(?<extreme>${EXTREME.en})(?: ${METRIC.en})?(?: in the world)?$`, 'u'),
  ],
  ar: [
    new RegExp(`^${LEAD.ar} (?<extreme>${EXTREME.ar}) (?<category>دوله|بلد|مدينه)(?: ${METRIC.ar})?(?: في العالم)?$`, 'u'),
    new RegExp(`^${LEAD.ar} (?<category>الدوله|البلد|المدينه) (?<extreme>${EXTREME.ar})(?: ${METRIC.ar})?(?: في العالم)?$`, 'u'),
  ],
};
const AMONG_SUPERLATIVES: Record<Language, readonly RegExp[]> = {
  en: [
    new RegExp(`^(?:what|which) (?:is|was|of these is) (?:the )?(?<extreme>${EXTREME.en}) (?<category>country|city|nation)(?: ${METRIC.en})? (?:among|out of|of) (?<names>.+)$`, 'u'),
  ],
  ar: [
    new RegExp(`^${LEAD.ar} (?<extreme>${EXTREME.ar}) (?<category>دوله|بلد|مدينه)(?: ${METRIC.ar})? (?:من بين|بين) (?<names>.+)$`, 'u'),
  ],
};
const COMPARISONS: Record<Language, readonly RegExp[]> = {
  en: [
    new RegExp(`^compare (?:the )?(?<metric>population|area|length|height|elevation)s? of (?<names>.+)$`, 'u'),
    new RegExp(`^compare (?<names>.+) ${METRIC.en}$`, 'u'),
    new RegExp(`^which (?:(?<kind>country|city|river|mountain) )?(?:is|was) (?:the )?(?<extreme>${COMPARATIVE.en})(?: ${METRIC.en})? (?<names>.+)$`, 'u'),
    /^(?:which|what) (?:(?<kind>country|city|river|mountain) )?has (?:the |a )?(?<extreme>larger|greater|higher|smaller|lower|longer|shorter) (?<metric>population|area|length|height|elevation) (?<names>.+)$/u,
    new RegExp(`^which (?:one )?(?:of )?(?<names>.+) (?:is|was) (?:the )?(?<extreme>${COMPARATIVE.en})(?: ${METRIC.en})?$`, 'u'),
  ],
  ar: [
    new RegExp(`^قارن(?: بين)? (?<names>.+) ${METRIC.ar}$`, 'u'),
    new RegExp(`^(?:ايهما|اي|ما|ما هو|ما هي|شنو|شو|وش|ايش) (?:(?<kind>الدوله|البلد|المدينه|النهر|الجبل) )?(?<extreme>${COMPARATIVE.ar})(?: ${METRIC.ar})? (?<names>.+)$`, 'u'),
    new RegExp(`^(?:ايهما|ما|شنو|شو|وش|ايش) (?<names>.+) (?<extreme>${COMPARATIVE.ar})(?: ${METRIC.ar})?$`, 'u'),
  ],
};

const DATED_COMPARISONS: Record<Language, readonly LookupRule[]> = {
  en: [
    [/^which (?:movie |film |book |game |work |series )?(?:came out|was released|was published|was launched) (first|earlier|last|later) (.+)$/u, 'publication', 'works'],
    [/^which (?:band |organization |organisation |company |university )?(?:(?:is|was) (?:founded|formed|established|created)) (first|earlier|last|later) (.+)$/u, 'inception', 'organizations'],
    [/^who was born (first|earlier|last|later) (.+)$/u, 'birthDate', 'people'],
  ],
  ar: [
    [/^(?:ما(?: هي| هو)?|اي|شنو|شو|وش) (?:(?:ال)?(?:فيلم|عمل|كتاب|سلسله|لعبه) )?(?:(?:الذي|التي|اللي) )?(?:صدر(?:ت)?|نشر(?:ت)?|اطلق(?:ت)?) (اولا|مبكرا|اخيرا|متاخرا) (.+)$/u, 'publication', 'works'],
    [/^(?:ما(?: هي| هو)?|اي|شنو|شو|وش) (?:(?:ال)?(?:شركه|فرقه|منظمه|جامعه) )?(?:(?:الذي|التي|اللي) )?(?:تاسس(?:ت)?|انشا(?:ت)?) (اولا|مبكرا|اخيرا|متاخرا) (.+)$/u, 'inception', 'organizations'],
    [/^(?:من|مين|شكون) (?:ولد|انولد|اتولد)(?:ت)? (اولا|مبكرا|اخيرا|متاخرا) (.+)$/u, 'birthDate', 'people'],
  ],
};

function directionOf(extreme: string): Direction {
  return /small|least|less|low|short|اصغر|اقل|ادني|اقصر/u.test(extreme) ? 'min' : 'max';
}

function metricOf(language: Language, metric: string | undefined, extreme: string | undefined, kind: string | undefined) {
  const implied = /popul|سكان/u.test(extreme ?? '') ? property('population')
    : /long|short|اطول|اقصر/u.test(extreme ?? '') ? property('length') : undefined;
  if (metric) {
    const explicit = metric === 'طوله الكلي' ? property('length') : mapKnowledgeProperty(metric, language);
    if (!implied || explicit?.id === implied.id) return explicit;
    return;
  }
  if (!extreme || implied) return implied;
  if (/high|low|اعلي|ادني/u.test(extreme) && /^(?:mountain|الجبل)$/u.test(kind ?? '')) return property('elevation');
  if (/larg|big|small|اكبر|اصغر/u.test(extreme) && kind && CATEGORIES[language][kind] === 'countries') return property('area');
}

function ranking(body: string, language: Language, time: KnowledgeTime | undefined): KnowledgeQuestion | undefined {
  for (const [pattern, key, category] of DATED_COMPARISONS[language]) {
    if (time?.order === 'latest') break;
    const match = pattern.exec(body);
    if (!match) continue;
    const entities = mentions(match[2], language, category);
    if (!entities) continue;
    const rule = property(key);
    return {
      ...questionBase(language, rule, { ...time, order: 'earliest' }), expected: 'entity',
      kind: 'compare', entities, direction: /^(?:first|earlier|اولا|مبكرا)$/u.test(match[1]) ? 'min' : 'max',
    };
  }
  for (const pattern of [...AMONG_SUPERLATIVES[language], ...CATEGORY_SUPERLATIVES[language]]) {
    const groups = pattern.exec(body)?.groups;
    if (!groups) continue;
    const category = CATEGORIES[language][groups.category];
    const rule = metricOf(language, groups.metric, groups.extreme, groups.category);
    const entities = groups.names && mentions(groups.names, language, category);
    if (rule && category && (!groups.names || entities)) {
      return {
        ...questionBase(language, rule, time), expected: 'entity', kind: 'superlative', direction: directionOf(groups.extreme),
        category, ...(entities && { entities }),
      };
    }
  }
  for (const pattern of COMPARISONS[language]) {
    const groups = pattern.exec(body)?.groups;
    if (!groups) continue;
    const rule = metricOf(language, groups.metric, groups.extreme, groups.kind);
    const entities = mentions(groups.names, language, CATEGORIES[language][groups.kind]);
    if (rule && entities) {
      return {
        ...questionBase(language, rule, time), expected: 'entity', kind: 'compare',
        entities, ...(groups.extreme && { direction: directionOf(groups.extreme) }),
      };
    }
  }
}

const PLURAL_PROPERTY = {
  en: /^(?:official languages|original languages|authors|writers|directors|publishers|composers|founders|children|spouses|awards(?: received)?|cast(?: members)?|parts|components|occupations)$/u,
  ar: /^(?:اللغات الرسميه|لغات رسميه|مولفو|مؤلفو|مولفي|مؤلفي|اولاد|الاولاد|الابناء|ابناء|الاطفال|اطفال|الجوائز|جوائز|الازواج|ازواج|طاقم التمثيل|الاجزاء|اجزاء|المكونات|مكونات)$/u,
};
const POLITE = {
  en: /^(?:(?:please|kindly|can you tell me|could you tell me|do you know) )+/u,
  ar: /^(?:(?:من فضلك|لو سمحت|رجاء|الرجاء|ممكن تقول لي|ممكن تخبرني) )+/u,
};
const PAST_REQUIRES_TIME: readonly KnowledgePropertyKey[] = [
  'capital', 'population', 'area', 'currency', 'headquarters', 'headOfState', 'headOfGovernment', 'employees',
];
const PAST_REQUIRES_TIME_IDS = new Set(PAST_REQUIRES_TIME.map(key => property(key).id));

export function knowledgeQuestionLanguage(text: string): Language {
  return /^\p{Script=Arabic}/u.test(normalizeLookupKey(text)) ? 'ar' : 'en';
}

/** Parses a supported factual clause into a typed relation without consulting the store. */
export function analyzeKnowledgeQuestion(text: string, language?: Language): KnowledgeQuestion | undefined {
  const raw = text.trim().replace(/[?؟.!]+$/u, '');
  if (!raw || raw.length > 400 || /[\r\n?؟;؛]|https?:\/\/|\bwww\.|(?:^|\s)[−-]\s*\p{Nd}/iu.test(raw)) return;
  const key = normalizeLookupKey(raw).replace(/\bvs\b/gu, 'versus');
  const selected = language ?? knowledgeQuestionLanguage(raw);
  const constrained = timeConstraint(key.replace(POLITE[selected], ''), selected);
  if (!constrained) return;
  const { body, time } = constrained;
  const result = ranking(body, selected, time) ?? verbLookup(body, selected, time);
  if (result) return result;
  const noun = NOUN_QUESTION[selected].exec(body) ?? (selected === 'ar' ? ARABIC_SUFFIX_QUESTION.exec(body) : null);
  const possessive = selected === 'en' ? POSSESSIVE_QUESTION.exec(body) : null;
  const phrase = noun?.[1] ?? possessive?.[2];
  const subject = noun?.[2] ?? possessive?.[1];
  if (!phrase || !subject) return;
  const rule = mapKnowledgeProperty(phrase, selected);
  if (rule?.id === property('spouse').id && time?.year === undefined && !/^who (?:was|were) /u.test(body)) return;
  // A past-tense request about a changing value needs a stated time.
  if (rule && selected === 'en' && !time && /^(?:what|which|who) (?:was|were) /u.test(body)
    && PAST_REQUIRES_TIME_IDS.has(rule.id)) return;
  if (rule) return relationQuestion(selected, rule, subject, time, undefined, PLURAL_PROPERTY[selected].test(phrase), true);
}
