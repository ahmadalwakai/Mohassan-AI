import { requestLanguage } from './reply-directive.js';

export interface ComputationReference { start: number; end: number; phrase: string; replaceWith: (value: string) => string }

/** One-for-one folding: offsets in the folded copy are offsets in the original. */
const foldSameLength = (text: string) => text.replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase();

const EN_NOUN = String.raw`(?:result|answer|value|number|total|sum|product|output|figure|outcome)`;
/** «your previous result», «the last answer», «that result», «the result above». */
const EN_PHRASE = new RegExp(String.raw`\b(?:(?:your|my|our|the|that|this)\s+(?:(?:previous|last|prior|earlier|latest|current|above|same)\s+)?${EN_NOUN}(?:\s+(?:above|before|you gave|you got|from before))?|(?:previous|last|prior|earlier)\s+${EN_NOUN})\b`, 'iu');
/** «it» or «that» as an operand: «add 12 to it», «multiply it by 3», «it times 2». */
const EN_PRONOUN = /(?<=\b(?:to|from|by|of)\s+)(?:it|that|this)\b(?!\s+(?:is|was|says|means))|(?<=^\s*(?:please\s+)?(?:multiply|divide|subtract|add)\s+)(?:it|that|this)\b|^\s*(?:it|that)\b(?=\s+(?:times|plus|minus|divided by|multiplied by|over)\b)/iu;
/** «النتيجة السابقة», «الناتج الأخير», «نتيجتك السابقة», «الجواب السابق». */
const AR_PHRASE = /(?<![\p{L}])(?:(?:ال)?(?:نتيجه|ناتج|جواب|اجابه|قيمه|مجموع|حاصل)(?:\s+(?:ال)?(?:سابق|سابقه|اخير|اخيره|قبل))|(?:نتيجتك|ناتجك|جوابك|اجابتك)(?:\s+(?:ال)?(?:سابق|سابقه|اخير|اخيره))?)(?![\p{L}])/u;
const AR_SEQUENCE_RESULT = /(?<!\p{L})ال(?:نتيجه|ناتج|جواب|اجابه|قيمه|مجموع|حاصل)(?!\p{L})/u;
const OMITTED_SEQUENCE_OPERAND = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+)?(?:(?:multiply|divide)\s+(?=by\s)|اضرب\s+(?=في\s)|اقسم\s+(?=علي\s))/iu;
/** «إليها», «عليه», «منها», «فيها» after a number: «أضف 12 إليها», «اطرح 5 منه». */
const AR_PREPOSITION = /(?<=[\d٠-٩]\s+)(الي|علي|من|في)(ها|ه)(?![\p{L}])/u;
/** «اضربها في 3», «اقسمه على 2», «اجمعها مع 5». */
const AR_VERB = /(?<![\p{L}])(اضرب|اقسم|اطرح|اجمع|ضاعف)(ها|ه)(?![\p{L}])/u;

const EN_REQUEST = String.raw`(?:(?:can|could|would)\s+you\s+)?(?:(?:please|kindly)\s+)?`;
const SHOW_RESULT = String.raw`(?:(?:\s*,)?\s+and\s+(?:give|show|tell|return|report|state)\s+(?:me\s+)?(?:the\s+)?(?:result|answer|value|number))?`;
const DOUBLE_EN = new RegExp(String.raw`^\s*${EN_REQUEST}double\s+(.+?)${SHOW_RESULT}[\s.!?]*$`, 'diu');
const DOUBLE_AR = /^\s*(?:هل يمكنك\s+)?ضاعف\s+(.+?)[\s.!?؟]*$/du;
const DOUBLE_CLITIC = /^\s*((ضاعف)(?:ها|ه))[\s.!?؟]*$/du;
const AR_NUMBER_REFERENCE = /^(?:(?:هذا|ذلك)\s+(?:الرقم|العدد|الناتج)|(?:هذه|تلك)\s+(?:القيمه|النتيجه))$/u;
const CONVERT_PRONOUN = new RegExp(String.raw`^\s*${EN_REQUEST}convert\s+(it|that|this)(?=\s)`, 'diu');
const CONVERT_AMOUNT = new RegExp(String.raw`^\s*${EN_REQUEST}convert\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(?:from\s+)?(.+?)\s+(?:to|into|in)\s+(.+)$`, 'iu');
const NUMERIC_VALUE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu;

function doubleOperand(text: string): [number, number] | undefined {
  return (DOUBLE_EN.exec(text) ?? DOUBLE_AR.exec(text))?.indices?.[1];
}

/**
 * The request is an operation on numbers: an operator word or sign, and a number or an operand pronoun beside it.
 * «What is the result of the election?» names a result but asks for no operation, so it is not a reference here.
 */
