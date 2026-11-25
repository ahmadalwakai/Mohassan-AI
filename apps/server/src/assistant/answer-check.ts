import { hasWrittenWorkPublicationHistory } from './selection/factual-claims.js';

/**
 * Checks before an answer line is sent (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §7.4). Pure functions on text.
 *
 * The baseline run of 2026-11-22 (0-baseline.md §8.3) sent, with confidence: a byline («By Vicky Stein last updated…»)
 * as the first line about the speed of light, a disambiguation page's «قد يُقصد من «طوكيو» ما يلي» as the capital of
 * Japan, and «The novel is often cited as one of the great achievements…» for «who wrote…». Each check here names
 * one such failure. A line that fails is dropped before the reply is built; when nothing passes, the reply says so.
 */
export type AnswerLanguage = 'ar' | 'en' | 'mixed' | 'none';
export type AnswerProblem = 'meta_line' | 'ui_text' | 'language' | 'needs_number' | 'needs_unit' | 'needs_aspect' | 'needs_name' | 'off_topic';
export interface AnswerLineCheck { ok: boolean; reasons: AnswerProblem[] }

/** The language most of a text's letters are in; a text with fewer than 15 letters has none to judge. */
export function textLanguage(text: string): AnswerLanguage {
  const plain = text.replace(/https?:\/\/\S+/gu, ' ');
  const arabic = (plain.match(/\p{Script=Arabic}/gu) ?? []).length, latin = (plain.match(/[A-Za-z]/gu) ?? []).length;
  const total = arabic + latin;
  if (total < 15) return 'none';
  const minority = Math.min(arabic, latin) / total;
  if (minority >= 0.4) return 'mixed';
  return arabic >= latin ? 'ar' : 'en';
}

/** Lines about the page rather than about the subject: disambiguation notes, hatnotes, bylines, headers and footers. */
const META_LINE = new RegExp([
  'قد يُ?قصد (?:من|ب)', 'يمكن أن يشير (?:إلى|الى)', 'قد يشير (?:إلى|الى)', 'هذه صفحة توضيح', 'توضيح\\)', 'هذه المقالة عن', 'لمقالة عن', 'للاستخدامات الأخرى',
  'من ويكيبيديا، الموسوعة الحرة', 'اذهب إلى التنقل', 'انتقل إلى',
  // A hatnote that points to other articles: «المقالات الرئيسة: أسباب الحرب العالمية الثانية و…» led the answer to «ما أسباب
  // الحرب العالمية الثانية؟» (live 2026-11-23).
  '^(?:المقال(?:ة|ه|ات) الرئيسي?[ةه]|مقال(?:ة|ه|ات) مفصل[ةه]|طالع [أا]يض[اًا]+|انظر [أا]يض[اًا]+)\\s*:', '^(?:main articles?|further information|see also)\\s*:',
  '\\bmay refer to\\b', '\\bmay also refer to\\b', '\\bfor other uses\\b', '\\bthis article is about\\b', '\\bnot to be confused with\\b', '\\bsee also\\b.*\\(disambiguation\\)',
  '\\bfrom wikipedia, the free encyclopedia\\b', '\\bjump to (?:navigation|content|search)\\b',
  '^by [A-Z][\\w.-]+(?: [A-Z][\\w.-]+){0,3}\\b', '\\blast updated\\b', '\\bupdated (?:on )?\\d', '\\bposted (?:on|by)\\b', '\\bmin(?:ute)?s? read\\b', 'آخر تحديث', 'تاريخ النشر', 'نُ?شر في \\d', 'بقلم ',
].join('|'), 'iu');
const PUBLICATION_NOTICE = /\bpublished(?: on)?:? /iu;
export function isMetaLine(line: string): boolean {
  const text = line.trim();
  return META_LINE.test(text) || PUBLICATION_NOTICE.test(text) && !hasWrittenWorkPublicationHistory(text);
}

/** Interface words a page shows around its text: never an answer. */
const UI_TEXT = /^(?:share(?: this)?|read more|subscribe|sign in|log in|accept(?: all)?|cookies?|menu|search|اشترك|شارك|اقرأ المزيد|تسجيل الدخول|القائمة|بحث|موافق)\b/iu;
export function isUiText(line: string): boolean { return UI_TEXT.test(line.trim()) && line.trim().split(/\s+/u).length <= 6; }

