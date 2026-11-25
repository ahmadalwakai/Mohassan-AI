import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';

const origin = 'http://127.0.0.1:3000';
const secret = 'conversation-share-fixture-internal-secret';
const setupToken = 'conversation-share-fixture-setup-token';
const owner = { name: 'Share owner', email: 'owner@example.test', password: 'Owner-Fixture-Share-Password-42' };
const member = { name: 'Share member', email: 'member@example.test', password: 'Member-Fixture-Share-Password-42' };
const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': secret, ...(cookie ? { cookie } : {}) });
const conversations = '/api/chat/conversations';
const settings = '/api/chat/conversation-share-settings';
const shares = '/api/chat/conversation-shares';
// RFC 2606 reserves example.test for fixtures. https://www.rfc-editor.org/rfc/rfc2606 (retrieved 2026-11-25).
const email = 'private@example.test';
const tokenFrom = (url: string) => new URL(url).pathname.split('/').at(-1)!;

describe('conversation exports and shares through the application', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory: string | undefined;
  let ownerCookie: string;
  let memberCookie: string;
  const app = () => application!.app;
  const db = () => application!.database.db;

  const get = (url: string, cookie?: string) => app().inject({ url, headers: headers(cookie) });
  const post = (url: string, cookie: string, payload: Record<string, unknown> = {}) =>
    app().inject({ method: 'POST', url, headers: headers(cookie), payload });
  const remove = (url: string, cookie: string) => app().inject({ method: 'DELETE', url, headers: headers(cookie) });

  async function signIn(user: typeof owner) {
    const response = await post('/api/auth/sign-in/email', '', { email: user.email, password: user.password });
    expect(response.statusCode, response.body).toBe(200);
    return [response.headers['set-cookie']].flat().map(value => String(value).split(';')[0]).join('; ');
  }

  async function makeConversation(cookie: string, text = 'سؤال بالعربية') {
    const response = await post(conversations, cookie);
    expect(response.statusCode, response.body).toBe(200);
    const id: string = response.json().id;
    await db().insertInto('chat_messages').values({ id: randomUUID(), conversation_id: id, role: 'user', text }).execute();
    return id;
  }

  async function preview(id: string, cookie: string) {
    const response = await post(`${conversations}/${id}/share/preview`, cookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  const publish = (id: string, cookie: string, review: string, expiry = '7d') =>
    post(`${conversations}/${id}/share`, cookie, { review, expiry, redact: true });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-share-'));
    application = await createApplication({
      authSecret: 'conversation-share-fixture-auth-secret', internalSecret: secret, setupToken, webOrigin: origin,
      production: false, runWorker: false, dataDir: join(directory, 'db'), browserProfileDir: join(directory, 'browser'),
      documentsDir: join(directory, 'documents'), testRequestLimit: 2000,
    });
    expect((await post('/api/setup', '', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    const invitation = await post('/api/members/invites', ownerCookie, { name: member.name, email: member.email });
    expect(invitation.statusCode, invitation.body).toBe(200);
    const token = new URL(invitation.json().url).hash.slice('#invite='.length);
    expect((await post('/api/invites/accept', '', { name: member.name, password: member.password, token })).statusCode).toBe(200);
    memberCookie = await signIn(member);
  }, 60_000);

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('binds approval to the reviewed conversation and stores redacted snapshots independently', async () => {
    const id = await makeConversation(memberCookie, `بريدي ${email}`);
    const old = await preview(id, memberCookie);
    expect(old.findings).toContainEqual(expect.objectContaining({ kind: 'email', messageIndex: 0 }));
    expect((await get(shares, memberCookie)).json()).toEqual({ shares: [] });
    await db().updateTable('chat_messages').set({ text: `البريد الخاص ${email}` }).where('conversation_id', '=', id).execute();
    const stale = await publish(id, memberCookie, old.review);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONVERSATION_SHARE_REVIEW_CHANGED');
    const fresh = await preview(id, memberCookie);
    expect((await post(`${conversations}/${id}/share`, memberCookie, { review: fresh.review, expiry: '7d', redact: false })).statusCode).toBe(400);
    const saved = await publish(id, memberCookie, fresh.review);
    expect(saved.statusCode).toBe(201);
    const { share, url } = saved.json();
    const token = tokenFrom(url);
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
    const row = await db().selectFrom('conversation_shares').selectAll().where('id', '=', share.id).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row).includes(token)).toBe(false);
    const lookup = `${shares}/public/${token}`;
    const first = await get(lookup);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).not.toContain(email);
    expect(first.json().snapshot.messages[0].text).toContain('البريد الخاص');
    expect(first.headers).toMatchObject({
      'x-robots-tag': expect.stringContaining('noindex'),
      'content-security-policy': expect.stringContaining("default-src 'none'"),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    await db().updateTable('chat_messages').set({ text: 'تعديل لاحق' }).where('conversation_id', '=', id).execute();
    expect((await get(lookup)).json()).toEqual(first.json());
    expect((await get(`${shares}/public/${row.token_hash}`)).statusCode).toBe(404);
    expect((await get(shares, memberCookie)).json()).toEqual({ shares: [share] });
    expect((await get(shares, ownerCookie)).json()).toEqual({ shares: [] });
    expect((await remove(`${shares}/${share.id}`, ownerCookie)).statusCode).toBe(404);
    expect((await remove(`${shares}/${share.id}`, memberCookie)).statusCode).toBe(200);
    const revoked = await get(lookup);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.headers['x-robots-tag']).toContain('noindex');
    expect((await get(shares, memberCookie)).json()).toEqual({ shares: [] });
  });

  it('limits export and sharing to the acting account and keeps export available when sharing is off', async () => {
    const ownerId = await makeConversation(ownerCookie);
    const memberId = await makeConversation(memberCookie);
    expect((await get(`${conversations}/${ownerId}/export?format=markdown`, memberCookie)).statusCode).toBe(404);
    expect((await post(`${conversations}/${ownerId}/share/preview`, memberCookie)).statusCode).toBe(404);
    const ownerReview = await preview(ownerId, ownerCookie);
    expect((await publish(ownerId, memberCookie, ownerReview.review)).statusCode).toBe(404);
    expect((await get(`${conversations}/${memberId}/export?format=markdown`)).statusCode).toBe(401);
    expect((await get(settings, memberCookie)).statusCode).toBe(403);
    expect((await post(settings, memberCookie, { memberSharingEnabled: false })).statusCode).toBe(403);
    const memberReview = await preview(memberId, memberCookie);
    const before = await publish(memberId, memberCookie, memberReview.review, 'never');
    expect(before.statusCode).toBe(201);
    expect((await post(settings, ownerCookie, { memberSharingEnabled: false })).json()).toEqual({ memberSharingEnabled: false });
    expect((await get(settings, ownerCookie)).json()).toEqual({ memberSharingEnabled: false });
    expect((await post(`${conversations}/${memberId}/share/preview`, memberCookie)).json().error.code).toBe('CONVERSATION_SHARE_DISABLED');
    expect((await publish(memberId, memberCookie, memberReview.review)).statusCode).toBe(403);
    expect((await get(`${shares}/public/${tokenFrom(before.json().url)}`)).statusCode).toBe(200);
    expect((await remove(`${shares}/${before.json().share.id}`, memberCookie)).statusCode).toBe(200);
    expect((await publish(ownerId, ownerCookie, ownerReview.review, '1d')).statusCode).toBe(201);
    const own = await get(`${conversations}/${memberId}/export?format=markdown`, memberCookie);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers['content-type']).toContain('text/markdown');
    expect(own.headers['content-disposition']).toContain('filename="conversation.md"');
    expect(own.body).toContain('سؤال بالعربية');
    const pdf = await get(`${conversations}/${memberId}/export?format=pdf`, memberCookie);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('filename="conversation.pdf"');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await post(settings, ownerCookie, { memberSharingEnabled: true })).statusCode).toBe(200);
  });

  it('keeps an ordinary assistant reply from the real chat in the shared transcript', async () => {
    const created = await post(conversations, ownerCookie, { goal: 'السلام عليكم' });
    expect(created.statusCode).toBe(200);
    const id: string = created.json().id;
    await application!.chat.settled(id);
    const answer = await db().selectFrom('chat_messages').select(['run_id', 'text'])
      .where('conversation_id', '=', id).where('role', '=', 'assistant').executeTakeFirstOrThrow();
    expect(answer.run_id).toEqual(expect.any(String));
    expect(answer.text).toContain('وعليكم السلام');
    const checked = await preview(id, ownerCookie);
    expect(checked.findings).toEqual([]);
    const published = await publish(id, ownerCookie, checked.review);
    expect(published.statusCode).toBe(201);
    const publicCopy = await get(`${shares}/public/${tokenFrom(published.json().url)}`);
    expect(publicCopy.json().snapshot.messages.map((message: { text: string }) => message.text)).toEqual(['السلام عليكم', answer.text]);
  });
});
