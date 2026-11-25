import { arabicBase, foldText } from '../../../../../packages/skills/src/stems.js';
import { CAPITAL_CITY_COORDINATION, CAPITAL_CITY_COPULA, searchFactRequest, searchFactValue, WRITTEN_WORK_CREDIT, WRITTEN_WORK_LABEL, type SearchFactRequest } from './factual-claims.js';
import { reasonScopeMatches } from './reason-scope.js';
import { selectionTerms, stemOverlap, type SelectionTerm } from './word-forms.js';

export interface EntityQuery {
  subjects: readonly string[];
  comparison: boolean;
  relation: string;
  language: 'ar' | 'en';
  reason: boolean;
  definition: boolean;
  currentAge?: boolean;
  effect?: readonly SelectionTerm[];
  setting?: readonly SelectionTerm[];
  question?: string;
  fact?: SearchFactRequest;
}

export interface EntityEvidence {
  text: string;
  pageTitle: string;
  heading?: string;
  kind?: 'title' | 'heading' | 'lead' | 'sentence' | 'list' | 'table';
  position?: number;
  previousText?: string;
}

export interface EntityAgreement {
  agreement: 'match' | 'inferred' | 'unknown' | 'conflict';
  reason: string;
}

interface Relation {
  name: string;
  en: string;
  ar: string;
}

const ARABIC = /\p{Script=Arabic}/u;
const RELATIONS: readonly Relation[] = [
  { name: 'age', en: 'age[ds]?|years? old|old|older|young(?:er|est)?', ar: '(?:ال)?(?:عمر|سن|اصغر|اكبر سنا)(?:ها|ه)?' },
  { name: 'population', en: 'population|inhabitants?|residents?|people(?: live)?|populous', ar: '(?:عدد )?(?:ال)?سكان(?:ها|ه)?|نسمه' },
  { name: 'capital', en: 'capital(?: city)?', ar: '(?:ال)?عاصم[هت](?:ها|ه)?' },
  { name: 'area', en: 'area|surface area', ar: '(?:ال)?مساح[هت](?:ها|ه)?' },
  { name: 'height', en: 'height|elevation|altitude|tall(?:er|est)?|higher|lower', ar: '(?:ال)?ارتفاع(?:ها|ه)?|اعلي|اقل ارتفاعا' },
  { name: 'length', en: 'length|long(?:er|est)?|short(?:er|est)?', ar: '(?:ال)?طول(?:ها|ه)?|اطول|اقصر' },
  { name: 'size', en: 'size|larg(?:e|er|est)|small(?:er|est)?|big(?:ger|gest)?', ar: '(?:ال)?حجم(?:ها|ه)?|اكبر|اصغر' },
  { name: 'speed', en: 'speed|swift(?:er|est)?|fast(?:er|est)?|slow(?:er|est)?', ar: '(?:ال)?سرع[هت](?:ها|ه)?|اسرع|ابطا' },
  { name: 'weight', en: 'weigh(?:s|ed|t)?|heav(?:y|ier)|lighter|mass', ar: '(?:ال)?(?:وزن|كتل[هت])(?:ها|ه)?|اثقل|اخف' },
  { name: 'distance', en: 'distance|far(?:ther|thest)?|further|near(?:er|est)?', ar: '(?:ال)?مساف[هت](?:ها|ه)?|ابعد|اقرب' },
  { name: 'currency', en: 'currency', ar: '(?:ال)?عمل[هت](?:ها|ه)?' },
  { name: 'language', en: '(?:official )?languages?', ar: '(?:ال)?لغ[هت](?:ها|ه)?(?: الرسميه)?' },
  { name: 'leadership', en: 'president|prime minister|king|queen|leader|mayor|governor|chief executive', ar: '(?:ال)?(?:رئيس|ملك|حاكم|وزير)(?:ها|ه)?' },
  { name: 'count', en: 'numbers?|moons?|planets?|members?|countries|states?', ar: '(?:ال)?(?:عدد|اقمار|كواكب|اعضاء|دول|ولايات)(?:ها|ه)?' },
  { name: 'invent', en: 'invent(?:s|ed|ing|or|ion)', ar: '(?:ال)?اختراع(?:ها|ه)?|اخترع(?:ت|ه|ها)?|مخترع' },
  { name: 'write', en: 'writ(?:e|es|ten|ing)|wrote|author(?:ed)?', ar: '(?:ال)?تاليف|الف(?:ت|ه|ها)?|كتب(?:ت|ه|ها)?|مؤلف' },
  { name: 'found', en: 'found(?:ed|er|ing)|establish(?:ed|ment)?|creat(?:e|ed|or|ion)', ar: '(?:ال)?تاسيس(?:ها|ه)?|تاسس(?:ت)?|اسس(?:ت)?|انشا(?:ت)?|مؤسس' },
  { name: 'born', en: 'born|birth', ar: '(?:ال)?ميلاد(?:ها|ه)?|مولد|م?ولد(?:ت)?' },
  { name: 'die', en: 'die[ds]?|death|passed away', ar: '(?:ال)?وفا[هت](?:ها|ه)?|توفي(?:ت)?|مات(?:ت)?' },
  { name: 'independence', en: 'independen(?:ce|t)', ar: '(?:ال)?استقلال(?:ها|ه)?|استقل(?:ت|وا)?' },
  { name: 'fall', en: 'fall(?:s|en|ing)?|fell|collapse[ds]?', ar: '(?:ال)?سقوط(?:ها|ه)?|سقط(?:ت)?|انهيار|انهار(?:ت)?' },
  { name: 'start', en: 'start(?:s|ed)?|beg(?:in(?:s|ning)?|an|un)|outbreak|broke out', ar: '(?:ال)?بداي[هت](?:ها|ه)?|بدا(?:ت)?|اندلاع|اندلع(?:ت)?|نشوب|نشب(?:ت)?' },
  { name: 'end', en: 'end(?:s|ed|ing)?|conclud(?:e|ed)', ar: '(?:ال)?نهاي[هت](?:ها|ه)?|انتهاء|انتهي|انتهت' },
  { name: 'location', en: 'located|location|situated', ar: '(?:ال)?موقع(?:ها|ه)?|تقع|يقع|توجد|يوجد' },
  { name: 'work', en: 'work(?:s|ed|ing)?|operat(?:e|es|ed|ion)', ar: 'تعمل|يعمل|عمل(?:ها|ه)?|طريق[هت](?:ها|ه)?' },
];
const RELATION_PATTERNS = {
  en: RELATIONS.map(relation => [relation.name, new RegExp(`(?<![\\p{L}\\p{N}])(?:${relation.en})(?![\\p{L}\\p{N}])`, 'u')] as const),
  ar: RELATIONS.map(relation => [relation.name, new RegExp(`(?<![\\p{L}\\p{N}])[وفب]?(?:${relation.ar})(?![\\p{L}\\p{N}])`, 'u')] as const),
};

