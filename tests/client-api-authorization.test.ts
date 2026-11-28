import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { HTTPMethods } from 'fastify';
import { PhoneServerErrorReplySchema } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clientInventory } from '../scripts/client-api/inventory.js';
import { serverRoutes } from '../scripts/client-api/server.js';
import { checkError, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

const root = resolve(import.meta.dirname, '..');
const inventory = clientInventory(root).filter(row => row.transport === 'fastify');
const protectedRoutes = inventory.filter(row => row.server && row.auth !== 'anonymous');
const ownerRoutes = protectedRoutes.filter(row => row.auth === 'owner');
const missingRoutes = inventory.filter(row => !row.server);
const urlFor = (pattern: string) => pattern.replace(/:[^/]+/g, () => randomUUID()).replace('*', 'index.html');

describe('Fastify client route access and errors', () => {
  let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
  let owner: ClientApiAccount;
  let member: ClientApiAccount;

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', '1');
    fixture = await openClientApiApp();
    owner = await fixture.setupOwner();
    member = await fixture.inviteMember(owner);
  });

  afterAll(async () => {
    try { await fixture?.close(); } finally { vi.unstubAllEnvs(); }
  });

  it('discovers exactly the routes registered by the application', () => {
    const keys = serverRoutes(root).map(route => `${route.method} ${route.registrationPath ?? route.path}`);
    expect(new Set(keys)).toEqual(fixture.application.routes);
  });

  it.each(protectedRoutes)('requires a session for $method $path', async ({ method, path }) => {
    const response = await fixture.send(method as HTTPMethods, urlFor(path));
    expect(response.statusCode).toBe(401);
    expect(PhoneServerErrorReplySchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it.each(ownerRoutes)('checks owner access for $method $path', async ({ method, path }) => {
    const response = await fixture.send(method as HTTPMethods, urlFor(path), member);
    expect(response.statusCode).toBe(403);
    expect(PhoneServerErrorReplySchema.parse(response.json()).error.code).toBe('MEMBER_FORBIDDEN');
  });

  if (missingRoutes.length) {
    it.each(missingRoutes)('returns Fastify’s default 404 for missing $method $path', async ({ method, path }) => {
      const url = urlFor(path);
      const response = await fixture.send(method as HTTPMethods, url, owner);
      expect(response.statusCode).toBe(404);
      // https://github.com/fastify/fastify/blob/v5.12.8/lib/four-oh-four.js#L52-L59 (retrieved 2026-11-27).
      expect(response.json()).toEqual({ statusCode: 404, error: 'Not Found', message: `Route ${method}:${url} not found` });
    });
  }

  it('returns typed not-found, conflict and relay rate-limit errors', async () => {
    checkError(await fixture.send('GET', `/api/chat/conversations/${randomUUID()}`, member), 404, 'CHAT_NOT_FOUND');
    checkError(await fixture.send('POST', '/api/members/invites', owner, { name: member.name, email: member.email }), 409, 'MEMBER_EXISTS');

    // app.ts registers five attempts per minute for POST /api/setup, including the successful setup above.
    const { name, email, password } = owner;
    const setupToken = fixture.setupToken + '-invalid';
    for (let attempt = 1; attempt < 5; attempt++) {
      checkError(await fixture.send('POST', '/api/setup', 'anonymous', { name, email, password, setupToken }), 403, 'SETUP_TOKEN_INVALID');
    }
    const limited = await fixture.send('POST', '/api/setup', 'anonymous', {});
    checkError(limited, 429, 'INTERNAL_ERROR');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