const DISAMBIGUATION_TITLE = /\((?:توضيح|disambiguation)\)/iu;
const DISAMBIGUATION_TEXT = /قد يُ?قصد (?:من|ب)|هذه صفحة توضيح|\bmay refer to\b|\bmay also refer to\b|\bdisambiguation page\b/iu;
export function isDisambiguationTitle(title: string): boolean { return DISAMBIGUATION_TITLE.test(title); }
/** A disambiguation page lists subjects and answers none: its title says so, or its opening does. */
export function isDisambiguationPage(page: { title: string; text: string }): boolean {
  return isDisambiguationTitle(page.title) || DISAMBIGUATION_TEXT.test(page.text.slice(0, 1200));
}

const NUMBER_QUESTION = /(?:^|\s)(?:كم|قديش|اديش|متى|متي)(?=\s|$)|\bhow (?:many|much|long|old|far|tall|big)\b|\bwhen\b|\bwhat year\b|في أي (?:عام|سنة)/iu;

/**
 * What kind of figure the question wants (plan §7.2: «كم» is answered by a number with its unit). A duration question
 * wants minutes or hours, a date question a year or a month, a price a currency. On 2026-11-22 «كم تستغرق عملية المياه
 * البيضاء» was answered with «فيلم دراما نيجيري صدر سنة 2007»: a number, but not a duration.
 */
export type FigureKind = 'duration' | 'date' | 'price' | 'people' | 'any';
const DURATION_QUESTION = /تستغرق|يستغرق|(?:^|\s)مد[ةه](?=\s|$)|كم (?:من )?(?:الوقت|وقت)|how long|how many (?:minutes|hours|days|weeks|months|years)/iu;
const DATE_QUESTION = /(?:^|\s)(?:متى|متي)(?=\s|$)|\bwhen\b|\bwhat year\b|في أي (?:عام|سنة)/iu;
const PRICE_QUESTION = /(?:^|\s)(?:ال)?(?:سعر|أسعار|اسعار|تكلفة|تكلفه|كلفة)(?=\s|$)|كم (?:يكلف|تكلف|ثمن)|how much (?:does|do|is|are|did|will|would)\b.*\b(?:cost|pay)|\bprice|\bcost/iu;
/**
 * A population question wants a count of people, not a share of them. Live on 2026-11-22 (artifacts/plan-2026-11-22/1-hands-http.md
 * §5.2): «كم عدد سكان اليابان» ranked «تحتل المناطق الجبلية ما يزيد عن 70% من أرض اليابان…» first, and «كم عدد سكان فرنسا»
 * ranked «حوالي 65% من سكان فرنسا» (Catholics) first; both passed, since any number did.
 */
