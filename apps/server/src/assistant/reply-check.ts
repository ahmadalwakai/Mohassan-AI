/**
 * Pre-send reply check (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, Phase 4 «فحص قبل الإرسال», experiment E4.1).
 *
 * Deterministic rules over the reply text and the question; nothing here is a model and nothing here reads a page.
 * It names what the 2026-11-22 baseline saw in real replies (artifacts/plan-2026-11-22/0-baseline.md §8.3):
 *   language_mismatch  the reply's own words are not in the question's language (rq022, rq097)
 *   foreign_heading    the fixed Arabic headings of hands.ts describe() inside an English answer (rq010, rq028, rq036, rq064, rq090)
 *   byline_lead        the answer opens with the page's byline or dateline («By Vicky Stein last updated October 29, 2024…», rq010)
 *   site_chrome        sentences that belong to the site, not the answer (share buttons, newsletter, affiliate note, nav tokens)
 *   duplicate_line     the same sentence twice
 *   lead_without_answer  a «who» question whose first line names nobody
 * Shadow first: the findings are recorded and the mechanical fixes are proposed (applyReplyFixes), not sent, until the
 * owner has judged a sample. Thresholds below are proposed, not fixed by the owner.
 */
export type ReplyLanguage = 'ar' | 'en';
export type ReplyFindingCode = 'language_mismatch' | 'foreign_heading' | 'byline_lead' | 'site_chrome' | 'duplicate_line' | 'lead_without_answer';
export interface ReplyFinding {
  code: ReplyFindingCode;
  /** fix: a mechanical repair exists (applyReplyFixes); review: a person or a later phase decides. */
  severity: 'fix' | 'review';
  /** 1-based line of the reply, or 0 for the reply as a whole. */
  line: number;
  excerpt: string;
  detail: string;
}
export interface ReplyCheckInput { question: string; reply: string }
export interface ReplyCheck {
  /** The question's language: Arabic script anywhere makes it Arabic, as the rest of the assistant decides. */
  lang: ReplyLanguage;
  /** The language of the reply's own words after quotes, links, titles and fixed headings are set aside. */
  replyLang: ReplyLanguage | 'mixed' | 'none';
  /** Share of Arabic letters among the reply's own letters, 0..1, or null without letters. */
  arabicShare: number | null;
  findings: ReplyFinding[];
}

const ARABIC = /[؀-ۿ]/u;
export const questionLanguage = (text: string): ReplyLanguage => ARABIC.test(text) ? 'ar' : 'en';

/** The fixed headings and notes hands.ts writes in Arabic whatever the question's language, with their English form. */
const FIXED_HEADINGS: [RegExp, string][] = [
  [/\*\*تفاصيل أخرى من نفس المصدر:\*\*/gu, '**More from the same source:**'],
  [/\*\*المصدر:\*\*/gu, '**Source:**'],
  [/\*\*للمزيد:\*\*/gu, '**More:**'],
  [/\*\*الموضوع:\*\*/gu, '**Subject:**'],
  [/للتشخيص والعلاج راجع طبيبًا مختصًا\./gu, 'For diagnosis and treatment, see a qualified doctor.'],
  [/هذه المعلومات عامة ولا تغني عن استشارة طبيب مختص\./gu, 'This is general information and no substitute for a doctor.'],
];
/** Proposed thresholds (E4.1): an English question's own words with ≥ 50% Arabic letters, an Arabic question's with ≥ 80% Latin letters. */
const MISMATCH_ARABIC_IN_ENGLISH = 0.5;
const MISMATCH_LATIN_IN_ARABIC = 0.8;
const MIN_WORDS_FOR_LANGUAGE = 4;

/**
 * An English byline: the mark, then a name in capitals, two to four words («By Vicky Stein»), or one word alone or before a
 * separator («By Reuters», «By AFP | …»); a separator after the name goes with it. Case matters, so «By the end of 1900, …»,
 * «By default, …» and «By January 2025, …» are sentences (until 2026-11-22 the first reached the reader as «, the city had…»).
 */
