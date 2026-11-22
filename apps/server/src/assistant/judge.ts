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
import { checkAnswerLine, isMetaLine } from './answer-check.js';
import { fold, topicWords } from './hands.js';
import { buildFrame } from './mind/frame.js';
import { applyReplyFixes, checkReply, questionLanguage, type ReplyFindingCode } from './reply-check.js';

export type ReplyKind = 'answer' | 'quote' | 'list' | 'computed' | 'memory' | 'question' | 'abstain' | 'action' | 'composed' | 'fixed';
export type JudgeCode = ReplyFindingCode
  | 'lead_meta' | 'lead_ui' | 'lead_off_topic' | 'lead_needs_number' | 'lead_needs_name' | 'fragment_lead' | 'lead_not_best'
  | 'definition_form_missing' | 'duration_unit_missing' | 'self_question_from_web' | 'local_intent_abstained'
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
  definition_form_missing: 'review', duration_unit_missing: 'block', self_question_from_web: 'block', local_intent_abstained: 'review',
  unsupported_sentence: 'block', evidence_unavailable: 'info',
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
  /** A meta line (byline, hatnote) scores this much lower than a plain sentence: it is never the lead. */
  metaPenalty: 3,
} as const;

export const WITHHOLD_TEXT = {
  ar: 'لم أجد في الصفحات التي قرأتها جملة تجيب عن سؤالك مباشرة، فلم أنقل لك جوابًا غير مؤكد. أرسل رابط صفحة مناسبة أو أعد صياغة السؤال.',
  en: 'The pages I read had no sentence that answers your question directly, so I did not pass on an unconfirmed answer. Send a suitable page link or rephrase the question.',
} as const;