const PEOPLE_QUESTION = /(?:^|\s)(?:ال)?سكان(?:ها|ه|هم)?(?=[\s؟?،,.]|$)|كم\s+نسم[ةه]|\bpopulation\b|how many (?:people|inhabitants|residents|persons)/iu;
export function figureKind(question: string): FigureKind {
  if (DURATION_QUESTION.test(question)) return 'duration';
  if (DATE_QUESTION.test(question)) return 'date';
  if (PRICE_QUESTION.test(question)) return 'price';
  if (PEOPLE_QUESTION.test(question)) return 'people';
  return 'any';
}
const DIGIT = '[\\d٠-٩]';
const FIGURE_UNITS: Record<Exclude<FigureKind, 'any'>, RegExp> = {
  duration: new RegExp(`${DIGIT}+(?:[.,]${DIGIT}+)?\\s*(?:ثانية|ثوان|دقيقة|دقائق|دقيقه|ساعة|ساعات|ساعه|يوم|أيام|ايام|أسبوع|اسبوع|أسابيع|اسابيع|شهر|أشهر|اشهر|شهور|سنة|سنه|سنوات|عام|أعوام|اعوام|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)(?![\\p{L}])`, 'iu'),
  date: new RegExp(`(?:^|[^\\d٠-٩])(?:1[0-9]|20)${DIGIT}{2}(?![\\d٠-٩])|(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|كانون|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين|january|february|march|april|may|june|july|august|september|october|november|december)`, 'iu'),
  price: /[$€£¥₺]|(?:^|\s)(?:دولار|دولارات|يورو|جنيه|جنيهات|ريال|ريالات|درهم|دراهم|دينار|دنانير|ليرة|ليرات|USD|EUR|GBP|SAR|AED|EGP|TRY|dollars?|euros?|pounds?|cents?|riyals?|dirhams?|dinars?)(?![\p{L}])/iu,
  // «123 مليون نسمة», «68,605,616 نسمة», «10,577 people».
  people: new RegExp(`${DIGIT}+(?:[.,،٬]${DIGIT}+)*\\s*(?:ألف|الف|آلاف|الاف|مليون|ملايين|مليار|thousand|million|billion)?\\s*(?:نسمة|نسمه|نسمات|شخص|أشخاص|اشخاص|مواطن|مواطنا|مواطنين|ساكن|people|persons|inhabitants|residents)(?![\\p{L}])`, 'iu'),
};
const PEOPLE_WORD = /سكان|population|inhabitants|residents/giu;
const NUMBER_TOKEN = /[\d٠-٩]+(?:[.,،٬][\d٠-٩]+)*/gu;
/** A line that states a population, not only a number of some people: «10,033,480 نسمة يعملون» counts a workforce. */
const POPULATION_STATEMENT = /سكان|تعداد|population|populous|populated|inhabitants|residents|\bliv(?:e|es|ed|ing)\b|يعيش|تعيش|يسكن|يقطن/iu;
/** A density measures land, not people: «2.8 نسمة لكل كيلومتر مربع», "337 people per km²". */
const PER_AREA = /^\s*(?:\/|لكل|في كل|للكيلومتر|في الكيلومتر|per\b)/iu;
/** A magnitude or a unit of people right after a number. */
const COUNT_WORD = /^\s*(?:ألف|الف|آلاف|الاف|مليون|ملايين|مليار|thousand|million|billion|نسمة|نسمه|نسمات|شخص|أشخاص|اشخاص|مواطن|مواطنا|مواطنين|ساكن|people|persons|inhabitants|residents)(?![\p{L}])/iu;
/** Where a clause ends. A comma or a dot inside a number («68,605,616», «68.6») ends nothing. */
const CLAUSE_END = /[،,؛;](?![\d٠-٩])|\.(?![\d٠-٩])/u;
/**
 * A count in the population word's own clause, after the word («عدد سكانها 125,416,877», "a population of 123 million"): not a
 * share («70%», «65 في المئة»), not a bare year («تعداد 1999»), not a density, and large or carrying its unit. Until
 * 2026-11-22 any number anywhere in a line that held the word passed, so «عدد سكان أستراليا يبلغ 0.3% فقط من سكان العالم، …
 * واحدة من أفضل 10 مساهمين» counted as a population through its «10» and led the answer to «كم عدد سكان أستراليا؟»
 * (artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe.json); «18 لغة لسكان أستراليا» and «في الساعة 00:00» passed too.
 */
function countOfPeople(text: string): boolean {
  for (const word of text.matchAll(PEOPLE_WORD)) {
    const rest = text.slice(word.index! + word[0].length);
    const end = rest.search(CLAUSE_END);
    const clause = (end < 0 ? rest : rest.slice(0, end)).slice(0, 90);
    for (const found of clause.matchAll(NUMBER_TOKEN)) {
      const after = clause.slice(found.index! + found[0].length);
      if (/^\s*(?:%|٪|في\s*الم[ئا]ئ[ةه]|بالم[ئا]ئ[ةه]|percent)/iu.test(after)) continue;
      const digits = found[0].replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));
      if (/^\d{4}$/u.test(digits) && Number(digits) >= 1000 && Number(digits) <= 2099) continue;
      const unit = COUNT_WORD.exec(after);
      if (unit && PER_AREA.test(after.slice(unit[0].length))) continue;
      if (otherPeople(text, word.index! + word[0].length + found.index!)) continue;
      if (unit || digits.replace(/[^\d]/gu, '').length >= 5) return true;
    }
  }
  return false;
}
/** «82 مدينة يزيد عدد سكانها عن 100,000 نسمة»: the people are those of the counted towns, not of the page's subject. */
const COUNTED_PLACES = /[\d٠-٩]+\s+(?:مدينة|مدينه|مدن|قرية|قريه|قرى|بلدة|بلده|ولاية|ولايه|ولايات|مقاطعة|مقاطعه|مقاطعات|محافظة|محافظه|محافظات|دولة|دوله|دول|بلد|بلدان|منطقة|منطقه|مناطق|جزيرة|جزيره|جزر|cities|towns|villages|states|provinces|countries|regions|municipalities|districts|islands)(?![\p{L}])/iu;
/**
 * A clause about a change: «ازداد تعداد سكان كندا بين 1990-2008 بنحو 5.6 مليون», «نما تعداد سكان العالم … بنسبة 27% أي 1,423
 * مليون», "grew by 5.6 million". Its count is how much the population changed, unless the clause says what it reached:
 * «ارتفع عدد السكان إلى 105 ملايين», "rose to 105 million".
 */
