import { DOCUMENT_THEMES, detectLang, parseDocumentText, type DocumentBlock, type DocumentSpecInput, type DocumentTheme, type PdfInfo } from '@mohassan/pdf';
import { matchText } from './mind/normalize.js';
import type { Lang } from './writer.js';

/**
 * PDF work without a model: the request names the operation, the file and the words; code does the rest.
 * Creating a file asks one card (title, content, design) unless the message already carries the content,
 * then renders the owner's text exactly as typed. Editing works on files from this conversation, or on a
 * .pdf path on the owner's computer. Nothing here writes a sentence of its own into a document.
 */
export type DocumentOperation = 'merge' | 'extract' | 'delete' | 'rotate' | 'watermark' | 'number' | 'info' | 'metadata';
export type DocumentSourceRef = { kind: 'path'; path: string } | { kind: 'latest'; count: number } | { kind: 'all' };
export interface DocumentCreateTask { kind: 'create'; lang: Lang; title?: string; theme?: DocumentTheme; suppliedText?: string; topic?: string }
export interface DocumentEditTask {
  kind: 'edit'; lang: Lang; operation: DocumentOperation; sources: DocumentSourceRef[];
  /** The owner's page words, read against the real page count when the file is open. */
  pages?: string; angle?: 90 | 180 | 270; text?: string; title?: string; author?: string;
}
export type DocumentTask = DocumentCreateTask | DocumentEditTask;
export type DocumentDecision = DocumentTask | { kind: 'unsupported'; lang: Lang; reason: 'convert_format' | 'missing_pages' | 'missing_text' };