const OPERATION = /\b(?:add|plus|subtract|minus|multiply|multiplied|times|divide|divided|over|increase|decrease)\b|[+*/×÷^]|(?<=\s)-(?=\s)|(?<![\p{L}])(?:اضف|اجمع|زد|زود|اطرح|انقص|اضرب|اقسم|ضاعف|زائد|زايد|ناقص|ضرب|قسمه|مضروب|مقسوم)/iu;
const HAS_OPERAND = /[\d٠-٩]|(?<![\p{L}])(?:اضرب|اقسم|اطرح|اجمع|ضاعف)(?:ها|ه)(?![\p{L}])/u;

/** The phrase in the request that points at an earlier result, or null. */
export function computationReference(request: string, inSequence = false): ComputationReference | null {
  if (typeof request !== 'string' || !request.trim() || request.length > 2000) return null;
  const folded = foldSameLength(request);
  const operand = (start: number, end: number, replaceWith: (value: string) => string): ComputationReference => ({
    start, end, phrase: request.slice(start, end), replaceWith,
  });
  const take = (match: RegExpExecArray | null, replaceWith: (value: string) => string): ComputationReference | null => match
    ? operand(match.index, match.index + match[0].length, replaceWith) : null;
  const double = doubleOperand(folded);
  if (double) {
    const reference = folded.slice(...double);
    if (/^(?:it|that|this)$/iu.test(reference) || AR_NUMBER_REFERENCE.test(reference)
      || EN_PHRASE.exec(reference)?.[0] === reference || AR_PHRASE.exec(reference)?.[0] === reference) {
      return operand(...double, value => value);
    }
  }
  const clitic = DOUBLE_CLITIC.exec(folded);
  if (clitic?.indices?.[1]) return operand(...clitic.indices[1], value => `${clitic[2]} ${value}`);
  const convert = CONVERT_PRONOUN.exec(folded)?.indices?.[1];
  if (convert) return operand(...convert, value => value);
  if (!OPERATION.test(folded) || !HAS_OPERAND.test(folded)) return null;
  const english = take(EN_PHRASE.exec(folded), value => value) ?? take(EN_PRONOUN.exec(folded), value => value);
  if (english) return english;
  const phrase = take(AR_PHRASE.exec(folded) ?? (inSequence ? AR_SEQUENCE_RESULT.exec(folded) : null), value => value);
  if (phrase) return phrase;
  const preposition = AR_PREPOSITION.exec(folded);
  // «أضف 12 عليها» adds onto it: the calculator reads «أضف 12 إلى 888».
  if (preposition) return take(preposition, value => `${preposition[1] === 'علي' && /(?<![\p{L}])(?:اضف|اجمع|زد|زود)(?![\p{L}])/u.test(folded) ? 'إلى' : request.slice(preposition.index, preposition.index + preposition[1]!.length)} ${value}`);
  const verb = AR_VERB.exec(folded);
  if (verb) return take(verb, value => `${request.slice(verb.index, verb.index + verb[1]!.length)} ${value}`);
  const omitted = inSequence ? OMITTED_SEQUENCE_OPERAND.exec(folded) : null;
  return omitted ? operand(omitted[0].length, omitted[0].length, value => `${value} `) : null;
}

/** The request with the referenced result written in: «Add 12 to 888.». */
export function withReferencedValue(request: string, reference: ComputationReference, value: string): string {
  return `${request.slice(0, reference.start)}${reference.replaceWith(value)}${request.slice(reference.end)}`;
}

/**
 * The shared calculator reads «اجمع 12 مع 888» but not «أضف 12 إلى 888» or «زد 12 على 888» (its frame does not take
 * «أضف» as a calculation; measured 2026-11-23). An addition written with those verbs is given in the form it reads.
 */
export function calculatorForm(text: string): string | null {
  const normalized = text.normalize('NFC');
  const match = /^\s*(?:أضف|اضف|إضف|زد|زود|زوّد)\s+(\S+)\s+(?:إلى|الى|إلي|الي|على|علي|ل)\s*(\S+?)\s*([.!؟?]*)$/u.exec(normalized);
  if (match) return `اجمع ${match[1]} مع ${match[2]}${match[3]}`;

  const double = doubleOperand(foldSameLength(normalized));
  const value = double && normalized.slice(...double);
  if (value && NUMERIC_VALUE.test(value)) {
    const expression = `(${value}) × 2`;
    return requestLanguage(text) === 'ar' ? `احسب ${expression}` : `Calculate ${expression}`;
  }

  const conversion = CONVERT_AMOUNT.exec(normalized);
  return conversion ? `Convert ${conversion[1]} ${conversion[2]} to ${conversion[3]}` : null;
}
