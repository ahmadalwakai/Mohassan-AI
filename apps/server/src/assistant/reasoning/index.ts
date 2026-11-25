import { analyzeCompoundRequest } from '../compound-request.js';
import type { HandsStep } from '../hands.js';
import type { Evidence, Lang } from '../mind/contract.js';
import { requestLanguage, splitReplyDirective } from '../reply-directive.js';
import { reasonCalendar } from './calendar.js';
import { isComparisonRequest, reasonComparison, type ComparisonPage } from './comparison.js';
import { reasonConversationComparison } from './comparison-conversation.js';
import { reasonDerivedComparison } from './comparison-derived.js';
import { isReadComparisonQuestion, reasonReadComparison } from './comparison-page.js';
import { containsComparisonAction, isStandaloneComparisonQuestion } from './comparison-prose.js';
import { comparisonPagePlan, priorComparisonQuestion } from './comparison-source.js';
import { reasonCurrency, type ExchangeRateTable } from './currency.js';
import { reasonNumberWords } from './number-words.js';
import { reasoningGap, type ReasoningResult } from './result.js';
import { reasonWordProblem } from './word-problems.js';

export interface ReasoningContext {
  /** Read by the host in this request, or supplied as attributable evidence. */
  evidence?: readonly Evidence[];
  pages?: readonly ComparisonPage[];
  rates?: ExchangeRateTable;
  previousUserTurn?: string;
}

export function reasoningEnabled(): boolean {
  return process.env.MOHASSAN_REASONING === '1';
}

const pageReference = /\b(?:on|in|from) (?:this|the|that) (?:open )?page\b|(?:^|\s)(?:في|من|على) (?:هذه |هذي )?الصفح[ةه](?!\p{L})/iu;

export function isPageReasoningRequest(request: string): boolean {
  return reasoningEnabled() && pageReference.test(request) && isStandaloneComparisonQuestion(request)
    && (isComparisonRequest(request) || isReadComparisonQuestion(request));
}

export function planComparisonPage(request: string, browserSplit: RegExp): HandsStep[] | null {
  return reasoningEnabled() ? comparisonPagePlan(request, browserSplit) : null;
}

export function evaluatePageReasoning(page: ComparisonPage, request: string, lang: Lang): ReasoningResult | null {
  if (!reasoningEnabled() || !isStandaloneComparisonQuestion(request)) return null;
  const structured = reasonComparison(request, lang, [], [page]);
  if (structured?.status === 'completed') return structured;
  if (!isReadComparisonQuestion(request)) return structured;
  return reasonReadComparison(page, request, lang) ?? structured ?? reasoningGap(lang, lang === 'ar'
    ? 'لم أجد في نص الصفحة أدلة كافية لإكمال المقارنة.'
    : 'I could not find enough evidence in the page text to complete the comparison.');
}

function comparePreviousTurn(body: string, previous: string, lang: Lang): ReasoningResult | null {
  const question = priorComparisonQuestion(body);
  if (!question || previous.length > 3000 || /[?؟]|https?:\/\//iu.test(previous)) return null;
  const supplied = previous.trim();
  const statements = supplied.split(/[؛;\r\n]+/u).map(quote => quote.trim()).filter(Boolean);
  if (!statements.length || statements.some(statement => containsComparisonAction(statement)
    || ['invalid', 'compound'].includes(analyzeCompoundRequest(statement).kind))) return null;
  const combined = `${supplied}\n${question}`;
  const derived = reasonDerivedComparison(combined, lang) ?? reasonConversationComparison(combined, lang);
  if (derived) return derived;
  const evidence = statements.map((quote, index): Evidence => ({
    id: `prior-comparison-${index + 1}`, source: 'computed', quote, value: /[:=]\s*([^:=]+)$/u.exec(quote)?.[1]?.trim(),
  }));
  return reasonComparison(question, lang, evidence);
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
  return (context.previousUserTurn ? comparePreviousTurn(body, context.previousUserTurn, lang) : null)
    ?? reasonCalendar(body, lang, now)
    ?? reasonCurrency(body, lang, context.rates)
    ?? reasonComparison(body, lang, context.evidence, context.pages)
    ?? reasonDerivedComparison(body, lang)
    ?? reasonConversationComparison(body, lang)
    ?? reasonWordProblem(body, lang)
    ?? reasonNumberWords(body, lang);
}
