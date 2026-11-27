import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPMethods } from 'fastify';
import { PhoneServerErrorReplySchema, PhoneSignInReplySchema } from '@mohassan/contracts';
import { expect } from 'vitest';
import { z } from 'zod';
import { createApplication, type AppConfig } from '../../apps/server/src/app.js';

const webOrigin = 'http://127.0.0.1:3000';
const setupToken = 'client-api-fixture-owner-setup-token';
const internalSecret = 'client-api-fixture-relay-secret-value';
const credentials = (role: 'owner' | 'member') => ({
  name: `Client API ${role}`,
  email: `client-api-${role}@example.test`,
  password: `Client-API-${role}-fixture-86`,
});

export type ClientApiAccount = ReturnType<typeof credentials> & { id: string; cookie: string };
export type ClientApiResponse = {
  statusCode: number;
  body: string;
  json<T = unknown>(): T;
};

export function checkJson<Schema extends z.ZodType>(response: ClientApiResponse, status: number, schema: Schema): z.output<Schema> {
  expect(response.statusCode).toBe(status);
  // Don't include the full response in failures, since some routes deliberately issue credentials.
  return schema.parse(response.json()) as z.output<Schema>;
}

export function checkError(response: ClientApiResponse, status: number, code?: string) {
  const body = checkJson(response, status, PhoneServerErrorReplySchema);
  if (code !== undefined) expect(body.error.code).toBe(code);
  return body.error;
}

export async function openClientApiApp(configOverrides: Partial<AppConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-client-api-'));
  const remove = () => rm(directory, { recursive: true, force: true });
  const application = await createApplication({
    authSecret: 'client-api-fixture-session-secret-value', internalSecret, setupToken, webOrigin,
    production: false, runWorker: false, testRequestLimit: 2000,
    codingAllowedRoots: [directory], codingDataDir: join(directory, 'coding'),
    documentsDir: join(directory, 'documents'), browserProfileDir: join(directory, 'browser'),
    ...configOverrides,
  }).catch(async error => {
    await remove();
    throw error;
  });

  function send(method: HTTPMethods, url: string, actor: ClientApiAccount | 'anonymous' = 'anonymous',
    payload?: object, extraHeaders?: Record<string, string>) {
    return application.app.inject({ method, url, ...(payload !== undefined && { payload }), headers: {
      origin: webOrigin, 'x-mohassan-internal': internalSecret,
      ...(actor !== 'anonymous' && { cookie: actor.cookie }), ...extraHeaders,
    } });
  }

  let nextClient = 1;
  async function signIn(account: ReturnType<typeof credentials>): Promise<ClientApiAccount> {
    const { email, password } = account;
    // Independent client addresses from TEST-NET-2. https://www.rfc-editor.org/rfc/rfc5737.html (retrieved 2026-11-27).
    const response = await send('POST', '/api/auth/sign-in/email', 'anonymous', { email, password },
      { 'x-mohassan-client-ip': `198.51.100.${nextClient++}` });
    const body = checkJson(response, 200, PhoneSignInReplySchema.extend({ user: z.object({ id: z.string().min(1), email: z.email() }) }));
    expect(body.user.email).toBe(email);
    const cookies = [response.headers['set-cookie']].flat();
    expect(cookies.some(value => /;\s*httponly\b/iu.test(value ?? ''))).toBe(true);
    const cookie = cookies.flatMap(value => value ? [value.split(';')[0]!] : []).join('; ');
    return { ...account, cookie, id: body.user.id };
  }

  async function setupOwner() {
    const owner = credentials('owner');
    checkJson(await send('POST', '/api/setup', 'anonymous', { ...owner, setupToken }), 200,
      z.strictObject({ ok: z.literal(true) }));
    return signIn(owner);
  }

  async function inviteMember(owner: ClientApiAccount) {
    const member = credentials('member');
    const invitation = checkJson(await send('POST', '/api/members/invites', owner, { name: member.name, email: member.email }), 200,
      z.strictObject({ id: z.string(), url: z.url(), expiresInDays: z.number().int().positive() }));
    const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get('invite');
    expect(token).toBeTruthy();
    checkJson(await send('POST', '/api/invites/inspect', 'anonymous', { token }), 200,
      z.strictObject({ name: z.literal(member.name), email: z.literal(member.email) }));
    checkJson(await send('POST', '/api/invites/accept', 'anonymous', { token, name: member.name, password: member.password }), 200,
      z.strictObject({ ok: z.literal(true), email: z.literal(member.email) }));
    return signIn(member);
  }

  return {
    application, directory, setupToken, send, setupOwner, inviteMember, signIn,
    async close() {
      try { await application.app.close(); } finally { await remove(); }
    },
  };
}
