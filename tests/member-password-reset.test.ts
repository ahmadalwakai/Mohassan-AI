import { createHash } from 'node:crypto';
import { MemberPasswordResetLinkSchema } from '@mohassan/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'member-password-reset-fixture-internal';
const setupToken = 'member-password-reset-fixture-setup';
const inspectPath = '/api/members/password-reset/inspect';
const acceptPath = '/api/members/password-reset/accept';
const ownerAccount = { name: 'Owner fixture', email: 'reset-owner@example.test', password: 'Fixture-owner-password-001' };
const memberAccount = { name: 'Member fixture', email: 'reset-member@example.test', password: 'Fixture-member-password-001' };
const pendingAccount = { name: 'Pending fixture', email: 'reset-pending@example.test', password: 'Fixture-pending-password-001' };
const newPassword = 'Fixture-password-after-reset-001';

describe('owner-issued member password reset', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie: string, ownerId: string, memberId: string, pendingId: string, pendingCookie: string;
  let nextAddress = 1;
  const db = () => application.database.db;

  function headers(cookie?: string) {
    // TEST-NET-2 addresses per RFC 5737 (retrieved 2026-11-27).
    // https://www.rfc-editor.org/rfc/rfc5737.html#section-3
    return { origin, 'x-mohassan-internal': internalSecret, 'x-mohassan-client-ip': `198.51.100.${nextAddress++}`, ...(cookie ? { cookie } : {}) };
  }

  function post(url: string, payload: object, cookie?: string) {
    return application.app.inject({ method: 'POST', url, headers: headers(cookie), payload });
  }

  const signIn = (email: string, password: string) => post('/api/auth/sign-in/email', { email, password });
  const access = (cookie: string) => application.app.inject({ url: '/api/access', headers: headers(cookie) });
  const issue = (userId: string, cookie = ownerCookie) => post(`/api/members/${userId}/password-reset`, {}, cookie);
  const inspect = (token: string) => post(inspectPath, { token });
  const accept = (token: string) => post(acceptPath, { token, newPassword });
  const cookieOf = (value: string | string[] | undefined) => [value].flat().filter(Boolean).map(item => item!.split(';')[0]).join('; ');

  async function logIn(email: string, password: string) {
    const response = await signIn(email, password);
    expect(response.statusCode).toBe(200);
    const cookie = cookieOf(response.headers['set-cookie']);
    expect(Boolean(cookie)).toBe(true);
    return cookie;
  }

  async function joinMember(account: typeof memberAccount) {
    const { name, email, password } = account;
    const invite = await post('/api/members/invites', { name, email }, ownerCookie);
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    expect((await post('/api/invites/accept', { token, name, password })).statusCode).toBe(200);
    const cookie = await logIn(email, password);
    const id = (await access(cookie)).json().user.id as string;
    return { id, cookie };
  }

  async function issueLink(userId: string) {
    const response = await issue(userId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { resetLink, expiresAt } = MemberPasswordResetLinkSchema.parse(response.json());
    return { token: new URL(resetLink, origin).hash.slice('#reset='.length), expiresAt };
  }

  function resetAudits(userId: string) {
    return db().selectFrom('workspace_member_audit').select(['actor_id', 'target_id', 'action'])
      .where('target_id', '=', userId).where('action', 'in', ['password_reset_issued', 'password_reset_used']).orderBy('id').execute();
  }

  beforeAll(async () => {
    application = await createApplication({ authSecret: 'member-password-reset-fixture-auth', internalSecret,
      setupToken, webOrigin: origin, production: false, runWorker: false });
    expect((await post('/api/setup', { ...ownerAccount, setupToken })).statusCode).toBe(200);
    ownerCookie = await logIn(ownerAccount.email, ownerAccount.password);
    ownerId = (await access(ownerCookie)).json().user.id;
    memberId = (await joinMember(memberAccount)).id;
    const pending = await joinMember(pendingAccount);
    pendingId = pending.id;
    pendingCookie = pending.cookie;
  });

  afterAll(async () => {
    await application?.app.close();
  });

  it('stores only a token hash, replaces the prior link and checks expiration on both public routes', async () => {
    const first = await issueLink(memberId);
    const second = await issueLink(memberId);
    const rows = await db().selectFrom('workspace_member_password_resets').selectAll().where('user_id', '=', memberId).execute();
    expect(rows).toHaveLength(1);
    const hash = createHash('sha256').update(second.token, 'utf8').digest('hex');
    expect(rows[0]!.token_hash === hash).toBe(true);
    expect(new Date(rows[0]!.expires_at).toISOString()).toBe(second.expiresAt);
    expect((await inspect(first.token)).statusCode).toBe(404);
    expect((await accept(first.token)).statusCode).toBe(404);
    expect((await inspect(second.token)).json()).toEqual({ ok: true });
    await db().updateTable('workspace_member_password_resets').set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where('user_id', '=', memberId).execute();
    expect((await inspect(second.token)).statusCode).toBe(404);
    expect((await accept(second.token)).statusCode).toBe(404);
    expect(await resetAudits(memberId)).toEqual([
      { actor_id: ownerId, target_id: memberId, action: 'password_reset_issued' },
      { actor_id: ownerId, target_id: memberId, action: 'password_reset_issued' },
    ]);
  });

  it('consumes a link once, ends all member sessions and records the committed reset', async () => {
    const { token } = await issueLink(memberId);
    const cookies = await Promise.all([
      logIn(memberAccount.email.toUpperCase(), memberAccount.password), logIn(memberAccount.email, memberAccount.password),
    ]);
    const sessions = await db().selectFrom('session').select('token').where('userId', '=', memberId).execute();
    expect(sessions.length).toBeGreaterThanOrEqual(cookies.length);
    const [first, second, concurrentSignIn] = await Promise.all([accept(token), accept(token), signIn(memberAccount.email, memberAccount.password)]);
    const accepts = [first, second];
    expect(accepts.map(response => response.statusCode).sort()).toEqual([200, 404]);
    for (const response of accepts) {
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body.includes(token)).toBe(false);
      expect(sessions.some(session => response.body.includes(session.token))).toBe(false);
    }
    expect(accepts.find(response => response.statusCode === 200)!.json()).toEqual({ ok: true });
    expect(await db().selectFrom('session').select('id').where('userId', '=', memberId).execute()).toEqual([]);
    expect(await db().selectFrom('workspace_member_password_resets').select('user_id').where('user_id', '=', memberId).execute()).toEqual([]);
    for (const cookie of cookies) expect((await access(cookie)).statusCode).toBe(401);
    expect([200, 401]).toContain(concurrentSignIn.statusCode);
    const concurrentCookie = cookieOf(concurrentSignIn.headers['set-cookie']);
    if (concurrentCookie) expect((await access(concurrentCookie)).statusCode).toBe(401);
    expect((await access(ownerCookie)).statusCode).toBe(200);
    expect((await inspect(token)).statusCode).toBe(404);
    expect((await signIn(memberAccount.email, memberAccount.password)).statusCode).toBe(401);
    expect((await access(await logIn(memberAccount.email, newPassword))).json().user.id).toBe(memberId);
    expect((await resetAudits(memberId)).filter(row => row.action === 'password_reset_used')).toEqual([
      { actor_id: null, target_id: memberId, action: 'password_reset_used' },
    ]);
  });

  it('preserves the sign-in rate limit for concurrent failed requests from one IP', async () => {
    const client = headers();
    // Better Auth 1.7.17 allows three sign-in requests per ten seconds.
    // https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz (retrieved 2026-11-27)
    const responses = await Promise.all(Array.from({ length: 4 }, () => application.app.inject({
      method: 'POST', url: '/api/auth/sign-in/email', headers: client,
      payload: { email: ownerAccount.email, password: memberAccount.password },
    })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([401, 401, 401, 429]);
  });

  it('requires the owner and rejects owner accounts and members awaiting deletion', async () => {
    expect((await issue(ownerId)).statusCode).toBe(404);
    expect((await issue(pendingId, pendingCookie)).statusCode).toBe(403);
    const { token } = await issueLink(pendingId);
    expect((await post('/api/member-data/deletion', { password: pendingAccount.password }, pendingCookie)).statusCode).toBe(200);
    const denied = await issue(pendingId);
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('MEMBER_DELETION_PENDING');
    expect((await inspect(token)).statusCode).toBe(404);
    expect((await accept(token)).statusCode).toBe(404);
    expect(await resetAudits(ownerId)).toEqual([]);
    expect(await resetAudits(pendingId)).toEqual([
      { actor_id: ownerId, target_id: pendingId, action: 'password_reset_issued' },
    ]);
  });
});
