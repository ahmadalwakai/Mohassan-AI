import { lemmaKeys } from '@mohassan/skills';
import { isEntireLiteralRequest, maskRequestLiteralData, parseUserRequestConstraints } from '../request-constraints.js';
import { foldForUnderstanding, normalize } from './normalization.js';
import { detectQuestionShape, type QuestionShape } from './question-shape.js';

export { normalize, detectQuestionShape };
export type { QuestionShape };

/** The small, host-derived view parsers can share and a chat run can retain across a retry. */
export interface RequestUnderstandingView {
  parserText: string;
  question: QuestionShape | null;
  isArabizi: boolean;
}

export interface RequestUnderstanding extends RequestUnderstandingView {
  displayText: string;
  matchText: string;
  lemmaKeys: string[];
}

export function understandRequest(text: string): RequestUnderstanding {
  const normalized = normalize(text);
  return { ...normalized, question: detectQuestionShape(normalized.matchText), lemmaKeys: lemmaKeys(normalized.matchText) };
}

/** Constraints and quoted payloads are interpreted from the original request and its original spans. */
export function parserView(understanding: RequestUnderstanding): RequestUnderstandingView | undefined {
  const { displayText, parserText, question, isArabizi } = understanding;
  if (!parserText.trim() || parserText.length > 8000 || isEntireLiteralRequest(displayText)
    || parseUserRequestConstraints(displayText) || parseUserRequestConstraints(parserText)) return undefined;
  // A new public interpretation must not turn a colloquial negative instruction into a positive action.
  const outer = maskRequestLiteralData(parserText);
  if (/(?:^|[.!?؟،,;؛\n]\s*)(?:ليس|مش|مو|ماهو)\s+(?:(?:أريد|اريد|عايز|أبغى|ابغى|بدي|حاب|نبي)\p{L}*\s+)?(?:أن\s+|ان\s+)?ت(?:بحث|دور|فتش|تصفح|فتح|ستخدم|حفظ|ضغط|نقر|كتب)(?!\p{L})/iu.test(outer)) return undefined;
  return { parserText, question, isArabizi };
}

const DETACHED_OWNER = /(?:^|[^\p{L}\p{N}])(?:بتاعي|بتاعتي|بتاعنا|تبعي|تبعنا|مالتي|مالنا|ديالي|ديالنا|تاعي|تاعنا)(?![\p{L}\p{N}])/u;
const FINANCIAL_OWNER = /(?:^|\s)(?:ال)?(?:رقم|باسوورد|باسورد|حساب|بنك|ملف|هاتف|جوال|بريد|مشروع)\s+(?:ال\p{L}+\s+){0,3}مالي(?![\p{L}\p{N}])/u;
const ATTACHED_OWNER = /(?:^|[^\p{L}\p{N}])(?:[وبلف]?(?:حساب|جوال|موبايل|هاتف|بريد|ايميل|ملف|جواز|بطاقت|هويت|راتب|عميل|زبون|سر))(?:ي|نا)(?![\p{L}\p{N}])|(?:^|\s)كلم[هة] (?:السر|المرور) (?:الخاص[هة] )?ب(?:ي|نا)(?![\p{L}\p{N}])/u;

export function hasColloquialOwnedRecord(text: string): boolean {
  const outer = foldForUnderstanding(maskRequestLiteralData(text));
  return DETACHED_OWNER.test(outer) || FINANCIAL_OWNER.test(outer) || ATTACHED_OWNER.test(outer);
}

/** A newly recognized public action must not send adjacent free-form clauses with its query. */
export function isSinglePublicClause(text: string): boolean {
  const outer = maskRequestLiteralData(text).replace(/(?:https?:\/\/|www\.)[^\s<>"'«»]+/giu, ' ');
  return !/(?:[!?؟:：;؛،,]|\.(?=\s)|[\r\n])\s*(?=[\p{L}\p{N}])/u.test(outer);
}

/** Only the view bound to the current full user message is reusable at execution. */
export function boundUnderstanding(text: string, resolution?: { original: string; understanding?: RequestUnderstandingView } | null): RequestUnderstandingView | undefined {
  if (!resolution?.understanding) return undefined;
  const clean = text.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim();
  return resolution.original === clean ? resolution.understanding : undefined;
}
