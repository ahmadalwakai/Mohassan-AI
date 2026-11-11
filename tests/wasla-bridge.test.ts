import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';
import { PUBLIC_ROUTES } from '../apps/server/src/members.ts';
import { WASLA_GATEWAY_ROUTES, registerWaslaRoutes } from '../apps/server/src/wasla.ts';
import { fixtureLocalModel } from './fixtures/local-model.js';

const answer = (text: string) => Response.json({
  model: 'fixture', choices: [{ message: { content: JSON.stringify({ thought: null, plan: null, note: null, tool: 'answer', url: null, ref: null, text, submit: null, options: null, sensitive: null, outcome: 'done' }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 12 },
});

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
  const modelFetch = vi.fn<typeof fetch>(async () => answer('أهلًا من موحسن.'));
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
      codingAllowedRoots: [directory], browserProfileDir: join(directory, 'browser'), ...fixtureLocalModel(modelFetch), testRequestLimit: 2000, waslaBridgeEnabled: true });
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
    const created = await app().inject({ method: 'POST', url: '/api/wasla/gateway/conversations', headers: service(), payload: { goal: 'مرحبا، كيف حالك اليوم؟' } });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    let detail: { status: string } = { status: 'running' };
    for (let attempt = 0; attempt < 200 && detail.status === 'running'; attempt++) {
      detail = (await app().inject({ url: `/api/wasla/gateway/conversations/${id}`, headers: service() })).json();
      if (detail.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(detail.status).not.toBe('running');
    expect(modelFetch).toHaveBeenCalled();
    // The owner sees the same conversation in the web workspace.
    const fromWeb = await app().inject({ url: `/api/chat/conversations/${id}`, headers: web() });
    expect(fromWeb.statusCode).toBe(200); expect(JSON.stringify(fromWeb.json())).toContain('مرحبا، كيف حالك اليوم؟');
    const listed = await app().inject({ url: '/api/wasla/gateway/conversations', headers: service() });
    // The shapes the iPhone app (Models.swift) and the computer service (mohassan.py) read.
    expect(listed.json()).toEqual({ conversations: expect.arrayContaining([expect.objectContaining({ id, title: expect.any(String), status: expect.any(String), updatedAt: expect.any(String) })]) });
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

  it('stops the key as soon as the owner revokes it', async () => {
    const revoked = await app().inject({ method: 'POST', url: `/api/wasla/gateways/${gatewayId}/revoke`, headers: web(), payload: {} });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const after = await app().inject({ url: '/api/wasla/gateway/conversations', headers: service() });
    expect(after.statusCode).toBe(401); expect(after.json().error.code).toBe('WASLA_GATEWAY_UNAUTHORIZED');
    expect((await app().inject({ url: '/api/wasla', headers: web() })).json().gateways[0].revoked).toBe(true);
  });
});
