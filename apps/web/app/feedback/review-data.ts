import { FeedbackItemSchema, FeedbackQueueSchema, type FeedbackQueue, type FeedbackReviewInput } from '@mohassan/contracts';

export const feedbackPath = '/api/feedback';
export type ReviewFilter = 'pending' | 'all';
export type ReviewPage =
  | { kind: 'ready'; queue: FeedbackQueue }
  | { kind: 'signin' | 'forbidden' | 'disabled' | 'error' };

export async function requestFeedbackPage(path: string | URL, options?: RequestInit): Promise<ReviewPage> {
  try {
    const response = await fetch(path, { ...options, cache: 'no-store', redirect: 'error' });
    if (response.status === 401) return { kind: 'signin' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (response.status === 404) return { kind: 'disabled' };
    if (!response.ok) return { kind: 'error' };
    const queue = FeedbackQueueSchema.safeParse(await response.json());
    return queue.success ? { kind: 'ready', queue: queue.data } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

export async function saveFeedbackReview(id: string, review: FeedbackReviewInput) {
  const response = await fetch(`${feedbackPath}/${encodeURIComponent(id)}/review`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review),
  });
  if (!response.ok) return null;
  const item = FeedbackItemSchema.safeParse(await response.json());
  return item.success ? item.data : null;
}
