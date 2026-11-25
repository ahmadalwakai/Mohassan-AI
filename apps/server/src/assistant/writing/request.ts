import { pdfPaths } from '../documents.js';
import { analyzeCompoundRequest, MAX_COMPOUND_ACTIONS } from '../compound-request.js';
import { normalizeRequest } from '../mind/normalize.js';
import { requestActionText } from '../request-context.js';
import { assessRequestScope, requestOperationText, requestScopeActionText } from '../request-scope.js';
import { sentenceSpans, type WritingLanguage } from './evidence.js';
import type { RestructureOptions } from './restructure.js';
import type { WritingFormat } from './summary.js';

type SourceRequest =
  | { kind: 'paste'; text: string; offset: number }
  | { kind: 'previous_text' }
  | { kind: 'page'; recent: boolean; all: boolean }
  | { kind: 'urls'; urls: string[] }
  | { kind: 'pdf'; paths: string[]; all: boolean }
  | { kind: 'search'; query: string }
  | { kind: 'missing' };

export interface ExtractiveWritingTask {
  kind: 'summary' | 'explanation' | 'comparison' | 'restructure';
  language: WritingLanguage;
  format: WritingFormat;
  source: SourceRequest;
  instruction: string;
  count?: number;
  topic?: string;
  subjects?: string[];
  intent?: 'why' | 'how';
  opensSource?: boolean;
  structure: RestructureOptions;
}

