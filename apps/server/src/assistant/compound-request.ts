import { assessRequestScope } from './request-scope.js';

export const MAX_COMPOUND_REQUEST = 8000;
export const MAX_COMPOUND_ACTIONS = 8;
export type PendingActionKind = 'compute' | 'save' | 'send' | 'publish' | 'schedule' | 'open' | 'delete' | 'change' | 'run';
export interface RequestSpan { text: string; start: number; end: number }
export interface CompoundAction extends RequestSpan { kind: PendingActionKind }
export interface CompoundRequestAnalysis {
  version: 1;
  kind: 'single' | 'compound' | 'unsupported_tail' | 'invalid';
  primary: RequestSpan;
  pendingActions: CompoundAction[];
  forbiddenActions: CompoundAction[];
  formatting: RequestSpan[];
  literalRanges: { start: number; end: number }[];
  /** Same UTF-16 offsets as input, with literal data blanked for classification. */
  outerText: string;
  reason?: 'invalid_input' | 'unbalanced_literal' | 'too_many_actions' | 'unrecognised_sequence' | 'missing_primary';
}

const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'").toLowerCase().trim();
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '«': '»', '“': '”', '‘': '’', '`': '`' };
const ACTION_HEADS: ReadonlyArray<readonly [PendingActionKind, RegExp]> = [
  ['save', /^(?:remember|save|store|record|احفظ|تذكر|سجل|خزن|تحفظ|تسجل)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['send', /^(?:send|email|mail|deliver|ارسل|ابعث|ابعت|ترسل|تبعث|تبعت)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['publish', /^(?:publish|post|انشر|تنشر)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['schedule', /^(?:remind|schedule|set (?:an? )?(?:alarm|reminder|timer)|ذكرني|نبهني|جدول|حدد موعدا?)(?!\p{L})/iu],
  ['open', /^(?:open|visit|navigate|go to|افتح|ادخل|اذهب|تفتح)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['delete', /^(?:delete|remove|erase|احذف|ازل|امسح|تحذف)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['change', /^(?:change|update|edit|replace|غير|عدل|حدث|بدل|تغير|تعدل)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['run', /^(?:run|execute|launch|شغل|نفذ|تشغل|تنفذ)(?:ها|ه|هم)?(?!\p{L})/iu],
  ['compute', /^(?:calculate|compute|convert|multiply|divide|add|subtract|احسب|حول|اضرب|اقسم|اجمع|اطرح)(?!\p{L})/iu],
];
const FORMAT = /^(?:(?:please|kindly|thanks|thank you|شكرا|من فضلك|لو سمحت)|(?:(?:give|return|show|output|answer)(?: me)?(?: with)?\s+)?(?:(?:only|just)\s+)?(?:the\s+)?(?:answer|result|value|number|calculation)(?:\s+(?:only|alone))?|(?:(?:اعطني|اعطيني|اكتب|اجب)\s+)?(?:ال)?(?:نتيجه|ناتج|جواب|اجابه|قيمه|رقم)(?:\s+(?:فقط|بس|وحدها))?|(?:only|just)\s+the\s+(?:answer|result|value|number)|(?:no|without(?: any)?)\s+(?:explanation|steps|working)|(?:بدون|بلا|دون|من دون)\s+(?:شرح|تفصيل|خطوات))[\s.!?؟،,;؛]*$/iu;
const CLAUSE_LEAD = /^(?:(?:please|kindly|من فضلك|لو سمحت)[,،:\s]+)+/iu;
const NEGATION = /^(?:(?:do not|don't|never|لا|دون|بدون)\s+)(?:(?:actually|ever)\s+)?/iu;
// These are recognisable requests outside this helper's supported pending-action
// taxonomy. They must not disappear behind a successful numeric prefix.
const UNSUPPORTED_HEAD = /^(?:explain|describe|summari[sz]e|translate|rewrite|paraphrase|draft|write|compose|list|report|format|put|show|display|present|اشرح|وضح|صف|لخص|ترجم|اعد صياغه|اكتب|صغ|اعرض|قدم|ضع|نسق|اذكر)(?!\p{L})/iu;

function span(text: string, start: number, end: number): RequestSpan {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return { text: text.slice(start, end), start, end };
}

/** Balanced literal regions never create an outer action, including code/URLs. */
function literals(text: string): { ranges: { start: number; end: number }[]; balanced: boolean } {
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < text.length;) {
    const address = /^https?:\/\/[^\s<>"'«»]+/iu.exec(text.slice(index));
    if (address) { ranges.push({ start: index, end: index + address[0].length }); index += address[0].length; continue; }
    const char = text[index]!, closing = QUOTES[char];
    if (!closing || (char === "'" || char === '‘') && /[\p{L}\p{N}]/u.test(text[index - 1] ?? '')) { index++; continue; }
    const fence = char === '`' && text.slice(index, index + 3) === '```';
    const endMarker = fence ? '```' : closing;
    const openingLength = fence ? 3 : 1;
    let end = index + openingLength;
    for (; end < text.length; end++) {
      if (text.slice(end, end + endMarker.length) === endMarker && text[end - 1] !== '\\') break;
    }
    if (end >= text.length) return { ranges, balanced: false };
    ranges.push({ start: index, end: end + endMarker.length });
    index = end + endMarker.length;
  }
  const source = assessRequestScope(text);
  if (source.source === 'supplied_content' && source.operation === 'transform') {
    for (const found of text.matchAll(/[:：]/gu)) {
      const at = found.index;
      if (ranges.some(range => at >= range.start && at < range.end)
        || /https?$/iu.test(text.slice(Math.max(0, at - 5), at))
        || /\d/u.test(text[at - 1] ?? '') && /\d/u.test(text[at + 1] ?? '')) continue;
      ranges.push({ start: at + 1, end: text.length });
      break;
    }
  }
  return { ranges: ranges.sort((a, b) => a.start - b.start), balanced: true };
}

interface Boundary { start: number; end: number; strong: boolean }
function matchingSource(outer: string): { text: string; starts: number[]; ends: number[] } {
  let text = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const char of outer) {
    const normalized = char.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '')
      .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/’/gu, "'").toLowerCase();
    for (let unit = 0; unit < normalized.length; unit++) { starts.push(offset); ends.push(offset + char.length); }
    text += normalized; offset += char.length;
  }
  return { text, starts, ends };
}

function boundaries(outer: string): Boundary[] {
  const result: Boundary[] = [];
  const source = matchingSource(outer);
  const pattern = /\b(?:and\s+then|then|afterwards|also|but)\b[\s,:،]*|\band\b\s+|(?<!\p{L})(?:ثم|وبعدها|وبعدين|بعدها|كذلك|ولكن|لكن)(?!\p{L})[\s,:،]*|و(?=(?:احفظ|تذكر|سجل|خزن|ارسل|انشر|ابعث|ابعت|ذكرني|نبهني|افتح|ادخل|اذهب|احذف|غير|عدل|شغل|نفذ|احسب|حول)(?:ها|ه|هم)?(?!\p{L}))|[.!?؟;؛]\s+(?=\p{L})/giu;
  for (const found of source.text.matchAll(pattern)) {
    if (result.length >= 256) return [...result, { start: -1, end: -1, strong: true }];
    const normalized = fold(found[0]);
    let end = source.ends[found.index + found[0].length - 1]!;
    while (end < outer.length && /[\u0640\u064b-\u065f\u0670]|\p{Cf}/u.test(outer[end]!)) end++;
    result.push({ start: source.starts[found.index]!, end,
      strong: normalized !== 'and' && normalized !== 'و' });
  }
  return result;
}

function actionHead(value: string): { kind?: PendingActionKind; forbidden: boolean; format: boolean } {
  let head = fold(value).replace(CLAUSE_LEAD, '');
  if (FORMAT.test(head)) return { forbidden: false, format: true };
  const negative = NEGATION.exec(head);
  if (negative) head = head.slice(negative[0].length);
  return { kind: ACTION_HEADS.find(([, pattern]) => pattern.test(head))?.[0], forbidden: Boolean(negative), format: false };
}

/**
 * Recognises explicit sequences, not a general planner. Exact spans refer to the
 * ORIGINAL argument. Pending actions are owner text, never grants or execution
 * receipts. Unknown outer sequence tails cannot be silently prefix-completed.
 */
export function analyzeCompoundRequest(text: string): CompoundRequestAnalysis {
  const original = typeof text === 'string' ? text : '';
  const base: CompoundRequestAnalysis = { version: 1, kind: 'single', primary: span(original, 0, original.length), pendingActions: [], forbiddenActions: [], formatting: [], literalRanges: [], outerText: original };
  if (!original.trim() || original.length > MAX_COMPOUND_REQUEST) return { ...base, kind: 'invalid', reason: 'invalid_input', outerText: '' };
  const literal = literals(original);
  base.literalRanges = literal.ranges;
  if (!literal.balanced) return { ...base, kind: 'invalid', reason: 'unbalanced_literal' };
  const masked = original.split('');
  for (const range of literal.ranges) for (let at = range.start; at < range.end; at++) masked[at] = ' ';
  base.outerText = masked.join('');
  const candidates = boundaries(base.outerText);
  if (candidates.some(item => item.start < 0)) return { ...base, kind: 'invalid', reason: 'too_many_actions' };
  const accepted: { boundary: Boundary; kind?: PendingActionKind; forbidden: boolean; format: boolean }[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const boundary = candidates[index]!;
    const next = candidates[index + 1]?.start ?? original.length;
    const chunk = base.outerText.slice(boundary.end, next).trim();
    if (!chunk) continue;
    const head = actionHead(chunk);
    if (head.kind || head.format) accepted.push({ boundary, ...head });
    else if (boundary.strong || UNSUPPORTED_HEAD.test(fold(chunk).replace(CLAUSE_LEAD, ''))) return { ...base, kind: 'unsupported_tail', primary: span(original, 0, boundary.start), reason: 'unrecognised_sequence' };
  }
  if (!accepted.length) return base;
  if (accepted.length > MAX_COMPOUND_ACTIONS) return { ...base, kind: 'invalid', reason: 'too_many_actions' };
  base.primary = span(original, 0, accepted[0]!.boundary.start);
  if (!base.primary.text) return { ...base, kind: 'invalid', reason: 'missing_primary' };
  base.kind = 'compound';
  for (let index = 0; index < accepted.length; index++) {
    const item = accepted[index]!, clause = span(original, item.boundary.end, accepted[index + 1]?.boundary.start ?? original.length);
    if (item.format) base.formatting.push(clause);
    else if (item.kind) (item.forbidden ? base.forbiddenActions : base.pendingActions).push({ ...clause, kind: item.kind });
  }
  return base;
}
