import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import type { NotificationPayload } from '@mohassan/contracts';
import { isBrowserPushSubscription, sendWebPushNotification, webPushConfigFromEnv } from '../apps/server/src/web-push.js';

const config = { ...generateVAPIDKeys(), subject: 'mailto:operations@example.org' };
const keys = { p256dh: generateVAPIDKeys().publicKey, auth: randomBytes(16).toString('base64url') };
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/browser-token', keys };
const payload = {
  kind: 'needs_you', taskId: randomUUID(), conversationId: randomUUID(), conversationTitle: 'إعداد الحساب',
} satisfies NotificationPayload;

const resolvePushHost = vi.hoisted(() => vi.fn<() => Promise<LookupAddress[]>>());
vi.mock('node:dns/promises', () => ({ lookup: resolvePushHost }));

beforeEach(() => {
  resolvePushHost.mockReset().mockResolvedValue([{ address: '142.250.190.74', family: 4 }]);
});
afterEach(() => vi.restoreAllMocks());

function interceptPush(statusCode: number, headers = {}) {
  const write = vi.fn();
  const handler = (_input: URL | https.RequestOptions, options: https.RequestOptions | ((response: IncomingMessage) => void),
    callback?: (response: IncomingMessage) => void) => {
    const respond = typeof options === 'function' ? options : callback!;
    const response = Object.assign(new EventEmitter(), { statusCode, headers });
    const client = Object.assign(new EventEmitter(), {
      write, destroy: vi.fn(),
      end(body?: Buffer) {
        if (body) write(body);
        queueMicrotask(() => {
          respond(response as unknown as IncomingMessage);
          response.emit('end');
          client.emit('close');
        });
      },
    }) as unknown as ClientRequest;
    return client;
  };
  const request = vi.spyOn(https, 'request').mockImplementation(handler as typeof https.request);
  return { request, write };
}

describe('Web Push delivery', () => {
  it('sends an encrypted RFC Web Push request using the configured VAPID keys', async () => {
    const { request, write } = interceptPush(201);
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('delivered');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0] as unknown as [URL, https.RequestOptions];
    expect(url.href).toBe(subscription.endpoint);
    expect(options).toMatchObject({
      method: 'POST',
      agent: false,
      headers: { 'content-encoding': 'aes128gcm', ttl: '300', 'content-type': 'application/octet-stream' },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const pinnedLookup = vi.fn();
    options.lookup?.('fcm.googleapis.com', { all: false }, pinnedLookup);
    expect(pinnedLookup).toHaveBeenCalledExactlyOnceWith(null, '142.250.190.74', 4);
    const authorization = (options.headers as OutgoingHttpHeaders | undefined)?.authorization;
    expect(typeof authorization === 'string' && authorization.startsWith('vapid t=') && authorization.includes(`k=${config.publicKey}`)).toBe(true);
    const body = write.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.includes(Buffer.from(payload.conversationTitle))).toBe(false);
  });

  it('rejects a subscription whose provider has no usable public DNS result before connecting', async () => {
    resolvePushHost.mockResolvedValueOnce([]);
    const { request } = interceptPush(201);
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([404, 410])('marks an HTTP %i subscription expired', async (status) => {
    interceptPush(status);
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('expired');
  });

  it.each([301, 429, 503])('reports an HTTP %i as a delivery failure after one request', async (status) => {
    const { request } = interceptPush(status, { location: 'https://fcm.googleapis.com/fcm/send/redirect-target' });
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('failed');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/token:registration',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/token',
    'https://wns2-par02p.notify.windows.com/w/?token=browser-token',
  ])('accepts subscriptions belonging to known browser push services (%s)', (endpoint) => {
    expect(isBrowserPushSubscription({ endpoint, keys })).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/token',
    'https://fcm.googleapis.com:8443/fcm/send/token',
    'https://fcm.googleapis.com@127.0.0.1/fcm/send/token',
    'https://fcm.googleapis.com.example.org/fcm/send/token',
    'https://fcm.googleapis.com/api/other',
  ])('rejects a non-push destination before sending (%s)', async (endpoint) => {
    const { request } = interceptPush(201);
    await expect(sendWebPushNotification(config, { endpoint, keys }, payload)).resolves.toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects malformed key material before sending', () => {
    expect(isBrowserPushSubscription({ ...subscription, keys: { ...keys, auth: 'bad' } })).toBe(false);
    const invalidPoint = Buffer.alloc(65);
    invalidPoint[0] = 4;
    expect(isBrowserPushSubscription({ ...subscription, keys: { ...keys, p256dh: invalidPoint.toString('base64url') } })).toBe(false);
  });
});

describe('Web Push keys', () => {
  it('loads a complete matching pair and rejects partial, mismatched or invalid settings', () => {
    const env = {
      WEB_PUSH_VAPID_SUBJECT: config.subject,
      WEB_PUSH_VAPID_PUBLIC_KEY: config.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: config.privateKey,
    };
    expect(!!webPushConfigFromEnv(env)).toBe(true);
    expect(webPushConfigFromEnv({})).toBeUndefined();
    expect(webPushConfigFromEnv({ ...env, WEB_PUSH_VAPID_SUBJECT: 'https://localhost' })).toBeUndefined();
    expect(webPushConfigFromEnv({ ...env, WEB_PUSH_VAPID_PUBLIC_KEY: generateVAPIDKeys().publicKey })).toBeUndefined();
  });

  it('writes keys privately without overwriting an existing file or printing the keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mohassan-vapid-test-'));
    const file = join(directory, '.env');
    const command = ['apps/server/scripts/generate-vapid-keys.mjs', file];
    try {
      const stdout = execFileSync(process.execPath, command, { encoding: 'utf8' });
      const written = readFileSync(file, 'utf8');
      const env = parseEnv(written);
      expect(!!webPushConfigFromEnv({ ...env, WEB_PUSH_VAPID_SUBJECT: config.subject })).toBe(true);
      expect([env.WEB_PUSH_VAPID_PRIVATE_KEY, env.WEB_PUSH_VAPID_PUBLIC_KEY].some(key => key && stdout.includes(key))).toBe(false);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(spawnSync(process.execPath, command).status).toBe(1);
      expect(readFileSync(file, 'utf8') === written).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
