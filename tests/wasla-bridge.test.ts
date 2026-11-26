import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApplication } from '../apps/server/src/app.js';
import { PUBLIC_ROUTES } from '../apps/server/src/members.js';
import { WASLA_GATEWAY_ROUTES, registerWaslaRoutes, type WaslaChat } from '../apps/server/src/wasla.js';

describe('the existing local Wasla bridge integration', () => {
  it('is closed by default before touching a database or chat control', async () => {
    const app = Fastify();
    const untouched = new Proxy({}, { get: () => { throw new Error('database touched'); } }) as never;
    await registerWaslaRoutes(app, { db: untouched, enabled: false, owner: async () => ({ id: 'owner' }), roleOf: async () => 'owner', chat: () => { throw new Error('chat touched'); } });
    try {
      for (const [method, url] of [['POST', '/api/wasla/pairing'], ['POST', '/api/wasla/gateway/pair'], ['GET', '/api/wasla/gateway/status'], ['POST', '/api/wasla/gateway/conversations/22222222-2222-4333-8444-555555555555/campaign/resume']] as const) {
        const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
        expect(response.statusCode, url).toBe(403);
      }
    } finally { await app.close(); }
  });

  it('rejects an enabled bridge in production before database startup', async () => {
    await expect(createApplication({ authSecret: 'x'.repeat(32), internalSecret: 'y'.repeat(32), setupToken: 'z'.repeat(32), webOrigin: 'https://example.test', production: true, databaseUrl: 'postgres://unused', runWorker: false, waslaBridgeEnabled: true })).rejects.toThrow('ربط وصلة يعمل على خادم موحسن المحلي فقط');
  });

  it('exempts only registered gateway routes and retains normal owner authentication for pairing administration', () => {
    for (const route of WASLA_GATEWAY_ROUTES) expect(PUBLIC_ROUTES.has(route), route).toBe(true);
    expect(PUBLIC_ROUTES.has('POST /api/wasla/pairing')).toBe(false);
    expect(PUBLIC_ROUTES.has('GET /api/wasla')).toBe(false);
    const routes = [...WASLA_GATEWAY_ROUTES].join('\n');
    for (const banned of ['/secure', '/screen', '/browser', '/windows', '/google-ads']) expect(routes).not.toContain(banned);
    expect(routes).toContain('/campaign/resume');
  });

  it('registers the paired gateway against the current application chat control', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wasla-current-app-'));
    const origin = 'http://127.0.0.1:3000', internalSecret = 'wasla-current-app-internal-'.padEnd(40, 'x'), setupToken = 'wasla-current-app-setup-'.padEnd(40, 'x');
    const web = { origin, 'x-mohassan-internal': internalSecret };
    const application = await createApplication({ authSecret: 'wasla-current-app-auth-'.padEnd(40, 'x'), internalSecret, setupToken, webOrigin: origin, production: false, runWorker: false, waslaBridgeEnabled: true, windowsEnabled: false, browserProfileDir: join(directory, 'browser'), codingAllowedRoots: [directory], desktop: { enabled: false } });
    try {
      expect((await application.app.inject({ method: 'POST', url: '/api/wasla/pairing', headers: web, payload: {} })).statusCode).toBe(401);
      const identity = { name: 'Bridge owner', email: 'bridge-current@example.test', password: 'Bridge-Current-Fixture-Password-42' };
      expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: web, payload: { ...identity, setupToken } })).statusCode).toBe(200);
      const signed = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: web, payload: { email: identity.email, password: identity.password } });
      const cookie = [signed.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
      const pairing = await application.app.inject({ method: 'POST', url: '/api/wasla/pairing', headers: { ...web, cookie }, payload: {} });
      expect(pairing.statusCode, pairing.body).toBe(200);
      const paired = await application.app.inject({ method: 'POST', url: '/api/wasla/gateway/pair', payload: { code: pairing.json().code, name: 'Paired service fixture' } });
      expect(paired.statusCode, paired.body).toBe(200);
      const gateway = { authorization: `Bearer ${paired.json().gatewayKey}` };
      expect((await application.app.inject({ url: '/api/wasla/gateway/status', headers: gateway })).statusCode).toBe(200);
      const missing = await application.app.inject({ method: 'POST', url: '/api/wasla/gateway/conversations/22222222-2222-4333-8444-555555555555/campaign/resume', headers: { ...gateway, 'idempotency-key': 'campaign-readback-missing-1' }, payload: { runId: '33333333-2222-4333-8444-555555555555' } });
      // The real current chat control rejects the nonexistent owned task; the proxy did not stop at an old-control 503.
      expect(missing.statusCode, missing.body).toBe(404);
      const revoked = await application.app.inject({ method: 'POST', url: `/api/wasla/gateways/${paired.json().gatewayId}/revoke`, headers: { ...web, cookie }, payload: {} });
      expect(revoked.statusCode).toBe(200);
      expect((await application.app.inject({ url: '/api/wasla/gateway/status', headers: gateway })).statusCode).toBe(401);
    } finally { await application.app.close(); await rm(directory, { recursive: true, force: true }); }
  }, 120_000);
});

