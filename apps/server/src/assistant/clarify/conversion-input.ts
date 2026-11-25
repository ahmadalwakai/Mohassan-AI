import { requestOperationText } from '../request-scope.js';

const conversion = /^(?:convert|حول|حولي)(?!\p{L})(?:\s+(?:لي|لنا))?(?:\s+(.+))?$/iu;
const quantity = /^[+-]?\d+(?:[.٫]\d+)?$/u;

/** The requested conversion's operand clause, after optional courtesy and recipient phrases. */
export function conversionOperand(text: string): string | null {
  const action = requestOperationText(text).replace(/[.!?؟…]+$/u, '').trim().replace(/\s+for (?:me|us)$/iu, '');
  const match = conversion.exec(action);
  return match ? match[1] ?? '' : null;
}

/** A quantity with neither a source unit nor a target unit. */
export function conversionQuantity(text: string): string | null {
  // Position-sensitive digits are not quantities after compatibility folding.
  if (/[¹²³\u2070-\u209f]/u.test(text)) return null;
  const operand = conversionOperand(text);
  return operand && quantity.test(operand) ? operand.replace('٫', '.') : null;
}
