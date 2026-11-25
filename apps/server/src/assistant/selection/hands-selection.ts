import type { AgentPage } from '@mohassan/browser';
import { hostOf } from '../activity.js';
import { isDisambiguationPage } from '../answer-check.js';
import type { HandsPlan, HandsRead } from '../hands.js';
import { rankAnswer, type SelectionDecision } from './ranker.js';

type FoundAnswer = NonNullable<HandsPlan['found']>;
type Baseline = { url: string; text: string } | undefined;
type SelectionScope = 'search' | 'open-page';

const sameQuote = (left: string, right: string) => left.replace(/\s+/gu, ' ').trim() === right.replace(/\s+/gu, ' ').trim();

function logComparison(scope: SelectionScope, baseline: Baseline, decision: SelectionDecision | undefined, applied: boolean): void {
  const selected = decision?.selected;
  try {
    // The server log can include private page reads. Compare the choices without storing questions, URLs or quotes.
    console.info(JSON.stringify({
      event: 'answer_selection_shadow', scope, applied,
      language: decision?.intent.language ?? null,
      answerType: decision?.intent.type ?? null,
      baseline: baseline ? 'answer' : 'abstain',
      ranker: decision ? selected ? 'answer' : 'abstain' : 'error',
      reason: decision?.reason ?? null,
      sameSource: baseline && selected ? baseline.url === selected.url : null,
      sameQuote: baseline && selected ? sameQuote(baseline.text, selected.text) : null,
      score: selected?.score ?? decision?.ranked[0]?.score ?? null,
      threshold: decision?.threshold ?? null,
      candidates: decision?.ranked.length ?? 0,
    }));
  } catch { /* Logging never changes the answer. */ }
}

function decide(question: string, pages: readonly AgentPage[], baseline: Baseline, scope: SelectionScope, observe: boolean, live: boolean): SelectionDecision | undefined {
  // Current-fact checks stay on the existing path until structured evidence can establish freshness.
  const enabled = !live && process.env.MOHASSAN_ANSWER_SELECTION === '1';
  const shadow = observe && !process.env.VITEST;
  const evaluate = () => {
    let decision: SelectionDecision | undefined;
    try { decision = rankAnswer(question, pages); } catch { /* Preserve the legacy reply on an unexpected ranker failure. */ }
    const supported = decision && decision.reason !== 'unsupported-question';
    if (shadow) logComparison(scope, baseline, decision, enabled && Boolean(supported));
    return supported ? decision : undefined;
  };
  if (enabled) return evaluate();
  if (shadow) setImmediate(evaluate);
  return undefined;
}

export function selectSearchAnswer(
  question: string,
  legacy: FoundAnswer | undefined,
  reads: readonly (HandsRead | null)[],
  browserPage: AgentPage | null,
  policy: { readableOverHttp: (text: string) => boolean; rejected: (url: string) => boolean; live: boolean },
): FoundAnswer | undefined {
  const pages = new Map<string, AgentPage>();
  const admit = (page: AgentPage) => {
    if (!policy.rejected(page.url) && !isDisambiguationPage(page)) pages.set(page.url, page);
  };
  for (const read of reads) {
    if (read?.kind === 'page' && policy.readableOverHttp(read.page.text)) admit(read.page);
  }
  if (browserPage) admit(browserPage);
  const baseline = legacy?.lines[0] ? { url: legacy.url, text: legacy.lines[0] } : undefined;
  const decision = decide(question, [...pages.values()], baseline, 'search', true, policy.live);
  if (!decision) return legacy;
  const selected = decision.selected;
  if (!selected) return undefined;
  const page = pages.get(selected.url);
  if (!page) return legacy;
  const second = baseline && baseline.url === selected.url && sameQuote(baseline.text, selected.text) ? legacy?.second : undefined;
  return {
    url: page.url, title: page.title.trim() || hostOf(page.url), lines: [selected.text], readAt: page.observedAt,
    ...(second ? { second } : {}),
  };
}

export function selectOpenPageLines(page: AgentPage, question: string, legacy: string[], observe: boolean, live: boolean): string[] {
  const baseline = legacy[0] ? { url: page.url, text: legacy[0] } : undefined;
  const decision = decide(question, [page], baseline, 'open-page', observe, live);
  return decision ? decision.selected ? [decision.selected.text] : [] : legacy;
}