describe('Wasla read-only campaign recovery boundary', () => {
  const gatewayId = '11111111-2222-4333-8444-555555555555', secret = 'K'.repeat(43);
  const conversationId = '22222222-2222-4333-8444-555555555555', runId = '33333333-2222-4333-8444-555555555555';
  const key = `campaign-readback-${runId}`, path = `/api/wasla/gateway/conversations/${conversationId}/campaign/resume`;
  const service = { authorization: `Bearer ${gatewayId}.${secret}`, 'idempotency-key': key };
  const accountEvent = { id: '44444444-2222-4333-8444-555555555555', taskId: 'campaign-recovery-test', seq: 1, stepId: 'intent', status: 'passed', at: '2026-11-24T04:00:00.000Z', type: 'account_observed', data: { customerId: '1234567890', currency: 'GBP', timeZone: 'Europe/London', range: { start: '2026-10-25', end: '2026-11-23' }, checkedAt: '2026-11-24T04:00:00.000Z' } };
  const source = { id: conversationId, status: 'failed', messages: [], campaign: { taskId: accountEvent.taskId, lastSeq: 1, events: [accountEvent] }, campaignRecovery: { runId, mode: 'readback_only' }, browser: { recoveryToken: 'not-for-phone' }, internalSecret: 'not-for-phone' };

  async function fixture(available = true) {
    let ownerAllowed = true, snapshot: unknown = source;
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => { const known = error as Error & { statusCode?: number; code?: string }; return reply.code(known.statusCode ?? (error instanceof z.ZodError ? 400 : 500)).send({ error: { code: known.code ?? 'INVALID_REQUEST' } }); });
    const row = { id: gatewayId, owner_id: 'paired-owner', key_hash: createHash('sha256').update(secret).digest('hex'), revoked_at: null, last_seen_at: new Date() };
    const query = { selectAll() { return this; }, where() { return this; }, executeTakeFirst: async () => row };
    const db = { selectFrom: () => query } as never;
    const resume = vi.fn(async (ownerId: string, id: string, body: unknown) => ({ ...source, status: 'running', campaignRecovery: undefined, ownerId, target: id, submitted: body }));
    const held = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
    const once = vi.fn(async (ownerId: string, scope: string, requestKey: string, body: unknown, run: () => Promise<unknown>) => {
      const mapKey = `${ownerId}:${requestKey}`, fingerprint = JSON.stringify({ scope, body });
      const prior = held.get(mapKey);
      if (prior && prior.fingerprint !== fingerprint) throw Object.assign(new Error('changed'), { statusCode: 409 });
      if (prior) return prior.result;
      const result = run(); held.set(mapKey, { fingerprint, result }); return result;
    });
    const noChange = async () => ({ ok: true });
    const control: WaslaChat = { list: noChange, create: noChange, detail: async () => snapshot, remove: noChange, campaignEvents: noChange, send: noChange, respond: noChange, approve: noChange, cancel: noChange,
      ...(available ? { resumeCampaign: resume, once: once as WaslaChat['once'] } : {}) };
    await registerWaslaRoutes(app, { db, enabled: true, owner: async () => ({ id: 'paired-owner' }), roleOf: async () => ownerAllowed ? 'owner' : 'member', chat: () => control });
    return { app, resume, once, denyOwner: () => { ownerAllowed = false; }, setSnapshot: (value: unknown) => { snapshot = value; } };
  }

  it('requires loopback gateway authentication and the still-authorized owner before recovery', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: path, payload: { runId } })).statusCode).toBe(401);
      expect((await f.app.inject({ method: 'POST', url: path, headers: service, remoteAddress: '192.168.1.20', payload: { runId } })).statusCode).toBe(403);
      expect((await f.app.inject({ method: 'POST', url: path, headers: { ...service, origin: 'https://page.example' }, payload: { runId } })).statusCode).toBe(403);
      f.denyOwner();
      expect((await f.app.inject({ method: 'POST', url: path, headers: service, payload: { runId } })).statusCode).toBe(403);
      expect(f.resume).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it('validates exact run and request key, binds the paired owner and deduplicates through the chat control', async () => {
    const f = await fixture();
    try {
      for (const payload of [{}, { runId, execute: 'create' }, { runId: 'not-a-run' }]) expect((await f.app.inject({ method: 'POST', url: path, headers: service, payload })).statusCode).toBe(400);
      expect((await f.app.inject({ method: 'POST', url: path, headers: { authorization: service.authorization }, payload: { runId } })).statusCode).toBe(400);
      const first = await f.app.inject({ method: 'POST', url: path, headers: service, payload: { runId } });
      const again = await f.app.inject({ method: 'POST', url: path, headers: service, payload: { runId } });
      expect(first.statusCode, first.body).toBe(200); expect(again.statusCode).toBe(200);
      expect(f.resume).toHaveBeenCalledExactlyOnceWith('paired-owner', conversationId, { runId });
      expect(f.once).toHaveBeenCalledWith('paired-owner', `campaign-resume:${conversationId}`, key, { runId }, expect.any(Function));
      expect(first.body).not.toContain('not-for-phone'); expect(first.json()).not.toHaveProperty('submitted');
    } finally { await f.app.close(); }
  });

  it('projects bounded account evidence and hides recovery on an older control', async () => {
    const f = await fixture();
    const old = await fixture(false);
    try {
      const current = (await f.app.inject({ url: `/api/wasla/gateway/conversations/${conversationId}`, headers: service })).json();
      expect(current.campaign.events[0].data).toEqual(accountEvent.data);
      expect(current.campaignRecovery).toEqual({ runId, mode: 'readback_only' });
      expect(current).not.toHaveProperty('browser'); expect(current).not.toHaveProperty('internalSecret');
      f.setSnapshot({ ...source, campaign: { ...source.campaign, events: [{ ...accountEvent, data: { ...accountEvent.data, credential: 'not-for-phone' } }] } });
      const bounded = (await f.app.inject({ url: `/api/wasla/gateway/conversations/${conversationId}`, headers: service })).json();
      expect(bounded).not.toHaveProperty('campaign');
      const prior = (await old.app.inject({ url: `/api/wasla/gateway/conversations/${conversationId}`, headers: service })).json();
      expect(prior).not.toHaveProperty('campaignRecovery');
      const unavailable = await old.app.inject({ method: 'POST', url: path, headers: service, payload: { runId } });
      expect(unavailable.statusCode).toBe(503); expect(unavailable.json().error.code).toBe('WASLA_RECOVERY_UNAVAILABLE');
    } finally { await f.app.close(); await old.app.close(); }
  });
});
