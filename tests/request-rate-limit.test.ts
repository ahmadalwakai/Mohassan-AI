import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@mohassan/database';
import { createAuth, migrateAuth } from '../apps/server/src/auth.js';
import { createRequestRateLimitKey } from '../apps/server/src/request-rate-limit.js';

const origin = 'http://127.0.0.1:3102';
const serviceMarker = 'rate-limit-local-fixture';
const proxyIp = '127.0.0.1';
let store: Awaited<ReturnType<typeof createDatabase>>, auth: ReturnType<typeof createAuth>;
let aliceCookie = '', aliceOtherSession = '', bobCookie = '';
const apps: FastifyInstance[] = [];

async function signIn(email: string) {
  const response = await auth.api.signInEmail({ body: { email, password: 'Local-rate-fixture-password-42' }, asResponse: true });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

beforeAll(async () => {
  store = await createDatabase();
  await migrateAuth(store.db);
  auth = createAuth(store.db, { secret: 'local-rate-auth-fixture-only-00000001', webOrigin: origin, production: false });
  for (const name of ['alice', 'bob']) await auth.api.signUpEmail({ body: {
    name, email: `${name}@rate.example.test`, password: 'Local-rate-fixture-password-42',
  } });
  aliceCookie = await signIn('alice@rate.example.test');
  aliceOtherSession = await signIn('alice@rate.example.test');
  bobCookie = await signIn('bob@rate.example.test');
});
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
afterAll(async () => { await store?.close(); });

async function fixture() {
  const app = Fastify({ trustProxy: false }); apps.push(app);
  const userId = vi.fn(async (request: { headers: Record<string, unknown> }) => {
    const headers = new Headers();
    if (typeof request.headers.cookie === 'string') headers.set('cookie', request.headers.cookie);
    return (await auth.api.getSession({ headers }))?.user.id ?? null;
  });
  const keyGenerator = createRequestRateLimitKey({
    trusted: request => request.headers['x-mohassan-internal'] === serviceMarker,
    userId,
  });
  await app.register(rateLimit, { max: 2, timeWindow: '1 minute', keyGenerator });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers['x-mohassan-internal'] !== serviceMarker) return reply.code(401).send({ error: 'SERVICE_UNAUTHORIZED' });
  });
  app.get('/ordinary-a', async () => ({ ok: true }));
  app.get('/ordinary-b', async () => ({ ok: true }));
  app.get('/activity', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
  app.get('/screen', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
  const request = (cookie: string, url = '/ordinary-a', extra: Record<string, string> = {}) => app.inject({
    url, remoteAddress: proxyIp,
    headers: { 'x-mohassan-internal': serviceMarker, ...(cookie ? { cookie } : {}), ...extra },
  });
  return { app, request, userId, keyGenerator };
}

describe('verified account rate limits behind a shared service proxy', () => {
  it('isolates accounts while retaining one account-wide global bucket across ordinary routes', async () => {
    const { request } = await fixture();
    expect((await request(aliceCookie)).statusCode).toBe(200);
    expect((await request(aliceCookie, '/ordinary-b')).statusCode).toBe(200);
    expect((await request(aliceCookie)).statusCode).toBe(429);
    expect((await request(bobCookie)).statusCode).toBe(200);
    expect((await request(bobCookie, '/ordinary-b')).statusCode).toBe(200);
    expect((await request(bobCookie)).statusCode).toBe(429);
  });

  it('isolates account polling allowances and keeps extra sessions on the same account allowance', async () => {
    const { request } = await fixture();
    expect(aliceOtherSession).not.toBe(aliceCookie);
    expect((await request(aliceCookie, '/activity')).statusCode).toBe(200);
    expect((await request(aliceOtherSession, '/activity')).statusCode).toBe(200);
    expect((await request(aliceCookie, '/activity')).statusCode).toBe(429);
    expect((await request(bobCookie, '/activity')).statusCode).toBe(200);
    expect((await request(bobCookie, '/activity')).statusCode).toBe(200);
    expect((await request(bobCookie, '/activity')).statusCode).toBe(429);
    expect((await request(aliceCookie, '/screen')).statusCode).toBe(200);
  });

  it('keeps forged cookies and claimed forwarded/account identities in the bounded unauthenticated IP bucket', async () => {
    const { request } = await fixture();
    for (let index = 0; index < 3; index++) {
      const response = await request(`better-auth.session_token=forged-${index}`, '/ordinary-a', {
        'x-forwarded-for': `192.0.2.${index + 1}`, 'x-user-id': `claimed-${index}`, 'x-real-ip': `198.51.100.${index + 1}`,
      });
      expect(response.statusCode).toBe(index < 2 ? 200 : 429);
    }
    expect((await request(aliceCookie)).statusCode).toBe(200);
  });

  it('bounds missing-cookie traffic without accepting forwarded-IP rotation', async () => {
    const { request } = await fixture();
    expect((await request('', '/ordinary-a', { 'x-forwarded-for': '192.0.2.1' })).statusCode).toBe(200);
    expect((await request('', '/ordinary-b', { 'x-forwarded-for': '192.0.2.2' })).statusCode).toBe(200);
    expect((await request('', '/ordinary-a', { 'x-forwarded-for': '192.0.2.3' })).statusCode).toBe(429);
  });

  it('rejects missing/incorrect service credentials without resolving a supplied session', async () => {
    const { app, request, userId, keyGenerator } = await fixture();
    for (const marker of ['', 'incorrect']) {
      const response = await app.inject({ url: '/ordinary-a', remoteAddress: proxyIp,
        headers: { cookie: aliceCookie, ...(marker ? { 'x-mohassan-internal': marker } : {}) } });
      expect(response.statusCode).toBe(401);
      expect(await keyGenerator({ ip: proxyIp, headers: { cookie: aliceCookie, 'x-mohassan-internal': marker } })).toBe(`ip:${proxyIp}`);
    }
    expect(userId).not.toHaveBeenCalled();
    expect((await request(aliceCookie)).statusCode).toBe(200);
  });

  it('uses the authenticated account ID and never includes raw session cookies in a key', async () => {
    const { keyGenerator } = await fixture();
    const accountKey = await keyGenerator({ ip: proxyIp, headers: { cookie: aliceCookie, 'x-mohassan-internal': serviceMarker } });
    expect(accountKey).toMatch(/^account:/u);
    expect(accountKey).not.toContain(aliceCookie);
    expect(accountKey).not.toContain(serviceMarker);
    expect(await keyGenerator({ ip: proxyIp, headers: { cookie: aliceOtherSession, 'x-mohassan-internal': serviceMarker } })).toBe(accountKey);
  });
});
