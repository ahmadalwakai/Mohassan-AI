import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { PUBLIC_ROUTES } from '../apps/server/src/members.ts';
import { WASLA_GATEWAY_ROUTES, registerWaslaRoutes } from '../apps/server/src/wasla.ts';

describe('Wasla bridge switch', () => {
  it('is closed unless the server enables it, before any database access', async () => {
    const app = Fastify();
    const untouched = new Proxy({}, { get: () => { throw new Error('database touched'); } }) as never;
    await registerWaslaRoutes(app, { db: untouched, enabled: false, owner: async () => ({ id: 'owner' }), roleOf: async () => 'owner', chat: () => { throw new Error('chat touched'); } });
    for (const [method, url] of [['POST', '/api/wasla/pairing'], ['POST', '/api/wasla/gateway/pair'], ['GET', '/api/wasla/gateway/status'], ['GET', '/api/wasla/gateway/conversations']] as const) {
      const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode, url).toBe(403); expect(response.json().code ?? response.json().error?.code, url).toBe('WASLA_BRIDGE_DISABLED');
    }
    await app.close();
  });

  it('refuses to start on a production server', async () => {
    await expect(createApplication({ authSecret: 'x'.repeat(32), internalSecret: 'y'.repeat(32), setupToken: 'z'.repeat(32), webOrigin: 'https://example.test', production: true, databaseUrl: 'postgres://unused', runWorker: false, waslaBridgeEnabled: true }))
      .rejects.toThrow('ربط وصلة يعمل على خادم موحسن المحلي فقط');
  });

  it('lists only chat routes, and no sign-in values or browser control', () => {
    for (const key of WASLA_GATEWAY_ROUTES) expect(PUBLIC_ROUTES.has(key), key).toBe(true);
    const joined = [...WASLA_GATEWAY_ROUTES].join('\n');
    for (const banned of ['/secure', '/screen', '/browser', '/memory', '/windows', '/tasks', '/coding', '/google-ads']) expect(joined).not.toContain(banned);
  });
});

