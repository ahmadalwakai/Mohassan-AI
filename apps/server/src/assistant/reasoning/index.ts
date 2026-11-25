import { analyzeCompoundRequest } from '../compound-request.js';
import type { Evidence, Lang } from '../mind/contract.js';
import { requestLanguage, splitReplyDirective } from '../reply-directive.js';
import { reasonCalendar } from './calendar.js';
import { isComparisonRequest, reasonComparison, type ComparisonPage } from './comparison.js';
import { reasonCurrency, type ExchangeRateTable } from './currency.js';
import { reasonNumberWords } from './number-words.js';
import type { ReasoningResult } from './result.js';
import { reasonWordProblem } from './word-problems.js';

export interface ReasoningContext {
  /** Read by the host in this request, or supplied as attributable evidence. */
  evidence?: readonly Evidence[];
  pages?: readonly ComparisonPage[];
  rates?: ExchangeRateTable;
}

export function reasoningEnabled(): boolean {
  return process.env.MOHASSAN_REASONING === '1';
}

const pageReference = /\b(?:on|in|from) (?:this|the|that) (?:open )?page\b|(?:^|\s)(?:في|من|على) (?:هذه |هذي )?الصفح[ةه](?!\p{L})/iu;

export function isPageReasoningRequest(request: string): boolean {
  return reasoningEnabled() && pageReference.test(request) && isComparisonRequest(request);
}

export function evaluatePageReasoning(page: ComparisonPage, request: string, lang: Lang): ReasoningResult | null {
  return reasoningEnabled() ? reasonComparison(request, lang, [], [page]) : null;
}

export function evaluateLocalReasoning(request: string, now: Date, context: ReasoningContext = {}): ReasoningResult | null {
  if (!reasoningEnabled()) return null;
  const { body, directive } = splitReplyDirective(request);
  if (directive?.fields?.length) return null;
  const lang = directive?.lang ?? requestLanguage(body);
  if (!context.pages?.length && !context.evidence?.length && isPageReasoningRequest(body)) return null;

  // The specialised grammars consume the whole request, including sentences in
  // a word problem. A single calculation question after its stated data is
  // part of the problem when that grammar can consume both clauses.
  const compound = analyzeCompoundRequest(body);
  if (compound.kind === 'invalid') return null;
  if (compound.kind === 'compound') {
    return compound.pendingActions.length === 1 && compound.pendingActions[0].kind === 'compute'
      && !compound.forbiddenActions.length && !compound.formatting.length ? reasonWordProblem(body, lang) : null;
  }
  return reasonCalendar(body, lang, now)
    ?? reasonCurrency(body, lang, context.rates)
    ?? reasonComparison(body, lang, context.evidence, context.pages)
    ?? reasonWordProblem(body, lang)
    ?? reasonNumberWords(body, lang);
}
