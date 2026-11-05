import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SkillDetailSchema, SkillRegistryResultSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';

describe('skill registry API', () => {
  let application: Awaited<ReturnType<typeof createApplication>>, cookie = '';
  const webOrigin = 'http://127.0.0.1:3000', secret = 'skills-api-fixture-internal-secret-0001', setupToken = 'skills-api-fixture-setup-token-000001';
  const headers = () => ({ 'x-mohassan-internal': secret, origin: webOrigin, ...(cookie ? { cookie } : {}) });
  beforeAll(async () => {
    application = await createApplication({ authSecret: 'skills-api-fixture-auth-secret-000001', internalSecret: secret, setupToken, webOrigin, production: false, runWorker: false });
    const account = { email: 'skills-api@example.test', password: 'Skills-API-Password-Fixture-42' };
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name: 'Skills fixture', ...account, setupToken } })).statusCode).toBe(200);
    const login = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: account });
    cookie = [login.headers['set-cookie']].flat().filter(Boolean).map((value) => String(value).split(';')[0]).join('; ');
  });
  afterAll(async () => { await application?.app.close(); });

  it('requires the service secret and a session', async () => {
    expect((await application.app.inject({ url: '/api/skills' })).statusCode).toBe(401);
    expect((await application.app.inject({ url: '/api/skills', headers: { 'x-mohassan-internal': secret } })).statusCode).toBe(401);
  });
  it('returns a valid registry and detail', async () => {
    const response = await application.app.inject({ url: '/api/skills?category=research', headers: headers() });
    expect(response.statusCode).toBe(200);
    const result = SkillRegistryResultSchema.parse(response.json());
    expect(result.items.map((item) => item.slug)).toEqual(['verified-web-research']);
    const detail = await application.app.inject({ url: `/api/skills/${result.items[0].id}`, headers: headers() });
    expect(detail.statusCode).toBe(200);
    expect(SkillDetailSchema.parse(detail.json()).contract.requires.tools).toContain('browser.open');
  });
  it('rejects bad queries and unknown skills without leaking detail', async () => {
    expect((await application.app.inject({ url: '/api/skills?category=magic', headers: headers() })).statusCode).toBe(400);
    expect((await application.app.inject({ url: '/api/skills?extra=1', headers: headers() })).statusCode).toBe(400);
    expect((await application.app.inject({ url: '/api/skills/not-a-uuid', headers: headers() })).statusCode).toBe(400);
    const missing = await application.app.inject({ url: `/api/skills/${randomUUID()}`, headers: headers() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SKILL_NOT_FOUND');
  });
  it('leaves the existing memory skill routes in place', async () => {
    expect((await application.app.inject({ url: '/api/memory', headers: headers() })).json().skills).toEqual([]);
  });
});