const MAX_REQUEST = 6000;
const PDF_WORD = /(?<![\p{L}\p{N}])(?:pdf|بي ?دي ?اف|بي\.دي\.اف)(?![\p{L}\p{N}])/iu;
const QUOTED_PATH = /[«"“'‘]([^«»"“”'‘’\n]+?\.pdf)[»"”'’]/giu;
const BARE_PATH = /(?<![\p{L}\p{N}«"“'‘])(?:[a-zA-Z]:[\\/]|\\\\|\.{1,2}[\\/]|~[\\/]|\/)?[^\s"'«»“”،,;]*?\.pdf(?![\p{L}\p{N}])/giu;
const OTHER_FILE = /\.(?:docx?|xlsx?|pptx?|odt|rtf|txt|md|html?|jpe?g|png|gif|webp|heic|csv)(?![\p{L}\p{N}])/iu;
const PAGE_WORD = /(?<![\p{L}])(?:صفح(?:ه|ات|تين|تي)?|الصفح(?:ه|ات|تين|تين)?|pages?)(?![\p{L}])/iu;
const MERGE = /(?<![\p{L}])(?:ادمج|دمج|اجمع|جمع|ضم|وحد|اربط|merge|combine|join|concatenate|stitch)(?![\p{L}])/iu;
const DELETE = /(?<![\p{L}])(?:احذف|حذف|ازل|ازاله|امسح|شيل|احذفي|delete|remove|drop|strip)(?![\p{L}])/iu;
const EXTRACT = /(?<![\p{L}])(?:استخرج|استخراج|اقتطع|اقص|قص|افصل|فصل|قسم|تقسيم|اقتصر|احتفظ|ابق|خذ|اطلع|split|extract|take|keep|cut|separate)(?![\p{L}])/iu;
const ROTATE = /(?<![\p{L}])(?:دور|لف|اقلب|تدوير|rotate|rotation|turn|flip)(?![\p{L}])/iu;
const WATERMARK = /علام[هة] مائي[هة]|watermark|(?<![\p{L}])(?:ختم|stamp)(?![\p{L}])/iu;
const NUMBER = /ترقيم|(?<![\p{L}])(?:رقم|ارقام|رقّم)(?![\p{L}]).{0,12}?صفح|page numbers?|number the pages|numbering|paginate/iu;
const INFO = /كم صفح|عدد الصفحات|عدد صفحات|معلومات|بيانات|تفاصيل|خصائص|how many pages|page count|number of pages|(?<![\p{L}])(?:info|metadata|details|properties)(?![\p{L}])/iu;
const METADATA = /(?:(?<![\p{L}])(?:غير|عدل|اجعل|ضع|حدث|سم|set|change|update|rename)(?![\p{L}]).{0,40}?(?:العنوان|عنوان|المؤلف|الكاتب|اسم الملف|title|author))|(?:(?<![\p{L}])(?:العنوان|عنوان|المؤلف|title|author)(?![\p{L}])\s*[:：=])/iu;
const CREATE = /(?<![\p{L}])(?:انشئ|انشاء|اصنع|صنع|اعمل|عمل|سوي|سو|سولي|جهز|تجهيز|حضر|كون|ولد|توليد|اكتب|اكتبلي|كتابه|صمم|تصميم|حول|حولي|تحويل|صدر|تصدير|اطبع|احفظ|اعطني|اعطيني|هات|اريد|ابغي|ابغا|بدي|نزل|create|make|generate|build|design|convert|export|turn|produce|write|draft|prepare|save|download|give me|i want|i need|get me)(?![\p{L}])/iu;
const QUESTION = /^(?:ما ?هو|ما ?هي|ما معني|ماذا يعني|كيف|لماذا|هل يمكن فتح|what is|what are|what does|how do i|how to|why)(?![\p{L}])/iu;
const EDIT_FILLER = /(?<![\p{L}])(?:ال)?(?:ملف|الملف|ملفات|الملفات|مستند|المستند|وثيق[هة]|الوثيق[هة]|pdf|file|files|document|documents|the|this|that|it|هذا|هذه|ذلك|تلك|على|في|من|الى|إلى|ل|لي|له|لها|to|on|for|in|of|at|with|please|من فضلك|لو سمحت)(?![\p{L}])/giu;
const LATEST = /(?<![\p{L}])(?:اخر|آخر|السابق|السابقه|الاخير|الاخيره|هذا الملف|الملف ده|نفس الملف|the last|latest|previous|this file|that file|the file|it)(?![\p{L}])/iu;
const ALL_FILES = /(?<![\p{L}])(?:كل|جميع|all|every|both|الملفين|الملفات)(?![\p{L}])/iu;
const THEME_WORDS: [RegExp, DocumentTheme][] = [
  [/فاتور|عرض سعر|سند|وصل|invoice|quotation|quote|receipt|bill/iu, 'invoice'],
  [/تقرير|report/iu, 'report'],
  [/رسال|خطاب|letter|memo/iu, 'letter'],
  [/حديث|عصري|انيق|ملون|modern|sleek|stylish|colou?rful/iu, 'modern'],
  [/بسيط|عادي|plain|simple|minimal|basic/iu, 'plain'],
];
const TITLE = /(?:بعنوان|عنوانه|عنوانها|اسمه|اسمها|سمه|سمها|titled|called|named|with the title|title)\s*[:：]?\s*(«[^»\n]+»|"[^"\n]+"|“[^”\n]+”|'[^'\n]+'|[^،,.:\n]+)/iu;
const TOPIC = /(?<![\p{L}])(?:عن|حول|بخصوص|about|regarding|on the subject of)\s+(.+?)(?=\s+(?:بعنوان|بالنص|نصه|محتواه|بتصميم|بشكل|بتنسيق|with|titled|containing|in the style)|[،,.:\n]|$)/iu;
const BODY_MARKER = /(?:بالنص|نصه|نصها|محتواه|محتواها|محتواه هو|يحتوي على|فيه|containing|with (?:this|the following|the) (?:text|content|body)|saying|that says)\s*[:：]?\s*/iu;
const QUOTES: Record<string, string> = { '«': '»', '“': '”', '"': '"', "'": "'", '‘': '’' };

const lang = (text: string): Lang => /[\u0600-\u06FF]/u.test(text) ? 'ar' : 'en';
const unquote = (value: string) => value.replace(/^[«"“'‘]\s*|\s*[»"”'’]$/gu, '').trim();

function quotedAfter(request: string, start: number): { text: string; end: number } | null {
  const closing = QUOTES[request[start] ?? ''];
  if (!closing) return null;
  const end = request.indexOf(closing, start + 1);
  return end > start + 1 ? { text: request.slice(start + 1, end), end: end + 1 } : null;
}

/** Paths in the owner's own characters, quoted ones first; the Windows backslashes are kept. */
export function pdfPaths(request: string): string[] {
  const found: string[] = [];
  const rest = request.replace(QUOTED_PATH, (_, path: string) => { found.push(path.trim()); return ' '; });
  for (const match of rest.matchAll(BARE_PATH)) if (match[0].length > 4) found.push(match[0]);
  return [...new Set(found)];
}

/** Everything after the first line, or after a body marker, or the first long quotation: literal content, never summarised. */
function suppliedContent(request: string): { text: string; instruction: string } {
  const newline = request.indexOf('\n');
  if (newline > 0 && request.slice(newline + 1).trim()) {
    const first = request.slice(0, newline);
    if (PDF_WORD.test(matchText(first)) || CREATE.test(matchText(first))) return { text: request.slice(newline + 1).replace(/^\n+/u, '').trimEnd(), instruction: first };
  }
  const marker = BODY_MARKER.exec(request);
  if (marker) {
    const start = marker.index + marker[0].length;
    const quoted = quotedAfter(request, start);
    const text = quoted ? quoted.text : request.slice(start);
    if (text.trim()) return { text, instruction: request.slice(0, marker.index) + (quoted ? request.slice(quoted.end) : '') };
  }
  const colon = /[:：]\s*(?=\S)/u.exec(request);
  if (colon && !TITLE.test(request.slice(0, colon.index + 1)) && request.slice(colon.index + 1).trim().length >= 12 && !/https?$/iu.test(request.slice(0, colon.index))) {
    return { text: request.slice(colon.index + 1).trim(), instruction: request.slice(0, colon.index) };
  }
  const quote = /[«"“]([^»"”]{24,})[»"”]/u.exec(request);
  if (quote) return { text: quote[1]!, instruction: request.replace(quote[0], ' ') };
  return { text: '', instruction: request };
}

function themeOf(text: string): DocumentTheme | undefined {
  const folded = matchText(text);
  return THEME_WORDS.find(([pattern]) => pattern.test(folded))?.[1];
}

function anglesOf(folded: string): 90 | 180 | 270 {
  const explicit = /(\d{2,3})\s*(?:درج[هة]|°|deg(?:rees?)?)/iu.exec(folded);
  if (explicit) { const value = Number(explicit[1]) % 360; return value >= 225 ? 270 : value >= 135 ? 180 : 90; }
  if (/اقلب|راسا علي عقب|بالعكس|upside|flip|180/iu.test(folded)) return 180;
  if (/يسار|عكس اتجاه|counter|anticlockwise|left|270/iu.test(folded)) return 270;
  return 90;
}

function watermarkText(request: string, folded: string): string | undefined {
  const marker = /(?:بنص|بكلم[هة]|كلم[هة]|نصها|نصه|مكتوب(?:\s+فيها|\s+عليها)?|تقول|reading|saying|that says|with the text|with text|text)\s*[:：]?\s*/iu.exec(request);
  if (marker) {
    const start = marker.index + marker[0].length;
    const quoted = quotedAfter(request, start);
    const text = quoted ? quoted.text : request.slice(start).split(/\s+(?:على|علي|في|ل|on|to|in|for)\s+/iu)[0]!;
    if (text.trim()) return unquote(text).slice(0, 80);
  }
  const quoted = /[«"“'‘]([^«»"“”'‘’\n]{1,80})[»"”'’]/u.exec(request.replace(QUOTED_PATH, ' '));
  if (quoted) return quoted[1]!.trim();
  const after = /(?:علام[هة] مائي[هة]|watermark|ختم|stamp)\s+(.+)$/iu.exec(request.replace(BARE_PATH, ' ').replace(QUOTED_PATH, ' '));
  if (after) {
    const words = after[1]!.replace(EDIT_FILLER, ' ').replace(LATEST, ' ').replace(/[،,.!؟?]+$/u, '').trim();
    if (words && words.length <= 80 && !PDF_WORD.test(matchText(words))) return words;
  }
  void folded;
  return undefined;
}

/** The value named after a keyword: a quoted string anywhere after it, else the words after «إلى», «to», «:» or «=». */
function valueAfter(request: string, keyword: RegExp): string | undefined {
  const match = keyword.exec(request);
  if (!match) return undefined;
  const rest = request.slice(match.index + match[0].length).replace(QUOTED_PATH, ' ');
  const quoted = /[«"“'‘]([^«»"“”'‘’\n]+)[»"”'’]/u.exec(rest);
  if (quoted) return quoted[1]!.trim() || undefined;
  const after = /(?:^|\s)(?:الي|إلى|الى|to|=|:|：)\s*([^،,\n]+)/iu.exec(rest) ?? /^\s*([^،,\n]+)/u.exec(rest);
  const value = after?.[1]?.replace(BARE_PATH, ' ').replace(EDIT_FILLER, ' ').replace(/\s+/gu, ' ').replace(/[.!؟?]+$/u, '').trim();
  return value && !PDF_WORD.test(matchText(value)) ? value : undefined;
}

function pagesOf(request: string, folded: string): string | undefined {
  const cleaned = folded.replace(BARE_PATH, ' ').replace(/\d{2,3}\s*(?:درج[هة]|°|deg(?:rees?)?)/giu, ' ');
  const at = PAGE_WORD.exec(cleaned);
  if (!at) return undefined;
  const tail = cleaned.slice(at.index);
  const before = cleaned.slice(Math.max(0, at.index - 24), at.index);
  const candidate = /\d/u.test(tail) ? tail : /\d/u.test(before) ? before + tail : /الاخير|آخر|last/iu.test(tail) ? tail : '';
  void request;
  return candidate.trim() || undefined;
}

function sourcesOf(request: string, folded: string, operation: DocumentOperation): DocumentSourceRef[] {
  const paths = pdfPaths(request).map(path => ({ kind: 'path' as const, path }));
  if (paths.length) return paths;
  if (operation === 'merge') return [LATEST.test(folded) && !ALL_FILES.test(folded) ? { kind: 'latest', count: 2 } : { kind: 'all' }];
  return [{ kind: 'latest', count: 1 }];
}

const FILE_WORD = /(?<![\p{L}])(?:ملف|الملف|ملفين|الملفين|ملفات|الملفات|مستند|المستند|وثيق[هة]|الوثيق[هة]|file|files|document|documents)(?![\p{L}])/iu;

export interface DocumentTaskContext {
  /** The conversation already holds PDFs Mohassan made: «ادمج الملفين» or «احذف الصفحة 2» then means those files. */
  hasDocuments?: boolean;
}

/** What a PDF request is, or null when it is not one. Questions about PDF as a topic stay a web question. */
export function documentTask(request: string, context: DocumentTaskContext = {}): DocumentDecision | null {
  if (typeof request !== 'string' || !request.trim() || request.length > MAX_REQUEST) return null;
  const paths = pdfPaths(request);
  const folded = matchText(request.trim());
  const firstLine = folded.split('\n', 1)[0]!;
  const named = PDF_WORD.test(folded) || paths.length > 0;
  const implied = !named && context.hasDocuments === true && (FILE_WORD.test(firstLine) || PAGE_WORD.test(firstLine))
    && (MERGE.test(firstLine) || DELETE.test(firstLine) || EXTRACT.test(firstLine) || ROTATE.test(firstLine) || WATERMARK.test(firstLine) || NUMBER.test(firstLine) || INFO.test(firstLine) || METADATA.test(firstLine));
  if (!named && !implied) return null;
  const language = lang(request);
  if (QUESTION.test(firstLine.replace(/^(?:من فضلك|لو سمحت|please)\s+/iu, ''))) return null;
  const editOperation: DocumentOperation | null =
    WATERMARK.test(firstLine) ? 'watermark'
    : NUMBER.test(firstLine) ? 'number'
    : MERGE.test(firstLine) && (paths.length !== 1) ? 'merge'
    : ROTATE.test(firstLine) ? 'rotate'
    : DELETE.test(firstLine) && PAGE_WORD.test(firstLine) ? 'delete'
    : EXTRACT.test(firstLine) && PAGE_WORD.test(firstLine) ? 'extract'
    : METADATA.test(firstLine) ? 'metadata'
    : INFO.test(firstLine) && !CREATE.test(firstLine) ? 'info'
    : null;
  if (editOperation) {
    const task: DocumentEditTask = { kind: 'edit', lang: language, operation: editOperation, sources: sourcesOf(request, folded, editOperation) };
    if (editOperation === 'rotate') { task.angle = anglesOf(firstLine); const pages = pagesOf(request, firstLine); if (pages) task.pages = pages; }
    if (editOperation === 'delete' || editOperation === 'extract') {
      const pages = pagesOf(request, firstLine);
      if (!pages) return { kind: 'unsupported', lang: language, reason: 'missing_pages' };
      task.pages = pages;
    }
    if (editOperation === 'watermark') {
      const text = watermarkText(request.split('\n', 1)[0]!, firstLine);
      if (!text) return { kind: 'unsupported', lang: language, reason: 'missing_text' };
      task.text = text;
    }
    if (editOperation === 'metadata') {
      const title = valueAfter(request, /(?<![\p{L}])(?:العنوان|عنوان|title)(?![\p{L}])/iu);
      const author = valueAfter(request, /(?<![\p{L}])(?:المؤلف|الكاتب|author)(?![\p{L}])/iu);
      if (title) task.title = title.slice(0, 200);
      if (author) task.author = author.slice(0, 120);
      if (!task.title && !task.author) return { kind: 'unsupported', lang: language, reason: 'missing_text' };
    }
    return task;
  }
  if (implied) return null;
  if (!CREATE.test(firstLine) && !/\n/u.test(request.trim())) return null;
  if (OTHER_FILE.test(request) && !paths.length) return { kind: 'unsupported', lang: language, reason: 'convert_format' };
  const { text, instruction } = suppliedContent(request.trim());
  const task: DocumentCreateTask = { kind: 'create', lang: language };
  const title = TITLE.exec(instruction);
  if (title) task.title = unquote(title[1]!).slice(0, 200);
  const topic = TOPIC.exec(instruction.replace(TITLE, ' '));
  if (topic) task.topic = topic[1]!.trim().slice(0, 200);
  const theme = themeOf(instruction);
  if (theme) task.theme = theme;
  if (text.trim()) task.suppliedText = text;
  return task;
}

export const THEME_LABELS: Record<DocumentTheme, [string, string]> = {
  plain: ['بسيط', 'Plain'], report: ['تقرير', 'Report'], letter: ['رسالة', 'Letter'], invoice: ['فاتورة', 'Invoice'], modern: ['حديث', 'Modern'],
};
const ORDER: DocumentTheme[] = ['plain', 'report', 'letter', 'invoice', 'modern'];

/** One card: the title, the content as it should appear, and the design. The guessed design is chosen in advance. */
export function documentQuestion(task: DocumentCreateTask) {
  const ar = task.lang === 'ar';
  const themes = task.theme ? [task.theme, ...ORDER.filter(theme => theme !== task.theme)] : ORDER;
  return {
    prompt: ar ? 'أصنع لك ملف PDF من كلماتك أنت، بلا إضافة من عندي. أجب عن هذه الأسئلة:' : 'I will make the PDF from your own words, adding nothing of my own. Answer these:',
    fields: [
      { id: 'title', prompt: ar ? 'ما عنوان الملف؟' : 'What is the title?', suggestions: [], ...(task.title ?? task.topic ? { initialValue: (task.title ?? task.topic)!.slice(0, 200) } : {}), placeholder: ar ? 'مثلاً: تقرير المبيعات لشهر نوفمبر' : 'e.g. Sales report for November' },
      { id: 'content', multiline: true, prompt: task.suppliedText
          ? (ar ? 'هذا هو النص الذي أرسلته. عدّله إن شئت قبل الإنشاء.' : 'Your supplied text is shown here; edit it if needed.')
          : (ar ? 'ما محتوى الملف؟ اكتبه كما تريده أن يظهر: # للعناوين، و- للنقاط، و| للجداول.' : 'What goes in the file? Write it as it should appear: # for headings, - for bullets, | for tables.'),
        suggestions: [], ...(task.suppliedText ? { initialValue: task.suppliedText.slice(0, 4000) } : {}), placeholder: ar ? 'مثلاً:\n# المقدمة\nنص الفقرة…\n- نقطة أولى\n- نقطة ثانية' : 'e.g.\n# Introduction\nParagraph text…\n- first point\n- second point' },
      { id: 'style', prompt: ar ? 'ما التصميم؟' : 'Which design?', suggestions: themes.map(theme => ({ label: THEME_LABELS[theme][ar ? 0 : 1] })), selected: [0] },
    ],
  };
}

const themeFromAnswer = (answer: string, fallback: DocumentTheme): DocumentTheme =>
  (Object.entries(THEME_LABELS).find(([, labels]) => labels.some(label => answer.trim() === label || answer.includes(label)))?.[0] as DocumentTheme | undefined) ?? themeOf(answer) ?? fallback;

export interface ComposedDocument { spec: DocumentSpecInput; theme: DocumentTheme; emptyContent: boolean }

/** The specification from the card answers (or the message alone); every word is the owner's. */
const TITLE_LINE_MAX = 80;
const LIST_OR_TABLE = /^\s*(?:[-*•·–—◦▪]\s|[0-9٠-٩۰-۹]{1,3}[.)]\s|\||>|```)/u;

export function composeDocumentSpec(task: DocumentCreateTask, answers: Readonly<Record<string, string>> = {}, today?: string): ComposedDocument {
  const value = (key: string) => typeof answers[key] === 'string' ? answers[key]!.slice(0, 60_000) : '';
  let content = (value('content').trim() ? value('content') : task.suppliedText ?? '').replace(/\r\n?/gu, '\n');
  const explicit = (value('title').trim() || task.title || '').trim();
  // Without a title of its own, a short first line followed by more text is the title (a «# heading» or a plain line).
  let derived = '';
  const lines = content.split('\n');
  const firstIndex = lines.findIndex(line => line.trim());
  const firstLine = firstIndex >= 0 ? lines[firstIndex]!.trim() : '';
  const rest = firstIndex >= 0 && lines.slice(firstIndex + 1).some(line => line.trim());
  const headingLine = /^#{1,3}\s+(.+?)\s*#*$/u.exec(firstLine);
  if (!explicit && firstLine && rest && (headingLine || (firstLine.length <= TITLE_LINE_MAX && !LIST_OR_TABLE.test(firstLine) && !/[.!؟?]$/u.test(firstLine)))) {
    derived = (headingLine ? headingLine[1]! : firstLine).trim();
    content = lines.slice(firstIndex + 1).join('\n');
  }
  let blocks: DocumentBlock[] = parseDocumentText(content);
  const title = (explicit || derived || task.topic || (task.lang === 'ar' ? 'مستند' : 'Document')).trim().slice(0, 200);
  // An explicit title repeated as the first heading of the content is kept once.
  if (blocks[0]?.kind === 'heading' && blocks[0].level === 1 && blocks[0].text.trim() === title) blocks = blocks.slice(1);
  const theme = themeFromAnswer(value('style'), task.theme ?? 'plain');
  const spec: DocumentSpecInput = { title, theme, blocks, lang: detectLang(`${title} ${content}`), ...(today ? { date: today } : {}) };
  return { spec, theme, emptyContent: !blocks.length };
}

export function formatBytes(size: number, language: Lang): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} ${language === 'ar' ? 'ميغابايت' : 'MB'}`;
  return `${Math.max(1, Math.round(size / 1000))} ${language === 'ar' ? 'كيلوبايت' : 'KB'}`;
}
const pagesLabel = (pages: number, ar: boolean) => ar ? pages === 1 ? 'صفحة واحدة' : pages === 2 ? 'صفحتان' : pages <= 10 ? `${pages} صفحات` : `${pages} صفحة` : `${pages} page${pages === 1 ? '' : 's'}`;

export interface DocumentSummary { name: string; pages: number; size: number; theme?: string | null }

export function documentCreatedReply(document: DocumentSummary, url: string, language: Lang, emptyContent = false): string {
  const ar = language === 'ar';
  const theme = document.theme && document.theme in THEME_LABELS ? THEME_LABELS[document.theme as DocumentTheme][ar ? 0 : 1] : null;
  const lines = ar
    ? [`أنشأت ملف PDF: **${document.name}**`, `- ${pagesLabel(document.pages, true)}، ${formatBytes(document.size, 'ar')}${theme ? `، تصميم «${theme}»` : ''}`, '', `[تنزيل الملف](${url})`]
    : [`Created the PDF: **${document.name}**`, `- ${pagesLabel(document.pages, false)}, ${formatBytes(document.size, 'en')}${theme ? `, ${theme} design` : ''}`, '', `[Download the file](${url})`];
  if (emptyContent) lines.push('', ar ? 'الملف يحمل العنوان فقط لأن المحتوى لم يُذكر. أرسل النص وأعيد إنشاءه.' : 'The file holds only the title because no content was given. Send the text and I will remake it.');
  lines.push('', '---', ar
    ? 'النص في الملف كما كتبته أنت؛ لم يكتبه نموذج. يمكنك بعدها أن تقول مثلاً: «أضف علامة مائية سري»، أو «احذف الصفحة 2»، أو «رقّم الصفحات».'
    : 'The text in the file is yours as typed; no model wrote it. Next you can say, for example: “add a watermark CONFIDENTIAL”, “delete page 2” or “number the pages”.');
  return lines.join('\n');
}

const OPERATION_LABELS: Record<Exclude<DocumentOperation, 'info'>, [string, string]> = {
  merge: ['دمج الملفات', 'merged the files'], extract: ['استخراج الصفحات', 'extracted the pages'], delete: ['حذف الصفحات', 'deleted the pages'],
  rotate: ['تدوير الصفحات', 'rotated the pages'], watermark: ['إضافة العلامة المائية', 'added the watermark'], number: ['ترقيم الصفحات', 'numbered the pages'], metadata: ['تعديل بيانات الملف', 'updated the file details'],
};

export function documentEditedReply(task: DocumentEditTask, document: DocumentSummary, url: string, inputs: readonly string[]): string {
  const ar = task.lang === 'ar';
  const operation = OPERATION_LABELS[task.operation as Exclude<DocumentOperation, 'info'>]?.[ar ? 0 : 1] ?? task.operation;
  const detail = task.operation === 'watermark' ? ar ? ` «${task.text}»` : ` “${task.text}”` : task.operation === 'rotate' ? ` ${task.angle}°` : '';
  const from = inputs.length ? ar ? `\n- من: ${inputs.join('، ')}` : `\n- From: ${inputs.join(', ')}` : '';
  return ar
    ? `تم ${operation}${detail}. الملف الجديد: **${document.name}**${from}\n- ${pagesLabel(document.pages, true)}، ${formatBytes(document.size, 'ar')}\n\n[تنزيل الملف](${url})\n\n---\nالملف الأصلي لم يتغير؛ هذه نسخة جديدة.`
    : `I ${operation}${detail}. New file: **${document.name}**${from}\n- ${pagesLabel(document.pages, false)}, ${formatBytes(document.size, 'en')}\n\n[Download the file](${url})\n\n---\nThe original file is unchanged; this is a new copy.`;
}

export function documentInfoReply(name: string, size: number, info: PdfInfo, language: Lang): string {
  const ar = language === 'ar';
  const rows = ar
    ? [['الملف', name], ['الصفحات', String(info.pages)], ['الحجم', formatBytes(size, 'ar')], ['العنوان', info.title ?? '—'], ['المؤلف', info.author ?? '—'], ['مقاس الصفحة', `${info.pageSize.width} × ${info.pageSize.height} نقطة`], ['أُنشئ', info.created?.slice(0, 10) ?? '—']]
    : [['File', name], ['Pages', String(info.pages)], ['Size', formatBytes(size, 'en')], ['Title', info.title ?? '—'], ['Author', info.author ?? '—'], ['Page size', `${info.pageSize.width} × ${info.pageSize.height} pt`], ['Created', info.created?.slice(0, 10) ?? '—']];
  return rows.map(([key, value]) => `- **${key}:** ${value}`).join('\n');
}

export function noSourceReply(task: DocumentEditTask, owner: boolean): string {
  const ar = task.lang === 'ar';
  const needed = task.operation === 'merge' ? (ar ? 'الدمج يحتاج ملفين على الأقل' : 'Merging needs at least two files') : (ar ? 'لا يوجد ملف PDF في هذه المحادثة بعد' : 'There is no PDF in this conversation yet');
  const ways = ar
    ? ['أنشئ ملفًا هنا أولًا، مثلاً: «اصنع ملف pdf بعنوان …»', 'أو ارفع ملف PDF من لوحة المستندات ثم أعد الطلب', ...(owner ? ['أو اكتب مسار الملف على جهازك، مثلاً: C:\\Users\\name\\Documents\\file.pdf'] : [])]
    : ['Create a file here first, for example: “make a pdf titled …”', 'Or upload a PDF from the documents panel and ask again', ...(owner ? ['Or write the file path on your computer, for example: C:\\Users\\name\\Documents\\file.pdf'] : [])];
  return `${needed}.\n${ways.map(way => `- ${way}`).join('\n')}`;
}

export function unsupportedDocumentReply(decision: { reason: 'convert_format' | 'missing_pages' | 'missing_text'; lang: Lang }): string {
  const ar = decision.lang === 'ar';
  switch (decision.reason) {
    case 'convert_format': return ar
      ? 'لا أحوّل ملفات Word أو Excel أو الصور إلى PDF؛ هذه القدرة غير مفعّلة في موحسن الآن.\n\nما أستطيعه: أن أصنع ملف PDF من نصّ ترسله لي هنا، بتصميم تختاره (بسيط، تقرير، رسالة، فاتورة، حديث).'
      : 'I do not convert Word, Excel or image files to PDF; that capability is not enabled in Mohassan yet.\n\nWhat I can do: make a PDF from text you send me here, in a design you choose (plain, report, letter, invoice, modern).';
    case 'missing_pages': return ar ? 'أي صفحات؟ اذكر أرقامها، مثلاً: «احذف الصفحة 2» أو «استخرج الصفحات 1-3 من الملف».' : 'Which pages? Name their numbers, for example: “delete page 2” or “extract pages 1-3 from the file”.';
    case 'missing_text': return ar ? 'ما النص المطلوب؟ اكتبه بين علامتي تنصيص، مثلاً: «أضف علامة مائية "سري"» أو «غيّر عنوان الملف إلى "تقرير 2026"».' : 'What text? Put it in quotes, for example: “add a watermark "CONFIDENTIAL"” or “set the title to "Report 2026"”.';
  }
}

export const DOCUMENT_THEME_COUNT = DOCUMENT_THEMES.length;
