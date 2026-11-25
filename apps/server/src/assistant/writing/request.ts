import { pdfPaths } from '../documents.js';
import { normalizeRequest } from '../mind/normalize.js';
import { requestActionText } from '../request-context.js';
import { requestOperationText, requestScopeActionText } from '../request-scope.js';
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
  structure: RestructureOptions;
}

const SUMMARY = /^(?:summari[sz]e|give (?:me )?(?:a |the )?summary of|provide (?:a |the )?summary of|shorten|لخص(?:لي|ها|ه|هم)?|اختصر(?:ها|ه|هم)?|اعطني ملخص(?:ا)?(?: عن| ل)?)(?!\p{L})/iu;
const EXPLAIN = /^(?:explain(?: to me| for me)?|describe how|how (?:does|do|did)|how it works|[اأإ]شرح(?:لي|ها|ه)?(?: لي)?|وضح(?:لي|ها|ه)?(?: لي)?|فسر(?:لي|ها|ه)?(?: لي)?|كيف (?:يعمل|تعمل|يشتغل|تشتغل))(?!\p{L})/iu;
const COMPARE = /^(?:compare|contrast|what(?: is|'s|’s) (?:the )?difference between|ما (?:هو )?(?:الفرق|الاختلاف) بين|قارن(?: لي)?(?: بين)?)(?!\p{L})/iu;
const RESTRUCTURE = /^(?:restructure|rearrange|re-?format|organi[sz]e|sort|order|(?:turn|convert|change|rewrite|put)\b.{0,100}?(?:into|as) (?:a |the )?(?:paragraphs?|bullet points?|bullets?|a list|points)|(?:add|use) headings|(?:extract|list|identify|pull out) (?:the )?(?:action items|tasks|to-dos|due dates|dates|deadlines)|رتب|اعد ترتيب|اعد تنظيم|اعد تنسيق|نظم|حول\s+.{0,100}?(?:الي|ل)\s*(?:فقر|نقاط|قائم)|(?:اضف|ضع) عناوين|(?:استخرج|حدد) (?:المهام|اجراءات|الاجراءات|بنود العمل|التواريخ|المواعيد))(?!\p{L})/iu;
const URL = /https?:\/\/[^\s<>"'«»“”]+/giu;
const PDF = /(?:\bpdf\b|\.pdf(?=$|[\s"'»”])|(?<!\p{L})(?:ملف|مستند) (?:مرفق|مرفوع)(?!\p{L}))/iu;
const LINK_REF = /\b(?:pages?|sites?|sources?|articles?|links?|reports?)\b|(?<!\p{L})(?:الصفح[هة]|صفح[هة]|المصادر|مصادر|الموقع|المواقع|المقالات|الروابط|الرابط|المقال)(?!\p{L})/iu;
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

export function parseExtractiveWriting(request: string): ExtractiveWritingTask | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 8000) return null;
  const { instruction, content } = rawBody(request);
  const outer = requestActionText(requestScopeActionText(instruction));
  const head = requestOperationText(outer);
  // Compound actions and translation stay with their existing routes.
  if (/\b(?:and(?: then)?|then)\s+(?:send|publish|delete|open|save|click|write|translate|paraphrase|rewrite|email (?:it|them|that|this))\b|(?:ثم|وبعدين)\s+(?:ارسل|انشر|احذف|افتح|احفظ|ترجم|اكتب)(?!\p{L})|(?:وارسل|وانشر|وترجم|واعد صياغه)(?!\p{L})/iu.test(head)) return null;
  const kind = SUMMARY.test(head) ? 'summary' : COMPARE.test(head) ? 'comparison'
    : EXPLAIN.test(head) ? 'explanation' : RESTRUCTURE.test(head) ? 'restructure' : null;
  if (!kind || /^how do (?:i|you)\b/iu.test(head)
    || PROCESS_QUESTION.test(head) && !PROCESS_SUFFIX.test(withoutPresentation(withoutSourceClues(head)))) return null;
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

  const urls = urlsIn(outer);
  const paths = PDF.test(head) && !urls.length ? pdfPaths(outer) : [];
  const topic = topicIn(outer, kind);
  if (kind === 'explanation' && !content && /^(?:you|yourself|[اأإ]نت|نفسك)$/iu.test(topic)) return null;
  const subjects = kind === 'comparison'
    ? topic.split(/\s+(?:and|vs\.?|versus|و\s*)\s*|\s+مقابل\s+/iu).map(value => value.trim()).filter(Boolean)
    : undefined;
  let source: SourceRequest = { kind: 'missing' };
  if (content) source = { kind: 'paste', ...content };
  else if (previousText) source = { kind: 'previous_text' };
  else if (kind !== 'restructure') {
    if (urls.length) source = { kind: 'urls', urls };
    else if (PDF.test(head)) source = { kind: 'pdf', paths, all: ALL.test(head) };
    else if (!OWNED_REPORT.test(head) && LINK_REF.test(head) && (RECENT.test(head) || ALL.test(head) || /\b(?:this|that|the|current|open)\b|(?:هذا|هذه|الصفح|الرابط|المصادر|المفتوح)/iu.test(head))) {
      const pluralSources = /المصادر|\bsources\b/iu.test(head);
      source = { kind: 'page', recent: RECENT.test(head) || pluralSources, all: ALL.test(head) || pluralSources };
    } else if (/^(?:summari[sz]e|shorten|لخص|اختصر)\s+(?:it|that|them|هذا|هذه|ذلك)(?=\s|[.!?؟]|$)/iu.test(head) || /^(?:لخص|اختصر)(?:ه|ها|هم)(?=\s|[.!?؟]|$)/iu.test(head)
      || kind === 'explanation' && (RECENT_TOPIC.test(topic) || /^(?:how it works|كيف (?:يعمل|تعمل|يشتغل|تشتغل))$/iu.test(withoutPresentation(head)))) {
      source = { kind: 'page', recent: true, all: false };
    } else if (kind !== 'summary' && topic && !SOURCE_ONLY_TOPIC.test(topic)
      && !/^(?:it|this|that|them|هذا|هذه|ذلك|النص التالي|الفرق بينهما)\s*$/iu.test(topic)) {
      source = { kind: 'search', query: kind === 'comparison' && subjects?.length === 2 ? subjects.join(' ') : topic };
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
    structure: { format, headings, chronological, extract } };
}

export function extractiveWritingEnabled(): boolean {
  return process.env.MOHASSAN_EXTRACTIVE_WRITING === '1';
}