const SOURCE_LINE = /^\s*\*\*(?:المصدر|Source):\*\*/u;
const SOURCE_TITLE = /\*\*(?:المصدر|Source):\*\*\s*\[([^\]\n]+)\]/u;
/** Lines of the reply's layout, not of its own sentences: headings, sources, notes, instructions to the user, quotes, result lists. */
const STRUCTURE = /^\s*(?:\*\*(?:المصدر|للمزيد|الموضوع|تفاصيل أخرى من نفس المصدر|Source|More|Subject|More from the same source):\*\*|ملاحظة: هذه معلومات عامة|للتشخيص والعلاج راجع|هذه المعلومات عامة|This is general information|For diagnosis and treatment|قل «|اكتب «|Say «|>|\d+\. \[)/u;
const QUOTE_LINE = /^\s*>\s?/u;
const QUESTION_TO_USER = /أجب عن هذه الأسئلة|هل أتابع\s*؟|سجّل دخولك|اضغط «أكملت»|What would you like me to do|Please rewrite|ما الشيء الذي تقصده|أعد كتابة طلبك|Name the subject and the result|حدّد الشيء المقصود|أعد صياغة الطلب|Rewrite the request|Start a new request|ابدأ طلبًا جديدًا|Do you want me to continue|Shall I continue/u;
const ABSTAIN_LEAD = /^(?:لم أتمكن|لم أتمكّن|لم أنفّذ|لم أنفذ|لم أؤكد|لم أبحث في الويب|لم أجد صفحة|لم أجد نصًا|لم أجد نصاً|لم أتحقق|لم يتضح|لم أستبدل|تعذر|تعذّر|لا توجد صفحة مفتوحة|قراءة نافذة الكمبيوتر غير متاحة|حسنًا، لم أنفّذ|I haven[’']t (?:performed|verified)|I could not|I couldn[’']t|I did not (?:search|perform)|Understood\. I did not|No page is open)/u;
const NEEDS_MODEL = /needs? a (?:writing )?model|يحتاج (?:إلى )?نموذج|لا يوجد نموذج/u;
const COMPUTED = /^[\d٠-٩\s+\-*/=%.,()×÷x^√π:]+$/u;
const MEMORY_LEAD = /^(?:من الذاكرة:|From memory:)/u;
const LIST_ITEM = /^\d+\. \[/u;
const QUOTE_LEAD = /^(?:من \*\*|وصلت إلى|بحثت عن .* فنقلني|From \*\*)/u;
const COMPOSED_LEAD = /^\*\*(?:الموضوع|Subject):\*\*/u;
const ACTION_LEAD = /^(?:كتبت «|ضغطت|فتحت|سجّلت مراجعتك|أعدت قراءة الصفحة|I typed|I clicked|I opened)/u;
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
const ELLIPSIS_END = /(?:…|\.\.\.)$/u;
const QUESTION_WORDS = new Set(['ما', 'ماذا', 'من', 'هو', 'هي', 'كم', 'متى', 'متي', 'أين', 'اين', 'كيف', 'هل', 'لماذا', 'ليش', 'في', 'عن', 'على', 'علي', 'إلى', 'الى', 'مع', 'لي', 'و', 'أو', 'او', 'ثم', 'هذا', 'هذه', 'ذلك',
  'what', 'is', 'are', 'the', 'of', 'in', 'who', 'how', 'when', 'where', 'which', 'does', 'do', 'did', 'a', 'an', 'to', 'for', 'i', 'my', 'me', 'you', 'and', 'or', 'was', 'were', 'it', 'that', 'this', 'please', 'tell', 'with', 'about']);
const ARABIC_SUFFIX = /(?:هما|ها|هم|كم|كن|نا|ني|ك|ه|ي)$/u;

const excerptOf = (text: string) => text.replace(/\s+/gu, ' ').trim().slice(0, 140);
const words = (text: string) => text.split(/\s+/u).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** The own words of a layout line: no bullet, no leading ellipsis, no bold marks or markdown links, no footnote marks. */
const bare = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').replace(ELLIPSIS_START, '').replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
  .replace(/\*\*/gu, '').replace(/\[(?:\d+|[ا-ي]|[a-z])\]/gu, '').replace(/\s+/gu, ' ').trim();
/** Text as the evidence is compared: folded letters, no marks, no punctuation, one space. */
export function comparable(text: string): string {
  return fold(text).replace(/[ً-ْٰـ]/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
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

export interface OwnLine { line: number; raw: string; text: string }
/** The reply's own sentences, by line: not blank, not layout, not a quote. */
export function ownLines(reply: string): OwnLine[] {
  return reply.split('\n').map((raw, index) => ({ line: index + 1, raw, text: bare(raw) }))
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
  if (ACTION_LEAD.test(lead)) return 'action';
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

export interface Relevance { topicHits: number; implied: number; phrase: boolean; cue: boolean; typed: boolean; fragment: boolean; meta: boolean; score: number }
export interface RelevanceContext { question: string; topic: readonly string[]; cues: readonly string[]; titleWords: readonly string[]; answerType: string | null; lang: 'ar' | 'en' }
/**
 * How well one own sentence answers the question: its subject words (those of the page's title count only beside a word
 * of its own, as hands.ts does), the question's phrase in order, the asked relation, the asked type (a number, a
 * duration, a definition), minus a fragment and minus a meta line. Explainable arithmetic, not a model.
 */
export function relevance(text: string, context: RelevanceContext): Relevance {
  const folded = fold(text);
  const inLine = context.topic.filter(word => mentions(folded, word));
  const implied = context.topic.filter(word => !inLine.includes(word) && context.titleWords.some(title => mentions(title, word) || mentions(stem(word), title))).length;
  const topicHits = inLine.length + (inLine.length ? implied : 0);
  const phrase = context.topic.length >= 2 && new RegExp(context.topic.map(word => `(?:ال)?${escape(stem(word))}`).join('\\S*\\s+'), 'u').test(folded);
  const cue = context.cues.some(word => folded.includes(word));
  const hasNumber = /[\d٠-٩]/u.test(text);
  const duration = DURATION_QUESTION.test(context.question);
  const typed = duration ? hasNumber && DURATION_UNIT.test(text)
    : context.answerType === 'number' || context.answerType === 'money' || context.answerType === 'date' ? hasNumber
    : context.answerType === 'definition' ? definitionForm(text, context.topic)
    : false;
  const fragment = isFragment(text, context.lang);
  const meta = isMetaLine(text);
  const score = topicHits + (phrase ? 2 : 0) + (cue ? 1 : 0) + (typed ? context.answerType === 'definition' ? 2 : 1 : 0) - (fragment ? 1 : 0) - (meta ? JUDGE_THRESHOLDS.metaPenalty : 0);
  return { topicHits, implied, phrase, cue, typed, fragment, meta, score };
}

/** «الذكاء الاصطناعي (AI) هو …», «Photosynthesis is …»: the subject within the first three words, then a copula soon after. */
export function definitionForm(text: string, topic: readonly string[]): boolean {
  const folded = fold(text).replace(/\([^)]*\)/gu, ' ').replace(/\s+/gu, ' ').trim();
  const head = words(folded).slice(0, 3).join(' ');
  if (!topic.some(word => mentions(head, word))) return false;
  const opening = words(folded).slice(0, 12).join(' ');
  return COPULA.test(opening);
}

/** A sentence cut from its context: an ellipsis, a connective or pronoun opening, a timestamp, a lowercase start, a glued run. */
export function isFragment(text: string, lang: 'ar' | 'en'): boolean {
  const trimmed = text.trim();
  if (ELLIPSIS_START.test(trimmed) || ELLIPSIS_END.test(trimmed)) return true;
  if (TIMESTAMP.test(trimmed)) return true;
  if (words(trimmed).length > JUDGE_THRESHOLDS.fragmentMaxWords) return true;
  if (ARABIC_CONNECTIVE.test(trimmed)) return true;
  if (ENGLISH_CONNECTIVE.test(trimmed)) return true;
  if (lang === 'en' && /^[a-z]/u.test(trimmed) && !/^(?:e\.g\.|i\.e\.)/u.test(trimmed)) return true;
  return false;
}

export function judge(input: JudgeInput): JudgeVerdict {
  const started = performance.now();
  const question = input.question ?? '';
  const reply = input.reply ?? '';
  const lang = questionLanguage(question);
  const frame = buildFrame(question);
  let topic = topicWords(question);
  if (topic.length < 2 && input.previous) topic = [...new Set([...topic, ...topicWords(input.previous)])];
  const sourced = reply.split('\n').some(line => SOURCE_LINE.test(line)) || Boolean(input.evidence?.some(item => item.kind === 'page'));
  const kind = replyKind(input, frame.intent, sourced);
  const findings: JudgeFinding[] = [];
  const add = (code: JudgeCode, line: number, excerpt: string, detail: string, severity = SEVERITY[code]) => findings.push({ code, severity, line, excerpt: excerptOf(excerpt), detail });

  // Form: the pre-send checks, as they are.
  const form = checkReply({ question, reply });
  for (const finding of form.findings) add(finding.code, finding.line, finding.excerpt, finding.detail, finding.severity === 'fix' ? 'fix' : SEVERITY[finding.code]);

  const own = ownLines(reply);
  const cues = cueWords(question, topic);
  const titleWords = sourceTitleWords(reply);
  let lead: ScoredLine | null = null, best: ScoredLine | null = null, dropOldLead = false;

  if (kind === 'answer' && sourced && own.length) {
    const context: RelevanceContext = { question, topic, cues, titleWords, answerType: frame.answerType, lang };
    const scored = own.map(item => ({ ...item, relevance: relevance(item.text, context) }));
    const first = scored[0]!;
    lead = { line: first.line, text: first.text, score: first.relevance.score };
    const top = [...scored].sort((a, b) => b.relevance.score - a.relevance.score || a.line - b.line)[0]!;
    best = { line: top.line, text: top.text, score: top.relevance.score };

    const check = checkAnswerLine(question, first.text);
    const anyNumber = scored.some(item => /[\d٠-٩]/u.test(item.text));
    const bylineFixed = form.findings.some(finding => finding.code === 'byline_lead' && finding.line === first.line);
    for (const reason of check.reasons) {
      if (reason === 'meta_line') add('lead_meta', first.line, first.text, lang === 'ar' ? 'السطر الأول عن الصفحة لا عن الموضوع' : 'The first line is about the page, not the subject', bylineFixed ? 'review' : 'block');
      else if (reason === 'ui_text') add('lead_ui', first.line, first.text, lang === 'ar' ? 'السطر الأول من واجهة الموقع' : 'The first line is interface text');
      else if (reason === 'needs_number') add('lead_needs_number', first.line, first.text, anyNumber
        ? (lang === 'ar' ? 'سؤال عددي والسطر الأول بلا رقم، ورقم في سطر لاحق' : 'A number question whose first line has no number; a later line has one')
        : (lang === 'ar' ? 'سؤال عددي ولا رقم في أي سطر' : 'A number question with no number in any line'), anyNumber ? 'review' : 'block');
      else if (reason === 'needs_name') add('lead_needs_name', first.line, first.text, lang === 'ar' ? 'سؤال عن شخص والسطر الأول بلا اسم' : 'A who question whose first line names nobody');
      // 'language' is covered by language_mismatch over the whole reply; 'off_topic' is decided below with the page's title.
    }
    if (topic.length && first.relevance.topicHits === 0) {
      add('lead_off_topic', first.line, first.text, lang === 'ar' ? `لا يذكر السطر الأول أي كلمة من الموضوع (${topic.join('، ')})` : `The first line names none of the subject words (${topic.join(', ')})`);
    }
    if (first.relevance.fragment) add('fragment_lead', first.line, first.text, lang === 'ar' ? 'السطر الأول مقطوع من سياقه: يبدأ بأداة ربط أو بنقاط حذف أو بوقت، أو طويل كجدول' : 'The first line is cut from its context: a connective, an ellipsis, a timestamp or a table-long run');
    if (frame.answerType === 'definition' && frame.intent === 'fact_question' && !SUPERLATIVE.test(question) && !first.relevance.typed) {
      add('definition_form_missing', first.line, first.text, lang === 'ar' ? 'سؤال تعريف والسطر الأول ليس بصيغة «X هو …»' : 'A definition question whose first line is not «X is …»');
    }
    if (DURATION_QUESTION.test(question) && !scored.some(item => item.relevance.typed)) {
      add('duration_unit_missing', first.line, first.text, lang === 'ar' ? 'سؤال عن مدة ولا سطر فيه رقم مع وحدة زمن' : 'A how-long question with no line holding a number and a time unit');
    }
    if (top.line !== first.line && top.relevance.score - first.relevance.score >= JUDGE_THRESHOLDS.leadNotBestMargin) {
      dropOldLead = first.relevance.meta;
      add('lead_not_best', first.line, first.text, lang === 'ar'
        ? `السطر ${top.line} يجيب أفضل (${top.relevance.score} مقابل ${first.relevance.score}): «${excerptOf(top.text)}»`
        : `Line ${top.line} answers better (${top.relevance.score} vs ${first.relevance.score}): “${excerptOf(top.text)}”`);
    }
    if (SELF_QUESTION.test(question)) add('self_question_from_web', first.line, first.text, lang === 'ar' ? 'سؤال عن المساعد نفسه أُجيب من صفحة ويب' : 'A question about the assistant itself answered from a web page');
  }
  if (kind === 'abstain' && (SELF_QUESTION.test(question) || ['identity', 'smalltalk', 'compute', 'memory_recall'].includes(frame.intent))) {
    add('local_intent_abstained', 1, reply.split('\n')[0] ?? '', lang === 'ar' ? `طلب محلي (${frame.intent}) قوبل بقالب امتناع` : `A local request (${frame.intent}) met an abstention template`);
  }

  // Support: only when the host hands over what the reply was built from.
  let support: JudgeVerdict['support'] = null;
  if (kind === 'answer' || kind === 'quote') {
    if (!input.evidence) add('evidence_unavailable', 0, '', lang === 'ar' ? 'لم تُمرَّر نصوص الأدلة، فلم يُقَس السند' : 'No evidence texts were passed; support not measured');
    else {
      const corpus = [...input.evidence.map(item => comparable(item.text)), ...(input.fixedTexts ?? []).map(comparable), comparable(WITHHOLD_TEXT.ar), comparable(WITHHOLD_TEXT.en)];
      let sentences = 0, supported = 0;
      const candidates = kind === 'quote'
        ? reply.split('\n').map((raw, index) => ({ line: index + 1, raw, text: bare(raw.replace(QUOTE_LINE, '')) })).filter(item => QUOTE_LINE.test(item.raw) && item.text)
        : own;
      for (const item of candidates) {
        for (const sentence of item.text.split(/(?<=[.!?؟])\s+/u)) {
          const parts = sentence.split(/…|\.\.\./u).map(comparable).filter(part => part.length >= JUDGE_THRESHOLDS.supportMinChars);
          if (!parts.length) continue;
          sentences++;
          const found = parts.every(part => corpus.some(text => text.includes(part)));
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
    fixedReply = applyReplyFixes({ question, reply: lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim() });
    // A details heading left with nothing under it goes too.
    fixedReply = fixedReply.replace(/\n\n\*\*(?:تفاصيل أخرى من نفس المصدر|More from the same source):\*\*(?=\n\n|$)/gu, '').replace(/\n{3,}/gu, '\n\n').trim();
  }
  return {
    decision, kind, lang, frame: { intent: frame.intent, answerType: frame.answerType, topic }, sourced, codes, findings, lead, best,
    fixedReply, withholdText: decision === 'withhold' ? WITHHOLD_TEXT[lang] : null, support, ms: Number((performance.now() - started).toFixed(3)),
  };
}
