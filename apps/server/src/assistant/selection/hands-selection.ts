import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentPage } from '@mohassan/browser';
import { hostOf } from '../activity.js';
import { isDisambiguationPage } from '../answer-check.js';
import type { HandsPlan, HandsRead } from '../hands.js';
import { acceptsLegacyCandidate, rankAnswer, rankCalibratedAnswer, type RankedCandidate, type SelectionDecision } from './ranker.js';

type FoundAnswer = NonNullable<HandsPlan['found']>;
type Baseline = { url: string; text: string } | undefined;
type SelectionScope = 'search' | 'open-page';
type SelectionMode = 'legacy' | 'ranker-only' | 'combined';
type AnswerChoice = { kind: 'legacy' | 'validated-legacy' | 'abstain' } | { kind: 'ranker'; candidate: RankedCandidate; page: AgentPage };

export interface SelectionObservation {
  question: string;
  pages: readonly AgentPage[];
  baseline: Baseline;
  scope: SelectionScope;
  live: boolean;
  decision: SelectionDecision | undefined;
  choice: AnswerChoice['kind'];
}

const replay = new AsyncLocalStorage<{ mode: SelectionMode; capture?: (observation: SelectionObservation) => void }>();

/** In-process evaluation runs the actual chooser without changing a server-wide flag. */
export function withAnswerSelectionMode<T>(mode: SelectionMode, run: () => T, capture?: (observation: SelectionObservation) => void): T {
  return replay.run({ mode, capture }, run);
}

const sameQuote = (left: string, right: string) => left.replace(/\s+/gu, ' ').trim() === right.replace(/\s+/gu, ' ').trim();

function logComparison(scope: SelectionScope, baseline: Baseline, decision: SelectionDecision | undefined, choice: AnswerChoice, applied: boolean): void {
  const selected = decision?.selected;
  try {
    // The server log can include private page reads. Compare the choices without storing questions, URLs or quotes.
    console.info(JSON.stringify({
      event: 'answer_selection_shadow', scope, applied, choice: choice.kind,
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

function decide(question: string, pages: readonly AgentPage[], baseline: Baseline, scope: SelectionScope, observe: boolean, live: boolean): AnswerChoice {
  const settings = replay.getStore();
  // Current-fact checks stay on the existing path until structured evidence can establish freshness.
  const mode = live ? 'legacy' : settings?.mode ?? (process.env.MOHASSAN_ANSWER_SELECTION === '1' ? 'combined' : 'legacy');
  const shadow = observe && !settings && !process.env.VITEST;
  const evaluate = (): AnswerChoice => {
    let decision: SelectionDecision | undefined;
    let choice: AnswerChoice = { kind: mode === 'combined' ? 'abstain' : 'legacy' };
    try {
      if (mode === 'ranker-only') decision = rankAnswer(question, pages);
      else if (mode === 'combined' || shadow) decision = rankCalibratedAnswer(question, pages);
      if (mode !== 'legacy' && decision) {
        const selected = decision.selected;
        const source = selected ? pages.find(page => page.url === selected.url) : undefined;
        if (selected && source) choice = { kind: 'ranker', candidate: selected, page: source };
        else if (mode === 'combined' && !selected && baseline && decision.reason !== 'unsupported-question') {
          const legacySource = pages.find(page => page.url === baseline.url);
          if (legacySource && acceptsLegacyCandidate(question, legacySource, baseline.text)) choice = { kind: 'validated-legacy' };
        } else if (mode === 'ranker-only' && !selected && decision.reason !== 'unsupported-question') {
          choice = { kind: 'abstain' };
        }
      }
    } catch { /* The combined chooser's default is an abstention when ranking or validation fails. */ }
    if (shadow) logComparison(scope, baseline, decision, choice, mode !== 'legacy' && choice.kind !== 'legacy');
    settings?.capture?.({ question, pages, baseline, scope, decision, live, choice: choice.kind });
    return choice;
  };
  if (mode !== 'legacy' || settings?.capture) return evaluate();
  if (shadow) setImmediate(evaluate);
  return { kind: 'legacy' };
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
  const choice = decide(question, [...pages.values()], baseline, 'search', true, policy.live);
  if (choice.kind === 'legacy') return legacy;
  if (choice.kind === 'validated-legacy' && legacy) {
    const { url, title, lines, readAt } = legacy;
    return { url, title, lines: lines.slice(0, 1), readAt };
  }
  if (choice.kind !== 'ranker') return undefined;
  const { candidate: selected, page } = choice;
  const second = baseline && baseline.url === selected.url && sameQuote(baseline.text, selected.text) ? legacy?.second : undefined;
  return {
    url: page.url, title: page.title.trim() || hostOf(page.url), lines: [selected.text], readAt: page.observedAt,
    ...(second ? { second } : {}),
  };
}

export function selectOpenPageLines(page: AgentPage, question: string, legacy: string[], observe: boolean, live: boolean): string[] {
  const baseline = legacy[0] ? { url: page.url, text: legacy[0] } : undefined;
  const choice = decide(question, [page], baseline, 'open-page', observe, live);
  if (choice.kind === 'legacy') return legacy;
  if (choice.kind === 'validated-legacy') return legacy.slice(0, 1);
  return choice.kind === 'ranker' ? [choice.candidate.text] : [];
}
