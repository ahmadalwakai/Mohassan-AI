import { AsyncLocalStorage } from 'node:async_hooks';
import type { JudgeDecision, JudgeInput } from './assistant/judge.js';
import type { MindDeps, MindReply } from './assistant/mind/contract.js';
import { feedbackPageKey } from './feedback-page-key.js';

export interface FeedbackEvidencePolicy {
  blocked: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
}

export function allowsFeedbackEvidence(policy: FeedbackEvidencePolicy, url: string): boolean {
  const key = feedbackPageKey(url);
  return !key || !policy.blocked.has(key);
}

/** Keep normal relevance checks and use a pin only among their admitted candidates. */
export function selectFeedbackEvidence<T extends { url: string }>(policy: FeedbackEvidencePolicy, candidates: readonly T[]): T[] {
  const preferred: T[] = [], other: T[] = [];
  for (const candidate of candidates) {
    if (!allowsFeedbackEvidence(policy, candidate.url)) continue;
    const key = feedbackPageKey(candidate.url);
    (key && policy.pinned.has(key) ? preferred : other).push(candidate);
  }
  return [...preferred, ...other];
}

export interface FeedbackSelectionScope {
  policy(): Promise<FeedbackEvidencePolicy>;
  evidenceAllowed(url: string): boolean;
  startHands(): void;
  handSource(url: string, requiresCitation: boolean, actionOutcome?: string): void;
  citedHandSources(reply: string): string[];
  mindSource(evidenceUrls: string[]): void;
  judgeDecision(decision: JudgeDecision): void;
}

export const feedbackSelectionScope = new AsyncLocalStorage<FeedbackSelectionScope>();

export async function restrictFeedbackMind(deps: MindDeps): Promise<MindDeps> {
  const scope = feedbackSelectionScope.getStore();
  if (!scope) return deps;
  const policy = await scope.policy();
  if (!policy.blocked.size && !policy.pinned.size) return deps;
  const snapshot = deps.siteSnapshot;
  return {
    ...deps,
    async search(query, limit, signal) {
      return selectFeedbackEvidence(policy, await deps.search(query, limit, signal));
    },
    async read(url, signal) {
      if (!allowsFeedbackEvidence(policy, url)) throw new Error('Evidence is blocked by feedback');
      const result = await deps.read(url, signal);
      if (!allowsFeedbackEvidence(policy, result.url)) throw new Error('Evidence is blocked by feedback');
      return result;
    },
    ...(snapshot && { async siteSnapshot(url) {
      return allowsFeedbackEvidence(policy, url) ? snapshot(url) : null;
    } }),
  };
}

export function recordFeedbackMind(reply: MindReply) {
  const scope = feedbackSelectionScope.getStore();
  if (!scope) return;
  if (reply.status === 'completed' || reply.status === 'partial') {
    const used = new Set(reply.claims.flatMap(claim => claim.support));
    scope.mindSource(reply.evidence.flatMap(item => item.url && used.has(item.id) ? [item.url] : []));
  }
}

export function feedbackBlockedReply(arabic: boolean): string {
  return arabic
    ? 'لم أجد مصدرًا آخر أستطيع التحقق منه بعد استبعاد الصفحة محل المراجعة.'
    : 'I did not verify another source after excluding a page flagged for review.';
}

export function restrictFeedbackJudge<T extends JudgeInput>(input: T): T {
  const scope = feedbackSelectionScope.getStore();
  if (!scope || !input.evidence) return input;
  const evidence = input.evidence.filter(item => !item.url || scope.evidenceAllowed(item.url));
  return evidence.length === input.evidence.length ? input : { ...input, evidence };
}
