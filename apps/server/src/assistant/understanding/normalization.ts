import { foldText } from '../../../../../packages/skills/src/stems.js';
import { maskRequestLiteralData } from '../request-constraints.js';
import { isArabiziText, transliterateArabizi } from './arabizi.js';
import { DIALECT_MAPPINGS, type DialectMapping } from './dialect.js';

export { DIALECT_MAPPINGS, type ArabicDialect, type DialectMapping } from './dialect.js';

export interface NormalizedText {
  displayText: string;
  /** Canonical text for lexical and question matching. */
  matchText: string;
  /** Matching input for existing parsers, with unmodified operands and literal spans. */
  parserText: string;
  isArabizi: boolean;
}

const ARABIC = /\p{Script=Arabic}/u;
const ARABIC_MARK = /\p{Script_Extensions=Arabic}/u;
const removeArabicMarks = (text: string) => text.replace(/ـ|\p{M}/gu, char => ARABIC_MARK.test(char) ? '' : char);
const digits = (text: string) => text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) % 16));

// Leave ة distinct when selecting aliases. For example, «آية» is a valid MSA
// noun and shares a folded key with the Egyptian question word «إيه».
function lexicalKey(text: string): string {
  return removeArabicMarks(text.normalize('NFKC')).replace(/[أإآٱ]/gu, 'ا')
    .replace(/[ىی]/gu, 'ي').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Used only for comparisons, including inside the shared lemma and question views. */
export function foldForUnderstanding(text: string): string {
  return removeArabicMarks(foldText(text)).replace(/[ؤئ]/gu, 'ء').replace(/\s+/gu, ' ').trim();
}

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]*)?/gu;
const PROTECTED = /(?:https?:\/\/|www\.)[^\s<>"'«»]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|(?<![\p{L}\p{N}])(?:[a-z]:\\|\.{0,2}\/|~\/)[^\s<>"'«»]+|[a-z0-9]+(?:[._/-][a-z0-9]+)+/giu;
const blank = (text: string) => ' '.repeat(text.length);
const CORRECTIONS = new Map([
  ['ازاى', 'ازاي'], ['ازيك', 'كيف حالك'], ['ازيكو', 'كيف حالكم'], ['ازاىك', 'كيف حالك'],
  ['عافاك', 'عفاك'], ['لمادا', 'لماذا'], ['لماذ', 'لماذا'], ['هاذا', 'هذا'], ['هاذه', 'هذه'],
  ['هاؤلاء', 'هؤلاء'], ['ماهي', 'ما هي'], ['ماهذا', 'ما هذا'], ['ماهذه', 'ما هذه'],
  ['منهو', 'من هو'], ['منهي', 'من هي'], ['انضُر', 'انظر'], ['انضر', 'انظر'], ['الانترنيت', 'الإنترنت'],
].map(([wrong, right]) => [lexicalKey(wrong), right]));
const SINGLE = new Map<string, DialectMapping>();
const PHRASE = new Map<string, DialectMapping>();
for (const mapping of DIALECT_MAPPINGS) {
  const key = lexicalKey(mapping.from);
  (key.includes(' ') ? PHRASE : SINGLE).set(key, mapping);
}

const DIALECT_PROJECTION: Readonly<Record<string, string>> = {
  شوف: 'شوف', شوفلي: 'شوف لي', شوفه: 'شوفه', شوفها: 'شوفها', شوفلنا: 'شوف لنا',
  بتاعي: 'بتاعي', تبعي: 'تبعي', مالتي: 'مالتي', ديالي: 'ديالي',
};
const QUESTION_AFTER = /^(?:ما|ماذا|لماذا|اين|كيف|متي|من|كم|هل|اي|ايان|ممن|عمن|كيفيه)$/u;
const WANT_COMMAND = /^(?:اكتب|صغ|ترجم|لخص|اعد|صحح|اشرح|وضح|فسر|ابحث|دور|فتش|اعمل|افعل|انشئ|جهز|صمم|شوف|انظر|اعرض|افتح|ادخل|اضغط|انقر|اختر|اقرا|احسب|حول|ذكرني|ذكرنا|تذكر|احفظ|اوقف|غير|نظم|خطط|ساعدني|استرجع|احجز)$/u;
const REQUEST_HEAD = /^(?:ما|ماذا|لماذا|اين|كيف|متي|من|كم|هل|اي|ايان|رجاء|لا|ليس|اريد|معرفه|الطقس|الاخبار|طقس|اخبار|ماهو|ماهي|ماهذا)(?!\p{L})|^(?:what|who|when|where|why|how|which|is|are|do|does|did|can|will|could|would|please|don't|never|not|search|look up|tell|explain|describe|find|write|draft|translate|type|enter|click|tap|open|show|calculate|compute|remember|read|help|i want)\b/u;
// These existing parser verbs take an exact label, search phrase, or user payload.
// Once a head is recognized, the parser projection preserves its original tail.
const LITERAL_OPERAND = /^(?:اكتب|صغ|ترجم|لخص|اعد|صحح|ابحث|دور|فتش|افتح|ادخل|اضغط|انقر|اختر|search|type|enter|write|draft|rewrite|translate|click|tap|choose|select|open|visit)$/u;
const LEAD_WORDS = /[^\s،,!.؟?؛;:：]+/gu;
const GREETING = /^(?:(?:مرحبا|اهلا|هلا|شكرا|تسلم|صباح الخير|مساء الخير|السلام عليكم(?: ورحمه الله(?: وبركاته)?)?)(?: يا [\p{L}]{1,30})?|(?:hi|hello|hey|thanks|thank you|good morning|good evening)(?: mohassan)?|سلام)$/u;
const POLITENESS = /^(?:من فضلك|لو سمحت|رجاء|ارجوك|please|kindly)$/u;
const SOCIAL_QUESTION = /^(?:كيف حالك|كيفك|كيف الحال|how are you|how are you doing)[.!?؟]*$/u;
const CONJUNCTION = /^[وف]/u;
const WANT_PREDICATE = /^(?:معرفه|معرفة|مساعده|مساعدة|اعرف|اتعلم|استفسر|افهم|اسال|احتاج|اشتري|جواب|اجابه|إجابة|نسخه|نسخة|تعريف|سعر|قائمه|قائمة|جدول|معلومات|المعلومات|الطقس|اخبار|طلب|شي|شئ|شيء|سياره|سيارة|ان)$/u;
const NEGATIVE_PREDICATE = /^(?:جاهز[هة]?|موجود[هة]?|متاح[هة]?|صحيح[هة]?|عارف[هة]?|واضح[هة]?|ممكن|اكيد[هة]?|حاضر[هة]?|نافع[هة]?|بارد[هة]?|ساخن[هة]?|محتاج[هة]?|مناسب[هة]?|متاخر[هة]?|مفتوح[هة]?|مغلق[هة]?|تمام|مش|مو|موافق[هة]?|لي|لك|لها|له|لنا|لكم|لهم)$/u;

interface Word {
  value: string;
  key: string;
  start: number;
  end: number;
}

function wordBoundary(text: string, preceding: Word | undefined, current: Word): boolean {
  return !preceding || /[،,!?.؟؛;:\r\n]/u.test(text.slice(preceding.end, current.start));
}

function allowsDialectMapping(word: Word, before: Word | undefined, after: Word | undefined, atStart: boolean, tailQuestion: boolean): boolean {
  const next = after?.key ?? '';
  if (word.key === 'ليه') {
    return atStart || tailQuestion || /^(?:قل|قولي|قلي|اشرح|افهم|وضح|فسر|اعرف|كده|هكذا|حصل|عملت)$/u.test(before?.key ?? '')
      || ['مرحبا', 'اهلا', 'هلا', 'اهلين', 'فضلك', 'سمحت'].includes(before?.key ?? '');
  }
  if (word.key === 'نبي' || word.key === 'ابي') return WANT_PREDICATE.test(next) || WANT_COMMAND.test(next);
  if (word.key === 'دير') return atStart && !/^(?:مار|القديس|السيده|سيدنا|الزور)$/u.test(next);
  if (word.key === 'دول') return !next || SINGLE.get(next)?.category === 'question' || before?.key.startsWith('ال') === true;
  if (word.key === 'هلا') return atStart;
  if (word.key === 'معلش') return atStart;
  if (word.key === 'بكم') return atStart || /^(?:السعر|سعر|التكلفه|تكلفه|الثمن|ثمن)$/u.test(foldForUnderstanding(before?.value ?? next));
  return true;
}

function stripRequestLead(text: string, stripWant: boolean, rounds = 0): string {
  if (rounds === 4) return text;
  let count = 0;
  for (const word of text.matchAll(LEAD_WORDS)) {
    if (++count > 8) break;
    const end = word.index + word[0].length;
    const prefix = foldForUnderstanding(text.slice(0, end));
    const greeting = GREETING.test(prefix);
    const want = stripWant && /^(?:انا )?اريد(?: ان)?$/u.test(prefix);
    if (!greeting && !want && !POLITENESS.test(prefix)) continue;
    const remainder = text.slice(end).replace(/^[\s،,!.؟?؛;:：]+/u, '');
    if (!remainder) continue;
    const suffix = stripRequestLead(remainder, stripWant, rounds + 1);
    const folded = foldForUnderstanding(suffix);
    if (!folded || greeting && SOCIAL_QUESTION.test(folded)) continue;
    const first = folded.match(/^[\p{L}\p{N}]+/u)?.[0] ?? '';
    if (want ? WANT_COMMAND.test(first) || QUESTION_AFTER.test(first) : REQUEST_HEAD.test(folded) || WANT_COMMAND.test(first)) return suffix;
  }
  return text;
}

function replaceWords(text: string, words: readonly Word[]): { canonical: string; parser: string } {
  let canonical = '', parser = '', cursor = 0;
  let parserTail: number | undefined;
  for (const [index, word] of words.entries()) {
    const previous = words[index - 1], next = words[index + 1];
    const between = next ? text.slice(word.end, next.start) : '';
    const candidate = next && /^\s+$/u.test(between) ? PHRASE.get(`${word.key} ${next.key}`) : undefined;
    const atStart = wordBoundary(text, previous, word);
    const attached = CONJUNCTION.test(word.key) ? SINGLE.get(word.key.slice(1)) : undefined;
    // Match an attached conjunction only on an otherwise unambiguous dialect question.
    const conjunction = attached?.category === 'question' && !['واش', 'وش'].includes(lexicalKey(attached.from)) ? word.key[0] : '';
    const key = SINGLE.has(word.key) || !conjunction ? word.key : word.key.slice(1);
    let mapping = candidate ?? SINGLE.get(key);
    let end = word.end;
    let value = digits(CORRECTIONS.get(word.key) ?? word.value);
    mapping ??= SINGLE.get(lexicalKey(value));
    if (mapping && !candidate && !allowsDialectMapping({ ...word, key }, previous, next, atStart, /^\s*[?؟]/u.test(text.slice(word.end, next?.start)))) mapping = undefined;
    if (mapping) {
      const replacement = mapping.to;
      // A joined «ماهو» before a definite subject is a common question spelling.
      // Keep the dialect negator before a known predicate, or after its subject.
      value = key === 'ماهو' && atStart && next && !NEGATIVE_PREDICATE.test(next.key) && !WANT_COMMAND.test(next.key) ? 'ما هو' : replacement;
      if (conjunction && key !== word.key) value = conjunction + value;
      if (candidate && next) end = next.end;
    }
    if (word.start < cursor) continue;
    const gap = text.slice(cursor, word.start);
    canonical += gap + value;
    if (parserTail === undefined) {
      const parserValue = mapping ? DIALECT_PROJECTION[key] ?? value : value;
      parser += gap + parserValue;
      if (LITERAL_OPERAND.test(lexicalKey(parserValue))) parserTail = end;
    }
    cursor = end;
  }
  return { canonical: canonical + text.slice(cursor), parser: parser + text.slice(parserTail ?? cursor) };
}

/** Normalize only the match views. Display, original tool arguments and persisted user text use displayText. */
export function normalize(text: string): NormalizedText {
  const content = maskRequestLiteralData(text).replace(PROTECTED, blank);
  // A colon after a transliterated instruction can introduce unquoted payload.
  // Respect the same literal boundary as the existing request parser.
  const romanTransform = /^\s*(?:targem|tarjem|la5es|lakhis)\b[^:\r\n]{0,200}[:：]/iu.exec(content);
  const view = romanTransform ? content.slice(0, romanTransform[0].length) : content;
  const tokens = [...view.matchAll(WORD)];
  const isArabizi = romanTransform !== null || isArabiziText(tokens.map(token => token[0]));
  const mixedScript = ARABIC.test(view);
  const words = tokens.map((match): Word => {
    const from = match[0];
    const value = isArabizi ? transliterateArabizi(from, mixedScript) : from;
    return { value, key: lexicalKey(value), start: match.index, end: match.index + from.length };
  });
  const { canonical, parser } = replaceWords(text, words);
  return { displayText: text, matchText: foldForUnderstanding(stripRequestLead(canonical, false)), parserText: stripRequestLead(parser, true), isArabizi };
}
