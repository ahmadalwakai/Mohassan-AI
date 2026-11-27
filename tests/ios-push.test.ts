import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type IncomingHttpHeaders } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IosPushPayload, IosPushRegistration } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.ts';
import { apnsConfigFromEnv, createApnsSender, listApnsDevices, sendToApnsDevice, type ApnsSender } from '../apps/server/src/apns.ts';
import { dispatchBackgroundApns } from '../apps/server/src/background-apns-delivery.ts';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.ts';

const origin = 'http://127.0.0.1:3000';
const secret = 'ios-push-fixture-internal-2026-11-25';
const owner = { name: 'Push owner', email: 'push-owner@example.test', password: 'Test-Push-Owner-45' };
const member = { name: 'Push member', email: 'push-member@example.test', password: 'Test-Push-Member-45' };
const registration = (byte: string, environment: IosPushRegistration['environment']): IosPushRegistration => ({
  platform: 'ios', token: byte.repeat(32), environment, appVersion: '1.0.0',
});
const devices = '/api/push/devices';
const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': secret, cookie });
const cookieOf = (cookies: string | string[] | undefined) => [cookies].flat().filter(Boolean).map(value => value!.split(';')[0]).join('; ');

function pushFixture() {
  const conversationId = randomUUID();
  return {
    aps: { alert: { title: 'Mohassan', body: 'Your task is done.' }, sound: 'mohassan-done.caf', 'thread-id': conversationId },
    conversationId, runId: randomUUID(), kind: 'run-completed',
  } satisfies IosPushPayload;
}