function clean(text: string): string {
  return foldText(text).replace(/[’‘`]/gu, "'").replace(/[^\p{L}\p{N}'\s-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function trimSubject(text: string): string {
  return text.replace(/^(?:(?:the|an?|of|for|about|to|in|on|and|من|في|عن|بين|الي|علي)\s+)+/u, '')
    .replace(/\s+(?:is|are|was|were|have|has|had|in total|today|currently|now|حاليا|اليوم|الان)$/u, '')
    .replace(/^ل(?=ال\p{L}{3})/u, '').trim();
}

function findRelation(text: string, language: EntityQuery['language'], only?: string): { name: string; index: number; text: string } | undefined {
  let first: ReturnType<typeof findRelation>;
  for (const [name, pattern] of RELATION_PATTERNS[language]) {
    if (only && only !== name) continue;
    const found = pattern.exec(text);
    if (found && (first === undefined || found.index < first.index)) first = { name, index: found.index, text: found[0] };
  }
  return first;
}

const COMPARE_EN = /^(?:(?:what (?:is|are) (?:the )?|give (?:the )?)?(?:difference|differences|comparison) between|compare)\s+/u;
const COMPARE_AR = /^(?:(?:ما|اذكر) (?:هو )?الفرق بين|(?:ما هي )?الفروق بين|(?:وجه|اوجه) المقارنه بين|(?:اعمل )?مقارنه بين|قارن(?: بين)?)\s+/u;
const COMPARE_PAIR_EN = /\s+(?:and|or|versus|vs)\s+/u;
const COMPARE_PAIR_AR = /\s+(?:(?:ام|او|مقابل|مع|و)\s+|و(?=\p{Script=Arabic}))/u;
const EN_COMPARATIVE = '(?:more|less)(?: [a-z]+){0,2}|taller|shorter|higher|lower|longer|larger|smaller|bigger|faster|slower|older|younger|heavier|lighter|farther|closer|earlier|later|better';
const AR_COMPARATIVE = 'اكثر|اقل|اكبر|اصغر|اعلي|ادني|اطول|اقصر|اسرع|ابطا|اقدم|احدث|اثقل|اخف|ابعد|اقرب|افضل';

function comparisonQuery(input: string, question: string, language: EntityQuery['language']): Pick<EntityQuery, 'subjects' | 'relation'> | undefined {
  const arabic = language === 'ar';
  const comparison = arabic ? COMPARE_AR : COMPARE_EN;
  const pair = arabic ? COMPARE_PAIR_AR : COMPARE_PAIR_EN;
  const option = arabic ? AR_COMPARATIVE : EN_COMPARATIVE;
  const explicitOption = new RegExp(arabic ? `^ايهما (?:${option})(?: (?:حجما|طولا|ارتفاعا|سنا|عمرا|مساحه|سرعه|وزنا))?(?= |$)` : `^which (?:one )?(?:is|was) (?:${option})(?= |$)`, 'u');
  const optionPrefix = explicitOption.exec(question);
  const punctuatedPrefix = clean(input.split(/[,،]/u)[0]!);
  const optionAttribute = optionPrefix && punctuatedPrefix !== question && /^by /u.test(punctuatedPrefix.slice(optionPrefix[0].length).trim())
    ? punctuatedPrefix.slice(optionPrefix[0].length).trim().slice(3) : undefined;
  const against = new RegExp(`^(.+?) (${option}) ${arabic ? 'من' : 'than'} (.+)$`, 'u').exec(question.replace(/^(?:هل|is|was)\s+/u, ''));
  const attribute = /\s+(?:in terms of|with respect to|من حيث)\s+(.+)$/u.exec(question);
  let subjects: string[];
  let predicate = optionAttribute ?? optionPrefix?.[0] ?? against?.[2] ?? '';
  if (against) {
    subjects = [against[1]!.replace(/\s+(?:is|are|was|were)$/u, ''), against[3]!];
  } else if (comparison.test(question) || optionPrefix || /\s(?:versus|vs|مقابل)\s/u.test(question)) {
    const stem = attribute ? question.slice(0, attribute.index) : question;
    const body = (optionAttribute ? stem.slice(punctuatedPrefix.length) : stem.replace(comparison, '').replace(explicitOption, '')).trim();
    const separators = [...body.matchAll(new RegExp(pair.source, 'gu'))];
    const separator = separators.length === 1 ? separators[0] : undefined;
    subjects = separator ? [body.slice(0, separator.index), body.slice(separator.index + separator[0].length)] : [];
  } else {
    return undefined;
  }
  if (attribute) {
    predicate = attribute[1]!;
    subjects = subjects.map(subject => subject.replace(attribute[0], ''));
  }
  const namedAttribute = arabic && /(?:^|\s)مساحه(?:$|\s)/u.test(predicate) ? 'area' : undefined;
  return { subjects: subjects.map(trimSubject).filter(Boolean), relation: namedAttribute ?? findRelation(predicate, language)?.name ?? predicate };
}

const EN_ASK = /^(?:(?:explain|tell me) )?(?:why|when|where|who|whom|what(?:'s)?|which|how)(?:\s+(?:is|are|was|were|did|do|does|has|have|had|can|could|would|will|should))?\s+/u;
const EN_REGION_ASK = /^(?:in|at) (?:what|which) (?:country|city|place|region|continent|part|area)(?: (?:of|in) (?:the )?(?:world|country|continent))? (?:is|was|are|were) /u;
const AR_ASK = /^(?:اشرح )?(?:[وف])?(?:لماذا|ليش|ليه|متي|اين|وين|كيف|كم|ما|ماذا|من|مين|اي)(?:\s+(?:هو|هي|كان|كانت|يمكن))?\s+/u;
const AR_LOCATION_ASK = /^(?:اين|وين|من وين) (?:(?:هو|هي|يقع|تقع|يوجد|توجد|موجوده?) )?(?:(?:مدينه|بلده|قريه|جزيره|منطقه|دوله) )?/u;
const EN_RELATION_FRAME = /^(?:(?:organization|organisation|institution|company|agency|country|city|person|place)\s+)?(?:runs|operates|manages|discovered|painted|directed|composed|causes|caused|produces|manufactures|publishes|built|builds|leads)\s+/u;
const AR_RELATION_FRAME = /^(?:الذي |التي )?(?:(?:ال)?(?:شرك[هت]|جه[هت]|منظم[هت]|دول[هت]|مدين[هت])\s+)?(?:يدير|تدير|اكتشف|رسم|الف|انتج|تنتج|ينتج|ينشر|تنشر|سبب|اسباب|بني|بنت)\s+/u;
const EN_REASON_PREDICATE = /\s+(?:seems?|looks?|appears?|changes?|happens?|causes?|falls?|rises?|migrates?|needs?|moves?|forms?|shrinks?|grows?|flies|fly|flows?|rotates?|exists?|burns?|sinks?|floats?|went|goes?|runs?|turns?|stops?|freezes?|melts?|roams?|favou?red|(?:so )?(?:blue|red|green|white|black|dark|light|hot|cold|wet|dry|salty|round|flat|important|visible|dangerous|extinct))(?=\s|$)/u;
const AR_REASON_PREDICATE = /^(?:سمي(?:ت)?|تسمي|يسمي|تحدث|يحدث|تسقط|يسقط|تهاجر|يهاجر|انقرض(?:ت)?|انقراض|تدور|يدور|تظهر|يظهر|تغير|يتغير|تتغير|تسخن|يسخن|تبدو|يبدو|تكون|يكون|زرْ?ق[هت]|تسمي[هت]|سقوط|حدوث|هجر[هت]|تغير|انتشار)\s+|\s+(?:زرقاء|ازرق|حمراء|احمر|اخضر|خضراء|مالح|مالح[هت]|مهم|مهم[هت]|منقرض|يتغير|تتغير|بارده|حاره)(?=\s|$)/gu;
const PRONOUN_SUBJECT = /^(?:i|we|you|he|she|it|they|this|that|here|there|هو|هي|هما|هم|هن|هذا|هذه|ذلك|تلك|هنا|هناك)$/u;
const POSSESSIVE_QUERY = /^(.+?)'s\s+(.+)$/u;
const ASK_EFFECT_FILLER = /(?:بهذا الاسم|بهذه الطريقه|(?:by|under) that name|its name|this name|^the reason|^that)(?=\s|$)/u;
const EFFECT_FILLER = new Set(['did', 'had', 'has', 'does', 'so', 'more', 'this', 'name', 'بهذا', 'الاسم', 'اسم',
  'happen', 'happens', 'happened', 'occur', 'occurs', 'occurred', 'حدث', 'تحدث', 'يحدث', 'حدوث', 'وقوع']);
const SETTING_ASK = /(?:^|\s)(?:within|across|throughout|during|in|شتاء|صيفا|شتا|في|خلال)(?=\s|$)/u;
const SETTING_FILLER = new Set(['within', 'across', 'throughout', 'during', 'in', 'region', 'season', 'climate', 'مناخ', 'في', 'خلال', 'فصل', 'موسم']);
const WORK_DESCRIPTOR = new RegExp(`^(?:the|an?) ${WRITTEN_WORK_LABEL} `, 'u');

export function questionEntities(input: string): EntityQuery {
  const language = ARABIC.test(input) ? 'ar' : 'en';
  const arabic = language === 'ar';
  const question = clean(input);
  const fact = searchFactRequest(input, language);
  if (fact) return { subjects: [fact.subject], relation: fact.type, comparison: false, language, reason: false, definition: false, fact };
  const comparison = comparisonQuery(input, question, language);
  if (comparison) return { ...comparison, comparison: true, language, reason: false, definition: false };

  const reason = /^(?:explain |اشرح )?(?:why|what (?:caus(?:e[sd]?)|(?:is|are) (?:the )?(?:reasons?|causes?))|لماذا|ليش|ليه|ما (?:سبب|اسباب))(?=\s|$)/u.test(question);
  const definition = /^(?:what(?:'s| is| are)|who (?:is|was)|ما (?:هو|هي|معني|المقصود)|من (?:هو|هي)|ماذا يعني)(?=\s|$)/u.test(question);
  const locationAsk = arabic ? AR_LOCATION_ASK.exec(question) : null;
  let body = locationAsk ? question.slice(locationAsk[0].length) : question.replace(EN_REGION_ASK, '').replace(arabic ? AR_ASK : EN_ASK, '');
  if (arabic) body = body.replace(/^(?:معني|المقصود ب|يعني|تعريف)\s*/u, '');
  const possessive = !arabic ? POSSESSIVE_QUERY.exec(body) : null;
  const possessedRelation = possessive && findRelation(possessive[2]!, language);
  if (possessive && possessedRelation) {
    return { subjects: [trimSubject(possessive[1]!)], relation: possessedRelation.name, language, comparison: false, reason, definition: false };
  }

  body = body.replace(arabic ? AR_RELATION_FRAME : EN_RELATION_FRAME, '').replace(/^(?:the )?(?:main |primary )?(?:reasons?|causes?) (?:for|of|behind)\s+/u, '');
  body = body.replace(/^(?:many|much)\s+/u, '');
  if (reason) body = body.replace(ASK_EFFECT_FILLER, '').trim();
  const found = findRelation(body, language);
  let subject = body;
  if (found && reason) {
    subject = found.index === 0 ? body.slice(found.text.length) : body.slice(0, found.index).replace(/\s+(?:did|does|do|has|have|gained|gain|got)$/u, '');
  } else if (found) {
    const before = trimSubject(body.slice(0, found.index)).replace(/\s+(?:did|does|do|gain(?:ed)?|got)$/u, '');
    const after = trimSubject(body.slice(found.index + found.text.length));
    subject = before || after;
    if (!before && found.name === 'write' && !arabic) {
      subject = trimSubject(body.slice(found.index + found.text.length).trim().replace(WORK_DESCRIPTOR, ''));
    }
    if (!arabic && /^(?:does|did|do|has|have|was|is|were|are)\s+/u.test(after)) {
      subject = after.replace(/^(?:does|did|do|has|have|was|is|were|are)\s+/u, '').replace(/\s+(?:have|live|contain|hold|include|there)(?: .*)?$/u, '');
    }
  }
  if (reason) subject = arabic ? subject.replace(AR_REASON_PREDICATE, '').split(/\s+(?:في مناخ|شتاء|صيفا|في فصل|خلال موسم)(?=\s|$)/u)[0]! : subject.split(EN_REASON_PREDICATE)[0]!;
  if (!found && !reason && /^how /u.test(question)) {
    subject = subject.split(/\s+(?:transmits?|converts?|conveys?|produces?|passes?|injects?|prevents?|generates?|uses?|makes?|creates?|detects?|tracks?|measures?)\s+/u)[0]!;
  }
  subject = trimSubject(subject).replace(/^\s*(?:city of|country of|مدينة |دوله )/u, '').trim();
  const subjects = subject && !PRONOUN_SUBJECT.test(subject) ? [subject] : [];
  const currentAge = found?.name === 'age' && !/\b(?:was|were|when|at the time)\b|(?:^|\s)(?:كان|كانت|عندما|حين)(?=\s|$)/u.test(question);
  const predicate = reason && subject ? body.replace(subject, ' ').trim() : '';
  const settingStart = SETTING_ASK.exec(predicate)?.index;
  const setting = settingStart === undefined ? undefined : selectionTerms(predicate.slice(settingStart)).filter(term => !SETTING_FILLER.has(term.word));
  const effect = predicate ? selectionTerms(predicate.slice(0, settingStart)).filter(term => !EFFECT_FILLER.has(term.word)) : undefined;
  return { subjects, relation: found?.name ?? '', comparison: false, language, reason, definition: definition && !found,
    currentAge, effect, setting, question: reason ? input : undefined };
}

const FAMILY_EN = 'sons?|daughters?|child(?:ren)?|fathers?|mothers?|brothers?|sisters?|wives|wife|husbands?|partners?|parents?|siblings?|grand(?:sons?|daughters?|parents?|father|mother)';
const FAMILY_POSSESSIVE_AR = '(?:ابنه|ابنته|ابنتها|ابنها|ابنتهما|نجله|نجلها|نجلته|ولده|ولدها|والدها|والده|والدته|والدتها|شقيقه|شقيقها|اخوه|اخوها|اخته|اختها|زوجه|زوجته|زوجها)';
const FAMILY_AR = `(?:ابن|ابناء|نجل|والد|شقيق|اخ|زوج|${FAMILY_POSSESSIVE_AR})`;
const SPECIFIED_OWNER_EN = new RegExp(`(?:'s (?:${FAMILY_EN})|\\b(?:his|her|their) (?:${FAMILY_EN})|\\b(?:the )?(?:${FAMILY_EN}) of)(?=\\s|$)`, 'u');
const SPECIFIED_OWNER_AR = new RegExp(`^(?:(?:ولد|ولدت|بلغ|يبلغ|تبلغ|كان|كانت|ان) )?${FAMILY_AR}(?=\\s|$)|(?<!\\p{L})[وف]?${FAMILY_POSSESSIVE_AR}(?=\\s|$)`, 'u');
const FAMILY_AFTER_EN = new RegExp(`^(?:of )?(?:(?:his|her|their|the) )?(?:${FAMILY_EN})(?=\\s|$)`, 'u');
const CAUSE = /(?<![\p{L}\p{N}])(?:(?:because(?: of)?|due to|caused by|as a result of|result(?:s|ed|ing)? from|owing to)|(?:ف|و)?لان(?:ه|ها|هم|هن)?|بسبب|نتيج[هت] (?:عن|ل)|(?:يرجع|يعود|تعزي|يعزي) (?:ذلك |هذا )?الي)(?![\p{L}\p{N}])/u;
const CAUSE_OF = /\b(?:one of the )?(?:causes?|reasons?) (?:of|for|behind)\b|(?<!\p{L})[ول]?(?:ال)?(?:اسباب|سبب)(?!\p{L})/gu;
const EFFECT_FOLLOWS = /\b(?:led to|leads to|causes?|caused|results? in|resulted in)\b|(?<!\p{L})(?:[وف]?(?:ادي|ادت|يؤدي|تؤدي) الي|[وف]?تسبب(?:ت)? (?:في|ب(?=\p{L})))/u;
const COMPARE_DIRECTION = new RegExp(`(?:\\b(?:${EN_COMPARATIVE}) than\\b|(?<!\\p{L})(?:${AR_COMPARATIVE})(?: [^ ]+)? من(?!\\p{L})|(?<!\\p{L})[وف]?(?:تزيد|يزيد|تقل|يقل)(?: [^ ]+)? عن(?!\\p{L}))`, 'u');
const COMPARE_CONTRAST = /\b(?:whereas|while|unlike|versus|in contrast|compared (?:to|with)|differs? from)\b|(?<!\p{L})(?:بينما|بخلاف|علي عكس|تختلف عن|يختلف عن|مقارنه ب)(?!\p{L})/u;
const COMPARE_ORDER = /\b(?:second|third|fourth)[ -](?:largest|smallest|highest|longest|oldest|most populous)\b.{0,65}\bafter\b/u;
const SETTING_COMPARE = /\b(?:in (?:terms of|respect of)|for)\b|(?<!\p{L})من حيث(?!\p{L})/u;
const SITE_SUFFIX = /\s+[-–—|]\s+(?:wikipedia|ويكيبيديا|britannica|bbc news(?: عربي)?|الجزيره نت|nhs)$/u;
const ALIGNED_PREFIX = /^(?:history of|biography of|demographics of|تاريخ|سيره|سكان)\s+/u;
const PRONOUN_EN = /^(?:(?:and|but) )?(?:he|she|it|they|his|her|its|their)(?=\s|$)/u;
const PRONOUN_AR = /^(?:[وف])?(?:هو|هي|هما|هم|هن|هذه|هذا|ذلك)(?=\s|$)/u;
const NAME_OR_TITLE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s'’-]*$/u;
const RELATION_OWNER = new Set(['age', 'population', 'capital', 'area', 'height', 'length', 'size', 'speed', 'weight', 'distance', 'currency', 'language', 'leadership', 'count', 'born', 'die', 'independence', 'fall', 'start', 'end', 'location', 'work']);
const MAKER_RELATIONS = new Set(['invent', 'write', 'found']);
const REPORTING = /\b(?:said|reported|explained|states?|claims?|claimed|announced) (?:that |why )?|(?<!\p{L})(?:قال|قالت|اكد|اكدت|ذكر|ذكرت|افاد|افادت) (?:ان )?/u;
const PAST_AGE = /\b(?:at (?:the )?age (?:of )?|was aged |at \d+ years old|as a \d+ year old)|(?<!\p{L})(?:عندما كان عمره|كان يبلغ|في سن|عن عمر|بعمر)(?=\s|$)/u;
const UNATTAINED_INDEPENDENCE = /\b(?:for|toward|towards|seeks?|sought|demanded|demanding|called for|advocated|rallied for|referendum on)(?: (?:the|its))? (?:national )?independence\b|(?<!\p{L})[وف]?(?:يهتف\p{L}*|يطالب\p{L}*|يدعو\p{L}*|مطالب[هت]|دعوه|مطلب|احتجاج\p{L}*|استفتاء)(?=\s).{0,33}(?:الاستقلال|استقلال)/u;
const FIGURATIVE_FALL = /\b(?:fall|falls|fell|fallen) (?:into|under|over)\b/u;
const TEMPORAL_MENTION = /(?:^|\s)(?:after|before|during|since|بعد|قبل|خلال|عقب|منذ)(?=\s)/gu;
const ARABIC_INDIRECT_OBJECT = /(?<!\p{L})(?:جهاز\p{L}*|اداه|ادوات|معدات|خاص\p{L}*|يسمي|يدعي|تسمي|سمي|اسماه)(?!\p{L})/u;
const MAKER_MODIFIERS = /^(?:(?:the|an?|first|practical|working|modern|electric|commercial|original)\s+)+/u;

function nameWords(text: string): string[] {
  return (clean(text).match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [])
    .filter(word => word !== 'the').map(word => ARABIC.test(word) ? arabicBase(word) : word.replace(/'s$/u, ''));
}

function nameStarts(text: string, subject: string): boolean {
  const actual = nameWords(text.replace(/^\s*(?:the|an?)\s+/u, '')), wanted = nameWords(subject);
  return wanted.length > 0 && wanted.every((word, index) => nameWordMatches(actual[index], word));
}

function nameWordMatches(actual: string | undefined, wanted: string): boolean {
  return actual === wanted || !!actual && ARABIC.test(wanted) && wanted.length >= 3 && /^[وفبل]/u.test(actual) && arabicBase(actual.slice(1)) === wanted;
}

function names(text: string, subject: string): boolean {
  const actual = nameWords(text), wanted = nameWords(subject);
  return wanted.length > 0 && actual.some((_, start) => wanted.every((word, index) => nameWordMatches(actual[start + index], word)));
}

function alignedTitle(title: string, subject: string, person = false): string {
  const surface = title.replace(/\s+[-–—|]\s+(?:Wikipedia|ويكيبيديا|Britannica|BBC News(?: عربي)?|الجزيرة نت|NHS)$/iu, '').trim();
  if (!NAME_OR_TITLE.test(surface)) return '';
  const bare = clean(surface).replace(SITE_SUFFIX, '').replace(ALIGNED_PREFIX, '');
  const actual = nameWords(bare), wanted = nameWords(subject);
  if (actual.length === wanted.length && names(bare, subject)) return bare;
  // A surname may name a biography whose title uses the person's full name.
  const personalTitle = person && (/^(?:\p{Lu}\p{L}{1,}\s+){1,3}\p{Lu}\p{L}{1,}$/u.test(surface) || /^(?:\p{Script=Arabic}{3,}\s+){1,2}\p{Script=Arabic}{3,}$/u.test(surface));
  if (wanted.length === 1 && actual.length > 1 && personalTitle && actual.at(-1) === wanted[0]) return bare;
  return '';
}

function agreement(value: EntityAgreement['agreement'], reason: string): EntityAgreement {
  return { agreement: value, reason };
}

function comparisonAgreement(query: EntityQuery, evidence: EntityEvidence): EntityAgreement {
  const quote = clean(evidence.text);
  if (query.subjects.length !== 2) return agreement('conflict', 'comparison needs both named subjects');
  const [left, right] = query.subjects as readonly [string, string];
  // A directional comparison has its own two participants. A third name in a later clause cannot complete it.
  const ordered = COMPARE_ORDER.exec(quote);
  const direction = COMPARE_DIRECTION.exec(quote) ?? ordered;
  const contrast = COMPARE_CONTRAST.exec(quote);
  const connector = direction ?? contrast;
  if (!connector) return agreement('conflict', 'comparison needs an explicit relation');
  const before = quote.slice(0, connector.index);
  const after = quote.slice(connector.index + connector[0].length).trim();
  const secondParticipant = direction ? nameStarts : names;
  const objectAttribute = query.relation ? findRelation(after, query.language, query.relation) : undefined;
  const target = objectAttribute?.index === 0 ? trimSubject(after.slice(objectAttribute.text.length)) : after;
  const subject = (name: string) => names(before, name) || !!alignedTitle(evidence.pageTitle, name)
    && /(?<!\p{L})(?:مساحتها|مساحته|طولها|طوله|ارتفاعها|ارتفاعه|وزنها|وزنه|حجمها|حجمه)(?!\p{L})|\b(?:its|their)\b/u.test(`${before} ${connector[0]}`);
  if (!(subject(left) && secondParticipant(target, right) || subject(right) && secondParticipant(target, left))) {
    return agreement('conflict', 'comparison relation has different participants');
  }
  const context = SETTING_COMPARE.test(quote) ? quote : `${evidence.heading ?? ''} ${quote}`;
  const areaRank = query.relation === 'area' && ordered && /\b(?:largest|smallest)\b.{0,40}\b(?:country|continent|island|ocean|lake)\b/u.test(ordered[0]);
  if (query.relation && !areaRank && !findRelation(clean(context), query.language, query.relation) && !names(context, query.relation)) {
    return agreement('conflict', 'comparison needs the requested attribute');
  }
  return agreement('match', 'explicit comparison of both subjects');
}

function makerAttribution(text: string, query: EntityQuery, subject: string): boolean {
  const work = query.relation === 'write' ? WRITTEN_WORK_CREDIT.exec(text)?.groups?.work : undefined;
  if (work) return nameWords(work).length === nameWords(subject).length && nameStarts(work, subject);
  const relation = findRelation(text, query.language, query.relation);
  if (!relation) {
    if (query.relation === 'invent' && /\bpatent (?:for|on) /u.test(text)) {
      return nameStarts(text.split(/\bpatent (?:for|on) /u)[1]!.replace(/^(?:the |an? )?(?:electric |practical |modern )?/u, ''), subject);
    }
    return query.relation === 'write' && nameStarts(text, subject)
      && /\b(?:novel|play|book|poem|tragedy|comedy|story)\b[^.]{0,40}?\bby\b/u.test(text);
  }
  const before = text.slice(0, relation.index).trim();
  const after = text.slice(relation.index + relation.text.length).trim();
  const object = after.replace(/^(?:of|for|to|ل)\s+/u, '').replace(MAKER_MODIFIERS, '');
  if (nameStarts(object, subject)) return true;
  const afterWords = nameWords(after), subjectWords = nameWords(subject);
  if (query.language === 'ar' && !before && !ARABIC_INDIRECT_OBJECT.test(after) && afterWords.length > subjectWords.length
      && afterWords.length <= subjectWords.length + 4 && subjectWords.every((word, index) => nameWordMatches(afterWords[afterWords.length - subjectWords.length + index], word))) return true;
  if (!nameStarts(before.replace(MAKER_MODIFIERS, ''), subject)) return false;
  const prefixWords = nameWords(before).length;
  return query.language === 'ar' || prefixWords === nameWords(subject).length || /\b(?:is|was|were|been|being|got)(?: briefly| originally| first)?$/u.test(before);
}

function effectClause(text: string, query: EntityQuery): string {
  const marker = CAUSE.exec(clean(text));
  if (!query.reason) return text;
  if (!marker) {
    const following = EFFECT_FOLLOWS.exec(clean(text));
    return following ? clean(text).slice(following.index + following[0].length).trim() : text;
  }
  const clauses = text.split(/[,،;؛]/u);
  if (marker.index === 0) return clauses.length > 1 ? clauses.slice(1).join(' ') : '';
  return clean(text).slice(0, marker.index).trim();
}

function directCauseAttribution(text: string, subject: string): boolean {
  const quote = clean(text);
  return [...quote.matchAll(CAUSE_OF)].some(marker => {
    const effect = quote.slice(marker.index + marker[0].length).trim().split(' ').slice(0, 8).join(' ');
    return names(effect, subject);
  });
}

function wrongFamilyOwner(text: string, query: EntityQuery): boolean {
  const arabic = query.language === 'ar';
  const pattern = arabic ? SPECIFIED_OWNER_AR : SPECIFIED_OWNER_EN;
  const relation = findRelation(text, query.language, query.relation);
  const before = relation ? text.slice(0, relation.index + relation.text.length) : text;
  if (pattern.test(before)) return true;
  // In an attribute-first construction, the owner may follow the attribute.
  if (!relation) return false;
  const after = text.slice(relation.index + relation.text.length).trim();
  return (arabic ? SPECIFIED_OWNER_AR : FAMILY_AFTER_EN).test(after)
    || !arabic && /^of /u.test(after) && SPECIFIED_OWNER_EN.test(after);
}

function subjectScope(text: string, query: EntityQuery): string {
  // Parenthetical attributes such as “(born …)” are often the lead's only answer-bearing predicate.
  const qualified = text.replace(/\(([^)]*)\)/gu, (_, aside: string) => query.relation && findRelation(clean(aside), query.language, query.relation) ? ` ${aside} ` : ' ');
  const effect = clean(effectClause(qualified, query));
  const report = REPORTING.exec(effect);
  return report && (query.reason || RELATION_OWNER.has(query.relation)) ? effect.slice(report.index + report[0].length) : effect;
}

function otherAntecedent(previous: string | undefined, query: EntityQuery, title: string, subject: string): boolean {
  if (!previous) return false;
  if (wrongFamilyOwner(clean(previous), query)) return true;
  const properName = /^[\p{Lu}][\p{L}]+(?:\s+[\p{Lu}][\p{L}]+){1,3}/u.exec(previous)?.[0];
  if (properName && !/^(?:In|After|Before|During|From|Between|At|By|On)\b/u.test(properName)) return !names(properName, subject) && !names(properName, title);
  const prior = clean(previous);
  if (nameStarts(prior, title) || nameStarts(prior, subject) || (query.language === 'ar' ? PRONOUN_AR : PRONOUN_EN).test(prior)) return false;
  return true;
}

export function entityAgreement(query: EntityQuery, evidence: EntityEvidence): EntityAgreement {
  if (query.fact) return searchFactValue(query.fact, evidence.text)
    ? agreement('match', 'assertion names the requested owner')
    : agreement('conflict', 'requested owner or attribute is not asserted');
  if (query.comparison) return comparisonAgreement(query, evidence);
  const subject = query.subjects[0];
  if (!subject) return agreement('unknown', 'question has no named subject');
  const text = subjectScope(evidence.text, query);
  const arabic = query.language === 'ar';
  const title = alignedTitle(evidence.pageTitle, subject, ['age', 'born', 'die'].includes(query.relation));
  const asksAboutRelative = (arabic ? SPECIFIED_OWNER_AR : SPECIFIED_OWNER_EN).test(subject);
  if (RELATION_OWNER.has(query.relation) && !asksAboutRelative && wrongFamilyOwner(text, query)) return agreement('conflict', 'attribute is assigned to a relative');
  if (query.currentAge && PAST_AGE.test(text)) return agreement('conflict', 'age describes a past milestone');
  if (query.relation === 'independence' && UNATTAINED_INDEPENDENCE.test(text)) return agreement('conflict', 'sentence describes seeking independence');
  if (query.relation === 'fall' && FIGURATIVE_FALL.test(text)) return agreement('conflict', 'sentence describes a figurative fall');
  if (query.setting?.length) {
    if (stemOverlap(query.setting, selectionTerms(evidence.text)) !== 1) return agreement('conflict', 'causal setting differs from the question');
  } else if (query.question && !reasonScopeMatches(query.question, effectClause(evidence.text, query))) {
    return agreement('conflict', 'effect is limited to a specific setting');
  }
  if (query.effect?.length && stemOverlap(query.effect, selectionTerms(text)) < (query.effect.length <= 2 ? 1 : 0.75)) {
    return agreement('conflict', 'causal effect differs from the question');
  }
  const relation = query.relation ? findRelation(text, query.language, query.relation) : undefined;
  if (MAKER_RELATIONS.has(query.relation)) {
    return makerAttribution(text, query, subject) || evidence.kind === 'table' && !!title && relation?.index === 0
      ? agreement('match', 'maker relation directly names the requested work')
      : agreement('conflict', 'maker relation leaves the requested work unproven');
  }
  const headingRelation = evidence.heading && query.relation ? findRelation(clean(evidence.heading), query.language, query.relation) : undefined;
  if (RELATION_OWNER.has(query.relation) && !relation && !(headingRelation && (evidence.kind === 'table' || evidence.kind === 'list'))) {
    return agreement('conflict', 'requested attribute is absent');
  }
  const before = relation ? text.slice(0, relation.index).trim() : '';
  let after = relation ? text.slice(relation.index + relation.text.length).trim() : '';
  if (query.relation === 'capital' && relation && CAPITAL_CITY_COPULA.test(text.slice(0, relation.index))) {
    after = after.replace(CAPITAL_CITY_COORDINATION, '');
  }
  const explicitOwner = /^(?:of|for)\s+(?!\p{N})/u.test(after) || arabic && query.relation === 'capital' && !/ت(?:ه|ها)$/u.test(relation?.text ?? '');
  if (explicitOwner && relation && evidence.kind !== 'table' && !nameStarts(trimSubject(after), subject) && !nameStarts(before, subject)) {
    return agreement('conflict', 'attribute has a different explicit owner');
  }
  const first = text.replace(/^(?:according to [^,]+,|(?:and|but|today) |(?:[وف])(?=\p{Script=Arabic}))/u, '').trim();
  if (nameStarts(first, subject) || !!title && nameStarts(first, title)) return agreement('match', 'sentence opens with the requested subject');
  if (query.definition) return agreement('unknown', 'definition has no matching subject');
  if (relation && (nameStarts(trimSubject(after), subject) || !!title && nameStarts(trimSubject(after), title))) {
    return agreement('match', 'requested subject is bound to the attribute');
  }
  const incidental = [...text.matchAll(TEMPORAL_MENTION)].some(marker => nameStarts(text.slice(marker.index + marker[0].length), subject));
  const reasonNamed = query.reason && (names(text, subject) || stemOverlap(selectionTerms(subject), selectionTerms(text)) === 1);
  if (query.reason && (reasonNamed && !incidental && !/\b(?:known as|called|mention(?:ed|s)?)\b/u.test(text) || directCauseAttribution(evidence.text, subject))) {
    return agreement('match', 'effect clause names the requested subject');
  }
  if (evidence.kind === 'table' && names(evidence.text.split(/[|\t]/u)[0]!, subject)) return agreement('match', 'table row names the requested subject');
  if (!title) return agreement('unknown', 'no reliable subject agreement');
  if ((arabic ? PRONOUN_AR : PRONOUN_EN).test(first)) {
    if (!otherAntecedent(evidence.previousText, query, title, subject)) return agreement('inferred', 'pronoun refers to the matching page title');
    return agreement('conflict', 'preceding sentence supplies a different antecedent');
  }
  if (arabic && relation?.index === 0 && !/^\p{L}+\s+(?:فقط|تلك|هذه|هذا)\s/u.test(first)) {
    const implied = /^(?:استقل(?:ت)?|تاسس(?:ت)?|توفي(?:ت)?|ولد(?:ت)?|سقط(?:ت)?|تقع|يقع|انتهت|انتهي|بدات|بدا)(?!\p{L})/u.test(first);
    const possessed = /(?:ه|ها)$/u.test(relation.text);
    if (implied && /^(?:في|عام|سنه|بتاريخ|يوم|\d)(?:\s|\p{N}|$)/u.test(after) || possessed && /^(?:هو|هي|كان|كانت|\d)(?:\s|\p{N}|$)/u.test(after)) {
      return agreement('inferred', 'Arabic predicate or possessive refers to the matching page title');
    }
  }
  if ((evidence.kind === 'table' || evidence.kind === 'list') && (relation?.index === 0 || evidence.kind === 'table' && query.relation === 'age' && !!relation || !!evidence.heading && names(evidence.heading, subject))) {
    return agreement('inferred', 'structured evidence is under the matching page subject');
  }
  return agreement('unknown', 'page title alone does not establish the sentence subject');
}
