import type { Evidence } from './mind/contract.js';
import { evaluateLocalComputation, type LocalComputation } from './local-computation.js';
import { requestLanguage, type ReplyLanguage } from './reply-directive.js';

/**
 * A calculation on a result this conversation already holds: «Add 12 to your previous result.» after «37 × 24 = 888»
 * (live test of 2026-11-23, which ended «not solved by the available local capabilities»), «اضرب الناتج السابق في 3»,
 * «Multiply it by 2». The referent is read only from this conversation's own runs (the host passes them), never from
 * another conversation or account; with none, the owner is asked for the number, and the same request then finishes.
 */
export interface ComputedRecord {
  /** The calculation as the calculator read it («37 * 24»). */
  expression: string;
  /** Its result, as shown («888»). */
  value: string;
  /** The calculator's own line («37 * 24 = 888»). */
  line: string;
}
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
export function computationReference(request: string): ComputationReference | null {
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
  const phrase = take(AR_PHRASE.exec(folded), value => value);
  if (phrase) return phrase;
  const preposition = AR_PREPOSITION.exec(folded);
  // «أضف 12 عليها» adds onto it: the calculator reads «أضف 12 إلى 888».
  if (preposition) return take(preposition, value => `${preposition[1] === 'علي' && /(?<![\p{L}])(?:اضف|اجمع|زد|زود)(?![\p{L}])/u.test(folded) ? 'إلى' : request.slice(preposition.index, preposition.index + preposition[1]!.length)} ${value}`);
  const verb = AR_VERB.exec(folded);
  if (verb) return take(verb, value => `${request.slice(verb.index, verb.index + verb[1]!.length)} ${value}`);
  return null;
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

/** The calculation of a request whose reference was written in, read in the calculator's form when needed. */
export function evaluateReferencedComputation(text: string, now = new Date()): LocalComputation | null {
  const direct = evaluateLocalComputation(text, now);
  if (direct) return direct;
  const form = calculatorForm(text);
  return form ? evaluateLocalComputation(form, now) : null;
}

const LINE = /^(.+?)\s=\s(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/iu;
/** «(12) + (888) = 900» as «12 + 888 = 900»: the calculator brackets each operand of a spoken operation. */
const tidyLine = (line: string) => line.replace(/\((-?\d+(?:\.\d+)?)\)/gu, '$1');
/** The record a completed local calculation leaves in its run state, so a later turn can refer to it. */
export function computedRecord(result: Pick<LocalComputation, 'status' | 'evidence'>): ComputedRecord | null {
  if (result.status !== 'completed') return null;
  const evidence = result.evidence.find(item => item.id === 'calculation' && typeof item.value === 'string');
  const parsed = evidence ? LINE.exec(tidyLine(evidence.quote.trim())) : null;
  return parsed && evidence?.value === parsed[2] ? { expression: parsed[1]!.trim(), value: parsed[2]!, line: parsed[0] } : null;
}

/**
 * The latest result among this conversation's earlier runs, newest first: the run state's own record, else the
 * calculator's trail line of a run recorded before records existed («calculate» → «37 * 24 = 888»).
 */
export function latestComputedResult(states: readonly unknown[]): ComputedRecord | null {
  for (const state of states) {
    if (!state || typeof state !== 'object') continue;
    const record = (state as { computed?: unknown }).computed;
    if (record && typeof record === 'object') {
      const { expression, value, line } = record as Record<string, unknown>;
      if (typeof expression === 'string' && typeof value === 'string' && typeof line === 'string' && LINE.test(line)) return { expression, value, line };
    }
    const trail = (state as { trail?: unknown }).trail;
    if (Array.isArray(trail)) {
      const entry = [...trail].reverse().find(item => item && typeof item === 'object' && (item as { action?: unknown }).action === 'calculate');
      const parsed = entry && typeof (entry as { result?: unknown }).result === 'string' ? LINE.exec(((entry as { result: string }).result).trim().split('\n')[0]!) : null;
      if (parsed) return { expression: parsed[1]!.trim(), value: parsed[2]!, line: parsed[0] };
    }
  }
  return null;
}

/** A number the owner typed («888», «٨٨٨», «1,250.5»), or the result of a calculation they typed instead. */
export function referencedValueFromAnswer(answer: string, now = new Date()): { value: string; line: string | null } | null {
  const text = answer.normalize('NFKC').replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/gu, digit => String(digit.charCodeAt(0) - 0x06f0)).trim();
  const plain = /^(-?\d{1,15}(?:[,٬]\d{3})*(?:[.٫]\d+)?)[.!]?$/u.exec(text);
  if (plain) return { value: plain[1]!.replace(/[,٬]/gu, '').replace('٫', '.'), line: null };
  const computed = evaluateLocalComputation(text, now);
  const record = computed ? computedRecord(computed) : null;
  return record ? { value: record.value, line: record.line } : null;
}

/**
 * The reply to a calculation on an earlier value: the calculation's own line, then where the value came from. Every line
 * is a computed claim with its own evidence, as the chat's supervision requires of a local answer.
 */
export function composeReferencedComputation(result: LocalComputation, source: { value: string; line: string | null; from: 'conversation' | 'owner' }): LocalComputation {
  const lang: ReplyLanguage = result.lang;
  const main = result.evidence.some(item => item.id === 'calculation-reply') ? result.text : tidyLine(result.text);
  const note = lang === 'ar'
    ? source.from === 'conversation' ? `${source.value} هو الناتج السابق في هذه المحادثة${source.line ? ` (${source.line})` : ''}.` : `${source.value} هو الرقم الذي كتبته${source.line ? ` (${source.line})` : ''}.`
    : source.from === 'conversation' ? `${source.value} is the previous result in this conversation${source.line ? ` (${source.line})` : ''}.` : `${source.value} is the number you gave${source.line ? ` (${source.line})` : ''}.`;
  const mainEvidence: Evidence = { id: 'calculation-shown', source: 'computed', quote: main, value: result.evidence.find(item => item.id === 'calculation')?.value };
  const noteEvidence: Evidence = { id: 'referenced-value', source: 'computed', quote: note, value: source.value };
  // One line per claim: the supervision compares the reply with its claims joined by a newline.
  return { ...result, text: `${main}\n${note}`,
    claims: [{ text: main, support: [mainEvidence.id], status: 'confirmed' }, { text: note, support: [noteEvidence.id], status: 'confirmed' }],
    evidence: [...result.evidence, mainEvidence, noteEvidence] };
}

/** The focused question when the request points at a result this conversation does not have. */
export function missingReferenceQuestion(request: string, reference: ComputationReference): { prompt: string; lang: ReplyLanguage } {
  const lang = requestLanguage(request);
  return lang === 'ar'
    ? { lang, prompt: `أي نتيجة تقصد بـ«${reference.phrase}»؟ لا توجد عملية حسابية سابقة في هذه المحادثة. اكتب الرقم، أو العملية التي جاء منها، وسأكمل طلبك به.` }
    : { lang, prompt: `Which result do you mean by “${reference.phrase}”? This conversation has no earlier calculation. Send the number, or the calculation it came from, and I will finish your request with it.` };
}
