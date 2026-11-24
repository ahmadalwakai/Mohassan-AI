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
const AR_RESULT = /(?<!\p{L})ال(?:نتيجه|ناتج|جواب|اجابه|قيمه|مجموع|حاصل)(?!\p{L})/u;
const IMPLIED_OPERAND = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+)?(?:(?:multiply|divide)\s+(?=by\s)|اضرب\s+(?=في\s)|اقسم\s+(?=علي\s))/iu;
/** «إليها», «عليه», «منها», «فيها» after a number: «أضف 12 إليها», «اطرح 5 منه». */
const AR_PREPOSITION = /(?<=[\d٠-٩]\s+)(الي|علي|من|في)(ها|ه)(?![\p{L}])/u;
/** «اضربها في 3», «اقسمه على 2», «اجمعها مع 5». */
const AR_VERB = /(?<![\p{L}])(اضرب|اقسم|اطرح|اجمع|ضاعف)(ها|ه)(?![\p{L}])/u;

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
  if (!OPERATION.test(folded) || !HAS_OPERAND.test(folded)) return null;
  const take = (match: RegExpExecArray | null, replaceWith: (value: string) => string): ComputationReference | null => match
    ? { start: match.index, end: match.index + match[0].length, phrase: request.slice(match.index, match.index + match[0].length), replaceWith } : null;
  const english = take(EN_PHRASE.exec(folded), value => value) ?? take(EN_PRONOUN.exec(folded), value => value);
  if (english) return english;
  const phrase = take(AR_PHRASE.exec(folded) ?? (inSequence ? AR_RESULT.exec(folded) : null), value => value);
  if (phrase) return phrase;
  const preposition = AR_PREPOSITION.exec(folded);
  // «أضف 12 عليها» adds onto it: the calculator reads «أضف 12 إلى 888».
  if (preposition) return take(preposition, value => `${preposition[1] === 'علي' && /(?<![\p{L}])(?:اضف|اجمع|زد|زود)(?![\p{L}])/u.test(folded) ? 'إلى' : request.slice(preposition.index, preposition.index + preposition[1]!.length)} ${value}`);
  const verb = AR_VERB.exec(folded);
  if (verb) return take(verb, value => `${request.slice(verb.index, verb.index + verb[1]!.length)} ${value}`);
  const implied = inSequence ? IMPLIED_OPERAND.exec(folded) : null;
  return implied ? take(implied, value => `${request.slice(0, implied[0].length)}${value} `) : null;
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
  const match = /^\s*(?:أضف|اضف|إضف|زد|زود|زوّد)\s+(\S+)\s+(?:إلى|الى|إلي|الي|على|علي|ل)\s*(\S+?)\s*([.!؟?]*)$/u.exec(text.normalize('NFC'));
  return match ? `اجمع ${match[1]} مع ${match[2]}${match[3]}` : null;
}
