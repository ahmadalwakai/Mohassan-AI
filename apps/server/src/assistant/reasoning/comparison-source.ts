import { safeResumeUrl } from '@mohassan/browser';
import { directRoute } from '../brain.js';
import type { HandsStep } from '../hands.js';
import { matchText } from '../mind/normalize.js';
import { isComparisonRequest } from './comparison.js';
import { isReadComparisonQuestion } from './comparison-page.js';
import { isStandaloneComparisonQuestion } from './comparison-prose.js';

const transition = /[.!?؟؛;]\s+|[,،]\s*|\s+(?:(?:and(?:\s+then)?|then|ثم|وبعدها)\s+|و\s*)/giu;
const address = /https?:\/\/[^\s<>"'«»]+/iu;
const courtesy = /^(?:please|kindly|من فضلك|لو سمحت)[\s,،]+/iu;
const tell = /^(?:please\s+)?(?:tell me|show me|give me|[اأ]خبرني|خبرني|احكي\s*لي|قل\s*لي|[اأ]عطني|عطيني|عطني|بين لي|وضح لي)\s+/iu;

/** Open just the stated destination and ask about the returned page. */
export function comparisonPagePlan(request: string, browserSplit: RegExp): HandsStep[] | null {
  if (request.length > 4000) return null;
  const body = request.trim().replace(courtesy, '');
  for (const boundary of body.matchAll(transition)) {
    const head = body.slice(0, boundary.index).trim();
    const target = directRoute(head);
    if (!target?.finishes || target.screenshot) continue;
    const url = safeResumeUrl(target.url.includes('://') ? target.url : `https://${target.url}`);
    if (!url) return null;
    const question = body.slice(boundary.index + boundary[0].length).trim().replace(tell, '');
    if (question.length > 300 || address.test(question) || browserSplit.test(question) || !isStandaloneComparisonQuestion(question)) return null;
    if (!isComparisonRequest(question) && !isReadComparisonQuestion(question)) return null;
    return [{ kind: 'open', url, name: target.name }, { kind: 'ask_page', question }];
  }
  return null;
}

const previousValues = /^(?:based on|using|given|from)\s+(?:the\s+)?(?:values|figures|numbers|data|amounts|options)\s+(?:above|from (?:the )?previous (?:message|turn)|i (?:just )?(?:gave|provided|shared))$|^(?:حسب|بناء علي|باستخدام|من)\s+(?:الارقام|القيم|البيانات|المبالغ|الخيارات)\s+(?:اعلاه|السابقه|المذكوره|في رسالتي السابقه)$/u;

/** A prior user turn is a source only when the current question points to it. */
export function priorComparisonQuestion(request: string): string | null {
  const delimiter = /[,،:]/u.exec(request);
  if (!delimiter || !previousValues.test(matchText(request.slice(0, delimiter.index).trim()))) return null;
  const question = request.slice(delimiter.index + 1).trim();
  return isStandaloneComparisonQuestion(question) ? question : null;
}
