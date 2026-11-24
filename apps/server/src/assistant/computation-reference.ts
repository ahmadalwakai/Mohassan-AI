import type { Evidence } from './mind/contract.js';
import { evaluateLocalComputation, type LocalComputation } from './local-computation.js';
import { requestLanguage, type ReplyLanguage } from './reply-directive.js';
import { calculatorForm, type ComputationReference } from './computation-reference-language.js';

export { calculatorForm, computationReference, withReferencedValue, type ComputationReference } from './computation-reference-language.js';

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
