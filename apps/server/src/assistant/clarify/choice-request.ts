import { z } from 'zod';
import { evaluateLocalComputation } from '../local-computation.js';
import { parseUserRequestConstraints } from '../request-constraints.js';
import { conversionQuantity } from './conversion-input.js';

export const ChoiceRequestEditSchema = z.object({
  kind: z.enum(['entity', 'date', 'account', 'file', 'conversion']),
  subject: z.string().min(1).max(160).optional(),
}).strict();
export type ChoiceRequestEdit = z.infer<typeof ChoiceRequestEditSchema>;

const literalValue = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,،'’_:/@&+()–—-]*$/u;
const filePath = /^(?:(?:[a-z]:)?[\\/])?[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,_/\\()–—-]*$/iu;
const instruction = /\b(?:then|also|instead|followed by)\b|(?:^|\s)(?:ثم|بعدها|أيضًا|بدلًا)(?=\s|$)|(?:^|\s)(?:ignore|disregard|override)\s+(?:the\s+)?(?:rules|instructions|prompt)\b/iu;
const actionClause = /(?:\b(?:and|or)\s+|\.\s+)(?:delete|send|email|publish|save|remember|run|execute|open|search|look up|write|create|change|upload|download)\b|(?<!\p{L})(?:و\s*|[.،]\s+)(?:احذف|أحذف|أرسل|ارسل|انشر|احفظ|شغّل|شغل|نفذ|افتح|ابحث|اكتب|أنشئ|انشئ|غير)(?!\p{L})/iu;
const other = /^(?:other|something else|غير ذلك|شيء آخر)$/iu;
const entityPointer = /(?<![\p{L}\p{M}\p{N}])(?:it|them|this|that|these|those|he|she|there|هذا|هذه|ذلك|تلك|هو|هي|هناك|هنالك)(?![\p{L}\p{M}\p{N}])/giu;
const punctuation = /[.!?؟…]+$/u;
const arabic = /\p{Script=Arabic}/u;
const computerSuffix = /(?:\s+on my (?:computer|pc)|\s+على\s+جهازي)$/iu;
const accountSuffix = /\b(my|the) account$/iu;
const unitLabel = String.raw`[\p{L}\p{M}\p{N}°][\p{L}\p{M}\p{N}°^/ .-]*?`;
const unitPair = new RegExp(String.raw`^(?:(?:from|من)\s+)?(${unitLabel})\s+(?:to|into|[إا]ل[يى])\s+(${unitLabel})[.!?؟]*$`, 'iu');

function replaceUniqueSubject(goal: string, subject: string, value: string): string | null {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...goal.matchAll(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu'))];
  if (matches.length !== 1) return null;
  const { index, 0: matched } = matches[0]!;
  return goal.slice(0, index) + value + goal.slice(index + matched.length);
}

function explicitEntityRequest(goal: string, subject: string | undefined, value: string): string | null {
  const pointers = subject ? [] : [...goal.matchAll(entityPointer)];
  const target = subject ?? (pointers.length === 1 ? pointers[0]?.[0] : undefined);
  if (!target) return null;
  const followUp = /^\s*(?:(?:what|how) about\s+|(?:ما|ماذا) عن\s+)/iu;
  const where = !followUp.test(goal) && /^(?:there|هناك|هنالك)$/iu.test(target);
  const replacement = where ? `${arabic.test(goal) ? 'في' : 'in'} ${value}` : value;
  const projected = replaceUniqueSubject(goal, target, replacement);
  return projected?.replace(followUp, arabic.test(goal) ? 'ماذا تعرف عن ' : 'What can you tell me about ') ?? null;
}

function conversionRequest(goal: string, answer: string): string | null {
  const constraints = parseUserRequestConstraints(goal);
  const span = constraints?.positiveSpan;
  if (constraints && !span) return null;
  const action = span ? goal.slice(span.start, span.end) : goal;
  const quantity = conversionQuantity(action);
  const units = unitPair.exec(answer);
  if (!quantity || !units) return null;
  const [, from, to] = units;
  const request = arabic.test(action) ? `حوّل ${quantity} ${from} إلى ${to}` : `Convert ${quantity} ${from} to ${to}`;
  const calculation = evaluateLocalComputation(request, new Date(0));
  if (calculation?.status !== 'completed' || calculation.consumption?.kind !== 'conversion') return null;
  return span ? `${goal.slice(0, span.start)}${request}${goal.slice(span.end)}` : request;
}

/** The only data added to an operand is the exact answer saved in the user message. */
export function applyChoiceRequestEdit(goal: string, answer: string, edit: ChoiceRequestEdit): string | null {
  const value = answer.trim();
  if (value.length > 160 || instruction.test(value) || actionClause.test(value) || other.test(value)) return null;
  if (edit.kind === 'conversion') return conversionRequest(goal, value);
  if (!(edit.kind === 'file' ? filePath : literalValue).test(value)) return null;
  if (edit.kind === 'entity') return explicitEntityRequest(goal, edit.subject, value);
  if (edit.subject) return replaceUniqueSubject(goal, edit.subject, value);
  const suffix = goal.match(punctuation)?.[0] ?? '';
  const action = goal.replace(punctuation, '');
  if (edit.kind === 'file') return `${action.replace(computerSuffix, '')} ${value}${suffix}`;
  if (edit.kind === 'account' && accountSuffix.test(action)) return `${action.replace(accountSuffix, (_, determiner) => `${determiner} ${value} account`)}${suffix}`;
  const joiner = edit.kind === 'date' ? arabic.test(goal) ? ' في تاريخ ' : ' on ' : arabic.test(goal) ? ' للحساب ' : ' for the account ';
  return `${action}${joiner}${value}${suffix}`;
}