describe('iOS push devices and APNs transport', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie = '', memberCookie = '', ownerId = '', memberId = '';
  const db = () => application.database.db;
  async function login(credentials: typeof owner) {
    // Fastify injections share an IP, so reset the Better Auth rate limit between fixture sign-ins.
    await db().deleteFrom('rateLimit').execute();
    const result = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: credentials });
    expect(result.statusCode, result.body).toBe(200);
    return cookieOf(result.headers['set-cookie']);
  }
  function register(cookie: string, input: IosPushRegistration) {
    return application.app.inject({ method: 'POST', url: devices, headers: headers(cookie), payload: input });
  }
  function remove(cookie: string, token: string) {
    return application.app.inject({ method: 'DELETE', url: `${devices}/${token}`, headers: headers(cookie) });
  }
  function removeRegistration(cookie: string, id: string) {
    return application.app.inject({ method: 'DELETE', url: `${devices}/registrations/${id}`, headers: headers(cookie) });
  }
  function signOut(cookie: string) {
    return application.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: headers(cookie), payload: {} });
  }
  async function addDevice(cookie: string, input: IosPushRegistration) {
    const result = await register(cookie, input);
    expect(result.statusCode, result.body).toBe(204);
    return db().selectFrom('ios_push_devices').selectAll().where('token', '=', input.token)
      .where('environment', '=', input.environment).executeTakeFirstOrThrow();
  }
  async function queueOutcome(userId: string) {
    const id = randomUUID(), conversationId = randomUUID(), now = new Date();
    await db().insertInto('chat_conversations').values({ id: conversationId, owner_id: userId, title: 'APNs session fixture' }).execute();
    await db().insertInto('chat_runs').values({ id, owner_id: userId, conversation_id: conversationId, status: 'completed',
      goal: 'APNs session fixture', lease_token: randomUUID(), lease_expires_at: now }).execute();
    await recordBackgroundRunOutcome(db(), { runId: id, userId, conversationId, startedAt: now,
      outcome: 'completed', language: 'en', preview: 'Private result' }, now);
    const { available_at } = await db().selectFrom('chat_notifications').select('available_at').where('task_id', '=', id).executeTakeFirstOrThrow();
    return { id, ready: new Date(available_at) };
  }
  async function queuedRegistrations(eventId: string) {
    const rows = await db().selectFrom('background_apns_deliveries').select('registration_id')
      .where('event_id', '=', eventId).orderBy('registration_id').execute();
    return rows.map(row => row.registration_id);
  }

  beforeAll(async () => {
    const setupToken = 'ios-push-setup-token-fixture-2026';
    application = await createApplication({ authSecret: 'ios-push-fixture-auth-secret-2026', internalSecret: secret,
      setupToken, webOrigin: origin, production: false, runWorker: false });
    const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } });
    expect(setup.statusCode, setup.body).toBe(200);
    ownerCookie = await login(owner);
    const invite = await application.app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie),
      payload: { name: member.name, email: member.email } });
    expect(invite.statusCode, invite.body).toBe(200);
    const token = new URL(invite.json().url).hash.slice('#invite='.length);
    const accepted = await application.app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(),
      payload: { token, name: member.name, password: member.password } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    memberCookie = await login(member);
    ownerId = (await application.app.inject({ url: '/api/access', headers: headers(ownerCookie) })).json().user.id;
    memberId = (await application.app.inject({ url: '/api/access', headers: headers(memberCookie) })).json().user.id;
  }, 45_000);

  afterAll(async () => { await application?.app.close(); });
  beforeEach(async () => { await db().deleteFrom('ios_push_devices').execute(); });

  it('allows authenticated owners and members to register and remove only their own devices', async () => {
    const own = registration('ab', 'production');
    const other = registration('cd', 'sandbox');
    expect((await register('', own)).statusCode).toBe(401);
    expect((await remove('', own.token)).statusCode).toBe(401);
    expect((await register(ownerCookie, { ...own, token: 'not-hex' })).statusCode).toBe(400);
    expect((await remove(ownerCookie, 'abc')).statusCode).toBe(400);
    const first = await register(ownerCookie, { ...own, token: own.token.toUpperCase() });
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');
    const [original] = await listApnsDevices(db(), ownerId);
    expect((await register(ownerCookie, { ...own, appVersion: '2.0.0' })).statusCode).toBe(204);
    expect((await register(memberCookie, other)).statusCode).toBe(204);
    expect((await register(memberCookie, own)).statusCode).toBe(409);
    expect((await remove(memberCookie, own.token)).statusCode).toBe(204);
    expect(await listApnsDevices(db(), ownerId)).toEqual([expect.objectContaining({
      registration_id: original!.registration_id, token: own.token, app_version: '2.0.0', user_id: ownerId, environment: 'production',
    })]);
    expect(await listApnsDevices(db(), memberId)).toEqual([expect.objectContaining({ token: other.token, user_id: memberId, environment: 'sandbox' })]);
    expect((await remove(ownerCookie, own.token)).statusCode).toBe(204);
    expect((await remove(ownerCookie, own.token)).statusCode).toBe(204);
    expect(await listApnsDevices(db(), ownerId)).toEqual([]);
    expect((await remove(memberCookie, other.token)).statusCode).toBe(204);
  });

  it('caps APNs registrations per account while allowing an existing registration to refresh', async () => {
    const prior = Array.from({ length: 15 }, (_, index) => registration(index.toString(16).padStart(2, '0'), 'sandbox'));
    await db().insertInto('ios_push_devices').values(prior.map(device => ({
      registration_id: randomUUID(), registration_generation: randomUUID(), user_id: memberId, token: device.token,
      environment: device.environment, app_version: device.appVersion,
    }))).execute();
    const own = registration('f3', 'sandbox');
    try {
      const results = await Promise.all([register(memberCookie, registration('f1', 'sandbox')), register(memberCookie, registration('f2', 'sandbox'))]);
      expect(results.map(result => result.statusCode).sort()).toEqual([204, 429]);
      expect((await register(memberCookie, { ...prior[0]!, appVersion: '2.0.0' })).statusCode).toBe(204);
      expect((await register(ownerCookie, own)).statusCode).toBe(204);
      expect(await listApnsDevices(db(), memberId)).toHaveLength(16);
    } finally {
      await db().deleteFrom('ios_push_devices').where('user_id', '=', memberId).execute();
      await remove(ownerCookie, own.token);
    }
  });

  it('sends the exact alert payload and ES256 authentication to the registered environment, and removes invalid tokens', async () => {
    const now = 1_770_000_000_000;
    const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const path = await mkdtemp(join(tmpdir(), 'mohassan-apns-fixture-'));
    const keyPath = join(path, 'mock-key.p8');
    await writeFile(keyPath, keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const env = { APNS_KEY_ID: 'KEY-FIXTURE', APNS_TEAM_ID: 'TEAM-FIXTURE', APNS_KEY_PATH: keyPath, APNS_BUNDLE_ID: 'ai.mohassan.fixture' };
    for (const key of Object.keys(env)) expect(apnsConfigFromEnv({ ...env, [key]: '' })).toBeUndefined();

    const accepted = registration('10', 'production');
    const unregistered = registration('11', 'sandbox');
    const malformed = registration('12', 'production');
    const unavailable = registration('13', 'sandbox');
    for (const input of [accepted, unregistered, malformed, unavailable]) expect((await register(ownerCookie, input)).statusCode).toBe(204);
    const statuses = new Map([
      [accepted.token, { status: 200, reason: '' }],
      [unregistered.token, { status: 410, reason: 'Unregistered' }],
      [malformed.token, { status: 400, reason: 'BadDeviceToken' }],
      [unavailable.token, { status: 503, reason: 'ServiceUnavailable' }],
    ]);
    const requests: Array<{ target: string; headers: IncomingHttpHeaders; payload: IosPushPayload }> = [];
    async function mockApns(target: string) {
      const server = createServer();
      server.on('stream', (stream, incoming) => {
        let received = '';
        stream.setEncoding('utf8');
        stream.on('data', (part: string) => { received += part; });
        stream.on('end', () => {
          requests.push({ target, headers: incoming, payload: JSON.parse(received) });
          const token = (incoming[':path'] ?? '').split('/').at(-1) ?? '';
          const response = statuses.get(token) ?? { status: 404, reason: 'BadPath' };
          stream.respond({ ':status': response.status });
          stream.end(response.reason ? JSON.stringify({ reason: response.reason }) : undefined);
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a mock APNs TCP address');
      return { target, server, origin: `http://127.0.0.1:${address.port}` };
    }
    const production = 'https://api.push.apple.com';
    const sandbox = 'https://api.sandbox.push.apple.com';
    const gateways = await Promise.all([mockApns(production), mockApns(sandbox)]);
    const sender = createApnsSender(apnsConfigFromEnv(env)!, { now: () => now, connect: target => {
      const gateway = gateways.find(mock => mock.target === target);
      if (!gateway) throw new Error('Unexpected APNs host');
      return connect(gateway.origin);
    } });
    try {
      const payload = pushFixture(), deliveryId = randomUUID();
      const expected = new Map([[accepted.token, 'delivered'], [unregistered.token, 'expired'], [malformed.token, 'expired'], [unavailable.token, 'failed']]);
      for (const device of await listApnsDevices(db(), ownerId)) {
        expect(await sendToApnsDevice(db(), sender, device, payload, deliveryId)).toBe(expected.get(device.token));
      }
      expect(requests.filter(request => request.target === sandbox).map(request => request.headers[':path']).sort())
        .toEqual([`/3/device/${unregistered.token}`, `/3/device/${unavailable.token}`]);
      expect(requests.filter(request => request.target === production).map(request => request.headers[':path']).sort())
        .toEqual([`/3/device/${accepted.token}`, `/3/device/${malformed.token}`]);
      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.headers[':path']).toMatch(/^\/3\/device\/[0-9a-f]+$/);
        expect(request.headers[':method']).toBe('POST');
        expect(request.headers['apns-topic']).toBe(env.APNS_BUNDLE_ID);
        expect(request.headers['apns-push-type']).toBe('alert');
        expect(request.headers['apns-collapse-id']).toBe(deliveryId);
        expect(request.payload).toEqual(payload);
        const authorization = String(request.headers.authorization);
        expect(authorization.startsWith('bearer ')).toBe(true);
        const [header, claims, signature] = authorization.slice('bearer '.length).split('.');
        expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'ES256', kid: env.APNS_KEY_ID });
        expect(JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'))).toEqual({ iss: env.APNS_TEAM_ID, iat: now / 1_000 });
        expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature!, 'base64url'))).toBe(true);
      }
      expect((await listApnsDevices(db(), ownerId)).map(device => device.token).sort()).toEqual([accepted.token, unavailable.token]);
    } finally {
      sender.close();
      await Promise.all(gateways.map(({ server }) => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      })));
      await rm(path, { recursive: true, force: true });
      for (const input of [accepted, unregistered, malformed, unavailable]) await remove(ownerCookie, input.token);
    }
  });

  it('keeps a new registration when APNs rejects its earlier generation', async () => {
    const input = registration('ef', 'production');
    expect((await register(ownerCookie, input)).statusCode).toBe(204);
    const [initial] = await listApnsDevices(db(), ownerId);
    await sendToApnsDevice(db(), async () => {
      expect((await register(ownerCookie, { ...input, appVersion: '2.0.0' })).statusCode).toBe(204);
      return 'expired';
    }, initial!, pushFixture(), randomUUID());
    expect(await listApnsDevices(db(), ownerId)).toEqual([expect.objectContaining({ app_version: '2.0.0' })]);
    expect((await remove(ownerCookie, input.token)).statusCode).toBe(204);
  });

  it('removes the devices and queues of other sessions while keeping the current session’s device', async () => {
    const otherCookie = await login(owner);
    const current = await addDevice(ownerCookie, registration('b1', 'sandbox'));
    const other = await addDevice(otherCookie, registration('b2', 'sandbox'));
    const refresh = registration('ba', 'sandbox');
    const beforeRefresh = await addDevice(otherCookie, refresh);
    const refreshed = await addDevice(ownerCookie, refresh);
    const sessions = await application.app.inject({ url: '/api/member-data/sessions', headers: headers(ownerCookie) });
    const currentSession = sessions.json().sessions.find((session: { current: boolean }) => session.current);
    expect(current.session_id).toBe(currentSession.id);
    expect(other.session_id).not.toBe(currentSession.id);
    expect(beforeRefresh.session_id).toBe(other.session_id);
    expect(refreshed).toMatchObject({ registration_id: beforeRefresh.registration_id, session_id: currentSession.id });
    const kept = [current.registration_id, refreshed.registration_id].sort();
    const event = await queueOutcome(ownerId);
    expect(await queuedRegistrations(event.id)).toEqual([...kept, other.registration_id].sort());

    const ended = await application.app.inject({ method: 'DELETE', url: '/api/member-data/sessions', headers: headers(ownerCookie) });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await listApnsDevices(db(), ownerId)).map(device => device.registration_id).sort()).toEqual(kept);
    expect(await queuedRegistrations(event.id)).toEqual(kept);
  });

  it('removes a signed-out phone and its queue and lets another account register its token', async () => {
    const phone = await login(owner);
    const input = registration('b3', 'production');
    const device = await addDevice(phone, input);
    const event = await queueOutcome(ownerId);
    expect(await queuedRegistrations(event.id)).toEqual([device.registration_id]);

    const signedOut = await signOut(phone);
    expect(signedOut.statusCode, signedOut.body).toBe(200);
    expect(await listApnsDevices(db(), ownerId)).toEqual([]);
    expect(await queuedRegistrations(event.id)).toEqual([]);
    expect((await addDevice(memberCookie, input)).user_id).toBe(memberId);
  });

  it('skips an expired session for new and queued alerts and allows its token to change accounts', async () => {
    const phone = await login(owner);
    const input = registration('b4', 'production');
    const device = await addDevice(phone, input);
    const conflict = await register(memberCookie, input);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('PUSH_DEVICE_IN_USE');
    const queued = await queueOutcome(ownerId);
    expect(await queuedRegistrations(queued.id)).toEqual([device.registration_id]);
    await db().updateTable('session').set({ expiresAt: new Date(Date.now() - 1) }).where('id', '=', device.session_id).execute();
    expect(await queuedRegistrations(queued.id)).toEqual([device.registration_id]);
    const afterExpiry = await queueOutcome(ownerId);
    expect(await queuedRegistrations(afterExpiry.id)).toEqual([]);
    const transport = vi.fn<ApnsSender>(async () => 'delivered');
    await dispatchBackgroundApns(db(), transport, async () => true, afterExpiry.ready);
    expect(transport).not.toHaveBeenCalled();

    const claimed = await addDevice(memberCookie, input);
    expect(claimed.user_id).toBe(memberId);
    expect(claimed.session_id).not.toBe(device.session_id);
    expect(await listApnsDevices(db(), ownerId)).toEqual([]);
    expect(await queuedRegistrations(queued.id)).toEqual([]);
    const next = await queueOutcome(memberId);
    await dispatchBackgroundApns(db(), transport, async () => true, next.ready);
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user_id: memberId }), expect.anything(), next.id);
  });

  it('keeps a legacy registration eligible for delivery until its account registers it with a session', async () => {
    const input = registration('b5', 'production');
    const id = randomUUID();
    await db().insertInto('ios_push_devices').values({ registration_id: id, registration_generation: randomUUID(), user_id: ownerId,
      token: input.token, environment: input.environment, app_version: input.appVersion }).execute();
    expect((await register(memberCookie, input)).statusCode).toBe(409);
    const event = await queueOutcome(ownerId);
    expect(await queuedRegistrations(event.id)).toEqual([id]);
    const transport = vi.fn<ApnsSender>(async () => 'delivered');
    await dispatchBackgroundApns(db(), transport, async () => true, event.ready);
    expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ registration_id: id, session_id: null }), expect.anything(), event.id);

    const phone = await login(owner);
    const rebound = await addDevice(phone, input);
    expect(rebound.registration_id).toBe(id);
    expect(rebound.session_id).toEqual(expect.any(String));
    const signedOut = await signOut(phone);
    expect(signedOut.statusCode, signedOut.body).toBe(200);
    expect(await listApnsDevices(db(), ownerId)).toEqual([]);
    expect(await queuedRegistrations(event.id)).toEqual([]);
  });

  it('lists each account’s iPhones without tokens and removes only its own registration by ID', async () => {
    const ownerPhone = await addDevice(ownerCookie, registration('b6', 'production'));
    const memberPhone = await addDevice(memberCookie, registration('b7', 'sandbox'));
    const settings = (cookie: string) => application.app.inject({ url: '/api/notifications/settings', headers: headers(cookie) });
    const before = await settings(ownerCookie);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().iosDevices).toEqual([{ id: ownerPhone.registration_id, label: expect.stringContaining('iPhone'),
      registeredAt: new Date(ownerPhone.registered_at).toISOString(), lastDeliveryAt: null }]);
    expect(before.body).not.toContain(ownerPhone.token);
    expect((await settings(memberCookie)).json().iosDevices).toEqual([{ id: memberPhone.registration_id, label: expect.stringContaining('iPhone'),
      registeredAt: new Date(memberPhone.registered_at).toISOString(), lastDeliveryAt: null }]);

    const event = await queueOutcome(memberId);
    await dispatchBackgroundApns(db(), async () => 'delivered', async () => true, event.ready);
    expect((await settings(memberCookie)).json().iosDevices[0].lastDeliveryAt).toBe(event.ready.toISOString());
    expect((await removeRegistration('', memberPhone.registration_id)).statusCode).toBe(401);
    expect((await removeRegistration(memberCookie, 'not-a-uuid')).statusCode).toBe(400);
    expect((await removeRegistration(ownerCookie, memberPhone.registration_id)).json()).toEqual({ removed: false });
    expect((await removeRegistration(memberCookie, ownerPhone.registration_id)).json()).toEqual({ removed: false });
    expect((await removeRegistration(memberCookie, memberPhone.registration_id)).json()).toEqual({ removed: true });
    expect((await removeRegistration(memberCookie, memberPhone.registration_id)).json()).toEqual({ removed: false });
    expect((await settings(memberCookie)).json().iosDevices).toEqual([]);
    expect((await settings(ownerCookie)).json().iosDevices).toEqual(before.json().iosDevices);
    expect(await queuedRegistrations(event.id)).toEqual([]);
  });

  it('removes a member’s device and queued deliveries when the owner ends their sessions', async () => {
    const device = await addDevice(memberCookie, registration('b8', 'sandbox'));
    const event = await queueOutcome(memberId);
    expect(await queuedRegistrations(event.id)).toEqual([device.registration_id]);

    const ended = await application.app.inject({ method: 'DELETE', url: `/api/members/${memberId}/sessions`, headers: headers(ownerCookie) });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(await listApnsDevices(db(), memberId)).toEqual([]);
    expect(await queuedRegistrations(event.id)).toEqual([]);
    memberCookie = await login(member);
  });

  it('removes a suspended member’s device and queued deliveries', async () => {
    const device = await addDevice(memberCookie, registration('b9', 'sandbox'));
    const event = await queueOutcome(memberId);
    expect(await queuedRegistrations(event.id)).toEqual([device.registration_id]);
    const access = (enabled: boolean) => application.app.inject({ method: 'POST', url: `/api/members/${memberId}/access`,
      headers: headers(ownerCookie), payload: { enabled } });

    const suspended = await access(false);
    expect(suspended.statusCode, suspended.body).toBe(200);
    try {
      expect(await listApnsDevices(db(), memberId)).toEqual([]);
      expect(await queuedRegistrations(event.id)).toEqual([]);
    } finally {
      expect((await access(true)).statusCode).toBe(200);
      memberCookie = await login(member);
    }
  });
});
