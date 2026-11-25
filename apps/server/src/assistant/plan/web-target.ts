import { namedSite } from '../brain.js';
import { requestScopeActionText } from '../request-scope.js';
import { webMeasureKind } from './web-figures.js';

const APPROACH = /^(?:(?:please|kindly|من فضلك|لو سمحت)[،,\s]+)?(?:read|open|visit|go\s+to|navigate\s+to|اقرأ|اقرا|إقرأ|افتح|تصفح|ادخل\s+(?:إلى|الى|على))\s+/iu;
const PAGE_OPERAND = /^(?:the\s+)?(?:(?:web\s*page|page|site|website)\s+(?:at|from)|(?:title|contents?|opening paragraph|first sentence)\s+(?:of|from|on))\s+|^(?:(?:محتو[ىي]|عنوان|نص)\s+)?(?:ال)?(?:صفحة|صفحه|موقع|رابط)(?:\s+(?:على|في))?\s+/iu;
const ENCLOSED = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|«([^»\r\n]+)»)$/u;
const URL_WITH_DETAIL = /^(?<url>https?:\/\/[^\s<>"'«»`]+?)[,،]?\s+(?<detail>.+)$/iu;
const DETAIL_PREFIX = /^(?:for\s+|(?:and\s+)?(?:read|find|check|extract|tell me|show me|look up)\s+|(?:و\s*)?(?:اقر[اأإ]|اگرا|[أا]عرف|خذ|استخرج|تحقق من|حدّد|حدد|هات|خبرني)\s+)/iu;
const NAVIGATION = /^(?:open|visit|go\s+to|navigate\s+to|افتح|تصفح|ادخل)(?:\s|$)/iu;
const INVALID_MEASURE_SELECTOR = /https?:\/\/|[<>"“”«»`]|[;؛\r\n]|[.!?؟]\s|\b(?:and|then)\s+(?:open|visit|send|type|write|click|search|save|remember)\b|(?:^|\s)(?:ثم\s+|و\s*)(?:افتح|ادخل|اكتب|اضغط|ارسل|احفظ)(?!\p{L})/iu;

/** Only a complete URL or named site operand can grant page navigation. */
export function planReadTarget(request: string): string | null {
  let operand = requestScopeActionText(request).replace(APPROACH, '').replace(PAGE_OPERAND, '').trim();
  operand = operand.replace(/[.,!،؟]+$/u, '');
  const quoted = ENCLOSED.exec(operand);
  if (quoted) operand = quoted.slice(1).find(Boolean) ?? '';
  if (/^https?:\/\/[^\s<>"'«»`]+$/iu.test(operand)) return operand;
  const measured = planReadMeasure(request);
  if (measured) return measured.url;
  const site = namedSite(operand);
  return site ? /^https?:\/\//iu.test(site.url) ? site.url : `https://${site.url}` : null;
}

/** A qualified measurement still requires a user-supplied URL at the head of a read/open command. */
export function planReadMeasure(request: string): { url: string; question: string; navigate: boolean } | null {
  const action = requestScopeActionText(request);
  const approach = APPROACH.exec(action);
  if (!approach) return null;
  const operand = action.slice(approach[0].length).replace(PAGE_OPERAND, '').trim();
  const match = URL_WITH_DETAIL.exec(operand)?.groups;
  if (!match) return null;
  const prefix = DETAIL_PREFIX.exec(match.detail!);
  if (!prefix) return null;
  const question = match.detail!.slice(prefix[0].length).trim();
  if (!webMeasureKind(question) || INVALID_MEASURE_SELECTOR.test(question)) return null;
  const head = approach[0].replace(/^(?:please|kindly|من فضلك|لو سمحت)[،,\s]+/iu, '');
  return { url: match.url!, question, navigate: NAVIGATION.test(head) };
}
