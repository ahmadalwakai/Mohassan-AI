import { randomUUID } from 'node:crypto';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackItem } from '@mohassan/contracts';
import { FeedbackReviewItem } from '../apps/web/app/feedback/review';
import { requestFeedbackPage, saveFeedbackReview } from '../apps/web/app/feedback/review-data';

const incoming = vi.hoisted(() => new Headers());
vi.mock('next/headers', () => ({ headers: async () => incoming }));

const date = new Date(0).toISOString();
const sourceUrl = 'https://fixture.example.test/article';
const feedback: FeedbackItem = {
  id: randomUUID(), conversationId: randomUUID(), messageId: randomUUID(),
  question: 'ما تاريخ هذا المثال؟', reply: 'جواب المثال',
  note: 'ملاحظة خاصة بالمراجعة', verdict: 'wrong', evidenceUrls: [sourceUrl],
  decision: null, sourceUrl: null, createdAt: date, reviewedAt: null,
};

afterEach(() => {
  incoming.delete('cookie');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('feedback review web page', () => {
  it('loads owner data through the authenticated server boundary and leaves denied visits without a queue', async () => {
    // The Next entry point belongs to the web TypeScript project. Load it at runtime here.
    const pagePath = '../apps/web/app/feedback/page';
    const { default: FeedbackPage } = await import(pagePath) as { default: () => Promise<ReactElement> };
    vi.stubEnv('MOHASSAN_SERVER_URL', 'http://localhost:4000');
    vi.stubEnv('INTERNAL_API_SECRET', 'feedback-page-test-only');
    incoming.set('cookie', 'fixture-session=owner');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [feedback], nextOffset: null }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const owner = renderToStaticMarkup(await FeedbackPage());
    expect(owner).toContain(feedback.note);
    expect(owner).toContain(`href="${sourceUrl}"`);
    expect(fetchMock).toHaveBeenNthCalledWith(1, new URL('http://localhost:4000/api/feedback'), expect.objectContaining({
      headers: { 'x-mohassan-internal': 'feedback-page-test-only', cookie: 'fixture-session=owner' },
      cache: 'no-store', redirect: 'error',
    }));

    incoming.set('cookie', 'fixture-session=member');
    const member = renderToStaticMarkup(await FeedbackPage());
    expect(member).toContain('المراجعة متاحة لحساب المالك فقط.');
    expect(member).not.toContain(feedback.note);
    expect(member).not.toContain('قائمة المراجعة');

    incoming.delete('cookie');
    const anonymous = renderToStaticMarkup(await FeedbackPage());
    expect(anonymous).toContain('سجّل الدخول من المحادثة لعرض الملاحظات.');
    expect(anonymous).not.toContain('قائمة المراجعة');

    incoming.set('cookie', 'fixture-session=owner');
    const disabled = renderToStaticMarkup(await FeedbackPage());
    expect(disabled).toContain('مراجعة الملاحظات غير مفعّلة.');
    expect(disabled).not.toContain('قائمة المراجعة');
  });

  it('offers source decisions only for recorded evidence and lets the owner undo a decision', () => {
    const render = (item: FeedbackItem) => renderToStaticMarkup(createElement(FeedbackReviewItem, { item, disabled: false, onReview: vi.fn() }));
    const pending = render(feedback);
    expect(pending).toContain('فضّل المصدر');
    expect(pending).toContain('استبعد المصدر');
    const historical = render({ ...feedback, evidenceUrls: [] });
    expect(historical).toContain('تمت المراجعة دون تغيير');
    expect(historical).not.toContain('استبعد المصدر');
    const reviewed = render({ ...feedback, decision: 'block', sourceUrl, reviewedAt: date });
    expect(reviewed).toContain('إلغاء قرار المراجعة');
    expect(reviewed).not.toContain('استبعد المصدر');
  });

  it('submits only the selected source and reports a malformed queue as unavailable', async () => {
    const decision = { decision: 'pin', sourceUrl } as const;
    const saved = { ...feedback, ...decision, reviewedAt: date };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(saved)).mockResolvedValueOnce(Response.json({ items: [null] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(saveFeedbackReview(feedback.id, decision)).resolves.toEqual(saved);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/feedback/${feedback.id}/review`, expect.objectContaining({
      method: 'POST', body: JSON.stringify(decision), credentials: 'same-origin', cache: 'no-store',
    }));
    await expect(requestFeedbackPage('/api/feedback')).resolves.toEqual({ kind: 'error' });
  });
});
