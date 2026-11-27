/**
 * The judge («الحَكَم»): a second, deterministic brain that reads the first brain's reply before it is sent and
 * decides send / fix / withhold. It never writes free text: a fix only reorders or removes what is already there,
 * and a withheld reply is replaced by a fixed sentence. Shadow first (owner, 2026-11-22 «ابدأ في الظل»): the
 * verdicts are recorded (judge-shadow.ts, scripts/judge/shadow.ts) and change nothing until the owner has judged them.
 *
 * It is stage 4 («الناقد») of docs/BRAIN-PLAN-2026-11-16.md applied to the replies hands.ts describe() builds today:
 *   form      the pre-send checks of reply-check.ts (language, headings, byline, site chrome, repeats)
 *   lead      the first own sentence against the question: meta line, off topic, number or name wanted, fragment,
 *             definition form, duration unit; and whether a later sentence of the same reply answers better (lead_not_best)
 *   route     a question about the assistant itself answered from a web page; a local question met with an abstention
 *   support   when the host passes the evidence texts: every own sentence must be a quote from them, a computed value,
 *             a memory item or a fixed text; without evidence the check is not measured, never assumed
 * Every threshold here is a proposal for the owner, labelled as such. Nothing here is a model.
 */
import { performance } from 'node:perf_hooks';
import { checkAnswerLine, figureKind, hasFigureOf, isMetaLine } from './answer-check.js';
import { factualPassage, formatFactualPassage } from './factual-evidence.js';
import { entityWords, fold, isFollowUp, refersBack, topicWords } from './hands.js';
import { buildFrame } from './mind/frame.js';
import { applyReplyFixes, checkReply, questionLanguage, type ReplyFindingCode } from './reply-check.js';
import { enforceReplyConstraints, type ReplyConstraintFinding } from './reply-constraint-review.js';
import type { ReplyConstraints } from './reply-directive.js';

export type ReplyKind = 'answer' | 'quote' | 'list' | 'computed' | 'memory' | 'question' | 'abstain' | 'action' | 'composed' | 'fixed';
export type JudgeCode = ReplyFindingCode | ReplyConstraintFinding
  | 'lead_meta' | 'lead_ui' | 'lead_off_topic' | 'lead_needs_number' | 'lead_needs_name' | 'fragment_lead' | 'lead_not_best'
  | 'definition_form_missing' | 'duration_unit_missing' | 'self_question_from_web' | 'local_intent_abstained' | 'page_subject_mismatch' | 'subject_missing'
  | 'unsupported_sentence' | 'evidence_unavailable';
/** block: the reply must not go out as it is. fix: a mechanical repair exists. review: counted for the owner. info: a note. */
export type JudgeSeverity = 'block' | 'fix' | 'review' | 'info';
export type JudgeDecision = 'send' | 'fix' | 'withhold';
export interface JudgeFinding { code: JudgeCode; severity: JudgeSeverity; line: number; excerpt: string; detail: string }
export interface JudgeEvidence { kind: 'page' | 'memory' | 'knowledge' | 'computed'; text: string; url?: string; title?: string }
export interface JudgeInput {
  question: string;
  reply: string;
  /** The host's status for the reply (completed, partial, blocked, waiting_user…); waiting_* marks a question to the user. */
  status?: string | null;
  /** The user's previous turn, for a follow-up whose own words name no subject («وكم عدد سكانها؟»). */
  previous?: string | null;
  /** The texts the reply was built from. Absent: support is reported as not measured. */
  evidence?: readonly JudgeEvidence[];
  /** Fixed texts of the host (templates, notes) that need no evidence. */
  fixedTexts?: readonly string[];
  constraints?: ReplyConstraints;
}
export interface ScoredLine { line: number; text: string; score: number }
export interface JudgeVerdict {
  decision: JudgeDecision;
  kind: ReplyKind;
  lang: 'ar' | 'en';
  frame: { intent: string; answerType: string | null; topic: string[] };
  /** Whether the reply quotes a web page (a source line, or page evidence). Lead checks apply only then. */
  sourced: boolean;
  codes: JudgeCode[];
  findings: JudgeFinding[];
  lead: ScoredLine | null;
  best: ScoredLine | null;
  /** The reply after the mechanical fixes, when the decision is fix. */
  fixedReply: string | null;
  /** The fixed sentence the host could send instead, when the decision is withhold (proposed wording). */
  withholdText: string | null;
  /** Own sentences checked against the evidence, and how many of them were found there; null when not measured. */
  support: { sentences: number; supported: number } | null;
  ms: number;
}

export const SEVERITY: Record<JudgeCode, JudgeSeverity> = {
  language_mismatch: 'review', foreign_heading: 'fix', byline_lead: 'fix', site_chrome: 'fix', duplicate_line: 'fix', lead_without_answer: 'review',
  lead_meta: 'block', lead_ui: 'review', lead_off_topic: 'block', lead_needs_number: 'block', lead_needs_name: 'review', fragment_lead: 'review', lead_not_best: 'fix',
  definition_form_missing: 'review', duration_unit_missing: 'block', self_question_from_web: 'block', local_intent_abstained: 'review', page_subject_mismatch: 'review',
  subject_missing: 'block', unsupported_sentence: 'block', evidence_unavailable: 'info',
  reply_language: 'block', reply_length: 'fix', reply_format: 'fix', reply_links: 'fix',
};
const ORDER: JudgeSeverity[] = ['block', 'fix', 'review', 'info'];

/** Proposed thresholds (not fixed by the owner). */
export const JUDGE_THRESHOLDS = {
  /** A later sentence outranks the lead by at least this much before the judge proposes to promote it. */
  leadNotBestMargin: 2,
  /** A lead with more words than this is an infobox or table run glued to a sentence, not a sentence. */
  fragmentMaxWords: 60,
  /** An own sentence shorter than this (normalized) is too short to look up in the evidence; it is not judged. */
  supportMinChars: 12,
  /** A sentence hands.ts cleaned (menu labels, edit marks) still counts as found when this share of its words is in the text… */
  supportWordShare: 0.9,
  /** …and this many of them stand in a row there. */
  supportRunWords: 5,
  /** A meta line (byline, hatnote) scores this much lower than a plain sentence: it is never the lead. */
  metaPenalty: 3,
} as const;

export const WITHHOLD_TEXT = {
  ar: 'لم أجد في الصفحات التي قرأتها جملة تجيب عن سؤالك مباشرة، فلم أنقل لك جوابًا غير مؤكد. أرسل رابط صفحة مناسبة أو أعد صياغة السؤال.',
  en: 'The pages I read had no sentence that answers your question directly, so I did not pass on an unconfirmed answer. Send a suitable page link or rephrase the question.',
} as const;
/**
 * The fixed sentences a withheld reply is built from (proposed wording): one reason, the link to the page that was read
 * (so a wrong withhold costs the owner one click), and what to do next. Nothing here is written from the page.
 */