const BYLINE = /^(?:[Bb][Yy]|[Ww]ritten by|[Rr]eported by|[Aa]uthor:|[Pp]osted by|[Ss]tory by)\s+(?:[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){1,3}\b|[A-Z][\w.'-]*(?=\s*(?:$|[|•·—–-])))(?:\s*[|•·—–-])?/u;
const DATELINE = /\b(?:last\s+)?updated:?\s+(?:on\s+)?[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}|\bpublished:?\s+(?:on\s+)?(?:[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4})|^\d{1,2}\s+[A-Z][a-z]{2,8}\s+\d{4}\b/u;
const ARABIC_DIGIT = '[0-9٠-٩]';
const ARABIC_MONTH = '(?:يناير|فبراير|مارس|أبريل|إبريل|ابريل|مايو|يونيو|يونيه|يوليو|يوليه|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر'
  + '|كانون الثاني|كانون الأول|كانون الاول|شباط|آذار|اذار|نيسان|أيار|ايار|حزيران|تموز|آب|أيلول|ايلول|تشرين الأول|تشرين الاول|تشرين الثاني)';
const ARABIC_WEEKDAY = '(?:الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت)';
/** A date as Arabic pages print it, with an optional weekday and time: «22 نوفمبر 2026», «الأحد، 22 نوفمبر/تشرين الثاني 2026 - 07:00 ص», «22/11/2026». */
const ARABIC_DATE = `(?:${ARABIC_WEEKDAY}\\s*[،,]?\\s*)?(?:${ARABIC_DIGIT}{1,2}\\s+${ARABIC_MONTH}(?:\\s*/\\s*${ARABIC_MONTH})?\\s*[،,]?\\s*${ARABIC_DIGIT}{4}`
  + `|${ARABIC_DIGIT}{1,4}[/.-]${ARABIC_DIGIT}{1,2}[/.-]${ARABIC_DIGIT}{1,4})`
  + `(?:\\s*[-–—|،,]?\\s*(?:الساعة\\s+)?${ARABIC_DIGIT}{1,2}:${ARABIC_DIGIT}{2}(?:\\s*(?:صباحًا|صباحا|مساءً|مساء|ص|م))?)?`;
/**
 * An Arabic byline or dateline mark at the start of the reply. Some marks also open sentences: the verbs «كتب», «كتبت», «كتبه»
 * open the assistant's own replies («كتبت «مرحبا» في …» in hands.ts; «كتبت 14 حرفًا في …» from the desktop, cut to «14 حرفًا…»
 * live on 2026-11-22) and page sentences («كتب نجيب محفوظ …»); «تحرير» opens «تحرير الكويت …»; «نُشر في» opens «نُشر في 24
 * نوفمبر 1859 كتاب …». So these count only before a colon or a dash («كتب: محمد علي», «تحرير - سارة أحمد», «نُشر في: …»),
 * and «نُشر في» also before a date that ends the line («نُشر في 22 نوفمبر 2026»). The match takes the mark with its colon or
 * dash, and «نُشر في» with its date, so the fix leaves no stray «- », «: » or date behind.
 */
const ARABIC_BYLINE = new RegExp('^(?:(?:بقلم|آخر تحديث|تاريخ النشر|المصدر الأصلي)[:\\s]'
  + '|(?:كتبه|كتبت|كتب|تحرير)\\s*[:–—-]\\s*'
  + `|نُ?شر في(?:\\s*[:–—-]\\s*(?:${ARABIC_DATE}\\s*)?|\\s+${ARABIC_DATE}\\s*$))`, 'u');
const CHROME_SENTENCE = new RegExp([
  'share this (?:article|story|page)', 'join the conversation', 'follow us', 'add us as a preferred source', 'subscribe to (?:our )?newsletter',
  'sign up (?:for|to) (?:our )?(?:newsletter|updates|emails?)', 'when you purchase through links on our site', 'affiliate commission', 'skip to (?:main )?content',
  'accept (?:all )?cookies', 'cookie (?:settings|policy|preferences)', '\\badvertisement\\b', 'all rights reserved', 'terms of (?:use|service)', 'privacy policy',
  'click here', 'read more:', 'related (?:articles|stories|topics)', 'test kitchen approved', 'nutrition facts:', '\\btotal time:', '\\bservings:', '\\breviews\\b',
  'اشترك في (?:النشرة|نشرتنا)', 'تابعنا على', 'شارك (?:هذا )?(?:المقال|الخبر|الصفحة)', 'انضم إلى (?:قائمتنا|نشرتنا)', 'جميع الحقوق محفوظة', 'سياسة الخصوصية',
  'ملفات تعريف الارتباط', 'تخط(?:َّ|ى|)\\s*إلى المحتوى', 'اقرأ أيضً?ا', 'مواضيع ذات صلة', 'إعلان مدفوع',
].join('|'), 'iu');
/** Navigation residue: a run of three or more ALL-CAPS tokens («FONT ALL SVG ALL PNG»). */
const NAV_TOKENS = /(?:\b[A-Z]{2,}\b[\s|·•/-]+){3,}/u;
const UPDATE_STAMP = /\bUpdated:\s*[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}/u;
const isChrome = (sentence: string) => CHROME_SENTENCE.test(sentence) || NAV_TOKENS.test(sentence) || UPDATE_STAMP.test(sentence);
/** A page sentence glued to site chrome keeps only its own words: segments of at least this many words between the site's phrases. */
const MIN_SEGMENT_WORDS = 6;
/** What a site-chrome sentence still says once the site's own phrases are cut out, or null when nothing of its own is left. */
function scrubChrome(sentence: string): string | null {
  const withoutNav = sentence.replace(new RegExp(NAV_TOKENS.source, 'gu'), ' ').replace(new RegExp(UPDATE_STAMP.source, 'gu'), ' ');
  const kept = withoutNav.split(new RegExp(CHROME_SENTENCE.source, 'giu'))
    .map(part => part.replace(/^[\s,;:·|•-]+|[\s,;:·|•-]+$/gu, '').trim())
    .filter(part => part.split(/\s+/u).filter(Boolean).length >= MIN_SEGMENT_WORDS);
  return kept.length ? kept.join(' ') : null;
}
const WHO_QUESTION = /^\s*(?:who\b|من\s+(?:هو|هي|كتب|ألّف|الف|مؤلف|اخترع|أسس|اسس|بنى|رسم|اكتشف))/iu;
const NAME_IN_LINE = /\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|de|van|von|al|bin|ibn))+\b/u;

