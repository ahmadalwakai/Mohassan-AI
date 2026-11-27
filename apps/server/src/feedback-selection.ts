import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentPage } from '@mohassan/browser';
import type { HandsIO, HandsPlan } from './assistant/hands.js';
import type { MindDeps, MindReply } from './assistant/mind/contract.js';
import { feedbackPageKey } from './feedback-page-key.js';

export interface FeedbackEvidencePolicy {
  blocked: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
}

interface FeedbackSelection {
  load(): Promise<FeedbackEvidencePolicy | undefined>;
  current(): FeedbackEvidencePolicy | undefined;
  observe(urls: readonly string[], reply?: string): void;
}

export const feedbackSelectionScope = new AsyncLocalStorage<FeedbackSelection>();

export function allowsFeedbackEvidence(policy: FeedbackEvidencePolicy | undefined, url: string): boolean {
  if (!policy?.blocked.size) return true;
  const key = feedbackPageKey(url);
  return !key || !policy.blocked.has(key);
}

/** Keep candidate objects and their contents intact, and preserve order within each group. */
export function selectFeedbackEvidence<T extends { url?: string }>(policy: FeedbackEvidencePolicy | undefined, candidates: T[]): T[] {
  if (!policy) return candidates;
  const preferred: T[] = [], remaining: T[] = [];
  for (const candidate of candidates) {
    const key = candidate.url && feedbackPageKey(candidate.url);
    if (key && policy.blocked.has(key)) continue;
    (key && policy.pinned.has(key) ? preferred : remaining).push(candidate);
  }
  return [...preferred, ...remaining];
}

export function orderCurrentEvidence<T extends { url?: string }>(candidates: T[]): T[] {
  return selectFeedbackEvidence(feedbackSelectionScope.getStore()?.current(), candidates);
}

export function feedbackHandsReader(read: HandsIO['read'], policy: FeedbackEvidencePolicy | undefined): HandsIO['read'] {
  if (!read || !policy?.blocked.size) return read;
  return async url => {
    if (!allowsFeedbackEvidence(policy, url)) return { kind: 'disallowed' };
    const result = await read(url);
    return result.kind === 'page' && !allowsFeedbackEvidence(policy, result.page.url) ? { kind: 'disallowed' } : result;
  };
}

export function excludeReviewedHandsEvidence(plan: HandsPlan, policy: FeedbackEvidencePolicy | undefined) {
  if (!policy?.blocked.size) return;
  if (plan.results) plan.results = plan.results.filter(item => allowsFeedbackEvidence(policy, item.url));
  if (plan.found && !allowsFeedbackEvidence(policy, plan.found.url)) delete plan.found;
  if (plan.found?.second && !allowsFeedbackEvidence(policy, plan.found.second.url)) delete plan.found.second;
}

export function observeHandsEvidence(plan: HandsPlan, page: AgentPage | null, reply: string) {
  const scope = feedbackSelectionScope.getStore();
  if (!scope) return;
  const last = plan.steps.at(-1);
  if (last?.kind === 'search' && last.ask && plan.found) {
    scope.observe([plan.found.url, ...(plan.found.second ? [plan.found.second.url] : [])]);
  } else if (page && (last?.kind === 'news' || /^> \S/mu.test(reply) || last?.kind === 'ask_page')) {
    scope.observe([page.url], reply);
  }
}

export function feedbackExcludedPageReply(lang: HandsPlan['lang']) {
  return {
    kind: 'done', status: 'partial',
    text: lang === 'en'
      ? 'I could not verify an answer from another source after applying the source review.'
      : 'لم أتحقق من جواب من مصدر آخر بعد تطبيق مراجعة المصدر.',
  } as const;
}

export async function restrictFeedbackMind(deps: MindDeps): Promise<MindDeps> {
  const policy = await feedbackSelectionScope.getStore()?.load();
  if (!policy) return deps;
  return {
    ...deps,
    async search(query, limit, signal) {
      return selectFeedbackEvidence(policy, await deps.search(query, limit, signal));
    },
    async read(url, signal) {
      if (!allowsFeedbackEvidence(policy, url)) throw new Error('Source excluded by owner review');
      const page = await deps.read(url, signal);
      if (!allowsFeedbackEvidence(policy, page.url)) throw new Error('Source excluded by owner review');
      return page;
    },
    ...(deps.siteSnapshot && {
      siteSnapshot: url => allowsFeedbackEvidence(policy, url) ? deps.siteSnapshot!(url) : Promise.resolve(null),
    }),
  };
}

export function observeMindEvidence(reply: MindReply) {
  const scope = feedbackSelectionScope.getStore();
  if (!scope || (reply.status !== 'completed' && reply.status !== 'partial')) return;
  const supported = new Set(reply.claims.flatMap(claim => claim.support));
  scope.observe(reply.evidence.flatMap(item => item.url && supported.has(item.id) ? [item.url] : []), reply.text);
}