export const WITHHOLD_COPY = {
  ar: {
    self: 'هذا سؤال عنّي، ولا أجيب عنه من صفحات الويب، فلم أنقل ما وجدته في صفحة لا تخصني.',
    number: 'لم أجد في الصفحة التي قرأتها الرقم الذي يسأل عنه سؤالك، فلم أنقل لك جوابًا غير مؤكد.',
    unsupported: 'في الجواب جملة لم أجدها في الصفحات التي قرأتها، فلم أرسله.',
    subject: 'الصفحة التي وجدتها لا تتحدث عن موضوع سؤالك، فلم أنقل منها جوابًا.',
    generic: 'لم أجد في الصفحات التي قرأتها جملة تجيب عن سؤالك مباشرة، فلم أنقل لك جوابًا غير مؤكد.',
    page: 'الصفحة التي قرأتها:',
    next: 'أرسل رابط صفحة مناسبة أو أعد صياغة السؤال.',
  },
  en: {
    self: 'This is a question about me, and I do not answer it from web pages, so I did not pass on what a page that is not about me says.',
    number: 'The page I read does not give the figure your question asks for, so I did not pass on an unconfirmed answer.',
    unsupported: 'The answer had a sentence I did not find in the pages I read, so I did not send it.',
    subject: 'The page I found is not about the subject of your question, so I did not take an answer from it.',
    generic: 'The pages I read had no sentence that answers your question directly, so I did not pass on an unconfirmed answer.',
    page: 'The page I read:',
    next: 'Send a suitable page link or rephrase the question.',
  },
} as const;