describe('Wasla bridge over disposable local state', { timeout: 120000 }, () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined, directory = '', ownerCookie = '', gatewayKey = '', gatewayId = '';
  const origin = 'http://127.0.0.1:3000', secret = 'wasla-fixture-internal-secret-00000001', setupToken = 'wasla-fixture-setup-token-000000000001';
  const owner = { name: 'Wasla owner fixture', email: 'wasla-owner@example.test', password: 'Wasla-Owner-Fixture-Password-42' };
  const web = (session = ownerCookie) => ({ origin, 'x-mohassan-internal': secret, ...(session ? { cookie: session } : {}) });
  const service = (key = gatewayKey) => ({ authorization: `Bearer ${key}` });
  const app = () => application!.app;
  const cookieOf = (response: { headers: Record<string, unknown> }) => [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
  async function pairingCode() {
    const response = await app().inject({ method: 'POST', url: '/api/wasla/pairing', headers: web(), payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().code as string;
  }

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'mohassan-wasla-')));
    application = await createApplication({ authSecret: 'wasla-fixture-auth-secret-000000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false,
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), testRequestLimit: 2000, waslaBridgeEnabled: true,
      // The phone's search goes through Mohassan's engine; a fixture provider stands in for the network.
      browser: { searchProvider: { name: 'fixture-engine', limitations: ['مصادر متخصصة'], search: async (question: string) => {
        if (question.includes('لاشيء')) throw Object.assign(new Error('no reliable result'), { code: 'RESEARCH_SEARCH_UNAVAILABLE', statusCode: 502 });
        if (question.includes('عطل')) throw Object.assign(new Error('engine crashed'), { code: 'FIXTURE_ENGINE_DOWN', statusCode: 503 });
        return [
          { title: `نتيجة عن ${question}`, url: 'https://example.test/one', snippet: 'مقتطف' },
          { title: 'insecure', url: 'http://example.test/two', snippet: 'dropped' },
        ];
      } } } });
    expect((await app().inject({ method: 'POST', url: '/api/setup', headers: web(''), payload: { ...owner, setupToken } })).statusCode).toBe(200);
    const signIn = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: web(''), payload: { email: owner.email, password: owner.password } });
    ownerCookie = cookieOf(signIn);
  }, 240000);
  afterAll(async () => { await application?.app.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('registers every gateway route', () => {
    for (const key of WASLA_GATEWAY_ROUTES) expect(application!.routes.has(key), key).toBe(true);
  });

  it('pairs only from this computer, never from a browser, and only once per code', async () => {
    const code = await pairingCode(), body = { code, name: 'Wasla on this PC' };
    const remote = await app().inject({ method: 'POST', url: '/api/wasla/gateway/pair', remoteAddress: '100.72.1.2', payload: body });
    expect(remote.statusCode).toBe(403); expect(remote.json().error.code).toBe('WASLA_LOCAL_ONLY');
    const browser = await app().inject({ method: 'POST', url: '/api/wasla/gateway/pair', headers: { origin }, payload: body });
    expect(browser.statusCode).toBe(403); expect(browser.json().error.code).toBe('WASLA_BROWSER_DENIED');
    const withCookie = await app().inject({ method: 'POST', url: '/api/wasla/gateway/pair', headers: { cookie: ownerCookie }, payload: body });
    expect(withCookie.statusCode).toBe(403);
    const paired = await app().inject({ method: 'POST', url: '/api/wasla/gateway/pair', payload: body });
    expect(paired.statusCode, paired.body).toBe(200);
    gatewayKey = paired.json().gatewayKey; gatewayId = paired.json().gatewayId;
    expect(gatewayKey.startsWith(`${gatewayId}.`)).toBe(true);
    const again = await app().inject({ method: 'POST', url: '/api/wasla/gateway/pair', payload: body });
    expect(again.statusCode).toBe(401); expect(again.json().error.code).toBe('WASLA_PAIRING_INVALID');
    const summary = await app().inject({ url: '/api/wasla', headers: web() });
    expect(summary.statusCode).toBe(200); expect(summary.json().enabled).toBe(true);
    expect(summary.json().gateways).toEqual([expect.objectContaining({ id: gatewayId, name: 'Wasla on this PC', revoked: false })]);
    expect(summary.body).not.toContain(gatewayKey.split('.')[1]);
    expect(summary.json().events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(['pairing_created', 'gateway_paired']));
  });

  it('refuses a missing, wrong or remote key', async () => {
    expect((await app().inject({ url: '/api/wasla/gateway/status' })).statusCode).toBe(401);
    expect((await app().inject({ url: '/api/wasla/gateway/status', headers: service(`${gatewayId}.${'A'.repeat(43)}`) })).statusCode).toBe(401);
    expect((await app().inject({ url: '/api/wasla/gateway/status', headers: service(), remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    const ok = await app().inject({ url: '/api/wasla/gateway/status', headers: service() });
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json()).toEqual({ ok: true, bridge: 'mohassan' });
  });

  it('runs the phone request through the same Mohassan chat the web uses', async () => {
    // Answered by Mohassan's own brain (its calculator), with no model and no browser.
    const created = await app().inject({ method: 'POST', url: '/api/wasla/gateway/conversations', headers: service(), payload: { goal: 'كم يساوي 15 ضرب 23؟' } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    let detail: { status: string } = { status: 'running' };
    for (let attempt = 0; attempt < 200 && detail.status === 'running'; attempt++) {
      detail = (await app().inject({ url: `/api/wasla/gateway/conversations/${id}`, headers: service() })).json();
      if (detail.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(detail.status).not.toBe('running');
    // The owner sees the same conversation, and the same answer, in the web workspace.
    const fromWeb = await app().inject({ url: `/api/chat/conversations/${id}`, headers: web() });
    expect(fromWeb.statusCode).toBe(200);
    expect(JSON.stringify(fromWeb.json())).toContain('كم يساوي 15 ضرب 23؟');
    expect(JSON.stringify(fromWeb.json())).toContain('345');
    const listed = await app().inject({ url: '/api/wasla/gateway/conversations', headers: service() });
    // The shapes the iPhone app (Models.swift) and the computer service (mohassan.py) read.
    expect(listed.json()).toMatchObject({ conversations: expect.arrayContaining([expect.objectContaining({ id, title: expect.any(String), status: expect.any(String), updatedAt: expect.any(String) })]) });
    const shape = (await app().inject({ url: `/api/wasla/gateway/conversations/${id}`, headers: service() })).json();
    for (const key of ['id', 'title', 'status', 'messages', 'question', 'approval', 'secure', 'progress', 'steps', 'error']) expect(shape, key).toHaveProperty(key);
    for (const message of shape.messages) expect(Object.keys(message)).toEqual(expect.arrayContaining(['id', 'role', 'text']));
    // The browser block (recovery token, screen link) and the decision log stay on the web side.
    for (const key of ['browser', 'browserAccount', 'decisions', 'goal']) expect(shape, key).not.toHaveProperty(key);
    expect(JSON.stringify(shape)).not.toContain('recoveryToken');
    expect(created.json().id).toBe(id);
    const events = await app().inject({ url: `/api/wasla/gateway/conversations/${id}/campaign-events?after=0`, headers: service() });
    expect(events.statusCode, events.body).toBe(200);
    // Sign-in values and the browser are not reachable through the gateway.
    for (const path of ['secure', 'screen', 'browser/pointer']) {
      const response = await app().inject({ method: path === 'screen' ? 'GET' : 'POST', url: `/api/wasla/gateway/conversations/${id}/${path}`, headers: service(), ...(path === 'screen' ? {} : { payload: {} }) });
      // No such gateway route: the service-secret check refuses it before any handler.
      expect(response.statusCode, path).toBe(401); expect(response.json().error.code, path).toBe('SERVICE_UNAUTHORIZED');
    }
    // The key does not open the web routes.
    const direct = await app().inject({ url: '/api/chat/conversations', headers: service() });
    expect(direct.statusCode).toBe(401); expect(direct.json().error.code).toBe('SERVICE_UNAUTHORIZED');
    const removed = await app().inject({ method: 'DELETE', url: `/api/wasla/gateway/conversations/${id}`, headers: service() });
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('searches with Mohassan\'s engine and keeps only https results', async () => {
    const found = await app().inject({ url: '/api/wasla/gateway/search?q=%D8%AA%D9%8A%D9%84%D8%B3%D9%83%D9%8A%D9%84', headers: service() });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json()).toEqual({ query: 'تيلسكيل', provider: 'fixture-engine', limitations: ['مصادر متخصصة'], results: [{ title: 'نتيجة عن تيلسكيل', url: 'https://example.test/one', snippet: 'مقتطف' }] });
    expect((await app().inject({ url: '/api/wasla/gateway/search', headers: service() })).statusCode).toBe(400);
    expect((await app().inject({ url: '/api/wasla/gateway/search?q=x' })).statusCode).toBe(401);
  });

  it('runs each phone request key at most once, even when it arrives twice at the same time', async () => {
    const userMessages = async (cid: string) => (await app().inject({ url: `/api/wasla/gateway/conversations/${cid}`, headers: service() })).json().messages.filter((m: { role: string }) => m.role === 'user');
    const settle = async (cid: string) => { for (let i = 0; i < 200; i++) { const d = (await app().inject({ url: `/api/wasla/gateway/conversations/${cid}`, headers: service() })).json(); if (d.status !== 'running') return d; await new Promise(r => setTimeout(r, 50)); } throw new Error('did not settle'); };
    // Create twice with one key: one conversation.
    const createKey = '6f1c2b8a-3d4e-4f5a-9b6c-7d8e9f0a1b2c';
    const first = await app().inject({ method: 'POST', url: '/api/wasla/gateway/conversations', headers: service(), payload: { goal: 'كم يساوي 7 ضرب 6؟', clientRequestId: createKey } });
    expect(first.statusCode, first.body).toBe(200);
    const cid = first.json().id as string;
    await settle(cid);
    const again = await app().inject({ method: 'POST', url: '/api/wasla/gateway/conversations', headers: service(), payload: { goal: 'كم يساوي 7 ضرب 6؟', clientRequestId: createKey } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(cid);
    expect(await userMessages(cid)).toHaveLength(1);
    // The same message twice at once with one key: one message.
    const messageKey = '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d';
    const body = { text: 'كم يساوي 9 ضرب 9؟', clientRequestId: messageKey };
    const [a, b] = await Promise.all([1, 2].map(() => app().inject({ method: 'POST', url: `/api/wasla/gateway/conversations/${cid}/messages`, headers: service(), payload: body })));
    expect([a!.statusCode, b!.statusCode].sort()).toEqual(expect.arrayContaining([200]));
    for (const r of [a!, b!]) if (r.statusCode !== 200) expect(r.json().error.code).toMatch(/^CLIENT_REQUEST_(IN_PROGRESS|UNKNOWN)$/);
    await settle(cid);
    expect((await userMessages(cid)).map((m: { text: string }) => m.text)).toEqual(['كم يساوي 7 ضرب 6؟', 'كم يساوي 9 ضرب 9؟']);
    // A resend after the reply is replayed, not repeated.
    const resend = await app().inject({ method: 'POST', url: `/api/wasla/gateway/conversations/${cid}/messages`, headers: service(), payload: body });
    expect(resend.statusCode, resend.body).toBe(200);
    expect(await userMessages(cid)).toHaveLength(2);
    // The same key for another text is refused.
    const reused = await app().inject({ method: 'POST', url: `/api/wasla/gateway/conversations/${cid}/messages`, headers: service(), payload: { text: 'شيء آخر', clientRequestId: messageKey } });
    expect(reused.statusCode).toBe(409); expect(reused.json().error.code).toBe('CLIENT_REQUEST_REUSED');
    // A refused request frees its key for the corrected one.
    const freeKey = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
    const refused = await app().inject({ method: 'POST', url: `/api/wasla/gateway/conversations/${cid}/messages`, headers: service(), payload: { text: '', clientRequestId: freeKey } });
    expect(refused.statusCode).toBe(400);
    expect((await app().inject({ url: `/api/wasla/gateway/requests/${freeKey}`, headers: service() })).json()).toEqual({ known: false });
    // What became of a request, by its key.
    expect((await app().inject({ url: `/api/wasla/gateway/requests/${messageKey}`, headers: service() })).json()).toEqual({ known: true, kind: 'messages', state: 'done', conversationId: cid });
    expect((await app().inject({ url: '/api/wasla/gateway/requests/not-a-key', headers: service() })).statusCode).toBe(400);
  });

  it('answers «no reliable result» as an empty search, and a real failure as an error', async () => {
    const empty = await app().inject({ url: `/api/wasla/gateway/search?q=${encodeURIComponent('لاشيء هنا')}`, headers: service() });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ query: 'لاشيء هنا', results: [] });
    expect(empty.json().notice).toContain('ليست فهرسًا شاملًا للويب');
    const broken = await app().inject({ url: `/api/wasla/gateway/search?q=${encodeURIComponent('عطل')}`, headers: service() });
    expect(broken.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('stops the key as soon as the owner revokes it', async () => {
    const revoked = await app().inject({ method: 'POST', url: `/api/wasla/gateways/${gatewayId}/revoke`, headers: web(), payload: {} });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const after = await app().inject({ url: '/api/wasla/gateway/conversations', headers: service() });
    expect(after.statusCode).toBe(401); expect(after.json().error.code).toBe('WASLA_GATEWAY_UNAUTHORIZED');
    expect((await app().inject({ url: '/api/wasla', headers: web() })).json().gateways[0].revoked).toBe(true);
  });
});
