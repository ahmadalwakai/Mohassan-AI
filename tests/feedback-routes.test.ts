import type { ChatConversation, FeedbackItem, FeedbackQueue } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

describe('answer feedback through authenticated application routes', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie: string;
  let firstCookie: string;
  let secondCookie: string;
  let firstConversation: ChatConversation;
  const origin = 'http://127.0.0.1:3000';
  const fixtureServiceKey = 'feedback-routes-test-service-key-only';
  const fixturePassword = 'Feedback-Routes-Fixture-Password-42';
  const note = 'أريد خطوة الحساب قبل النتيجة.';

  function call(method: 'GET' | 'POST', url: string, cookie = '', payload?: Record<string, unknown>) {
    return application.app.inject({ method, url, headers: { origin, 'x-mohassan-internal': fixtureServiceKey, cookie }, payload });
  }

  async function signIn(email: string) {
    const response = await call('POST', '/api/auth/sign-in/email', '', { email, password: fixturePassword });
    expect(response.statusCode).toBe(200);
    return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  }

  async function invite(label: string) {
    const account = { name: `عضو ${label}`, email: `feedback-${label}@example.test` };
    const invite = await call('POST', '/api/members/invites', ownerCookie, account);
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await call('POST', '/api/invites/accept', '', { name: account.name, token, password: fixturePassword })).statusCode).toBe(200);
    return signIn(account.email);
  }

  async function flag(cookie: string, goal: string) {
    const created = await call('POST', '/api/chat/conversations', cookie, { goal });
    expect(created.statusCode).toBe(200);
    const { id }: ChatConversation = created.json();
    await application.chat.settled(id);
    const detail = await call('GET', `/api/chat/conversations/${id}`, cookie);
    expect(detail.statusCode).toBe(200);
    const conversation: ChatConversation = detail.json();
    expect(conversation.status).toBe('idle');
    const reply = conversation.messages.find(message => message.role === 'assistant')!;
    expect((await call('POST', `/api/chat/conversations/${conversation.id}/feedback`, cookie,
      { messageId: reply.id, verdict: 'wrong', note })).statusCode).toBe(200);
    return conversation;
  }

  async function queue(cookie: string, query = ''): Promise<FeedbackQueue> {
    const response = await call('GET', `/api/feedback${query}`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return response.json();
  }

  beforeAll(async () => {
    const setupToken = 'feedback-routes-test-setup-token-only';
    application = await createApplication({ authSecret: 'feedback-routes-test-auth-key-only', internalSecret: fixtureServiceKey,
      setupToken, webOrigin: origin, production: false, runWorker: false });
    const ownerEmail = 'feedback-owner@example.test';
    const setup = await call('POST', '/api/setup', '', { name: 'مالك الاختبار', email: ownerEmail, password: fixturePassword, setupToken });
    expect(setup.statusCode).toBe(200);
    ownerCookie = await signIn(ownerEmail);
    firstCookie = await invite('first');
    secondCookie = await invite('second');
    firstConversation = await flag(firstCookie, 'احسب ١٩ + ٣');
    await flag(secondCookie, 'احسب ٢٤ + ٧');
  });

  afterAll(async () => { await application?.app.close(); });

  it('lets the owner see all items and members see only their own reports', async () => {
    const [owner, first, second] = await Promise.all([queue(ownerCookie), queue(firstCookie), queue(secondCookie)]);
    expect(owner.role).toBe('owner');
    expect(owner.items).toHaveLength(2);
    expect(first).toMatchObject({ role: 'member', nextOffset: null, items: [expect.objectContaining({
      conversationId: firstConversation.id, question: 'احسب ١٩ + ٣', note, verdict: 'wrong', trainingAllowed: false,
    })] });
    expect(first.items).toHaveLength(1);
    expect(second.items.map(item => item.question)).toEqual(['احسب ٢٤ + ٧']);
    expect(first).not.toHaveProperty('metrics');
    expect(second).not.toHaveProperty('metrics');
    expect((await call('GET', '/api/feedback')).statusCode).toBe(401);
    expect((await call('GET', `/api/feedback?userId=${first.items[0]!.userId}`, secondCookie)).statusCode).toBe(400);
    const reply = firstConversation.messages.find(message => message.role === 'assistant')!;
    expect((await call('POST', `/api/chat/conversations/${firstConversation.id}/feedback`, secondCookie,
      { messageId: reply.id, verdict: 'wrong' })).statusCode).toBe(404);
  });

  it('requires owner review and an explicit training mark on the reviewed case', async () => {
    const first = (await queue(firstCookie)).items[0]!;
    const reviewPath = `/api/feedback/${first.id}/review`;
    const trainingPath = `/api/feedback/${first.id}/training`;
    const regressionPath = '/api/feedback/regression';
    expect((await call('POST', reviewPath, firstCookie, { decision: 'wrong' })).statusCode).toBe(403);
    expect((await call('POST', trainingPath, firstCookie, { allowed: true })).statusCode).toBe(403);
    expect((await call('POST', `/api/feedback/policies/${first.id}/clear`, firstCookie, {})).statusCode).toBe(403);
    expect((await call('GET', regressionPath, firstCookie)).statusCode).toBe(403);
    expect((await call('GET', `${regressionPath}?mode=training`, secondCookie)).statusCode).toBe(403);
    expect((await call('POST', reviewPath, ownerCookie, { decision: 'wrong', allowed: true })).statusCode).toBe(400);
    expect((await call('GET', '/api/feedback?offset=-1', ownerCookie)).statusCode).toBe(400);
    expect((await call('POST', trainingPath, ownerCookie, { allowed: true })).statusCode).toBe(409);

    const review = await call('POST', reviewPath, ownerCookie, { decision: 'wrong' });
    expect(review.statusCode).toBe(200);
    const reviewed: FeedbackItem = review.json();
    expect(reviewed).toMatchObject({ id: first.id, decision: 'wrong', caseSha256: expect.stringMatching(/^[a-f0-9]{64}$/), trainingAllowed: false });
    const pending = await queue(ownerCookie);
    expect(pending.items.map(item => item.id)).not.toContain(first.id);
    expect(pending).toMatchObject({ metrics: { regressionSize: 1 } });
    expect((await queue(ownerCookie, '?status=all')).items.map(item => item.id)).toContain(first.id);
    expect((await queue(firstCookie)).items[0]).toMatchObject({ decision: 'wrong', caseSha256: reviewed.caseSha256 });

    const regression = await call('GET', regressionPath, ownerCookie);
    expect(regression.statusCode).toBe(200);
    expect(regression.headers['content-type']).toMatch(/application\/json/);
    expect(regression.body).toContain(reviewed.caseSha256);
    expect((await call('GET', regressionPath, ownerCookie)).body).toBe(regression.body);
    const trainingExport = `${regressionPath}?mode=training`;
    const emptyTraining = await call('GET', trainingExport, ownerCookie);
    expect(emptyTraining.statusCode).toBe(200);
    expect(emptyTraining.body).not.toContain(reviewed.caseSha256);
    expect((await call('POST', trainingPath, ownerCookie, { allowed: 'true' })).statusCode).toBe(400);
    const mark = await call('POST', trainingPath, ownerCookie, { allowed: true });
    expect(mark.statusCode).toBe(200);
    expect(mark.json()).toMatchObject({ id: first.id, trainingAllowed: true });
    expect((await call('GET', trainingExport, ownerCookie)).body).toContain(reviewed.caseSha256);
    expect((await call('GET', regressionPath, ownerCookie)).body).toBe(regression.body);
    expect((await call('POST', trainingPath, ownerCookie, { allowed: false })).statusCode).toBe(200);
    expect((await call('GET', trainingExport, ownerCookie)).body).toBe(emptyTraining.body);
  });
});
