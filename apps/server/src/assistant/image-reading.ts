import type { ImageReading } from '@mohassan/vision';

/**
 * Replies about attached images from what the own reader measured: the text it
 * read, the facts it can state, and nothing it cannot verify. There is no
 * language model behind this; translation, summaries and object recognition are
 * named as not available instead of being guessed.
 */

export type ImageIntent = 'read' | 'describe' | 'count' | 'numbers' | 'translate' | 'summarize' | 'question' | 'other';
export interface ImageReplyInput { readonly request: string; readonly readings: readonly ImageReading[] }
export interface ImageReply { readonly text: string; readonly outcome: 'read' | 'no_text'; readonly intent: ImageIntent; readonly language: 'ar' | 'en' }

const ARABIC = /[؀-ۿ]/u;
const DESCRIBE = /ما (?:هذه|هذي|هاي|هي هذه) الصور[ةه]|(?:صف|وصف|اوصف) (?:لي )?(?:هذه )?الصور[ةه]|ماذا (?:ترى|تشوف|يوجد|في الصور[ةه])|شو (?:في|هاد|هذا|بالصور[ةه])|what(?:'s| is| do you see) (?:in |this |the )*(?:image|picture|photo|screenshot)|describe (?:this |the )?(?:image|picture|photo|screenshot)|what do you see/iu;
const COUNT = /كم (?:عدد )?(?:ال)?(?:كلم[ةه]|كلمات|سطر|[اأ]سطر|سطور|حرف|حروف)|عدد (?:ال)?(?:كلمات|[اأ]سطر|سطور|حروف)|(?:how many|count(?: the)?) (?:words|lines|characters|letters)|word count/iu;
const NUMBERS = /(?:كم|ما|شو|ايش|إيش) (?:هو |هي )?(?:ال)?(?:سعر|مبلغ|رقم|[اأ]رقام|مجموع|[اإ]جمالي|تكلف[ةه]|ثمن)|(?:ال)?(?:[اأ]رقام|[اأ]سعار|المبالغ) (?:في|ب)(?:ال)?صور[ةه]|(?:what(?:'s| is) the |the )?(?:price|amount|total|numbers?|cost)\b/iu;
const TRANSLATE = /ترجم|الترجم[ةه]|translat(?:e|ion)/iu;
const SUMMARIZE = /لخ[صّ]|تلخيص|ملخص|اشرح|وض[حّ]|summari[sz]e|summary|tl;?dr|explain/iu;
const READ = /اقر[أاء]|إقر[أا]|قراء[ةه]|ما (?:ال)?مكتوب|ماذا (?:كتب|مكتوب)|شو مكتوب|ايش مكتوب|(?:ال)?نص|استخرج|انسخ|حو[لّ]|\bread\b|extract|transcribe|\bocr\b|what does (?:it|this) say|copy the text|text (?:in|from)/iu;
const QUESTION = /[?؟]\s*$|^(?:هل|كم|ما|ماذا|أين|اين|متى|لماذا|ليش|كيف|من|وين|شو|ايش|إيش|does|do|is|are|can|what|where|when|why|how|who|which)\b/iu;
const STOP = new Set(['في', 'من', 'على', 'عن', 'إلى', 'الى', 'هذه', 'هذا', 'هل', 'ما', 'ماذا', 'كم', 'أين', 'اين', 'متى', 'لماذا', 'كيف', 'هو', 'هي', 'الصورة', 'الصوره', 'صورة', 'صوره', 'يوجد', 'فيها', 'فيه', 'و', 'أو', 'او', 'ثم', 'مع', 'لي', 'لك',
  'the', 'a', 'an', 'in', 'on', 'of', 'to', 'is', 'are', 'does', 'do', 'what', 'where', 'when', 'why', 'how', 'who', 'which', 'this', 'that', 'image', 'picture', 'photo', 'screenshot', 'there', 'it', 'and', 'or', 'for', 'with', 'my', 'me', 'can', 'you', 'please']);
const NUMBER_TOKEN = /(?:[$€£¥]\s?)?[\d٠-٩]+(?:[.,:/][\d٠-٩]+)*\s?(?:%|٪|ريال|ر\.س|درهم|د\.إ|جنيه|ج\.م|دينار|د\.ك|ليرة|ل\.س|دولار|يورو|SAR|AED|USD|EGP|KWD|QAR|EUR|GBP)?/gu;

export function imageIntent(request: string): ImageIntent {
  const text = request.trim();
  if (!text) return 'read';
  if (TRANSLATE.test(text)) return 'translate';
  if (SUMMARIZE.test(text)) return 'summarize';
  if (COUNT.test(text)) return 'count';
  if (NUMBERS.test(text)) return 'numbers';
  if (DESCRIBE.test(text)) return 'describe';
  if (READ.test(text)) return 'read';
  if (QUESTION.test(text)) return 'question';
  return 'other';
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ً-ٰٟـ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي');
const stem = (word: string) => word.replace(/^(?:ال|وال|بال|لل|كال|فال)/u, '').replace(/^(?:و|ف|ب|ل|ك)(?=.{3})/u, '');

export function contentWords(request: string): string[] {
  const words = fold(request).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2 && !STOP.has(word));
  return [...new Set(words.map(stem).filter(word => word.length >= 2))];
}

function matchingLines(reading: ImageReading, words: readonly string[]): string[] {
  if (!words.length) return [];
  return reading.lines.map(line => line.text).filter(text => { const folded = fold(text); return words.some(word => folded.includes(word)); });
}

const KIND_AR: Record<ImageReading['kind'], string> = { screenshot: 'لقطة شاشة', document: 'مستند', photo: 'صورة فوتوغرافية', graphic: 'رسم أو تصميم' };
const KIND_EN: Record<ImageReading['kind'], string> = { screenshot: 'a screenshot', document: 'a document', photo: 'a photograph', graphic: 'a graphic' };
const COLOR_EN: Record<string, string> = { 'أبيض': 'white', 'أسود': 'black', 'رمادي': 'gray', 'أحمر': 'red', 'برتقالي': 'orange', 'أصفر': 'yellow', 'أخضر': 'green', 'سماوي': 'cyan', 'أزرق': 'blue', 'بنفسجي': 'purple', 'وردي': 'pink', 'بني': 'brown' };

function confidenceOf(reading: ImageReading): number {
  const chars = reading.lines.reduce((sum, line) => sum + line.text.length, 0);
  return chars ? reading.lines.reduce((sum, line) => sum + line.confidence * line.text.length, 0) / chars : 0;
}

function facts(reading: ImageReading, language: 'ar' | 'en'): string {
  const { facts: f } = reading;
  const colors = f.dominant.filter(color => color.share >= 0.08).slice(0, 3).map(color => language === 'ar' ? color.name : COLOR_EN[color.name] ?? color.hex);
  if (language === 'ar') {
    const parts = [`${f.width}×${f.height}`, KIND_AR[reading.kind], f.darkBackground ? 'خلفية داكنة' : 'خلفية فاتحة'];
    if (colors.length) parts.push(`الألوان الغالبة: ${colors.join(' و')}`);
    return parts.join('، ');
  }
  const parts = [`${f.width}×${f.height}`, KIND_EN[reading.kind], f.darkBackground ? 'dark background' : 'light background'];
  if (colors.length) parts.push(`dominant colours: ${colors.join(', ')}`);
  return parts.join(', ');
}

function confidenceNote(confidence: number, language: 'ar' | 'en'): string {
  if (confidence >= 0.9) return language === 'ar' ? 'الثقة عالية' : 'high confidence';
  if (confidence >= 0.75) return language === 'ar' ? 'الثقة متوسطة؛ قد تختلف بعض الحروف' : 'medium confidence; some characters may differ';
  return language === 'ar' ? 'الثقة منخفضة؛ راجع النص قبل الاعتماد عليه' : 'low confidence; check the text before relying on it';
}

const HONESTY_AR = 'أقرأ النصوص والأبعاد والألوان في الصور بنموذجي الخاص؛ لا أتعرف بعد على الأشياء أو الوجوه.';
const HONESTY_EN = 'I read text, dimensions and colours with my own model; I do not recognise objects or faces yet.';

function numbersIn(reading: ImageReading): { value: string; line: string }[] {
  const out: { value: string; line: string }[] = [];
  const seen = new Set<string>();
  for (const line of reading.lines) {
    for (const match of line.text.matchAll(NUMBER_TOKEN)) {
      const value = match[0].trim();
      if (!/[\d٠-٩]/u.test(value) || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, line: line.text });
    }
  }
  return out;
}

function oneReading(reading: ImageReading, intent: ImageIntent, request: string, language: 'ar' | 'en'): string {
  const ar = language === 'ar';
  const text = reading.text.trim();
  const lineCount = reading.lines.length;
  if (!text) {
    const head = ar ? 'لم أجد نصًا مقروءًا في الصورة.' : 'I found no readable text in the image.';
    const about = ar ? `ما أستطيع قوله عنها: ${facts(reading, language)}.` : `What I can say about it: ${facts(reading, language)}.`;
    return `${head}\n${about}\n${ar ? HONESTY_AR : HONESTY_EN}`;
  }
  const confidence = confidenceOf(reading);
  const dropped = reading.dropped ? (ar ? `تجاوزت ${reading.dropped} من الأجزاء غير الواضحة.` : `${reading.dropped} unclear fragments were skipped.`) : '';
  const meta = ar ? `(عدد الأسطر: ${lineCount}، ${confidenceNote(confidence, language)})` : `(${lineCount} lines, ${confidenceNote(confidence, language)})`;
  const words = text.split(/\s+/u).filter(Boolean).length;
  switch (intent) {
    case 'count':
      return ar ? `عدد الكلمات: ${words}، عدد الأسطر: ${lineCount}، عدد الحروف: ${text.replace(/\s/gu, '').length}.\n\nالنص كما قرأته:\n${text}`
        : `Words: ${words}, lines: ${lineCount}, characters: ${text.replace(/\s/gu, '').length}.\n\nThe text as read:\n${text}`;
    case 'numbers': {
      const found = numbersIn(reading);
      if (!found.length) return ar ? `لم أجد أرقامًا في نص الصورة. النص كما قرأته ${meta}:\n${text}` : `I found no numbers in the image text. The text as read ${meta}:\n${text}`;
      const list = found.slice(0, 20).map(item => `- ${item.value}${item.line.trim() !== item.value ? (ar ? ` (في: ${item.line.trim()})` : ` (in: ${item.line.trim()})`) : ''}`).join('\n');
      return ar ? `الأرقام التي قرأتها في الصورة ${meta}:\n${list}` : `Numbers read in the image ${meta}:\n${list}`;
    }
    case 'translate':
    case 'summarize': {
      const need = ar ? (intent === 'translate' ? 'الترجمة' : 'التلخيص أو الشرح') : intent === 'translate' ? 'Translation' : 'Summarising or explaining';
      const note = ar ? `قرأت النص من الصورة، لكن ${need} يحتاج نموذج لغة غير متاح الآن. هذا النص كما قرأته ${meta}:` : `I read the text from the image, but ${need.toLowerCase()} needs a language model that is not available now. The text as read ${meta}:`;
      return `${note}\n${text}${dropped ? `\n${dropped}` : ''}`;
    }
    case 'describe': {
      const first = reading.lines[0]?.text ?? '';
      return ar ? `الصورة: ${facts(reading, language)}.\nفيها نص (عدد الأسطر: ${lineCount})، أوله: «${first.slice(0, 80)}».\n\nالنص كاملًا:\n${text}\n\n${HONESTY_AR}`
        : `The image: ${facts(reading, language)}.\nIt holds text (${lineCount} lines), starting: "${first.slice(0, 80)}".\n\nFull text:\n${text}\n\n${HONESTY_EN}`;
    }
    case 'question':
    case 'other': {
      const matched = matchingLines(reading, contentWords(request));
      if (matched.length) {
        const list = matched.slice(0, 8).map(line => `- ${line}`).join('\n');
        return ar ? `ما وجدته في الصورة بخصوص سؤالك:\n${list}\n\nالنص كاملًا ${meta}:\n${text}` : `What the image says about your question:\n${list}\n\nFull text ${meta}:\n${text}`;
      }
      return ar ? `لم أجد في نص الصورة ما يجيب عن سؤالك مباشرة. هذا ما قرأته ${meta}:\n${text}` : `Nothing in the image text answers your question directly. This is what I read ${meta}:\n${text}`;
    }
    default:
      return `${ar ? 'النص الذي قرأته في الصورة' : 'The text I read in the image'} ${meta}:\n${text}${dropped ? `\n\n${dropped}` : ''}`;
  }
}

export function composeImageReply(input: ImageReplyInput): ImageReply {
  const request = input.request.trim();
  const intent = imageIntent(request);
  const anyArabicText = input.readings.some(reading => reading.direction === 'rtl' || reading.direction === 'mixed');
  const language: 'ar' | 'en' = request ? (ARABIC.test(request) ? 'ar' : 'en') : anyArabicText || !input.readings.some(reading => reading.text) ? 'ar' : 'en';
  const parts = input.readings.map((reading, index) => {
    const body = oneReading(reading, intent, request, language);
    if (input.readings.length === 1) return body;
    return `${language === 'ar' ? `الصورة ${index + 1}` : `Image ${index + 1}`}:\n${body}`;
  });
  const outcome: ImageReply['outcome'] = input.readings.some(reading => reading.text.trim()) ? 'read' : 'no_text';
  return { text: parts.join('\n\n'), outcome, intent, language };
}

/** A short English note for the brain's trail when a screenshot is looked at without a vision model. */
export function readingForTrail(reading: ImageReading, limit = 700): string {
  if (!reading.text.trim()) return `no readable text; ${reading.facts.width}x${reading.facts.height} ${reading.kind}`;
  return `${reading.lines.length} text lines read (own OCR): ${reading.text.replace(/\s+/gu, ' ').slice(0, limit)}`;
}