const CHANGE_VERB = /(?<![\p{L}])(?:ازداد|ازدادت|زاد|زادت|ارتفع|ارتفعت|انخفض|انخفضت|تراجع|تراجعت|نما|نمت|تزايد|تناقص|تضاعف|increased?|increases|grew|grown|rose|risen|declined?|decreased?|fell|fallen|dropped|doubled)(?![\p{L}])/iu;
const REACHED = /\s(?:الى|إلى|ليصل الى|ليصل إلى|ليبلغ|عن|على|to|reaching|reach(?:ed|es)?)\s+(?:(?:نحو|حوالي|قرابة|اكثر من|أكثر من|about|around|nearly|almost|over|some|roughly|more than)\s+)?$/iu;
/**
 * True when the number at `index` counts someone else's people: those of a counted class of places, or the size of a
 * change. Both passed as the population of the page's subject on 2026-11-22 (wiring-probe-after-1.json: Germany, Canada).
 */
function otherPeople(text: string, index: number): boolean {
  const head = text.slice(0, index);
  const cut = [...head.matchAll(new RegExp(CLAUSE_END.source, 'gu'))].at(-1);
  const lead = cut ? head.slice(cut.index! + cut[0].length) : head;
  return COUNTED_PLACES.test(lead) || CHANGE_VERB.test(lead) && !REACHED.test(lead);
}
/** True when a line carries the kind of figure the question wants; a question of kind «any» needs only a number. */
export function hasFigureOf(kind: FigureKind, line: string): boolean {
  if (kind === 'any') return true;
  if (kind !== 'people') return FIGURE_UNITS[kind].test(line);
  // Wikipedia leads carry vowel marks: «قُدِّر عدد سكانها بأكثرَ من 120 مليون نسَمة». Marks and tatweel only: the range
  // U+064B–U+0670 written as one span would also take the digits ٠–٩ and the percent sign ٪.
  const text = line.replace(/[ً-ٰٟـ]/gu, '');
  // «123 مليون نسمة» with its unit is a population only in a line that speaks of one, and never as a density.
  const withUnit = POPULATION_STATEMENT.test(text) && [...text.matchAll(new RegExp(FIGURE_UNITS.people.source, 'giu'))]
    .some(found => !PER_AREA.test(text.slice(found.index! + found[0].length)) && !otherPeople(text, found.index!));
  return withUnit || countOfPeople(text);
}

/**
 * The aspect a question asks of its subject (plan §7.4, type match): a symptoms answer names symptoms, a benefits answer
 * benefits. On 2026-11-22 «ما أعراض المياه البيضاء في العين» was answered with «مياه بيضاء… هو فيلم دراما نيجيري»: the
 * film's title is the subject's words, and nothing in the line is a symptom.
 */