/** The reply's own words: no blockquotes, links, bold titles, parenthesised hosts, code or fixed headings. */
export function ownWords(reply: string): string {
  return reply.split('\n').filter(line => !/^\s*>/u.test(line)).join('\n')
    .replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\n]*`/gu, ' ')
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/gu, ' ').replace(/https?:\/\/\S+/gu, ' ')
    .replace(FIXED_HEADINGS.reduce((pattern, [heading]) => pattern ? new RegExp(`${pattern.source}|${heading.source}`, 'gu') : new RegExp(heading.source, 'gu'), null as RegExp | null) ?? /$^/u, ' ')
    .replace(/\*\*[^*\n]+\*\*/gu, ' ').replace(/\([a-z0-9.-]+\.[a-z]{2,}\)/giu, ' ');
}

function letters(text: string): { arabic: number; latin: number } {
  return { arabic: (text.match(/[؀-ۿ]/gu) ?? []).length, latin: (text.match(/[A-Za-z]/gu) ?? []).length };
}

export function replyLanguage(reply: string): { replyLang: ReplyCheck['replyLang']; arabicShare: number | null; words: number } {
  const own = ownWords(reply);
  const { arabic, latin } = letters(own);
  const words = own.split(/\s+/u).filter(word => /[\p{L}]/u.test(word)).length;
  if (!arabic && !latin) return { replyLang: 'none', arabicShare: null, words };
  const arabicShare = arabic / (arabic + latin);
  return { replyLang: arabicShare >= 1 - MISMATCH_ARABIC_IN_ENGLISH && arabicShare > 1 - MISMATCH_LATIN_IN_ARABIC ? arabicShare >= MISMATCH_ARABIC_IN_ENGLISH ? 'ar' : 'mixed' : arabicShare <= 1 - MISMATCH_LATIN_IN_ARABIC ? 'en' : 'mixed', arabicShare, words };
}

const normalizeLine = (line: string) => line.toLowerCase().normalize('NFC').replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
  .replace(/^[\s\-*•>\d.)]+/u, '').replace(/[«»"“”'‘’*_`]/gu, '').replace(/\s+/gu, ' ').trim();
const excerptOf = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 140);
const sentences = (line: string) => line.split(/(?<=[.!?؟])\s+/u).filter(Boolean);

