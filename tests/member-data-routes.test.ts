import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountSessionsSchema, MemberAuditPageSchema, PendingMemberDeletionsSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { MEMBER_DATA_ROUTES } from '../apps/server/src/member-data-routes.js';

const origin = 'http://127.0.0.1:3000';
const internalSecret = 'member-rights-test-internal-secret-001';
const setupToken = 'member-rights-test-setup-token-001';
const accounts = {
  owner: { name: 'Owner fixture', email: 'rights-owner@example.test', password: 'Owner-fixture-password-786' },
  alice: { name: 'Alice fixture', email: 'rights-alice@example.test', password: 'Alice-fixture-password-567' },
  bob: { name: 'Bob fixture', email: 'rights-bob@example.test', password: 'Bob-fixture-password-432' },
};
const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
const cookieOf = (value: string | string[] | undefined) => [value].flat().filter(Boolean).map(item => item!.split(';')[0]).join('; ');

describe('member data rights over the authenticated application', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory: string | undefined;
  let owner = '', alice = '', bob = '', ownerId = '', aliceId = '', bobId = '', aliceInvite = '';
  let nextAddress = 40;
  const app = () => application!.app;

  async function logIn(account: keyof typeof accounts) {
    // The IP is from TEST-NET-2. https://www.rfc-editor.org/rfc/rfc5737.html (retrieved 2026-11-25).
    const ip = `198.51.100.${nextAddress++}`;
    const { email, password } = accounts[account];
    const response = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email',
      headers: { ...headers(), 'x-mohassan-client-ip': ip, 'user-agent': 'fixture browser' }, payload: { email, password } });
    expect(response.statusCode).toBe(200);
    const cookie = cookieOf(response.headers['set-cookie']);
    expect(Boolean(cookie)).toBe(true);
    return { cookie, ip };
  }
  async function invite(cookie: string, account: { name: string; email: string }) {
    const response = await app().inject({ method: 'POST', url: '/api/members/invites', headers: headers(cookie), payload: { name: account.name, email: account.email } });
    expect(response.statusCode).toBe(200);
    const { id, url } = response.json<{ id: string; url: string }>();
    return { id, token: new URL(url).hash.slice('#invite='.length) };
  }
  async function joinMember(account: 'alice' | 'bob') {
    const { id, token } = await invite(owner, accounts[account]);
    const { name, password } = accounts[account];
    const joined = await app().inject({ method: 'POST', url: '/api/invites/accept', headers: headers(), payload: { token, name, password } });
    expect(joined.statusCode).toBe(200);
    const { cookie } = await logIn(account);
    return { cookie, id: await readAccountId(cookie), inviteId: id };
  }
  async function readAccountId(cookie: string) {
    const response = await app().inject({ url: '/api/access', headers: headers(cookie) });
    expect(response.statusCode).toBe(200);
    return response.json<{ user: { id: string } }>().user.id;
  }
  async function readAudit() {
    const response = await app().inject({ url: '/api/members/audit', headers: headers(owner) });
    expect(response.statusCode).toBe(200);
    return MemberAuditPageSchema.parse(response.json()).entries;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-member-rights-'));
    application = await createApplication({ authSecret: 'member-rights-test-auth-secret-001', internalSecret,
      setupToken, webOrigin: origin, production: false, runWorker: false, documentsDir: join(directory, 'documents'),
      browserProfileDir: join(directory, 'browser') });
    const setup = await app().inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...accounts.owner, setupToken } });
    expect(setup.statusCode).toBe(200);
    owner = (await logIn('owner')).cookie;
    ownerId = await readAccountId(owner);
    const first = await joinMember('alice');
    alice = first.cookie; aliceId = first.id; aliceInvite = first.inviteId;
    const second = await joinMember('bob');
    bob = second.cookie; bobId = second.id;
  });
  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('requires sign-in on all data routes and reserves administration for the owner', async () => {
    const admin = ['GET /api/members/audit', 'GET /api/members/deletions',
      `DELETE /api/members/deletions/${bobId}`, `DELETE /api/members/${bobId}/sessions`];
    for (const route of [...MEMBER_DATA_ROUTES, ...admin]) {
      const [method, url] = route.split(' ') as ['GET' | 'POST' | 'DELETE', string];
      const response = await app().inject({ method, url, headers: headers() });
      expect(response.statusCode, route).toBe(401);
    }
    for (const route of admin) {
      const [method, url] = route.split(' ') as ['GET' | 'DELETE', string];
      const response = await app().inject({ method, url, headers: headers(alice) });
      expect(response.statusCode, route).toBe(403);
    }
    for (const [method, url] of [['GET', '/api/auth/get-session'], ['POST', '/api/auth/sign-in/email']] as const) {
      const response = await app().inject({ method, url, headers: { origin, cookie: alice } });
      expect(response.json().error.code).toBe('SERVICE_UNAUTHORIZED');
    }
    const badOrigin = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email',
      headers: { 'x-mohassan-internal': internalSecret, origin: 'https://untrusted.example.test' } });
    expect(badOrigin.json().error.code).toBe('ORIGIN_DENIED');
    const unsupportedAuth = await app().inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: headers(alice) });
    expect(unsupportedAuth.json().error.code).toBe('AUTH_ACTION_DISABLED');
  });

  it('delivers the session through HttpOnly cookies and omits credentials from auth JSON', async () => {
    const { email, password } = accounts.bob;
    const signedIn = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email',
      headers: headers(), payload: { email, password } });
    expect(signedIn.statusCode).toBe(200);
    const cookie = cookieOf(signedIn.headers['set-cookie']);
    expect(Boolean(cookie)).toBe(true);
    const setCookies = [signedIn.headers['set-cookie']].flat();
    expect(setCookies.some(value => /;\s*httponly\b/i.test(value ?? ''))).toBe(true);
    const signedInBody = signedIn.json();
    expect.soft(Object.hasOwn(signedInBody, 'token')).toBe(false);
    expect(signedInBody.user.id).toBe(bobId);

    const current = await app().inject({ url: '/api/auth/get-session', headers: headers(cookie) });
    expect(current.statusCode).toBe(200);
    const currentBody = current.json();
    expect.soft(Object.hasOwn(currentBody.session, 'token')).toBe(false);
    expect(currentBody.user.id).toBe(bobId);

    const session = await application!.database.db.selectFrom('session').select('token')
      .where('id', '=', currentBody.session.id).executeTakeFirstOrThrow();
    expect.soft(signedIn.body.includes(session.token)).toBe(false);
    expect.soft(current.body.includes(session.token)).toBe(false);
    expect((await app().inject({ method: 'POST', url: '/api/auth/sign-out', headers: headers(cookie), payload: {} })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/auth/get-session', headers: headers(cookie) })).json() === null).toBe(true);
  });

  it('limits session metadata and revocation to the signed-in account and its other sessions', async () => {
    const baseline = await app().inject({ url: '/api/member-data/sessions', headers: headers(alice) });
    const baselineSessions = AccountSessionsSchema.parse(baseline.json()).sessions;
    expect(baselineSessions).toHaveLength(1);
    const otherAlice = await logIn('alice');
    const list = await app().inject({ url: '/api/member-data/sessions', headers: headers(alice) });
    expect(list.statusCode).toBe(200);
    const { sessions } = AccountSessionsSchema.parse(list.json());
    expect(sessions).toHaveLength(baselineSessions.length + 1);
    expect(sessions.filter(session => session.current)).toHaveLength(1);
    expect(sessions.filter(session => session.ipPrefix === '198.51.100.0/24')).toHaveLength(2);
    expect(list.body.includes(otherAlice.ip)).toBe(false);
    const authDetails = await app().inject({ url: '/api/auth/get-session?disableCookieCache=true', headers: headers(otherAlice.cookie) });
    expect(authDetails.json().session.ipAddress).toBe('198.51.100.0/24');
    expect(authDetails.body.includes(otherAlice.ip)).toBe(false);
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await app().inject({ method, url: `/api/member-data/sessions?userId=${bobId}`, headers: headers(alice) })).statusCode).toBe(400);
    }
    const ended = await app().inject({ method: 'DELETE', url: '/api/member-data/sessions', headers: headers(alice) });
    expect(ended.json()).toEqual({ ended: sessions.length - 1 });
    expect(await readAccountId(alice)).toBe(aliceId);
    expect((await app().inject({ url: '/api/access', headers: headers(otherAlice.cookie) })).statusCode).toBe(401);
    expect(await readAccountId(bob)).toBe(bobId);

    const adminEnded = await app().inject({ method: 'DELETE', url: `/api/members/${bobId}/sessions`, headers: headers(owner) });
    expect(adminEnded.json().ended).toBeGreaterThanOrEqual(1);
    expect((await app().inject({ url: '/api/access', headers: headers(bob) })).statusCode).toBe(401);
    expect((await app().inject({ method: 'DELETE', url: `/api/members/${ownerId}/sessions`, headers: headers(owner) })).statusCode).toBe(404);
    expect(await readAccountId(owner)).toBe(ownerId);
    expect((await readAudit()).filter(entry => entry.action === 'member_sessions_ended')).toEqual([
      expect.objectContaining({ actorId: ownerId, targetId: bobId }),
    ]);
    bob = (await logIn('bob')).cookie;
  });

  it('verifies the current password, revokes sessions, and limits access until the member cancels', async () => {
    const another = (await logIn('alice')).cookie;
    const requestDeletion = (cookie: string, password: string) => app().inject({ method: 'POST', url: '/api/member-data/deletion',
      headers: headers(cookie), payload: { password } });
    expect((await requestDeletion(owner, accounts.owner.password)).statusCode).toBe(403);
    expect((await requestDeletion(alice, accounts.bob.password)).statusCode).toBe(403);
    expect(await readAccountId(alice)).toBe(aliceId);
    const requested = await requestDeletion(alice, accounts.alice.password);
    expect(requested.statusCode).toBe(200);
    const deletion = requested.json().deletion;
    expect(Date.parse(deletion.purgeAfter) - Date.parse(deletion.requestedAt)).toBe(7 * 24 * 60 * 60 * 1000);
    for (const cookie of [alice, another]) {
      expect((await app().inject({ url: '/api/member-data/deletion', headers: headers(cookie) })).statusCode).toBe(401);
    }
    expect((await app().inject({ url: '/api/member-data/deletion', headers: headers(bob) })).json()).toEqual({ deletion: null });
    const pending = await app().inject({ url: '/api/members/deletions', headers: headers(owner) });
    expect(PendingMemberDeletionsSchema.parse(pending.json()).requests.map(request => request.userId)).toEqual([aliceId]);

    alice = (await logIn('alice')).cookie;
    expect((await app().inject({ url: '/api/access', headers: headers(alice) })).json().deletion).toEqual(deletion);
    expect((await app().inject({ method: 'HEAD', url: '/api/access', headers: headers(alice) })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/member-data/deletion', headers: headers(alice) })).json()).toEqual({ deletion });
    for (const url of ['/api/member-data/export', '/api/member-data/sessions', '/api/chat/conversations']) {
      expect((await app().inject({ url, headers: headers(alice) })).json().error.code, url).toBe('MEMBER_DELETION_PENDING');
    }
    expect((await app().inject({ method: 'DELETE', url: '/api/member-data/deletion', headers: headers(alice) })).json()).toEqual({ cancelled: true });
    expect((await app().inject({ url: '/api/member-data/deletion', headers: headers(alice) })).json()).toEqual({ deletion: null });
    expect(await readAccountId(alice)).toBe(aliceId);
  });

  it('lets the owner cancel a pending deletion and records actors for member administration', async () => {
    const invited = await invite(owner, { name: 'Revocation fixture', email: 'rights-revoked@example.test' });
    expect((await app().inject({ method: 'POST', url: `/api/members/invites/${invited.id}/revoke`, headers: headers(owner) })).statusCode).toBe(200);
    for (const enabled of [false, true]) {
      expect((await app().inject({ method: 'POST', url: `/api/members/${aliceId}/access`, headers: headers(owner), payload: { enabled } })).statusCode).toBe(200);
    }
    expect((await app().inject({ method: 'POST', url: '/api/member-data/deletion', headers: headers(bob), payload: { password: accounts.bob.password } })).statusCode).toBe(200);
    expect((await app().inject({ method: 'DELETE', url: `/api/members/deletions/${bobId}`, headers: headers(owner) })).json()).toEqual({ cancelled: true });
    bob = (await logIn('bob')).cookie;
    alice = (await logIn('alice')).cookie;
    expect((await app().inject({ url: '/api/member-data/deletion', headers: headers(bob) })).json()).toEqual({ deletion: null });
    expect(await readAudit()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: ownerId, targetId: aliceInvite, action: 'invite_created' }),
      expect.objectContaining({ actorId: aliceId, targetId: aliceInvite, action: 'invite_used' }),
      expect.objectContaining({ actorId: ownerId, targetId: invited.id, action: 'invite_revoked' }),
      expect.objectContaining({ actorId: ownerId, targetId: aliceId, action: 'member_suspended' }),
      expect.objectContaining({ actorId: ownerId, targetId: aliceId, action: 'member_unsuspended' }),
      expect.objectContaining({ actorId: aliceId, targetId: aliceId, action: 'deletion_requested' }),
      expect.objectContaining({ actorId: aliceId, targetId: aliceId, action: 'deletion_cancelled' }),
      expect.objectContaining({ actorId: ownerId, targetId: bobId, action: 'deletion_cancelled' }),
    ]));
  });

  it('preserves a suspended member’s own rights with product and owner routes blocked', async () => {
    const suspend = (enabled: boolean) => app().inject({ method: 'POST', url: `/api/members/${bobId}/access`, headers: headers(owner), payload: { enabled } });
    expect((await suspend(false)).statusCode).toBe(200);
    bob = (await logIn('bob')).cookie;
    expect((await app().inject({ url: '/api/access', headers: headers(bob) })).json()).toMatchObject({ role: 'member', services: [], dataOnly: true });
    expect((await app().inject({ url: '/api/member-data/sessions', headers: headers(bob) })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/chat/conversations', headers: headers(bob) })).statusCode).toBe(403);
    expect((await app().inject({ url: '/api/members/audit', headers: headers(bob) })).statusCode).toBe(403);
    expect((await app().inject({ method: 'POST', url: '/api/member-data/deletion', headers: headers(bob), payload: { password: accounts.bob.password } })).statusCode).toBe(200);
    bob = (await logIn('bob')).cookie;
    expect((await app().inject({ method: 'DELETE', url: '/api/member-data/deletion', headers: headers(bob) })).json()).toEqual({ cancelled: true });
    expect((await app().inject({ url: '/api/chat/conversations', headers: headers(bob) })).statusCode).toBe(403);
    expect((await suspend(true)).statusCode).toBe(200);
  });

  it('audits completed exports and rate-limits the requester independently', async () => {
    expect((await app().inject({ url: `/api/member-data/export?userId=${bobId}`, headers: headers(alice) })).statusCode).toBe(400);
    const download = await app().inject({ url: '/api/member-data/export', headers: headers(alice) });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.rawPayload.length).toBeGreaterThan(0);
    const repeated = await app().inject({ url: '/api/member-data/export', headers: headers(alice) });
    expect(repeated.statusCode).toBe(429);
    expect(Number(repeated.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app().inject({ url: '/api/member-data/export', headers: headers(bob) })).statusCode).toBe(200);
    await vi.waitFor(async () => {
      const downloaded = (await readAudit()).filter(entry => entry.action === 'export_downloaded');
      expect(downloaded).toHaveLength(2);
      expect(downloaded).toEqual(expect.arrayContaining([
        expect.objectContaining({ actorId: aliceId, targetId: aliceId }), expect.objectContaining({ actorId: bobId, targetId: bobId }),
      ]));
    });
  });
});