export type AspectKind = 'benefits' | 'symptoms' | 'causes' | 'treatment' | 'risks' | 'types' | 'stages';
const ASPECT_ASKED: [AspectKind, RegExp][] = [
  ['benefits', /(?:^|\s)فوائد(?=\s|$)|\bbenefits? of\b/iu],
  ['symptoms', /(?:^|\s)(?:أعراض|اعراض|علامات)(?=\s|$)|\b(?:symptoms|signs) of\b/iu],
  ['causes', /(?:^|\s)(?:أسباب|اسباب)(?=\s|$)|\bcauses of\b/iu],
  ['treatment', /(?:^|\s)علاج(?=\s|$)|\btreatment (?:of|for)\b/iu],
  ['risks', /(?:^|\s)(?:أضرار|اضرار|مخاطر)(?=\s|$)|\b(?:risks|dangers|harms) of\b/iu],
  ['types', /(?:^|\s)(?:أنواع|انواع)(?=\s|$)|\btypes of\b/iu],
  ['stages', /(?:^|\s)مراحل(?=\s|$)|\bstages of\b/iu],
];
/**
 * A question that asks for a reason: «لماذا تهاجر الطيور؟», «ليش…», «ما سبب زرقة السماء؟», "Why is the sky blue?". Its answer
 * is a sentence that states a cause. Live on 2026-11-23 (artifacts/agent-gaps-2026-11-22/after-cycle-fixes/why-probe-after.json)
 * such questions were answered by whatever sentence shared their words: the film «السماء الزرقاء» for «ليش السماء زرقاء؟»,
 * «Color "Sky Blue" redirects here» for "Why is the sky blue?", «مقياس الزرقة» for «ما سبب زرقة السماء؟».
 */
const REASON_QUESTION = /^(?:و|ف)?(?:لماذا|ليش|ليه)\s+\S|^(?:ما|ماهو|ما هو|ما هي|وش|شو|ايش)\s+(?:ال)?(?:سبب|أسباب|اسباب)(?=\s|$)|^why\b|^what (?:is|are|was|were) the (?:reasons?|causes?)\b|^what cause[sd]?\b/iu;
export const isReasonQuestion = (question: string): boolean => REASON_QUESTION.test(question.trim());
/**
 * How a sentence states a cause, beyond the word «سبب» itself: «لأنه», «لأن الضوء», «نتيجةً لـ», «يعود ذلك إلى», «نسبةً إلى»,
 * "because". «لأن» before a verb is «to», not «because» («تميل البروق الموجبة لأن تتشكّل…», shown for a why-question on 2026-11-23).
 */
const REASON_LINE = /(?:^|[\s،(])(?:و|ف)?ل[أإا]ن(?:ه|ها|هم|هما|نا|ك)(?=[\s،.]|$)|(?:^|[\s،(])(?:و|ف)?ل[أإا]ن\s+ال|نتيج[ةه]ً?\s+(?:ل|عن)|كنتيج[ةه]|(?:يعود|تعود|يرجع|ترجع|يعزى|يُعزى|تعزى)\s+(?:(?:ذلك|هذا|السبب)\s+)?(?:[إا]لى|الي)|(?:^|\s)نسب[ةه]ً?\s+(?:[إا]لى|الي|ل)|\bbecause\b|\bcaused by\b|\bas a result of\b|\bresult(?:s|ing|ed)? from\b|\bowing to\b|\breasons?\b|\bis why\b/iu;
const ASPECT_LINE: Record<AspectKind, RegExp> = {
  benefits: /فوائد|فائد|مفيد|يفيد|تفيد|منافع|benefit|beneficial/iu,
  symptoms: /أعراض|اعراض|عوارض|علامات|يعاني|يشعر|تشوش|ضبابي|symptom|signs?\b/iu,
  causes: new RegExp(`أسباب|اسباب|سبب|يسبب|تسبب|ينتج عن|ناتج عن|يحدث نتيجة|cause|due to|results? from|${REASON_LINE.source}`, 'iu'),
  treatment: /علاج|يعالج|تعالج|معالجة|دواء|أدوية|ادوية|جراح|treat|therap|medication|surgery/iu,
  risks: /أضرار|اضرار|ضرر|مخاطر|خطر|أخطار|آثار جانبية|الآثار الجانبية|مضاعفات|risk|harm|side effect|danger/iu,
  types: /أنواع|انواع|نوع|أصناف|اصناف|ينقسم|تنقسم|types?\b|kinds?\b/iu,
  stages: /مراحل|مرحلة|stages?\b|phases?\b/iu,
};
export function aspectKind(question: string): AspectKind | null {
  // A reason is asked whatever else the question names: «لماذا تظهر أعراض الحساسية في الربيع؟» wants a cause, not a list of symptoms.
  if (isReasonQuestion(question)) return 'causes';
  return ASPECT_ASKED.find(([, pattern]) => pattern.test(question))?.[0] ?? null;
}
/** True when a sentence states a cause, by the same words the answer check of a reason question accepts. */
export const statesReason = (line: string): boolean => ASPECT_LINE.causes.test(line);
const NAME_QUESTION = /^(?:من هو|من هي|من الذي|من التي|من (?:اخترع|كتب|ألف|أسس|اكتشف|بنى|صمم|رسم|أنشأ)|who (?:is|was|were|wrote|invented|founded|discovered|built|designed|painted|created|directed|composed))\b/iu;
const ENGLISH_NAME = /(?:^|[\s(,:;])[A-Z][a-z]+(?:[\s-][A-Z][a-z]+)+/u;

/** The question's language: Arabic script anywhere makes it Arabic. */
export const questionLanguage = (question: string): 'ar' | 'en' => /\p{Script=Arabic}/u.test(question) ? 'ar' : 'en';

/** A quoted title, a bold name, a link or a host is not the line's own language: «من **Search — Python docs** (docs.python.org):» is Arabic. */
export function ownWords(line: string): string {
  return line.replace(/\*\*[^*]*\*\*/gu, ' ').replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, ' ').replace(/\[[^\]]*\]\([^)]*\)/gu, ' ').replace(/\([^)]*\)/gu, ' ').replace(/https?:\/\/\S+/gu, ' ');
}

