import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { MEMBER_ROUTES, PUBLIC_ROUTES } from '../apps/server/src/members.ts';

/** Members are invited people with cloud services only. Every other route must refuse them. */
describe('workspace members over disposable local state', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined, directory = '', ownerCookie = '', memberCookie = '', memberId = '';
  const origin = 'http://127.0.0.1:3000', secret = 'members-fixture-internal-secret-000001', setupToken = 'members-fixture-setup-token-0000000001';
  const owner = { name: 'Members owner fixture', email: 'members-owner@example.test', password: 'Members-Owner-Fixture-Password-42' };
  const member = { name: 'Invited member fixture', email: 'invited-member@example.test', password: 'Invited-Member-Fixture-Password-42' };
  const headers = (session = ownerCookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  const modelBodies: string[] = [];
  const modelFetch = vi.fn<typeof fetch>(async (_input, init) => {
    const body = String(init?.body ?? '{}'); modelBodies.push(body);
    return Response.json({
      model: JSON.parse(body).model ?? 'openai/gpt-oss-20b',
      choices: [{ message: { content: JSON.stringify({ thought: null, plan: null, note: null, tool: 'answer', url: null, ref: null, text: 'أهلًا، أنا بخير.', submit: null, options: null, sensitive: null, outcome: 'done' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 12 },
    });
  });
  const app = () => application!.app;
  const cookieOf = (response: { headers: Record<string, unknown> }) => [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  async function login(credentials: { email: string; password: string }) {
    const response = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(''), payload: { email: credentials.email, password: credentials.password } });
    return { status: response.statusCode, cookie: cookieOf(response) };
  }
  async function invite(input: { name: string; email: string }) {
    const response = await app().inject({ method: 'POST', url: '/api/members/invites', headers: headers(), payload: input });
    expect(response.statusCode, response.body).toBe(200);
    const { id, url } = response.json() as { id: string; url: string };
    return { id, token: new URL(url).hash.replace('#invite=', '') };
  }
  const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, () => randomUUID()).replace('*', 'x');
  async function settle(conversationId: string, cookie: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const detail = await app().inject({ url: `/api/chat/conversations/${conversationId}`, headers: headers(cookie) });
      if (!['running'].includes(detail.json().status)) return detail.json();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('chat did not settle');
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-members-')));
    application = await createApplication({ authSecret: 'members-fixture-auth-secret-0000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false,
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), groqApiKey: 'synthetic-fixture-key-only', aiFetch: modelFetch, memberDailyRuns: 3, testRequestLimit: 2000 });
    expect((await app().inject({ method: 'POST', url: '/api/setup', headers: headers(''), payload: { ...owner, setupToken } })).statusCode).toBe(200);
    ownerCookie = (await login(owner)).cookie;
  }, 60000);
  afterAll(async () => { await application?.app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('lists only routes that exist', () => {
    for (const key of [...MEMBER_ROUTES, ...PUBLIC_ROUTES]) expect(application!.routes.has(key), key).toBe(true);
  });

  it('turns an invite into a member account once, and only for the invited address', async () => {
    const { token } = await invite({ name: member.name, email: member.email });
    const inspected = await app().inject({ method: 'POST', url: '/api/invites/inspect', headers: headers(''), payload: { token } });
    expect(inspected.statusCode, inspected.body).toBe(200); expect(inspected.json()).toEqual({ name: member.name, email: member.email });
    const accepted = await app().inject({ method: 'POST', url: '/api/invites/accept', headers: headers(''), payload: { token, name: member.name, password: member.password } });
    expect(accepted.statusCode, accepted.body).toBe(200); expect(accepted.json().email).toBe(member.email);
    const again = await app().inject({ method: 'POST', url: '/api/invites/accept', headers: headers(''), payload: { token, name: 'Someone else', password: 'Another-Fixture-Password-42' } });
    expect(again.statusCode).toBe(404); expect(again.json().error.code).toBe('INVITE_INVALID');
    const signedIn = await login(member); expect(signedIn.status).toBe(200); memberCookie = signedIn.cookie;
    const access = await app().inject({ url: '/api/access', headers: headers(memberCookie) });
    expect(access.statusCode, access.body).toBe(200); expect(access.json().role).toBe('member'); expect(access.json().services).not.toContain('all');
    memberId = access.json().user.id;
    expect((await app().inject({ url: '/api/access', headers: headers() })).json().role).toBe('owner');
    expect((await app().inject({ method: 'POST', url: '/api/members/invites', headers: headers(), payload: { name: 'Dup', email: member.email.toUpperCase() } })).statusCode).toBe(409);
  });

  it('refuses revoked, malformed and owner-only invite actions', async () => {
    const { id, token } = await invite({ name: 'Revoked fixture', email: 'revoked@example.test' });
    expect((await app().inject({ method: 'POST', url: `/api/members/invites/${id}/revoke`, headers: headers(), payload: {} })).statusCode).toBe(200);
    expect((await app().inject({ method: 'POST', url: '/api/invites/accept', headers: headers(''), payload: { token, name: 'Revoked fixture', password: 'Revoked-Fixture-Password-42' } })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: '/api/invites/inspect', headers: headers(''), payload: { token: 'short' } })).statusCode).toBe(400);
    const replaced = await invite({ name: 'Replaced fixture', email: 'replaced@example.test' }), current = await invite({ name: 'Replaced fixture', email: 'replaced@example.test' });
    expect((await app().inject({ method: 'POST', url: '/api/invites/inspect', headers: headers(''), payload: { token: replaced.token } })).statusCode).toBe(404);
    expect((await app().inject({ method: 'POST', url: '/api/invites/inspect', headers: headers(''), payload: { token: current.token } })).statusCode).toBe(200);
    const forbidden = await app().inject({ method: 'POST', url: '/api/members/invites', headers: headers(memberCookie), payload: { name: 'Member invite', email: 'x@example.test' } });
    expect(forbidden.statusCode).toBe(403); expect(forbidden.json().error.code).toBe('MEMBER_FORBIDDEN');
  });

  it('refuses a member on every route outside the member list, before any handler runs', async () => {
    const checked: string[] = [];
    for (const key of application!.routes) {
      if (PUBLIC_ROUTES.has(key) || MEMBER_ROUTES.has(key)) continue;
      const [method, url] = key.split(' ') as [string, string];
      if (method === 'OPTIONS') continue;
      const response = await app().inject({ method: method as 'GET', url: concrete(url), headers: headers(memberCookie), ...(method === 'GET' || method === 'HEAD' ? {} : { payload: {} }) });
      expect(response.statusCode, key).toBe(403); expect(response.json().error.code, key).toBe('MEMBER_FORBIDDEN');
      checked.push(key);
    }
    // The owner-only surface is large; a short list would mean routes were missed.
    expect(checked.length).toBeGreaterThan(100);
    for (const key of ['GET /api/workspace', 'POST /api/tasks', 'GET /api/coding/projects', 'POST /api/windows/pairing', 'POST /api/ai/providers/freellmapi/settings', 'POST /api/skills/import', 'POST /api/memory/skills/:id/run', 'GET /api/members']) expect(checked, key).toContain(key);
  }, 120000);

  it('requires a session on every non-public route', async () => {
    for (const key of application!.routes) {
      if (PUBLIC_ROUTES.has(key)) continue;
      const [method, url] = key.split(' ') as [string, string];
      if (method === 'OPTIONS') continue;
      const response = await app().inject({ method: method as 'GET', url: concrete(url), headers: headers(''), ...(method === 'GET' || method === 'HEAD' ? {} : { payload: {} }) });
      expect(response.statusCode, key).toBe(401);
    }
  }, 120000);

  it('lets a member reach the member list without the gate refusing', async () => {
    for (const key of MEMBER_ROUTES) {
      const [method, url] = key.split(' ') as [string, string];
      if (key === 'POST /api/chat/conversations' || key.endsWith('/messages')) continue;
      const response = await app().inject({ method: method as 'GET', url: concrete(url), headers: headers(memberCookie), ...(method === 'GET' ? {} : { payload: {} }) });
      const code = (() => { try { return response.json()?.error?.code; } catch { return undefined; } })();
      expect(code, key).not.toBe('MEMBER_FORBIDDEN');
      expect(response.statusCode, key).not.toBe(401);
    }
  }, 120000);

  it('never offers a member the owner tools in chat, while the owner keeps them', async () => {
    modelBodies.length = 0;
    const created = await app().inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(memberCookie), payload: { goal: 'مرحبا، كيف حالك اليوم؟' } });
    expect(created.statusCode, created.body).toBe(200);
    await settle(created.json().id, memberCookie);
    expect(modelBodies.length).toBeGreaterThan(0);
    for (const body of modelBodies) for (const tool of ['workspace_list', 'code_change', 'studio_change', 'computer_view', 'computer_click', 'run_skill']) expect(body, tool).not.toContain(`"${tool}"`);
    modelBodies.length = 0;
    const own = await app().inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(), payload: { goal: 'مرحبا، كيف حالك اليوم؟' } });
    expect(own.statusCode, own.body).toBe(200);
    await settle(own.json().id, ownerCookie);
    expect(modelBodies.some(body => body.includes('"workspace_list"'))).toBe(true);
    // The member cannot read the owner's conversation.
    expect((await app().inject({ url: `/api/chat/conversations/${own.json().id}`, headers: headers(memberCookie) })).statusCode).toBe(404);
  }, 60000);

  it('stops a member at the daily allowance and leaves the owner unlimited', async () => {
    const db = application!.database.db, conversationId = randomUUID();
    await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: memberId, title: 'quota fixture', status: 'idle' }).execute();
    for (let index = 0; index < 2; index++) await db.insertInto('chat_runs').values({ id: randomUUID(), conversation_id: conversationId, owner_id: memberId, status: 'completed', goal: 'quota fixture', lease_token: randomUUID(), lease_expires_at: new Date(Date.now() - 1000) }).execute();
    const limited = await app().inject({ method: 'POST', url: `/api/chat/conversations/${conversationId}/messages`, headers: headers(memberCookie), payload: { text: 'رسالة أخرى' } });
    expect(limited.statusCode, limited.body).toBe(429); expect(limited.json().error.code).toBe('MEMBER_DAILY_LIMIT');
    const access = (await app().inject({ url: '/api/access', headers: headers(memberCookie) })).json();
    expect(access.quota).toEqual({ dailyRuns: 3, used: 3 });
    expect((await app().inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(), payload: {} })).statusCode).toBe(200);
  });

  it('signs out a disabled member everywhere and lets the owner restore access', async () => {
    const listed = (await app().inject({ url: '/api/members', headers: headers() })).json();
    expect(listed.members.map((entry: { email: string }) => entry.email)).toEqual([member.email]);
    expect((await app().inject({ method: 'POST', url: `/api/members/${memberId}/access`, headers: headers(), payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/access', headers: headers(memberCookie) })).statusCode).toBe(401);
    // Signing in again still yields a session, but the gate refuses every route until access is restored.
    const again = await login(member); expect(again.status).toBe(200);
    const refused = await app().inject({ url: '/api/access', headers: headers(again.cookie) });
    expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe('MEMBER_FORBIDDEN');
    expect((await app().inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(again.cookie), payload: {} })).statusCode).toBe(403);
    expect((await app().inject({ method: 'POST', url: `/api/members/${memberId}/access`, headers: headers(), payload: { enabled: true } })).statusCode).toBe(200);
    expect((await app().inject({ url: '/api/access', headers: headers(again.cookie) })).json().role).toBe('member');
    // The owner cannot be disabled through the member endpoint.
    const ownerId = (await app().inject({ url: '/api/access', headers: headers() })).json().user.id;
    expect((await app().inject({ method: 'POST', url: `/api/members/${ownerId}/access`, headers: headers(), payload: { enabled: false } })).statusCode).toBe(404);
  });
});
