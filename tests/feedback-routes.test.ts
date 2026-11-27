import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatConversationSchema, FeedbackItemSchema, FeedbackQueueSchema } from '@mohassan/contracts';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { registerFeedbackRoutes } from '../apps/server/src/feedback-routes.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = randomBytes(32).toString('hex');
const setupToken = randomBytes(32).toString('hex');
const password = `Fixture-${randomUUID()}`;
const queuePath = '/api/feedback';

describe('answer feedback over the authenticated application', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory: string | undefined;
  let ownerCookie: string;
  let memberCookie: string;

  function call(method: 'GET' | 'POST', url: string, cookie?: string, payload?: Record<string, unknown>) {
    return application.app.inject({ method, url, payload,
      headers: { origin, 'x-mohassan-internal': internalSecret, ...(cookie && { cookie }) } });
  }

  async function signIn(email: string) {
    const response = await call('POST', '/api/auth/sign-in/email', undefined, { email, password });
    expect(response.statusCode).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    expect(Boolean(cookie)).toBe(true);
    return cookie;
  }

  async function ownerAnswer() {
    const goal = 'احسب ١٩ + ٣';
    const create = await call('POST', '/api/chat/conversations', ownerCookie, { goal });
    expect(create.statusCode).toBe(200);
    const { id } = ChatConversationSchema.parse(create.json());
    await application.chat.settled(id);
    const detail = await call('GET', `/api/chat/conversations/${id}`, ownerCookie);
    expect(detail.statusCode).toBe(200);
    const conversation = ChatConversationSchema.parse(detail.json());
    const answer = conversation.messages.find(message => message.role === 'assistant');
    if (!answer) throw new Error('Expected an assistant answer from the fixture conversation');
    return { id, goal, answer, submitPath: `/api/chat/conversations/${id}/feedback` };
  }

  async function queue(query = '') {
    const response = await call('GET', `${queuePath}${query}`, ownerCookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return FeedbackQueueSchema.parse(response.json());
  }

  beforeAll(async () => {
    vi.stubEnv('FEEDBACK_LOOP_ENABLED', '1');
    directory = await mkdtemp(join(tmpdir(), 'mohassan-feedback-routes-'));
    application = await createApplication({ authSecret: randomBytes(32).toString('hex'), internalSecret,
      setupToken, webOrigin: origin, production: false, runWorker: false, documentsDir: join(directory, 'documents'),
      browserProfileDir: join(directory, 'browser'), browser: { searchProvider: { name: 'feedback-routes-fixture', async search() { return []; } } } });
    const ownerEmail = 'feedback-routes-owner@example.test';
    const member = { name: 'Member fixture', email: 'feedback-routes-member@example.test' };
    expect((await call('POST', '/api/setup', undefined, { name: 'Owner fixture', email: ownerEmail, password, setupToken })).statusCode).toBe(200);
    ownerCookie = await signIn(ownerEmail);
    const invite = await call('POST', '/api/members/invites', ownerCookie, member);
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json<{ url: string }>().url).hash.slice('#invite='.length);
    expect((await call('POST', '/api/invites/accept', undefined, { token, name: member.name, password })).statusCode).toBe(200);
    memberCookie = await signIn(member.email);
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('reserves the existing submit route, queue and review for a signed-in owner', async () => {
    const ownerAccess = await call('GET', '/api/access', ownerCookie);
    const memberAccess = await call('GET', '/api/access', memberCookie);
    expect(ownerAccess.json()).toMatchObject({ role: 'owner', feedbackReviewEnabled: true });
    expect(memberAccess.json()).toMatchObject({ role: 'member' });
    expect(memberAccess.json()).not.toHaveProperty('feedbackReviewEnabled');

    const { id, goal, answer, submitPath } = await ownerAnswer();
    const rating = { messageId: answer.id, verdict: 'wrong', note: 'Show the arithmetic step.' };
    expect((await call('POST', submitPath, memberCookie, rating)).statusCode).toBe(403);
    expect((await call('POST', submitPath, undefined, rating)).statusCode).toBe(401);
    expect((await call('POST', submitPath, ownerCookie, rating)).statusCode).toBe(200);
    expect((await call('GET', queuePath, memberCookie)).statusCode).toBe(403);
    expect((await call('GET', queuePath)).statusCode).toBe(401);

    const item = (await queue()).items.find(candidate => candidate.messageId === answer.id);
    expect(item).toMatchObject({ conversationId: id, question: goal, reply: answer.text, verdict: 'wrong', note: rating.note, decision: null });
    const reviewPath = `${queuePath}/${item!.id}/review`;
    const review = { decision: 'dismiss' };
    expect((await call('POST', reviewPath, memberCookie, review)).statusCode).toBe(403);
    expect((await call('POST', reviewPath, undefined, review)).statusCode).toBe(401);
    expect((await call('POST', reviewPath, ownerCookie, { ...review, text: 'This is not a review field.' })).statusCode).toBe(400);
    expect((await call('POST', reviewPath, ownerCookie, { decision: 'pin' })).statusCode).toBe(400);
    expect((await call('GET', `${queuePath}?offset=-1`, ownerCookie)).statusCode).toBe(400);

    const dismissed = await call('POST', reviewPath, ownerCookie, review);
    expect(dismissed.statusCode).toBe(200);
    expect(FeedbackItemSchema.parse(dismissed.json())).toMatchObject({ id: item!.id, decision: 'dismiss' });
    expect((await queue()).items.map(candidate => candidate.id)).not.toContain(item!.id);
    expect((await queue('?status=all')).items.map(candidate => candidate.id)).toContain(item!.id);

    const cleared = await call('POST', reviewPath, ownerCookie, { decision: 'clear' });
    expect(cleared.statusCode).toBe(200);
    expect(FeedbackItemSchema.parse(cleared.json())).toMatchObject({ id: item!.id, decision: null });
    expect((await queue()).items.map(candidate => candidate.id)).toContain(item!.id);
  });

  it('uses the judge credential filter on the existing feedback capture', async () => {
    const { id, answer, submitPath } = await ownerAnswer();
    const fixtureToken = randomBytes(24).toString('hex');
    const submitted = await call('POST', submitPath, ownerCookie,
      { messageId: answer.id, verdict: 'wrong', note: `Authorization: Bearer ${fixtureToken}` });
    expect(submitted.statusCode).toBe(200);

    const events = await application.database.db.selectFrom('chat_events').select('data')
      .where('conversation_id', '=', id).where('kind', '=', 'feedback').execute();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events).includes(fixtureToken)).toBe(false);
    const item = (await queue()).items.find(candidate => candidate.messageId === answer.id);
    expect(item).toBeDefined();
    expect(JSON.stringify(item).includes(fixtureToken)).toBe(false);
  });

  it('keeps one rating event when the owner submits twice', async () => {
    const { id, answer, submitPath } = await ownerAnswer();
    const both = await Promise.all(['useful', 'wrong'].map(verdict =>
      call('POST', submitPath, ownerCookie, { messageId: answer.id, verdict })));
    expect(both.map(response => response.statusCode)).toEqual([200, 200]);
    const events = await application.database.db.selectFrom('chat_events').select('id')
      .where('conversation_id', '=', id).where('kind', '=', 'feedback').execute();
    expect(events).toHaveLength(1);
  });

  it('keeps review unavailable to the owner when the flag is off', async () => {
    const app = Fastify();
    try {
      registerFeedbackRoutes(app, { db: application.database.db, enabled: false,
        owner: async () => ({ id: randomUUID() }), role: async () => 'owner' });
      expect((await app.inject(queuePath)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `${queuePath}/${randomUUID()}/review`, payload: { decision: 'dismiss' } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