/**
 * One line against one question. `topic` are the question's subject words (hands.topicWords), folded; when given,
 * a line sharing none of them is off topic.
 */
export function checkAnswerLine(question: string, line: string, options: { topic?: readonly string[]; fold?: (text: string) => string } = {}): AnswerLineCheck {
  const reasons: AnswerProblem[] = [];
  const text = line.trim();
  if (isMetaLine(text)) reasons.push('meta_line');
  if (isUiText(text)) reasons.push('ui_text');
  // Judge the line's own words; a quoted English title inside an Arabic frame stays Arabic. A quote alone (no frame) is judged as it is.
  const own = ownWords(text).trim(), asked = questionLanguage(question);
  let answered: AnswerLanguage = textLanguage(own || text);
  // A short frame («وصلت إلى …:») has too few letters to count; the script it is written in still names its language.
  if (answered === 'none' && own) { const arabic = /\p{Script=Arabic}/u.test(own), latin = /[A-Za-z]/u.test(own); answered = arabic && !latin ? 'ar' : latin && !arabic ? 'en' : 'none'; }
  if ((answered === 'ar' || answered === 'en') && answered !== asked) reasons.push('language');
  if (NUMBER_QUESTION.test(question) && !/[\d٠-٩]/u.test(text)) reasons.push('needs_number');
  else if (NUMBER_QUESTION.test(question) && !hasFigureOf(figureKind(question), text)) reasons.push('needs_unit');
  const aspect = aspectKind(question);
  if (aspect && !ASPECT_LINE[aspect].test(text)) reasons.push('needs_aspect');
  // Arabic has no capitals to spot a name by; the check applies to English answers only.
  if (NAME_QUESTION.test(question.trim()) && asked === 'en' && answered === 'en' && !ENGLISH_NAME.test(text)) reasons.push('needs_name');
  if (options.topic?.length) {
    const fold = options.fold ?? ((value: string) => value.toLowerCase());
    const folded = fold(text);
    if (!options.topic.some(word => folded.includes(word))) reasons.push('off_topic');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Keeps the lines that pass, in order; the first survivor becomes the answer line. Dropped lines are returned with their reasons. */
export function checkAnswerLines(question: string, lines: readonly string[], options: { topic?: readonly string[]; fold?: (text: string) => string } = {}): { lines: string[]; dropped: { line: string; reasons: AnswerProblem[] }[] } {
  const kept: string[] = [], dropped: { line: string; reasons: AnswerProblem[] }[] = [];
  for (const line of lines) {
    const check = checkAnswerLine(question, line, options);
    if (check.ok) kept.push(line); else dropped.push({ line, reasons: check.reasons });
  }
  return { lines: kept, dropped };
}