export function checkReply(input: ReplyCheckInput): ReplyCheck {
  const lang = questionLanguage(input.question);
  const reply = input.reply ?? '';
  const lines = reply.split('\n');
  const findings: ReplyFinding[] = [];
  const language = replyLanguage(reply);

  if (language.words >= MIN_WORDS_FOR_LANGUAGE && language.arabicShare !== null) {
    if (lang === 'en' && language.arabicShare >= MISMATCH_ARABIC_IN_ENGLISH) findings.push({ code: 'language_mismatch', severity: 'review', line: 0, excerpt: excerptOf(ownWords(reply)),
      detail: `English question, ${Math.round(language.arabicShare * 100)}% of the reply's own letters are Arabic` });
    if (lang === 'ar' && 1 - language.arabicShare >= MISMATCH_LATIN_IN_ARABIC) findings.push({ code: 'language_mismatch', severity: 'review', line: 0, excerpt: excerptOf(ownWords(reply)),
      detail: `سؤال عربي، و${Math.round((1 - language.arabicShare) * 100)}% من حروف الرد اللاتينية` });
  }

  if (lang === 'en') {
    lines.forEach((line, index) => {
      const heading = FIXED_HEADINGS.find(([pattern]) => new RegExp(pattern.source, 'u').test(line));
      if (heading) findings.push({ code: 'foreign_heading', severity: 'fix', line: index + 1, excerpt: excerptOf(line), detail: `Arabic heading in an English answer; English form: ${heading[1]}` });
    });
  }

  const leadIndex = lines.findIndex(line => line.trim());
  if (leadIndex >= 0) {
    const lead = lines[leadIndex]!.trim();
    if (BYLINE.test(lead) || DATELINE.test(lead) || ARABIC_BYLINE.test(lead)) findings.push({ code: 'byline_lead', severity: 'fix', line: leadIndex + 1, excerpt: excerptOf(lead),
      detail: lang === 'ar' ? 'يبدأ الجواب بسطر المؤلف أو التاريخ من الصفحة' : 'The answer opens with the page byline or dateline' });
    if (lang === 'en' && WHO_QUESTION.test(input.question) && !NAME_IN_LINE.test(lead.replace(/^(?:the|a|an)\s+/iu, ''))) findings.push({ code: 'lead_without_answer', severity: 'review', line: leadIndex + 1,
      excerpt: excerptOf(lead), detail: 'A «who» question whose first line names nobody' });
  }

  lines.forEach((line, index) => {
    if (/^\s*>/u.test(line) && !CHROME_SENTENCE.test(line)) return;
    const stripped = line.replace(/!?\[[^\]\n]*\]\([^)\n]*\)/gu, ' ');
    for (const sentence of sentences(stripped)) {
      if (CHROME_SENTENCE.test(sentence)) findings.push({ code: 'site_chrome', severity: 'fix', line: index + 1, excerpt: excerptOf(sentence),
        detail: lang === 'ar' ? 'جملة من واجهة الموقع لا من الجواب' : 'A sentence of the site itself, not of the answer' });
      else if (NAV_TOKENS.test(sentence) || UPDATE_STAMP.test(sentence)) findings.push({ code: 'site_chrome', severity: 'fix', line: index + 1, excerpt: excerptOf(sentence),
        detail: lang === 'ar' ? 'بقايا قوائم الموقع أو تاريخ تحديثه' : 'Navigation residue or the page update stamp' });
    }
  });

  const seen = new Map<string, number>();
  lines.forEach((line, index) => {
    const key = normalizeLine(line);
    if (key.length < 25) return;
    const first = seen.get(key);
    if (first !== undefined) findings.push({ code: 'duplicate_line', severity: 'fix', line: index + 1, excerpt: excerptOf(line), detail: lang === 'ar' ? `تكرار للسطر ${first + 1}` : `Repeats line ${first + 1}` });
    else seen.set(key, index);
  });

  return { lang, replyLang: language.replyLang, arabicShare: language.arabicShare, findings };
}

/**
 * The mechanical repairs only: English headings for an English question, no byline prefix, no site sentences, no
 * repeated line. The reply's own sentences are never rewritten, so nothing is said that the pages did not say.
 */
export function applyReplyFixes(input: ReplyCheckInput, check = checkReply(input)): string {
  let lines = input.reply.split('\n');
  const fixable = check.findings.filter(finding => finding.severity === 'fix');
  if (!fixable.length) return input.reply;
  const byLine = (code: ReplyFindingCode) => new Set(fixable.filter(finding => finding.code === code).map(finding => finding.line - 1));
  const chromeLines = byLine('site_chrome'), duplicateLines = byLine('duplicate_line'), bylineLines = byLine('byline_lead');
  lines = lines.flatMap((line, index) => {
    if (duplicateLines.has(index)) return [];
    let value = line;
    if (bylineLines.has(index)) {
      // «By <name> … <year>» goes whole, only on a line that opens with a byline: on «By January 2025, …» a dateline elsewhere flags it.
      if (BYLINE.test(value.replace(/^\s*[-*•]\s*/u, ''))) value = value.replace(/^(?:\s*[-*•]\s*)?(?:by|written by|reported by|author:|posted by|story by)\s+[^.]*?\b\d{4}\s*/iu, '');
      value = value.replace(BYLINE, '').replace(ARABIC_BYLINE, '').replace(DATELINE, '').trim();
    }
    if (chromeLines.has(index)) {
      const prefix = /^(\s*(?:[-*•]|\d+[.)])\s*)/u.exec(value)?.[1] ?? '';
      const kept = sentences(value.slice(prefix.length)).map(sentence => isChrome(sentence) ? scrubChrome(sentence) : sentence)
        .filter((sentence): sentence is string => Boolean(sentence));
      value = kept.length ? prefix + kept.join(' ') : '';
    }
    // A line the fixes emptied disappears; a line that was blank stays blank.
    if (value.trim()) return [value];
    return line.trim() ? [] : [line];
  });
  let text = lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  if (check.lang === 'en') for (const [pattern, english] of FIXED_HEADINGS) text = text.replace(new RegExp(pattern.source, 'gu'), english);
  return text;
}
