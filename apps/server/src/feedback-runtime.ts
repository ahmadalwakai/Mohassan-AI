import type { Kysely } from 'kysely';
import { feedbackLoopEnabled } from './feedback-config.js';
import { feedbackPageKey } from './feedback-page-key.js';
import { feedbackSelectionScope, type FeedbackEvidencePolicy } from './feedback-selection.js';
import { feedbackEvidencePolicy, recordFeedbackAnswer } from './feedback-store.js';

export { migrateFeedbackInTransaction } from './feedback-migration.js';
export { safeFeedbackNote } from './feedback-store.js';
export { orderCurrentEvidence, feedbackSelectionScope } from './feedback-selection.js';

interface FeedbackRun {
  ownerId: string;
  full: boolean;
  request?: string;
  previousRequest?: string | null;
}

export function withFeedbackRun<T>(db: Kysely<any>, run: FeedbackRun, scrub: (text: string) => string,
  canApply: ((id: string) => Promise<boolean>) | undefined, work: () => T): T {
  if (!run.full || !feedbackLoopEnabled()) return work();
  const observed = new Map<string, string | undefined>();
  observations.set(run, observed);
  let pending: Promise<FeedbackEvidencePolicy | undefined> | undefined;
  let policy: FeedbackEvidencePolicy | undefined;
  return feedbackSelectionScope.run({
    load() {
      if (!run.request) return Promise.resolve(undefined);
      return pending ??= (async () => {
        const { request, previousRequest } = scrubbedRequest(run, scrub);
        if (!request) return undefined;
        const found = await feedbackEvidencePolicy(db, { id: run.ownerId, role: 'owner' }, request, previousRequest);
        if ((found.blocked.size || found.pinned.size) && (!canApply || await canApply(run.ownerId))) policy = found;
        return policy;
      })().catch(() => undefined);
    },
    current: () => policy,
    observe(urls, reply) {
      for (const url of urls) {
        if (scrub(url) !== url) continue;
        const key = feedbackPageKey(url);
        if (key) observed.set(key, reply);
      }
    },
  }, work);
}

const observations = new WeakMap<FeedbackRun, Map<string, string | undefined>>();

function scrubbedRequest(run: FeedbackRun, scrub: (text: string) => string) {
  const { request, previousRequest } = run;
  if (!request || request !== scrub(request) || (previousRequest && previousRequest !== scrub(previousRequest))) return {};
  return { request, previousRequest };
}

export async function snapshotFeedbackAnswer(tx: Kysely<any>, run: FeedbackRun | undefined, messageId: string,
  reply: string, scrub: (text: string) => string, canRecord?: (id: string, tx: Kysely<any>) => Promise<boolean>) {
  if (!run) return;
  const observed = observations.get(run);
  if (!observed?.size) return;
  const { request, previousRequest } = scrubbedRequest(run, scrub);
  // Match observed sources against the published reply. A judge or council
  // replacement can drop citations or replace the original page answer.
  const linked = new Set((reply.match(/https?:\/\/[^\s<>"'\x60\[\])]+/giu) ?? []).map(feedbackPageKey));
  const evidenceUrls = [...observed].flatMap(([url, originalReply]) =>
    linked.has(url) || (originalReply && reply.includes(originalReply)) ? [url] : []);
  if (!request || !evidenceUrls.length || (canRecord && !await canRecord(run.ownerId, tx))) return;
  await recordFeedbackAnswer(tx, { messageId, question: request, previousQuestion: previousRequest, evidenceUrls });
}
