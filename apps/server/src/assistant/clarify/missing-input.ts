import { buildFrame } from '../mind/frame.js';
import type { RequestResolution } from '../request-context.js';
import { requestOperationText } from '../request-scope.js';
import type { RequestRoutingDecision } from '../routing-decision.js';
import { conversionOperand, conversionQuantity } from './conversion-input.js';

type MissingInput = 'expression' | 'dimensions' | 'conversion' | 'units' | 'number' | 'website' | 'subject';

const openConversion = /^(?:it|this|that|ذلك|هذا|هذه|ها|ه)$|(?:\b(?:to|into|in)|(?<!\p{L})(?:الي|من))\s*$/iu;
const measurement = /^(?:(?:calculate|compute|find|work out)\s+(?:the\s+)?|(?:احسب|احسبي|اوجد)(?:\s+لي)?\s+)(?:area|perimeter|volume|المساحه|المحيط|الحجم)(?:\s+(?:of|for|ل)\s+(?:it|this|that|هذا|هذه|ذلك))?$/iu;
const numericAction = /^(?:double|triple|halve|ضاعف|نصف)(?!\p{L})\s*(?:(?:it|this|that|العدد|الرقم|هذا|ذلك)(?!\p{L})|$)|(?:^|\s)(?:اذا|لو)\s+(?:ضاعف|نصف)(?:نا|ت|توا)?(?:ه|ها)(?!\p{L})/iu;
const priorDecision = /^(?:how (?:much|many)|what(?:\s+(?:price|amount|figure|number))?)\s+(?:did|had)\s+(?:we|i)\s+(?:agree\s+(?:on|to)|decide(?:\s+on)?|settle\s+on)$/iu;
const possessiveMeasure = /^(?:كم|قديش|شقد|شكد|ما)\s+(?:كان(?:ت)?\s+)?(?:ال)?(?:مجموع|اجمالي|رصيد|سعر|تكلفه|عدد|total|balance|price|cost)\s+(?:حق|تبع|بتاع)(?:ه|ها|هم)$/iu;

const prompts: Record<MissingInput, Record<'ar' | 'en', string>> = {
  expression: { en: 'What expression should I calculate?', ar: 'ما العملية الحسابية التي تريدني أن أجريها؟' },
  dimensions: { en: 'What shape and dimensions should I use for the calculation?', ar: 'ما الشكل وأبعاده التي أستخدمها في الحساب؟' },
  conversion: { en: 'Which units should I convert from and to?', ar: 'من أي وحدة إلى أي وحدة تريد التحويل؟' },
  units: { en: 'What quantity should I convert, and from which unit to which unit?', ar: 'ما الكمية التي تريد تحويلها، ومن أي وحدة إلى أي وحدة؟' },
  number: { en: 'Which number should I use for the calculation?', ar: 'أي رقم تريدني أن أستخدم في الحساب؟' },
  website: { en: 'Which website should I open or check? Please include its address.', ar: 'أي موقع تريدني أن أفتحه أو أتحقق منه؟ أرسل عنوانه.' },
  subject: { en: 'Which subject do you mean? Please include it in your request.', ar: 'ما الذي تريد معرفة تفاصيله؟ اذكر الموضوع في طلبك لأتمكن من المتابعة.' },
};

/** Runs only after complete local handlers, and narrows unresolved work to one missing input. */
export function missingRequestInput(text: string, language: 'ar' | 'en', resolution: RequestResolution | null | undefined,
  routing: Pick<RequestRoutingDecision, 'reason' | 'availability'> | null | undefined): { kind: 'request' | 'conversion'; prompt: string } | null {
  if (resolution?.kind === 'follow_up' || routing?.availability === 'restricted') return null;
  const frame = buildFrame(text);
  const action = requestOperationText(text).replace(/[.!?؟…]+$/u, '').trim();
  const operand = conversionOperand(text);
  let missing: MissingInput | undefined;
  if (frame.missing.includes('website')) missing = 'website';
  else if (conversionQuantity(text)) missing = 'conversion';
  else if (operand !== null && (!operand || openConversion.test(operand))) missing = 'units';
  else if (measurement.test(action)) missing = 'dimensions';
  else if (!/\d/u.test(action) && numericAction.test(action)) missing = 'number';
  else if (frame.missing.includes('expression')) missing = 'expression';
  else if (priorDecision.test(action) || possessiveMeasure.test(action)
    || routing?.reason === 'missing_reference' && frame.missing.includes('question')) missing = 'subject';
  return missing ? { kind: missing === 'conversion' ? 'conversion' : 'request', prompt: prompts[missing][language] } : null;
}