const SUMMARY = /^(?:summari[sz]e|give (?:me )?(?:a |the )?summary of|provide (?:a |the )?summary of|shorten|لخص(?:لي|ها|ه|هم)?|اختصر(?:ها|ه|هم)?|اعطني ملخص(?:ا)?(?: عن| ل)?)(?!\p{L})/iu;
const EXPLAIN = /^(?:explain(?: to me| for me)?|describe how|how (?:does|do|did)|how it works|[اأإ]شرح(?:لي|ها|ه)?(?: لي)?|وضح(?:لي|ها|ه)?(?: لي)?|فسر(?:لي|ها|ه)?(?: لي)?|كيف (?:يعمل|تعمل|يشتغل|تشتغل))(?!\p{L})/iu;
const COMPARE = /^(?:compare|contrast|what(?: is|'s|’s) (?:the )?difference between|ما (?:هو )?(?:الفرق|الاختلاف) بين|قارن(?: لي)?(?: بين)?)(?!\p{L})/iu;
const RESTRUCTURE = /^(?:restructure|rearrange|re-?format|organi[sz]e|sort|order|(?:turn|convert|change|rewrite|put)\b.{0,100}?(?:into|as) (?:a |the )?(?:paragraphs?|bullet points?|bullets?|a list|points)|(?:add|use) headings|(?:extract|list|identify|pull out) (?:the )?(?:action items|tasks|to-dos|due dates|dates|deadlines)|رتب|اعد ترتيب|اعد تنظيم|اعد تنسيق|نظم|حول\s+.{0,100}?(?:الي|ل)\s*(?:فقر|نقاط|قائم)|(?:اضف|ضع) عناوين|(?:استخرج|حدد) (?:المهام|اجراءات|الاجراءات|بنود العمل|التواريخ|المواعيد))(?!\p{L})/iu;
const URL = /https?:\/\/[^\s<>"'«»“”]+/giu;
const PDF = /(?:\bpdf\b|\.pdf(?=$|[\s"'»”])|(?<!\p{L})(?:ملف|مستند) (?:مرفق|مرفوع)(?!\p{L}))/iu;
const LINK_REF = /\b(?:pages?|sites?|sources?|articles?|links?|reports?)\b|(?<!\p{L})(?:الصفح[هة]|صفح[هة]|المصادر|مصادر|الموقع|المواقع|المقالات|الروابط|الرابط|المقال)(?!\p{L})/iu;
const PAGE_REFERENCE = /\b(?:(?:the|this|that|these|those)\s+)?(?:(?:open|current)\s+)(?:pages?|sites?|sources?|articles?|links?|reports?)\b|\b(?:the|this|that|these|those)\s+(?:pages?|sites?|sources?|articles?|links?|reports?)\b|(?:هذا|هذه|الصفح|الرابط|المصادر|المفتوح)/iu;
const RECENT = /\b(?:last|latest|previous|prior|read earlier|you (?:have )?(?:read|found|opened)|above|earlier)\b|(?:اخر|السابق|سابقا|قرات|قريتها|الماضي|اعلاه|فتحته)/iu;
const PREVIOUS_TEXT = /\b(?:my|the) (?:last|previous|earlier) (?:message|text|notes?|paragraphs?)\b|\b(?:text|notes?|message) (?:i (?:sent|pasted|gave|provided)|above|from (?:the )?previous message)\b|(?:النص|رسالتي|الرساله|الملاحظات) (?:الذي |التي )?(?:ارسلت|ارسلته|ارسلته لك|كتبته|كتبته لك|لصقته|اعلاه|السابق|السابقه)|(?:اخر|السابق) (?:رساله|نص)/iu;
const TEXT_TARGET = /\b(?:text|notes?|paragraphs?|sentences?|bullets?|bullet points?)\b|(?<!\p{L})(?:النص|نص|الملاحظات|الملاحظه|الفقره|الفقرات|النقاط|نقاط)(?!\p{L})/iu;
const LITERAL_TARGET = /\b(?:this|the following|following|provided|supplied|pasted) (?:text|sentence|phrase|paragraph|quote|quotation)$|(?<!\p{L})(?:النص|الجمله|العباره|الفقره|الاقتباس)(?: (?:التاليه?|الملصقه?))?$/iu;
const OWNED_REPORT = /\b(?:my|our) (?:last |latest |previous )?reports?\b|(?<!\p{L})(?:تقريري|تقريرنا|تقاريري|تقاريرنا)(?!\p{L})/iu;
const ALL = /\b(?:all|both|multiple|several)\b|(?:كل|جميع|كلا|المصدرين|الصفحتين|الملفين)/iu;
const LINE = /\b(?:one|single|1) (?:line|sentence)\b|(?<!\p{L})(?:سطر|جمله) واحد[هة]|(?<!\p{L})بسطر(?!\p{L})/iu;
const PARAGRAPH = /\b(?:paragraphs?|prose)\b|(?<!\p{L})(?:الفقرات|الفقره|فقرات|فقره|فقرتين)(?!\p{L})/iu;
const BULLETS = /\b(?:bullet(?: points?)?s?|as a list|into a list|in (?:(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+) )?points)\b|(?<!\p{L})(?:النقاط|نقاط|في نقاط|بنقاط|قائمه نقطيه)(?!\p{L})/iu;
const TABLE = /\b(?:table|tabular)\b|(?<!\p{L})(?:الجدول|جدول)(?!\p{L})/iu;
const SHORT = /\b(?:short|brief|briefly|concise|quick)\b|(?<!\p{L})(?:باختصار|موجز|مختصر|مختصره|بسرعه)(?!\p{L})/iu;
const DETAILED = /\b(?:detailed|in detail|in depth|comprehensive)\b|(?<!\p{L})(?:بالتفصيل|مفصل|مفصله)(?!\p{L})/iu;
const DATE_ORDER = /\b(?:chronological(?:ly)?|by date|newest first|oldest first|latest first)\b|(?:حسب التاريخ|حسب التواريخ|زمنيا|ترتيب زمني|الاحدث|الاقدم)/iu;
const EXTRACT = /^(?:extract|list|identify|pull out|استخرج|حدد)(?!\p{L})/iu;
const ACTIONS = /\b(?:action items|tasks|to-dos)\b|(?:المهام|الاجراءات|اجراءات|بنود العمل)/iu;
const DATES = /\b(?:dates|deadlines)\b|(?:التواريخ|المواعيد)/iu;
const QUOTES: Record<string, string> = { '«': '»', '“': '”', '"': '"', '‘': '’', "'": "'" };
const QUOTED_TEXT = /(?:«([^»]+)»|“([^”]+)”|"([^"]+)"|‘([^’]+)’|(?<![\p{L}\p{N}])'([^']+)'(?![\p{L}\p{N}]))/gu;
const FORMAT_SUFFIX = /(?:\s+|[,،]\s*)(?:(?:in|as) (?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|\d+) )?(?:(?:short|single|brief) )?(?:sentences?|paragraphs?|lines?|bullet(?: points?)?s?|points|table|list|detail|depth)|briefly|concisely|side by side|with headings|في (?:جدول|سطر(?: واحد)?|فقرة(?: واحدة)?|نقاط)|بالتفصيل|باختصار)$/iu;
const TERMINAL = /[\s.!?؟]+$/u;
const PROCESS_QUESTION = /^how (?:does|do|did)\b/iu;
const PROCESS_SUFFIX = /\s+(?:work(?:s)?|operat(?:e|es)|function(?:s)?)$/iu;
const WHY_QUESTION = /^(?:why(?:\s+(?:does|do|did|is|are|was|were))?|what causes|لماذا|ليش|ليه|ما (?:سبب|[أا]سباب))(?=\s+[\p{L}\p{N}])\s+/iu;
const HOW_QUESTION = /^(?:how(?:\s+(?:does|do|did|is|are|was|were|can|could|would|should))?|كيف|[إا]زاي|(?:شو|وش|[أا]يش|ما) (?:هي )?الطريق[هة])(?=\s+[\p{L}\p{N}])\s+/iu;
const NON_EXPLANATION = /^(?:how (?:about|much|many|long|far|old|often|soon|tall|high|deep|wide|large|big|fast|heavy|strong|weak|cold|hot|warm|humid|windy|wet|dry)\b|how (?:does|do|did|can|could|would|should) you\b|how are you\b|كيف (?:حالك|حالكم|[أا]شغل المتصفح|[أا]فتح المتصفح)(?!\p{L}))/iu;
const UNBOUND_QUESTION_SUBJECT = /^(?:it|this|that|them|they|there|هذه|هذا|تلك|ذلك)(?!\p{L})/iu;
const IMPERSONAL_QUESTION = /^(?:why|how)\s+(?:is|was)\s+it\s+[a-z]+\s+(?:for [a-z][a-z -]{1,50}? )?to\s+[a-z]/iu;
const OWNED_QUESTION = /(?<!\p{L})(?:my|our|mine|ours|لدينا|عندنا|(?:ال)?خاص[هة]? (?:بي|بنا)|تخصني)(?!\p{L})/iu;
const PERSON_SPECIFIC_QUESTION = /^(?:i\b|we\s+(?:[a-z]{3,}ed|had|were|did|got|lost|left|went|made|took|put)\b)/iu;
const ANSWER_PREFIX = /^(?:explain(?: to me| for me)?|describe|tell me|teach me|say|[اأإ]شرح(?:لي|ها|ه)?(?: لي)?|وضح(?:لي|ها|ه)?(?: لي)?|فسر(?:لي|ها|ه)?(?: لي)?|علمني|خبرني|احكيلي|قولي|قول لي|قل لي)\s+/iu;
const FOLLOWUP_COMPARE = /^(?:(?:tell me|say|show me) (?:which|who)\s|(?:عطني|اعطني|خبرني|احكيلي|قولي|قل لي) (?:الفرق|[أا]ي(?:هما|هم)?)(?!\p{L}))/iu;
const COMPARATIVE_WORDING = /(?<!\p{L})(?:difference|more|less|fewer|cheaper|costlier|larger|smaller|longer|shorter|faster|slower|higher|lower|earlier|later|better|worse|الفرق|[أا](?:كثر|قل|كبر|صغر|طول|قصر|سرع|بطا|علي|دني|رخص|غلي|فضل))(?!\p{L})/iu;
const READ_AND_ANSWER = /^(?:(?:please|kindly|can you|could you|would you|من فضلك|لو سمحت|ممكن|هل يمكنك)\s+)*(?:open|read|visit|go to|[أا]فتح|[أا]قر[أا]|زر)\s+(https?:\/\/[^\s<>"'«»“”]+)(?:\s+(?:and(?: then)?|then)\s+|[.,،؛;]\s+|\s+(?:ثم\s+|و\s*|(?=(?:اشرح|وضح|فسر|علمني|خبرني|احكيلي|قارن))))(.+)$/isu;
const EXTRA_ACTION = /(?:\b(?:and(?: then)?|then|also)\s+(?:sign in|log in|click|type|submit|download|upload|buy|book|pay|share|install|order|register)\b|(?:\s+(?:ثم|وبعدين)\s+|\s+و)(?:انقر|اضغط|اكتب|سجل|اشتر|احجز|حمل|نزّل|ارفع|ادفع|شارك|ثبت)(?!\p{L}))/iu;
const PREPOSITIONAL_SEQUENCE = /(?:\bfrom\s+[^.!?؟;؛]+?\s+(?:to|into|through)\s+|(?<!\p{L})من\s+[^.!?؟;؛]+?\s+الي\s+)/iu;
const PREPOSITIONAL_CONTINUATION = /^(?:to\s+(?:the|an?|another|its|their|each)\s+|(?:into|through|towards?|الي|عبر|نحو)\s+(?!(?:ان|أن)(?!\p{L})))\p{L}/iu;
const RECENT_TOPIC = /^(?:it|this|that|هذا|هذه|ذلك)$/iu;
const SOURCE_ONLY_TOPIC = /^(?:(?:the|this|that|these|those|following|provided|supplied|attached|النص|هذا|هذه|ذلك)\s+)*(?:text|phrase|sentence|paragraph|quote|quotation|pages?|articles?|documents?|sources?|links?|pdfs?|الصفح[هة]|الصفحات|المقال|المصادر|النص|الروابط)$/iu;
const OPERAND_DELIMITERS = /\band\b|(?<!\p{L})و(?!\p{L})|[\s,،;؛.()[\]<>"'«»‘’“”-]/giu;

function unwrapAddress(value: string): string {
  let address = value.replace(/[.,،؛!?؟]+$/u, '');
  for (const [closing, opening] of [[')', '('], [']', '['], ['}', '{']]) {
    const excess = address.split(closing).length - address.split(opening).length;
    for (let count = 0; count < excess && address.endsWith(closing); count++) address = address.slice(0, -1);
  }
  return address;
}

function urlsIn(value: string): string[] {
  const urls = new Set<string>();
  for (const match of value.matchAll(URL)) {
    const url = writingUrl(unwrapAddress(match[0]));
    if (url) urls.add(url);
  }
  return [...urls];
}

export function writingUrl(value: string): string | null {
  const url = globalThis.URL.parse(value);
  return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
}

function onlyPdfPaths(value: string): boolean {
  const paths = pdfPaths(value);
  if (!paths.length) return false;
  const rest = paths.reduce((left, path) => left.replaceAll(path, ''), value);
  return !rest.replace(OPERAND_DELIMITERS, '').length;
}

function rawBody(request: string): { instruction: string; content?: { text: string; offset: number } } {
  const quotedText = [...request.matchAll(QUOTED_TEXT)];
  const operands = [...request.matchAll(URL), ...quotedText];
  const separator = [...request.matchAll(/[:：\r\n]/gu)].find(match =>
    !operands.some(item => match.index >= item.index && match.index < item.index + item[0].length)
    && !/[A-Za-z]:[\\/]/u.test(request.slice(match.index - 1, match.index + 2)));
  if (separator) {
    const instruction = request.slice(0, separator.index);
    const tail = request.slice(separator.index + 1);
    const head = requestOperationText(instruction);
    // A label followed only by addresses supplies links; a URL inside prose is literal data.
    if (!LITERAL_TARGET.test(withoutPresentation(head))) {
      if (!tail.replace(URL, '').replace(OPERAND_DELIMITERS, '').length) return { instruction: request };
      if ((PDF.test(head) || !TEXT_TARGET.test(head)) && onlyPdfPaths(tail)) return { instruction: request };
    }
    if (SUMMARY.test(head) || EXPLAIN.test(head) || COMPARE.test(head) || RESTRUCTURE.test(head)) {
      const leading = tail.length - tail.trimStart().length;
      let offset = separator.index + 1 + leading;
      let text = tail.trim();
      if (QUOTES[text[0]] && text.endsWith(QUOTES[text[0]]) && text.length > 2) {
        offset++;
        text = text.slice(1, -1);
      }
      if (text) return { instruction, content: { text, offset } };
    }
  }
  const quoted = quotedText.findLast(match => {
    const tail = request.slice(match.index + match[0].length).replace(TERMINAL, '');
    return !tail || FORMAT_SUFFIX.exec(tail)?.[0] === tail;
  });
  if (quoted) {
    const instruction = request.slice(0, quoted.index) + request.slice(quoted.index + quoted[0].length);
    const head = requestOperationText(instruction);
    const literal = quoted.slice(1).find(value => value !== undefined)!;
    const explicitLiteral = LITERAL_TARGET.test(withoutPresentation(head));
    const namedSource = PDF.test(head) || /\.pdf$/iu.test(literal) || LINK_REF.test(head) || writingUrl(literal);
    const explainLiteral = EXPLAIN.test(head) && (/(?:this|following|النص|هذا|التالي)\s*$/iu.test(withoutPresentation(head))
      || sentenceSpans({ title: '', text: literal }).length > 1);
    // Explicit literal instructions win over addresses inside their quotes.
    if (explicitLiteral && EXPLAIN.test(head) || !namedSource && (SUMMARY.test(head) || RESTRUCTURE.test(head) || explainLiteral)) {
      return { instruction, content: { text: literal, offset: quoted.index + 1 } };
    }
  }
  return { instruction: request };
}

function withoutPresentation(text: string): string {
  return text.replace(TERMINAL, '').replace(FORMAT_SUFFIX, '').trim();
}

function withoutSourceClues(text: string): string {
  return text
    .replace(/\s+(?:using|from|with|on) (?:(?:the|this|that) )?(?:pages?|sources?|links?)\b.*$|\s+(?:من|باستخدام|في) (?:(?:هذه|هذا|تلك) )?(?:المصادر|الصفحات|الصفحة|الروابط).*$/isu, '')
    .replace(/\s+(?:using|from|with|من|باستخدام)\s+(?=https?:\/\/).*$/isu, '')
    .replace(URL, ' ').trim();
}

function topicIn(instruction: string, kind: ExtractiveWritingTask['kind']): string {
  let topic = withoutSourceClues(instruction.replace(/^(?:(?:please|kindly|can you|could you|would you|من فضلك|لو سمحت|ممكن|هل يمكنك)\s+)+/iu, ''));
  topic = withoutPresentation(topic).replace(/\s+(?:using|from|with|من|باستخدام)\s*$/iu, '');
  if (kind === 'comparison') topic = topic.replace(COMPARE, '');
  if (kind === 'explanation') {
    topic = topic.replace(/[\u064b-\u065f]/gu, '').replace(EXPLAIN, '').replace(/^\s*(?:how|what (?:is|are)|كيف|ما (?:هو|هي))\s+/iu, '')
      .replace(/^\s*(?:works?|تعمل|يعمل|يشتغل|تشتغل)\s+/iu, '').replace(PROCESS_SUFFIX, '')
      .replace(/\s+(?:يعمل|تعمل|يشتغل|تشتغل)$/iu, '');
  }
  return topic.replace(/^[\s:：«“"']+|[\s.!?؟»”"']+$/gu, '');
}

function answerWithoutActions(answer: string): boolean {
  for (let index = 0; index < MAX_COMPOUND_ACTIONS; index++) {
    const analysis = analyzeCompoundRequest(answer);
    if (EXTRA_ACTION.test(requestOperationText(analysis.outerText))) return false;
    if (analysis.kind === 'single') return true;
    // A prepositional chain can describe several destinations in one question.
    // Recheck each remaining clause so a later explicit action still keeps its own route.
    if (analysis.kind !== 'unsupported_tail' || !analysis.tail
      || index === 0 && !PREPOSITIONAL_SEQUENCE.test(requestOperationText(analysis.primary.text))
      || !PREPOSITIONAL_CONTINUATION.test(requestOperationText(analysis.tail.text))) return false;
    answer = analysis.tail.text;
  }
  return false;
}

function readAndAnswer(instruction: string): { answer: string; url: string } | null {
  const match = READ_AND_ANSWER.exec(instruction);
  if (!match) return null;
  const url = writingUrl(unwrapAddress(match[1]!));
  const answer = match[2]!.trim();
  if (!url || urlsIn(answer).length || !answerWithoutActions(answer)) return null;
  return { answer, url };
}

function questionIntent(value: string): 'why' | 'how' | undefined {
  if (WHY_QUESTION.test(value)) return 'why';
  if (HOW_QUESTION.test(value) && !NON_EXPLANATION.test(value)) return 'how';
}

function comparisonSubjects(topic: string): string[] {
  const subjectText = topic.replace(FOLLOWUP_COMPARE, '').trim()
    .replace(/^(?:the\s+[^,،]{1,80}?\s+(?:of|for|between)|(?:الفرق|الاختلاف)?(?:\s*في [^،,]{1,60}?)?\s*بين)\s+/iu, '')
    .replace(/\s+(?:in terms of|with respect to|with regard to|as)\s+[^,،]+$/iu, '');
  const split = (text: string) => text.split(/\s+(?:(?:and|or|vs\.?|versus|مقابل|ولا)\s+|و\s*)/iu)
    .map(value => value.trim()).filter(Boolean);
  const subjects = split(subjectText);
  if (subjects.length > 2) {
    const unqualified = split(subjectText.replace(/\s+(?:in|في)\s+[^,،]+$/iu, ''));
    if (unqualified.length === 2) return unqualified;
  }
  return subjects;
}

export function parseExtractiveWriting(request: string): ExtractiveWritingTask | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 8000) return null;
  const { instruction, content } = rawBody(request);
  const outer = requestActionText(requestScopeActionText(instruction));
  const read = content ? null : readAndAnswer(outer);
  const operand = read?.answer ?? outer;
  const head = requestOperationText(operand);
  const question = operand.replace(ANSWER_PREFIX, '');
  const questionHead = requestOperationText(question);
  const intent = questionIntent(questionHead);
  const questionPrefix = intent === 'why' ? WHY_QUESTION : HOW_QUESTION;
  const questionSubject = questionHead.replace(questionPrefix, '');
  const legacyProcess = PROCESS_QUESTION.test(head) && PROCESS_SUFFIX.test(withoutPresentation(withoutSourceClues(head)));
  const localQuestion = intent && !read && !content && (OWNED_QUESTION.test(questionHead)
    || PERSON_SPECIFIC_QUESTION.test(questionSubject) || /^(?:why|how) (?:did|were|was) we\b/iu.test(questionHead));
  if (localQuestion) return null;
  const hasSubject = !UNBOUND_QUESTION_SUBJECT.test(questionSubject) || IMPERSONAL_QUESTION.test(questionHead);
  // A named public question can use evidence search. Preserve the ordinary
  // routes for private records, assistant capabilities, values, and unnamed past incidents.
  const standaloneQuestion = Boolean(intent && !read && !content && !/^how did\b/iu.test(head)
    && hasSubject && assessRequestScope(outer).scope !== 'private'
    && answerWithoutActions(operand));
  if (intent && !read && !content && !legacyProcess && !standaloneQuestion) return null;
  // Compound actions and translation stay with their existing routes.
  if (/\b(?:and(?: then)?|then)\s+(?:send|publish|delete|open|save|click|write|translate|paraphrase|rewrite|email (?:it|them|that|this))\b|(?:ثم|وبعدين)\s+(?:ارسل|انشر|احذف|افتح|احفظ|ترجم|اكتب)(?!\p{L})|(?:وارسل|وانشر|وترجم|واعد صياغه)(?!\p{L})/iu.test(head)) return null;
  const kind = COMPARE.test(head) || read && FOLLOWUP_COMPARE.test(head) && COMPARATIVE_WORDING.test(head) ? 'comparison'
    : read ? intent || EXPLAIN.test(head) ? 'explanation' : null
      : SUMMARY.test(head) ? 'summary' : standaloneQuestion || EXPLAIN.test(head) ? 'explanation'
        : RESTRUCTURE.test(head) ? 'restructure' : null;
  if (!kind || !read && !standaloneQuestion && (/^how do (?:i|you)\b/iu.test(head)
    || PROCESS_QUESTION.test(head) && !legacyProcess)) return null;
  const previousText = PREVIOUS_TEXT.test(head);
  const textTarget = TEXT_TARGET.test(head);
  const dateOrder = DATE_ORDER.test(head);
  if (kind === 'restructure' && !previousText && !textTarget && !content) return null;
  if (kind === 'restructure' && !previousText && !textTarget && /^(?:sort|order|organi[sz]e|رتب|نظم)(?!\p{L})/iu.test(head) && !dateOrder) return null;
  const language = /^(?:summari[sz]e|give|provide|shorten|restructure|rearrange|re-?format|organi[sz]e|sort|order|turn|convert|change|rewrite|put|add|use|extract|list|identify|pull)\b/iu.test(head) ? 'en' : normalizeRequest(outer).lang;
  const formatText = head.replace(URL, ' ');
  // For conversions, the requested destination is the text after "into"/«إلى».
  const presentation = kind === 'restructure' ? formatText.split(/\s+(?:into|as|الي)\s+/iu).at(-1)!
    : FORMAT_SUFFIX.exec(formatText.replace(TERMINAL, ''))?.[0] ?? formatText;
  const format = LINE.test(presentation) ? 'line' : TABLE.test(presentation) ? 'table' : BULLETS.test(presentation) ? 'bullets'
    : PARAGRAPH.test(presentation) ? 'paragraph' : DETAILED.test(presentation) ? 'detailed'
      : SHORT.test(presentation) && kind !== 'restructure' ? 'line' : kind === 'comparison' ? 'table'
        : kind === 'restructure' ? 'bullets' : 'paragraph';
  const quantity = /(?<!\p{N})(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:brief |short )?(?:bullet(?: points?)?s?|sentences?|points|نقاط|جمل|اسطر)(?!\p{L})/iu.exec(presentation)?.[1];
  const numberWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const count = quantity ? Number(quantity) || numberWords.indexOf(quantity) + 1 : undefined;
  const headings = /\bheadings?\b|(?:عناوين|عنوان)/iu.test(head);
  const chronological = dateOrder ? /(?:newest first|latest first|descending|تنازليا|الاحدث اولا|من الاحدث)/iu.test(head) ? 'descending' : 'ascending' : undefined;
  const extract = EXTRACT.test(head)
    ? ACTIONS.test(head) ? DATES.test(head) ? 'both' : 'actions' : DATES.test(head) ? 'dates' : undefined
    : undefined;

  const urls = read ? [read.url] : urlsIn(outer);
  const paths = PDF.test(head) && !urls.length ? pdfPaths(outer) : [];
  const topic = kind === 'explanation' && intent && !legacyProcess && !RECENT_TOPIC.test(questionHead)
    ? topicIn(question.replace(questionPrefix, ''), kind)
    : topicIn(operand, kind);
  if (kind === 'explanation' && !content && /^(?:you|yourself|[اأإ]نت|نفسك)$/iu.test(topic)) return null;
  const subjects = kind === 'comparison' ? comparisonSubjects(topic) : undefined;
  let source: SourceRequest = { kind: 'missing' };
  if (content) source = { kind: 'paste', ...content };
  else if (previousText) source = { kind: 'previous_text' };
  else if (kind !== 'restructure') {
    if (urls.length) source = { kind: 'urls', urls };
    else if (PDF.test(head)) source = { kind: 'pdf', paths, all: ALL.test(head) };
    else if (!OWNED_REPORT.test(head) && LINK_REF.test(head) && (RECENT.test(head) || ALL.test(head) || PAGE_REFERENCE.test(head))) {
      const pluralSources = /المصادر|\bsources\b/iu.test(head);
      source = { kind: 'page', recent: RECENT.test(head) || pluralSources, all: ALL.test(head) || pluralSources };
    } else if (/^(?:summari[sz]e|shorten|لخص|اختصر)\s+(?:it|that|them|هذا|هذه|ذلك)(?=\s|[.!?؟]|$)/iu.test(head) || /^(?:لخص|اختصر)(?:ه|ها|هم)(?=\s|[.!?؟]|$)/iu.test(head)
      || kind === 'explanation' && (RECENT_TOPIC.test(topic) || /^(?:how it works|كيف (?:يعمل|تعمل|يشتغل|تشتغل))$/iu.test(withoutPresentation(head)))) {
      source = { kind: 'page', recent: true, all: false };
    } else if (kind !== 'summary' && topic && !SOURCE_ONLY_TOPIC.test(topic)
      && !/^(?:it|this|that|them|هذا|هذه|ذلك|النص التالي|الفرق بينهما)\s*$/iu.test(topic)) {
      const questionQuery = standaloneQuestion && !legacyProcess ? withoutPresentation(question) : undefined;
      source = { kind: 'search', query: questionQuery || (kind === 'comparison' && subjects?.length === 2 ? subjects.join(' ') : topic) };
    }
  }
  if (kind === 'comparison' && subjects?.length !== 2 && (source.kind === 'search' || source.kind === 'missing')) return null;
  const focusedTopic = kind === 'explanation' && topic && !RECENT_TOPIC.test(topic) && !SOURCE_ONLY_TOPIC.test(topic)
    && ['urls', 'page', 'search'].includes(source.kind);
  // Normalize only complete URL operands after literal content has been ruled out.
  const instructionText = source.kind === 'urls' ? outer.replace(QUOTED_TEXT, wrapped => {
    const address = wrapped.slice(1, -1).trim();
    return writingUrl(address) ? address : wrapped;
  }) : outer;
  return { kind, language, source, instruction: instructionText, format, count: count || undefined,
    ...(focusedTopic ? { topic } : {}),
    ...(subjects?.length === 2 ? { subjects } : {}),
    ...(kind === 'explanation' && intent ? { intent } : {}),
    ...(read ? { opensSource: true } : {}),
    structure: { format, headings, chronological, extract } };
}

export function extractiveWritingEnabled(): boolean {
  return process.env.MOHASSAN_EXTRACTIVE_WRITING === '1';
}
