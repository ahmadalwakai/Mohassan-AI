/**
 * Checks before an answer line is sent (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §7.4). Pure functions on text.
 *
 * The baseline run of 2026-11-22 (0-baseline.md §8.3) sent, with confidence: a byline («By Vicky Stein last updated…»)
 * as the first line about the speed of light, a disambiguation page's «قد يُقصد من «طوكيو» ما يلي» as the capital of
 * Japan, and «The novel is often cited as one of the great achievements…» for «who wrote…». Each check here names
 * one such failure. A line that fails is dropped before the reply is built; when nothing passes, the reply says so.
 */
export type AnswerLanguage = 'ar' | 'en' | 'mixed' | 'none';
export type AnswerProblem = 'meta_line' | 'ui_text' | 'language' | 'needs_number' | 'needs_name' | 'off_topic';
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
  '\\bmay refer to\\b', '\\bmay also refer to\\b', '\\bfor other uses\\b', '\\bthis article is about\\b', '\\bnot to be confused with\\b', '\\bsee also\\b.*\\(disambiguation\\)',
  '\\bfrom wikipedia, the free encyclopedia\\b', '\\bjump to (?:navigation|content|search)\\b',
  '^by [A-Z][\\w.-]+(?: [A-Z][\\w.-]+){0,3}\\b', '\\blast updated\\b', '\\bupdated (?:on )?\\d', '\\bpublished(?: on)?:? ', '\\bposted (?:on|by)\\b', '\\bmin(?:ute)?s? read\\b', 'آخر تحديث', 'تاريخ النشر', 'نُ?شر في \\d', 'بقلم ',
].join('|'), 'iu');
export function isMetaLine(line: string): boolean { return META_LINE.test(line.trim()); }

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