const SOURCE_LINE = /^\s*\*\*(?:المصدر|Source):\*\*/u;
const SOURCE_TITLE = /\*\*(?:المصدر|Source):\*\*\s*\[([^\]\n]+)\]/u;
/** Lines of the reply's layout, not of its own sentences: headings, sources, notes, instructions to the user, quotes, result lists. */
// «Page title» and «Source link» name the page that was read when the owner asks for them (reply-directive.ts, 2026-11-23).
const STRUCTURE = /^\s*(?:\*\*(?:المصدر|للمزيد|الموضوع|تفاصيل أخرى من نفس المصدر|مصدر ثانٍ يؤكد|مصدر ثانٍ يختلف|عنوان الصفحة|رابط المصدر|Source|More|Subject|More from the same source|A second source agrees|A second source differs|Page title|Source link):\*\*|ملاحظة: هذه معلومات عامة|Note: this is general information|للتشخيص والعلاج راجع|هذه المعلومات عامة|This is general information|For diagnosis and treatment|لم أتحقق من هذا الرقم في مصدر ثانٍ|I did not check this figure against a second source|قل «|اكتب «|Say «|>|\d+\. \[)/u;
const QUOTE_LINE = /^\s*>\s?/u;
const QUESTION_TO_USER = /أجب عن هذه الأسئلة|هل أتابع\s*؟|سجّل دخولك|اضغط «أكملت»|What would you like me to do|Please rewrite|ما الشيء الذي تقصده|أعد كتابة طلبك|Name the subject and the result|حدّد الشيء المقصود|أعد صياغة الطلب|Rewrite the request|Start a new request|ابدأ طلبًا جديدًا|Do you want me to continue|Shall I continue/u;
const ABSTAIN_LEAD = /^(?:لم أتمكن|لم أتمكّن|لم أنفّذ|لم أنفذ|لم أؤكد|لم أبحث في الويب|لم أجد صفحة|لم أجد نصًا|لم أجد نصاً|لم أتحقق|لم يتضح|لم أستبدل|تعذر|تعذّر|لا توجد صفحة مفتوحة|قراءة نافذة الكمبيوتر غير متاحة|حسنًا، لم أنفّذ|I haven[’']t (?:performed|verified)|I could not|I couldn[’']t|I did not (?:search|perform)|I found no (?:page|results?|text)|Understood\. I did not|No page is open)/u;
const NEEDS_MODEL = /needs? a (?:writing )?model|يحتاج (?:إلى )?نموذج|لا يوجد نموذج/u;
const COMPUTED = /^[\d٠-٩\s+\-*/=%.,()×÷x^√π:]+$/u;
const MEMORY_LEAD = /^(?:من الذاكرة:|From memory:)/u;
const LIST_ITEM = /^\d+\. \[/u;
const QUOTE_LEAD = /^(?:من \*\*|وصلت إلى|بحثت عن .* فنقلني|From \*\*)/u;
const COMPOSED_LEAD = /^\*\*(?:الموضوع|Subject):\*\*/u;
const ACTION_LEAD = /^(?:كتبت\s|ضغطت|فتحت|نقرت|أغلقت|سجّلت مراجعتك|أعدت قراءة الصفحة|I typed|I wrote|I clicked|I opened|I closed)/u;
/**
 * An Arabic byline as pages print it: «بقلم …», «تحرير: …», «آخر تحديث …», «كتب: …». A bare «كتبت …» or «كتب …» opening
 * is a sentence («كتبت 14 حرفًا في نافذة المفكرة», «كتب طه حسين …»), not a byline: reply-check.ts flags it, the judge does not
 * act on it (live 2026-11-22 06:39–07:16: three desktop replies lost their «كتبت»).
 */
const STRICT_ARABIC_BYLINE = /^(?:بقلم|تحرير|آخر تحديث|نُ?شر في|تاريخ النشر|المصدر الأصلي)[:\s]|^(?:كتبه|كتبت|كتب)\s*:/u;
/** Whether a form finding of reply-check.ts may change this text: bylines must look like bylines when they are Arabic. */
function formFindingHolds(code: string, line: string | undefined): boolean {
  if (code !== 'byline_lead') return true;
  const text = (line ?? '').trim();
  return !/^\p{Script=Arabic}/u.test(text) || STRICT_ARABIC_BYLINE.test(text);
}
/** A question about the assistant itself: never answered from a web page. */
const SELF_QUESTION = /(?:^|\s)(?:ما (?:هي )?قدراتك|ماذا تستطيع|ما الذي تستطيع|ما (?:هي )?(?:مميزاتك|إمكانياتك|امكانياتك|وظيفتك|مهامك)|من (?:صنعك|أنشأك|انشأك|برمجك|طورك|طوّرك|صممك|صمّمك|بناك|درّبك|دربك|يملكك|انت|أنت)|ما (?:أنت|انت|اسمك)|هل أنت|هل انت|كيف حالك|who (?:made|created|built|trained|owns?|developed|designed) you|whos? create[ds]? you|are you (?:groq|chatgpt|gpt|openai|claude|gemini|an? (?:ai|bot|model|robot))|what (?:are you|can you do|is your name)|who are you|your (?:capabilities|abilities|creator|name|maker)|smarter (?:than|chatgpt or) you|upgrade you)(?=\s|$|[؟?!.,])/iu;
const DURATION_QUESTION = /كم (?:تستغرق|يستغرق|تأخذ|يأخذ|تستمر|يستمر|مدة|مدّة|مده)|كم (?:من )?(?:الوقت|وقت)|how long (?:does|do|will|is|did|would|should)|how much time/iu;
const DURATION_UNIT = /(?:^|[\s\d])(?:دقيقة|دقيقه|دقائق|دقيقتين|ساعة|ساعه|ساعات|ساعتين|يوم|أيام|ايام|يومين|أسبوع|اسبوع|أسابيع|اسابيع|شهر|أشهر|اشهر|شهور|سنة|سنه|سنوات|ثانية|ثوان|ثواني|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|seconds?|secs?)(?=\s|$|[،,.؟?!)])/iu;
const SUPERLATIVE = /(?:^|\s)(?:أطول|اطول|أكبر|اكبر|أصغر|اصغر|أعلى|اعلى|أقدم|اقدم|أول|اول|آخر|اخر|أحدث|احدث|أشهر|اشهر|أغنى|اغنى|أسرع|اسرع|أقوى|اقوى|أفضل|افضل|longest|largest|biggest|smallest|highest|tallest|oldest|first|last|latest|newest|fastest|strongest|best|richest|most)(?=\s|$)/iu;
const COPULA = /(?:^|\s)(?:هو|هي|يعد|تعد|يُعد|تُعد|يعرف|تعرف|يُعرف|تُعرف|عبارة عن|عباره عن|is|are|was|were|refers to|means)(?=\s|$)/iu;
const ARABIC_CONNECTIVE = /^(?:و|ف)?(?:هذا|هذه|ذلك|تلك|لذلك|لذا|كما|لكن|ولكن|بينما|فيما|حيث|إذ|اذ|أما|اما|ثم|كذلك|أيضا|أيضًا|ايضا|وهو|وهي|وقد|ومن ثم|بالإضافة|بالاضافة|إضافة|اضافة)(?=\s|$)/u;
const ENGLISH_CONNECTIVE = /^(?:but|and|so|however|this (?:process|method|technique|is|was)|it (?:is|was|also)|they|which|also|then|these|those|he|she|while|whereas|therefore|thus|moreover|furthermore)\b/iu;
const TIMESTAMP = /^\d{1,2}:\d{2}\b/u;
const ELLIPSIS_START = /^(?:…|\.\.\.)/u;
const QUESTION_WORDS = new Set(['ما', 'ماذا', 'من', 'هو', 'هي', 'كم', 'متى', 'متي', 'أين', 'اين', 'كيف', 'هل', 'لماذا', 'ليش', 'في', 'عن', 'على', 'علي', 'إلى', 'الى', 'مع', 'لي', 'و', 'أو', 'او', 'ثم', 'هذا', 'هذه', 'ذلك',
  'what', 'is', 'are', 'the', 'of', 'in', 'who', 'how', 'when', 'where', 'which', 'does', 'do', 'did', 'a', 'an', 'to', 'for', 'i', 'my', 'me', 'you', 'and', 'or', 'was', 'were', 'it', 'that', 'this', 'please', 'tell', 'with', 'about']);
const ARABIC_SUFFIX = /(?:هما|ها|هم|كم|كن|نا|ني|ك|ه|ي)$/u;
/** A folded word that ends in a possessive pronoun («سكانها», «عاصمتهم»). */
const POSSESSIVE = /\p{L}{3,}(?:هما|ها|هم|هن)$/u;
/**
 * The words a population question asks with («people», «live», «inhabitants», «عدد سكان», «نسمة»), as topicWords folds them.
 * A line stating a count of people answers them however it words them (live 2026-11-22 14:02: "With a population of almost
 * 123 million as of 2026, it is the world's 11th most populous country." names neither «people» nor «live» nor Japan).
 */
const POPULATION_WORD = /^(?:people|persons?|inhabitants?|residents?|live[sd]?|living|population|populous|عدد|تعداد|(?:ال)?سكان\p{L}{0,3}|نسم\p{L}{0,2}|يعيش\p{L}{0,2}|يسكن\p{L}{0,2})$/u;
/** «وكم», «فما», «ومن»: a conjunction glued to the question word, which topicWords would keep as a subject word. */
const CONJUNCTION_ASK = /(^|[\s،,؛])[وف](?=(?:كم|ما|ماذا|من|متى|متي|أين|اين|هل|كيف|لماذا|ليش|شو|ايش)(?=[\s؟?]|$))/gu;
/**
 * The question as the judge scores it. A follow-up that points back with a pronoun and names no subject of its own
 * («وكم عدد سكانها؟» after «ما عاصمة اليابان؟») borrows the previous turn's subject: «كم عدد سكانها؟ يابان». Only the subject,
 * not the attribute asked before («عاصمة»), and nothing when the follow-up names its own («وماذا عن فرنسا؟»).
 */
export function resolvedQuestion(question: string, previous?: string | null): string {
  const own = question.replace(CONJUNCTION_ASK, '$1');
  // refersBack reads whole words: «سكانها؟» with its question mark attached is not seen as «سكانها».
  const words = question.replace(/[؟?!.،,؛;:]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!previous || !isFollowUp(question) || !refersBack(words) || entityWords(own).length) return own;
  const before = entityWords(previous);
  const subject = before.length ? before : topicWords(previous);
  const have = topicWords(own);
  const missing = subject.filter(word => !have.some(item => mentions(item, word) || mentions(word, item)));
  return missing.length ? `${own.trim()} ${missing.join(' ')}` : own;
}
/** Capitalised words that open or join a question and name nothing. */
const QUESTION_NAMES = new Set(['What', 'Who', 'Whom', 'Whose', 'How', 'When', 'Where', 'Which', 'Why', 'Is', 'Are', 'Was', 'Were', 'Do', 'Does', 'Did', 'Can', 'Could',
  'Should', 'Would', 'Will', 'Tell', 'Give', 'Show', 'Find', 'Please', 'The', 'And', 'Or', 'In', 'On', 'At', 'Of', 'For', 'To', 'From', 'Me', 'My', 'Our', 'Your']);
/** Arabic prepositions that open a trailing qualifier («في العين», «في العالم», «على الخريطة»). */
const ARABIC_PREPOSITIONS = new Set(['في', 'علي', 'على', 'عن', 'من', 'الي', 'إلى', 'حول', 'خلال', 'داخل']);
/** Arabic words that name no subject of a question. */
const GENERIC_ARABIC = new Set(['صفحه', 'رابط', 'فيها', 'فيه', 'موقع', 'هنا', 'اخري', 'واحد', 'خطوه', 'ادوات', 'يوم', 'اليوم', 'الان', 'حاليا', 'عام', 'سنه', 'شيء']);

const excerptOf = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 140);
const words = (text: string) => text.split(/\s+/u).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Zero-width joiners and marks pages leave inside words («و‌عاصمتها»): invisible, and they break every word match. */
const ZERO_WIDTH = /[​-‍⁠﻿]/gu;
/** The own words of a layout line: no bullet, no leading ellipsis, no bold marks or markdown links, no footnote marks. */
const bare = (line: string) => line.replace(ZERO_WIDTH, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').replace(ELLIPSIS_START, '').replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
  .replace(/\*\*/gu, '').replace(/\[(?:\d+|[ا-ي]|[a-z])\]/gu, '').replace(/\s+/gu, ' ').trim();
/** Footnote marks a page carries inside its sentences («[12]», «[أ]», «[note 3]»); hands.ts drops them from the lines it quotes. */
const FOOTNOTE = /\[(?:\d{1,3}|[a-z]|[ا-ي]|note \d+|ملاحظة \d+|ملحوظة \d+)\]/giu;
/** Text as the evidence is compared: no footnote marks, folded letters, no marks, no punctuation, one space. */
export function comparable(text: string): string {
  return fold(text.replace(ZERO_WIDTH, '').replace(FOOTNOTE, ' ')).replace(/[ً-ْٰـ]/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
/**
 * Whether a comparable sentence part is found in a comparable evidence text: as it is, or, when the page's menu labels or
 * edit marks were cleaned out of it, by most of its words with a run of them in a row (proposed thresholds above).
 */
export function supportedBy(part: string, text: string): boolean {
  if (text.includes(part)) return true;
  const words = part.split(' ').filter(word => word.length >= 2);
  if (words.length < JUDGE_THRESHOLDS.supportRunWords) return false;
  const present = words.filter(word => text.includes(word)).length;
  if (present / words.length < JUDGE_THRESHOLDS.supportWordShare) return false;
  for (let index = 0; index + JUDGE_THRESHOLDS.supportRunWords <= words.length; index++) {
    if (text.includes(words.slice(index, index + JUDGE_THRESHOLDS.supportRunWords).join(' '))) return true;
  }
  return false;
}
/** A subject word as it may appear in a sentence: without an attached pronoun («سكانها» → «سكان»), without a plural s. */
export function stem(word: string): string {
  if (/\p{Script=Arabic}/u.test(word)) return word.length > 4 ? word.replace(ARABIC_SUFFIX, '') : word;
  return word.length > 4 && /s$/u.test(word) && !/ss$/u.test(word) ? word.slice(0, -1) : word;
}
/** Whether a folded sentence mentions a subject word, allowing the feminine «ة» to appear as «ت» before a suffix («عاصمة» in «عاصمتها»). */
export function mentions(folded: string, word: string): boolean {
  const base = stem(word);
  if (base.length < 2) return false;
  if (folded.includes(base)) return true;
  return base.endsWith('ه') && folded.includes(`${base.slice(0, -1)}ت`);
}

/** A page address as the judge compares it: host without «www.», decoded path without a trailing slash, no query or fragment. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep the encoded path */ }
    return `${parsed.host.toLowerCase().replace(/^www\./u, '')}${path.replace(/\/+$/u, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
/** The addresses of the reply's source line(s) («**المصدر:** [site — title](url)»), as page keys. */
export function sourceUrls(reply: string): string[] {
  return reply.split('\n').filter(line => SOURCE_LINE.test(line))
    .flatMap(line => [...line.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].map(match => pageKey(match[1]!)));
}
/** The first markdown link of the reply's source line, as the host wrote it. */
function sourceLink(reply: string): string | null {
  const line = reply.split('\n').find(item => SOURCE_LINE.test(item));
  return line ? /\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/u.exec(line)?.[0] ?? null : null;
}
/**
 * The reply sent instead of a withheld one: the reason (the strongest block code), the link to the page that was read,
 * and what to do next. Fixed sentences and the host's own link only; for a question about the assistant, the reason alone.
 */
export function withholdReply(lang: 'ar' | 'en', codes: readonly JudgeCode[], reply: string): string {
  const copy = WITHHOLD_COPY[lang];
  if (codes.includes('self_question_from_web')) return copy.self;
  const reason = codes.includes('unsupported_sentence') ? copy.unsupported
    : codes.includes('duration_unit_missing') || codes.includes('lead_needs_number') ? copy.number
    : codes.includes('subject_missing') || codes.includes('lead_off_topic') || codes.includes('lead_meta') ? copy.subject
    : copy.generic;
  const link = sourceLink(reply);
  return `${reason}${link ? `\n\n${copy.page} ${link}` : ''}\n\n${copy.next}`;
}

export interface OwnLine { line: number; raw: string; text: string }
/**
 * The reply's own sentences, by line: not blank, not layout, not a quote. In hands.ts's layout the page's sentences all
 * come before the source line; what follows it (more links, a second-source note, «لم أتحقق من هذا الرقم في مصدر ثانٍ»,
 * the medical note) is the host's own text, so it is neither scored nor looked up in the evidence.
 */
export function ownLines(reply: string): OwnLine[] {
  const lines = reply.split('\n');
  const sourceAt = lines.findIndex(line => SOURCE_LINE.test(line));
  return lines.slice(0, sourceAt >= 0 ? sourceAt : lines.length).map((raw, index) => ({ line: index + 1, raw, text: bare(raw) }))
    .filter(item => item.raw.trim() && !STRUCTURE.test(item.raw) && item.text);
}

export function replyKind(input: JudgeInput, intent: string, sourced: boolean): ReplyKind {
  const reply = input.reply.trim();
  const lead = reply.split('\n').find(line => line.trim())?.trim() ?? '';
  const lines = reply.split('\n');
  if (input.status?.startsWith('waiting_') || QUESTION_TO_USER.test(lead) && !ABSTAIN_LEAD.test(lead)) return 'question';
  if (ABSTAIN_LEAD.test(lead) || NEEDS_MODEL.test(lead)) return 'abstain';
  if (COMPUTED.test(reply)) return 'computed';
  if (MEMORY_LEAD.test(lead) || intent === 'memory_recall' && words(reply).length <= 6) return 'memory';
  if (lines.filter(line => LIST_ITEM.test(line.trim())).length >= 2) return 'list';
  if (QUOTE_LEAD.test(lead) && lines.some(line => QUOTE_LINE.test(line))) return 'quote';
  if (COMPOSED_LEAD.test(lead)) return 'composed';
  if (ACTION_LEAD.test(lead) && !sourced) return 'action';
  if ((intent === 'smalltalk' || intent === 'identity') && !sourced) return 'fixed';
  return 'answer';
}

/** The question's cue words: what it asks about the subject («عدد», «تستغرق», «فوائد»), which topicWords sets aside. */
export function cueWords(question: string, topic: readonly string[]): string[] {
  return [...new Set(words(fold(question).replace(/[؟?،,.!:;«»"]/gu, ' ')))]
    .filter(word => word.length >= 3 && !QUESTION_WORDS.has(word) && !topic.some(item => word.includes(stem(item)) || stem(item).includes(word)))
    .map(word => stem(word.length > 4 && word.startsWith('ال') ? word.slice(2) : word));
}

/** The words of the page's title in the source line («**المصدر:** [ويكيبيديا — أستراليا](…)»): the page's own subject, implied in its sentences. */
export function sourceTitleWords(reply: string): string[] {
  const title = SOURCE_TITLE.exec(reply)?.[1] ?? '';
  const own = title.includes(' — ') ? title.slice(title.indexOf(' — ') + 3) : title;
  return words(fold(own).replace(/[()،,.:|-]/gu, ' ')).filter(word => word.length >= 2);
}

/**
 * The one word the answer cannot do without: in English the last capitalised name («Japan» in «What is the best time
 * to visit Japan?»), else the longest subject word; in Arabic the last subject word («المغرب» in «كم عدد سكان المغرب؟»).
 * Seen live on 2026-11-22: a film article answered the Japan question with «visit» and «time» in its lead and no Japan.
 */
export interface QuestionSubject {
  words: string[];
  /**
   * name: Latin capitalised proper names, reliable enough to withhold on (live 2026-11-22: «Japan» and a film page).
   * word: an Arabic subject word, which a synonym page misses («المياه البيضاء» on the page «الساد», rq017): review only.
   */
  from: 'name' | 'word';
}
export function questionSubject(question: string, topic: readonly string[], lang: 'ar' | 'en'): QuestionSubject | null {
  // Proper names written in Latin capitals, in either language («Japan», «Python» in «ابحث عن Python pathlib»): any one of them will do,
  // so a comparison («Is Python faster than Java?») passes when the page names either.
  const latin = words(question.replace(/[؟?!.,;:«»"“”()]/gu, ' '));
  const names = latin.slice(/^[A-Z]/u.test(latin[0] ?? '') ? 1 : 0)
    .map(word => /^[A-Z][a-z]+/u.exec(word)?.[0]).filter((name): name is string => Boolean(name) && !QUESTION_NAMES.has(name!));
  if (names.length) return { words: [...new Set(names.map(name => stem(fold(name))))], from: 'name' };
  // English without a capitalised name has no reliable subject: the check is skipped rather than guessed.
  if (lang === 'en') return null;
  // Arabic: the last subject word before a trailing «في/على/من/عن/إلى …» qualifier («المياه البيضاء» in «… في العين»,
  // «نهر» in «أطول نهر في العالم»), never a generic word.
  const folded = words(fold(question).replace(/[؟?،,.!:;«»"]/gu, ' '));
  const at = (word: string) => folded.findIndex(item => item === word || item === `ال${word}` || item.replace(/^(?:و|ف|ب|ل)?(?:ال)?/u, '') === word);
  let cut = folded.length;
  for (let index = folded.length - 1; index >= Math.max(1, folded.length - 3); index--) if (ARABIC_PREPOSITIONS.has(folded[index]!)) { cut = index; break; }
  const candidates = topic.map(word => ({ word, index: at(word) })).filter(item => item.index >= 0 && !GENERIC_ARABIC.has(item.word));
  const before = candidates.filter(item => item.index < cut);
  const pick = (before.length ? before : candidates).sort((a, b) => b.index - a.index)[0];
  return pick && pick.word.length >= 3 ? { words: [stem(pick.word)], from: 'word' } : null;
}

/**
 * «صباح (المغرب)», «Sabah (Morocco)»: a page whose title carries the question's subject only as the qualifier in
 * parentheses is about something in that subject, not about it (seen live on 2026-11-22: a village's population for
 * «كم عدد سكان المغرب؟»). Returns the page's own subject and the qualifier, or null.
 */
export function pageSubjectMismatch(reply: string, topic: readonly string[]): { page: string; qualifier: string } | null {
  const title = SOURCE_TITLE.exec(reply)?.[1] ?? '';
  const own = (title.includes(' — ') ? title.slice(title.indexOf(' — ') + 3) : title).trim();
  const match = /^(.+?)\s*\(([^()]+)\)\s*$/u.exec(own);
  if (!match) return null;
  const page = fold(match[1]!), qualifier = fold(match[2]!);
  const inQualifier = topic.some(word => mentions(qualifier, word));
  const inPage = topic.some(word => mentions(page, word));
  return inQualifier && !inPage ? { page: match[1]!.trim(), qualifier: match[2]!.trim() } : null;
}

export interface Relevance { topicHits: number; implied: number; phrase: boolean; cue: boolean; typed: boolean; answerForm: boolean; fragment: boolean; meta: boolean; score: number }
export interface RelevanceContext { question: string; topic: readonly string[]; cues: readonly string[]; titleWords: readonly string[]; answerType: string | null; lang: 'ar' | 'en' }
/**
 * How well one own sentence answers the question: its subject words (those of the page's title count only beside a word
 * of its own, as hands.ts does; a count of people names a population question's own words), the question's phrase in
 * order, the asked relation, the asked type (a number, a duration, a definition), the Arabic answer form on the subject's
 * own page («عاصمتها كانبرا»: its capital is Canberra, stronger than a passing «عاصمة أستراليا»), minus a fragment and minus
 * a meta line. Explainable arithmetic, not a model.
 * `raw` is the layout line itself, so a leading ellipsis the clean text lost still marks a fragment.
 */
export function relevance(text: string, context: RelevanceContext, raw?: string): Relevance {
  const folded = fold(text);
  // A population question is answered by a count of people (answer-check's people figure: «123 مليون نسمة», "a population
  // of 123 million"), whatever words the line uses for it. Its population words then count as named, and the page's title
  // supplies the subject the line calls «it». Only those words: the subject must still be named, in the line or the title.
  const counted = figureKind(context.question) === 'people' && hasFigureOf('people', text);
  const inLine = context.topic.filter(word => mentions(folded, word) || counted && POPULATION_WORD.test(word));
  const implied = context.topic.filter(word => !inLine.includes(word) && context.titleWords.some(title => mentions(title, word) || mentions(stem(word), title))).length;
  const topicHits = inLine.length + (inLine.length ? implied : 0);
  // The question's words in a row, allowing one short particle between them («speed of light», «سكان في المغرب»).
  const phrase = context.topic.length >= 2 && new RegExp(context.topic.map(word => `(?:ال)?${escape(stem(word))}`).join('\\S*\\s+(?:\\S{1,3}\\s+)?'), 'u').test(folded);
  const cue = context.cues.some(word => folded.includes(word));
  const hasNumber = /[\d٠-٩]/u.test(text);
  const duration = DURATION_QUESTION.test(context.question);
  const typed = duration ? hasNumber && DURATION_UNIT.test(text)
    : context.answerType === 'number' || context.answerType === 'money' || context.answerType === 'date' ? hasNumber
    : context.answerType === 'definition' ? definitionForm(text, context.topic)
    : false;
  // Only the possessive «ها» and «هم» count: a bare «ه» is also the folded feminine ending («عاصمة», «المغربية»). A word the
  // question itself asks with a pronoun («سكانها» in «وكم عدد سكانها؟») is no sign of an answer: any sentence repeating it
  // would win (live 2026-11-22 08:30, «أما المدن التي يزيد عدد سكانها…» outranked «يبلغ عدد سكان اليابان 123 مليون نسمة»).
  const answerForm = context.titleWords.length > 0 && inLine.length > 0
    && context.topic.some(word => !POSSESSIVE.test(word)
      && new RegExp(`(?:^|\\s)[وف]?(?:ال)?${escape(stem(word))}\\p{L}{0,2}(?:ها|هم)(?=[\\s،,:.؛]|$)`, 'u').test(folded));
  const fragment = isFragment(text, context.lang) || Boolean(raw && ELLIPSIS_START.test(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim()));
  const meta = isMetaLine(text);
  const score = topicHits + (phrase ? 2 : 0) + (cue ? 1 : 0) + (typed ? context.answerType === 'definition' ? 2 : 1 : 0) + (answerForm ? 3 : 0) - (fragment ? 1 : 0) - (meta ? JUDGE_THRESHOLDS.metaPenalty : 0);
  return { topicHits, implied, phrase, cue, typed, answerForm, fragment, meta, score };
}

/** «الذكاء الاصطناعي (AI) هو …», «Photosynthesis is …»: the subject within the first three words, then a copula soon after. */
export function definitionForm(text: string, topic: readonly string[]): boolean {
  const folded = fold(text).replace(/\([^)]*\)/gu, ' ').replace(/\s+/gu, ' ').trim();
  const head = words(folded).slice(0, 3).join(' ');
  if (!topic.some(word => mentions(head, word))) return false;
  const opening = words(folded).slice(0, 12).join(' ');
  return COPULA.test(opening);
}

/**
 * A sentence cut from its context: a leading ellipsis, a connective or pronoun opening, a timestamp, a lowercase Latin
 * start (code, a list cell), a glued run. A trailing ellipsis is not one: hands.ts cuts an encyclopedia's long first
 * sentence at 300 characters, and that sentence is still the article's own lead.
 */
export function isFragment(text: string, lang: 'ar' | 'en'): boolean {
  const trimmed = text.trim();
  if (ELLIPSIS_START.test(trimmed)) return true;
  if (TIMESTAMP.test(trimmed)) return true;
  if (words(trimmed).length > JUDGE_THRESHOLDS.fragmentMaxWords) return true;
  if (ARABIC_CONNECTIVE.test(trimmed)) return true;
  if (ENGLISH_CONNECTIVE.test(trimmed)) return true;
  if (/^[a-z]/u.test(trimmed) && !/^(?:e\.g\.|i\.e\.)/u.test(trimmed)) return true;
  void lang;
  return false;
}

function judgeAnswer(input: JudgeInput): JudgeVerdict {
  const started = performance.now();
  const question = input.question ?? '';
  const reply = input.reply ?? '';
  const lang = input.constraints?.lang ?? questionLanguage(question);
  // What the first brain answered: a follow-up resolved with the previous turn's subject. Lines are scored against it.
  const asked = resolvedQuestion(question, input.previous);
  const frame = buildFrame(asked);
  // The question's own subject words; a short follow-up still borrows the previous turn's for matching, never for its subject.
  const ownTopic = topicWords(asked);
  let topic = ownTopic;
  if (topic.length < 2 && input.previous) topic = [...new Set([...topic, ...topicWords(input.previous)])];
  // A reply quotes a page when it carries the host's source line. Evidence alone does not make it so: a run that opened a
  // page may still end with a desktop or template reply, and the page checks must never judge those.
  const sourced = reply.split('\n').some(line => SOURCE_LINE.test(line));
  const kind = replyKind(input, frame.intent, sourced);
  /** Page text: the only replies a byline, site chrome, a fixed heading or a repeated line can come from. */
  const pageText = sourced || kind === 'quote';
  const findings: JudgeFinding[] = [];
  const add = (code: JudgeCode, line: number, excerpt: string, detail: string, severity = SEVERITY[code]) => findings.push({ code, severity, line, excerpt: excerptOf(excerpt), detail });

  // Form: the pre-send checks of reply-check.ts. Bylines, site chrome and repeated lines are judged on page text only; the
  // host's own fixed Arabic headings («**الموضوع:**») are translated for an English question on any reply (owner-approved,
  // rq097). On other replies (desktop actions, templates, computed values) nothing else changes.
  const replyLines = reply.split('\n');
  const keepForm = (code: string, line: string | undefined) => (code === 'foreign_heading' || pageText) && formFindingHolds(code, line);
  const form = checkReply({ question, reply, lang });
  for (const finding of form.findings) {
    if (finding.severity === 'fix' && !keepForm(finding.code, replyLines[finding.line - 1])) continue;
    add(finding.code, finding.line, finding.excerpt, finding.detail, finding.severity === 'fix' ? 'fix' : SEVERITY[finding.code]);
  }

  const own = ownLines(reply);
  const cues = cueWords(asked, topic);
  const titleWords = sourceTitleWords(reply);
  let lead: ScoredLine | null = null, best: ScoredLine | null = null, dropOldLead = false;

  if (kind === 'answer' && sourced && own.length) {
    const context: RelevanceContext = { question: asked, topic, cues, titleWords, answerType: frame.answerType, lang };
    const scored = own.map(item => ({ ...item, relevance: relevance(item.text, context, item.raw) }));
    const first = scored[0]!;
    const sources = first.raw.includes('**') ? sourceUrls(reply) : [];
    const extracted = sources.length > 0 && input.evidence?.some(item => {
      if (item.kind !== 'page' || !item.title || !item.url || !sources.includes(pageKey(item.url))) return false;
      const answer = factualPassage({ text: item.text, title: item.title }, asked);
      return answer && formatFactualPassage(answer) === first.raw;
    });
    lead = { line: first.line, text: first.text, score: first.relevance.score };
    const top = [...scored].sort((a, b) => b.relevance.score - a.relevance.score || a.line - b.line)[0]!;
    best = { line: top.line, text: top.text, score: top.relevance.score };

    const check = checkAnswerLine(asked, first.text);
    const anyNumber = scored.some(item => /[\d٠-٩]/u.test(item.text));
    const bylineFixed = form.findings.some(finding => finding.code === 'byline_lead' && finding.line === first.line);
    for (const reason of check.reasons) {
      if (reason === 'meta_line') add('lead_meta', first.line, first.text, lang === 'ar' ? 'السطر الأول عن الصفحة لا عن الموضوع' : 'The first line is about the page, not the subject', bylineFixed ? 'review' : 'block');
      else if (reason === 'ui_text') add('lead_ui', first.line, first.text, lang === 'ar' ? 'السطر الأول من واجهة الموقع' : 'The first line is interface text');
      else if (reason === 'needs_number' && !extracted) add('lead_needs_number', first.line, first.text, anyNumber
        ? (lang === 'ar' ? 'سؤال عددي والسطر الأول بلا رقم، ورقم في سطر لاحق' : 'A number question whose first line has no number; a later line has one')
        : (lang === 'ar' ? 'سؤال عددي ولا رقم في أي سطر' : 'A number question with no number in any line'), anyNumber ? 'review' : 'block');
      else if (reason === 'needs_name') add('lead_needs_name', first.line, first.text, lang === 'ar' ? 'سؤال عن شخص والسطر الأول بلا اسم' : 'A who question whose first line names nobody');
      // 'language' is covered by language_mismatch over the whole reply; 'off_topic' is decided below with the page's title.
    }
    if (!extracted && topic.length && first.relevance.topicHits === 0) {
      add('lead_off_topic', first.line, first.text, lang === 'ar' ? `لا يذكر السطر الأول أي كلمة من الموضوع (${topic.join('، ')})` : `The first line names none of the subject words (${topic.join(', ')})`);
    } else if (!extracted) {
      const subject = questionSubject(asked, ownTopic, questionLanguage(asked));
      const named = (word: string) => mentions(fold(first.text), word)
        || titleWords.some(title => mentions(title, word) || title.length >= 4 && mentions(word, title));
      if (subject && !subject.words.some(named)) add('subject_missing', first.line, first.text, lang === 'ar'
        ? `لا السطر الأول ولا عنوان الصفحة يذكر موضوع السؤال «${subject.words.join('» أو «')}»${subject.from === 'word' ? ' (كلمة عربية قد يكون لها مرادف: للمراجعة)' : ''}`
        : `Neither the first line nor the page title names the question's subject “${subject.words.join('” or “')}”`,
        subject.from === 'name' ? 'block' : 'review');
    }
    if (first.relevance.fragment) add('fragment_lead', first.line, first.text, lang === 'ar' ? 'السطر الأول مقطوع من سياقه: يبدأ بأداة ربط أو بنقاط حذف أو بوقت، أو طويل كجدول' : 'The first line is cut from its context: a connective, an ellipsis, a timestamp or a table-long run');
    if (frame.answerType === 'definition' && frame.intent === 'fact_question' && !SUPERLATIVE.test(asked) && !first.relevance.typed) {
      add('definition_form_missing', first.line, first.text, lang === 'ar' ? 'سؤال تعريف والسطر الأول ليس بصيغة «X هو …»' : 'A definition question whose first line is not «X is …»');
    }
    if (!extracted && DURATION_QUESTION.test(asked) && !scored.some(item => item.relevance.typed)) {
      add('duration_unit_missing', first.line, first.text, lang === 'ar' ? 'سؤال عن مدة ولا سطر فيه رقم مع وحدة زمن' : 'A how-long question with no line holding a number and a time unit');
    }
    // A lead is replaced only when it is itself defective: cut from its context, about the page, naming nothing of the
    // question, or neither stating the question's words in order nor answering in their pronoun form. A clean lead that states
    // the question («يبلغ عدد سكان اليابان 123 مليون نسمة») is never demoted, and the line promoted must pass the line checks.
    // The three promotions the owner judged correct on 2026-11-22 (rq010, rq016, rq028) all had a meta or cut lead.
    // A lead that already states a count of people for a population question answers it however it is worded: «تُعدُّ ألمانيا
    // أكثر دول الاتحاد الأوروبي سكانا بأزيد من 83 مليون نسمة» was demoted for «توجد في ألمانيا 82 مدينة يزيد عدد سكانها عن
    // 100,000 نسمة», whose «سكانها» is the answer form, and the fix went out on the owner's account (live 2026-11-22 23:53,
    // artifacts/agent-gaps-2026-11-22/audit-head-3959084/wiring-probe-after-1.json).
    const countedLead = figureKind(asked) === 'people' && first.relevance.topicHits > 0 && hasFigureOf('people', first.text);
    const defectiveLead = first.relevance.fragment || first.relevance.meta || first.relevance.topicHits === 0 || !first.relevance.phrase && !first.relevance.answerForm && !countedLead;
    if (!extracted && defectiveLead && top.line !== first.line && top.relevance.score - first.relevance.score >= JUDGE_THRESHOLDS.leadNotBestMargin
      && checkAnswerLine(asked, top.text).ok) {
      dropOldLead = first.relevance.meta;
      add('lead_not_best', first.line, first.text, lang === 'ar'
        ? `السطر ${top.line} يجيب أفضل (${top.relevance.score} مقابل ${first.relevance.score}): «${excerptOf(top.text)}»`
        : `Line ${top.line} answers better (${top.relevance.score} vs ${first.relevance.score}): “${excerptOf(top.text)}”`);
    }
    if (SELF_QUESTION.test(question)) add('self_question_from_web', first.line, first.text, lang === 'ar' ? 'سؤال عن المساعد نفسه أُجيب من صفحة ويب' : 'A question about the assistant itself answered from a web page');
    const mismatch = pageSubjectMismatch(reply, topic);
    if (mismatch) add('page_subject_mismatch', first.line, first.text, lang === 'ar'
      ? `الصفحة عن «${mismatch.page}» لا عن «${mismatch.qualifier}»: موضوع السؤال ورد في عنوانها قيدًا بين قوسين فقط`
      : `The page is about “${mismatch.page}”, not “${mismatch.qualifier}”: the question's subject appears in its title only as the qualifier in parentheses`);
  }
  if (kind === 'abstain' && (SELF_QUESTION.test(question) || ['identity', 'smalltalk', 'compute', 'memory_recall'].includes(frame.intent))) {
    add('local_intent_abstained', 1, reply.split('\n')[0] ?? '', lang === 'ar' ? `طلب محلي (${frame.intent}) قوبل بقالب امتناع` : `A local request (${frame.intent}) met an abstention template`);
  }

  // Support: only when the host hands over what the reply was built from, and only when the page the reply names as its
  // source is among those texts. A source page the host did not capture is «not measured», never «unsupported».
  let support: JudgeVerdict['support'] = null;
  // Evidence without addresses (bare texts) is measured as given; addressed evidence must include the reply's source page.
  const sources = sourceUrls(reply);
  const addressed = input.evidence?.filter(item => item.url) ?? [];
  const sourceRead = !sources.length || !addressed.length || addressed.some(item => sources.includes(pageKey(item.url!)));
  // Page text only: a desktop, template or local reply has no page to be found in, whatever the run read before it.
  if (pageText && (kind === 'answer' || kind === 'quote')) {
    if (!input.evidence) add('evidence_unavailable', 0, '', lang === 'ar' ? 'لم تُمرَّر نصوص الأدلة، فلم يُقَس السند' : 'No evidence texts were passed; support not measured');
    else if (!sourceRead) add('evidence_unavailable', 0, sources[0] ?? '', lang === 'ar' ? 'صفحة المصدر المذكورة في الجواب ليست بين الأدلة، فلم يُقَس السند' : 'The source page the reply names is not among the evidence; support not measured');
    else {
      const corpus = [...input.evidence.map(item => comparable(item.text)), ...(input.fixedTexts ?? []).map(comparable), comparable(WITHHOLD_TEXT.ar), comparable(WITHHOLD_TEXT.en),
        ...Object.values(WITHHOLD_COPY.ar).map(comparable), ...Object.values(WITHHOLD_COPY.en).map(comparable)];
      let sentences = 0, supported = 0;
      const candidates = kind === 'quote'
        ? reply.split('\n').map((raw, index) => ({ line: index + 1, raw, text: bare(raw.replace(QUOTE_LINE, '')) })).filter(item => QUOTE_LINE.test(item.raw) && item.text)
        : own;
      for (const item of candidates) {
        for (const sentence of item.text.split(/(?<=[.!?؟])\s+/u)) {
          const parts = sentence.split(/…|\.\.\./u).map(comparable).filter(part => part.length >= JUDGE_THRESHOLDS.supportMinChars);
          if (!parts.length) continue;
          sentences++;
          const found = parts.every(part => corpus.some(text => supportedBy(part, text)));
          if (found) supported++;
          else add('unsupported_sentence', item.line, sentence, lang === 'ar' ? 'جملة ليست من الأدلة ولا من النصوص الثابتة' : 'A sentence found in no evidence text and no fixed text');
        }
      }
      support = { sentences, supported };
    }
  }

  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.line - b.line);
  const codes = [...new Set(findings.map(finding => finding.code))];
  const decision: JudgeDecision = findings.some(finding => finding.severity === 'block') ? 'withhold' : findings.some(finding => finding.severity === 'fix') ? 'fix' : 'send';
  let fixedReply: string | null = null;
  if (decision === 'fix') {
    const lines = reply.split('\n');
    if (lead && best && codes.includes('lead_not_best')) {
      // Promote the better sentence to the lead; the old lead moves among the details, or goes when it was a meta line. Wording stays the page's.
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/u;
      const prefix = (raw: string) => bullet.exec(raw)?.[0] ?? '';
      const leadRaw = lines[lead.line - 1]!, bestRaw = lines[best.line - 1]!;
      lines[lead.line - 1] = prefix(leadRaw) + bestRaw.replace(bullet, '');
      lines[best.line - 1] = dropOldLead ? '' : prefix(bestRaw) + leadRaw.replace(bullet, '');
    }
    // The same form findings the verdict kept, recomputed on the reordered text, so a sentence opening with «كتبت» is never cut.
    const rebuilt = { question, lang, reply: lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim() };
    const recheck = checkReply(rebuilt);
    const rebuiltLines = rebuilt.reply.split('\n');
    fixedReply = applyReplyFixes(rebuilt, { ...recheck, findings: recheck.findings.filter(finding => keepForm(finding.code, rebuiltLines[finding.line - 1])) });
    // A details heading left with nothing under it goes too.
    fixedReply = fixedReply.replace(/\n\n\*\*(?:تفاصيل أخرى من نفس المصدر|More from the same source):\*\*(?=\n\n|$)/gu, '').replace(/\n{3,}/gu, '\n\n').trim();
  }
  return {
    decision, kind, lang, frame: { intent: frame.intent, answerType: frame.answerType, topic }, sourced, codes, findings, lead, best,
    fixedReply, withholdText: decision === 'withhold' ? withholdReply(lang, codes, reply) : null, support, ms: Number((performance.now() - started).toFixed(3)),
  };
}

export function judge(input: JudgeInput): JudgeVerdict {
  const verdict = judgeAnswer(input);
  if (!input.constraints) return verdict;
  const selected = verdict.withholdText ?? verdict.fixedReply ?? input.reply;
  const checked = enforceReplyConstraints(selected, input.constraints);
  if (checked.text === selected) return verdict;
  const decision = verdict.decision === 'withhold' || checked.withheld ? 'withhold' : 'fix';
  const findings = [...verdict.findings, ...checked.findings.map(code => ({
    code, severity: SEVERITY[code], line: 0, excerpt: '', detail: code,
  }))];
  return { ...verdict, decision, findings, codes: [...new Set(findings.map(finding => finding.code))],
    fixedReply: decision === 'fix' ? checked.text : null, withholdText: decision === 'withhold' ? checked.text : null };
}
