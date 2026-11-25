import { namedSite } from '../brain.js';
import { requestScopeActionText } from '../request-scope.js';

const APPROACH = /^(?:(?:please|kindly|من فضلك|لو سمحت)[،,\s]+)?(?:read|open|visit|go\s+to|navigate\s+to|اقرأ|اقرا|إقرأ|افتح|تصفح|ادخل\s+(?:إلى|الى|على))\s+/iu;
const PAGE_OPERAND = /^(?:the\s+)?(?:(?:web\s*page|page|site|website)\s+(?:at|from)|(?:title|contents?|opening paragraph|first sentence)\s+(?:of|from|on))\s+|^(?:(?:محتو[ىي]|عنوان|نص)\s+)?(?:ال)?(?:صفحة|صفحه|موقع|رابط)(?:\s+(?:على|في))?\s+/iu;
const ENCLOSED = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|«([^»\r\n]+)»)$/u;

/** Only a complete URL or named site operand can grant page navigation. */
export function planReadTarget(request: string): string | null {
  let operand = requestScopeActionText(request).replace(APPROACH, '').replace(PAGE_OPERAND, '').trim();
  operand = operand.replace(/[.,!،؟]+$/u, '');
  const quoted = ENCLOSED.exec(operand);
  if (quoted) operand = quoted.slice(1).find(Boolean) ?? '';
  if (/^https?:\/\/[^\s<>"'«»`]+$/iu.test(operand)) return operand;
  const site = namedSite(operand);
  return site ? /^https?:\/\//iu.test(site.url) ? site.url : `https://${site.url}` : null;
}
