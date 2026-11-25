import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import type { NotificationPayload } from '@mohassan/contracts';
import { isBrowserPushSubscription, sendWebPushNotification, webPushConfigFromEnv } from '../apps/server/src/web-push.js';

const config = { ...generateVAPIDKeys(), subject: 'mailto:operations@example.org' };
const keys = { p256dh: generateVAPIDKeys().publicKey, auth: randomBytes(16).toString('base64url') };
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/browser-token', keys };
const payload = {
  kind: 'needs_you', taskId: randomUUID(), conversationId: randomUUID(), conversationTitle: 'إعداد الحساب',
} satisfies NotificationPayload;

afterEach(() => vi.restoreAllMocks());

function interceptPush(statusCode: number) {
  const write = vi.fn();
  const handler = (_options: https.RequestOptions, respond: (response: IncomingMessage) => void) => {
    const response = Object.assign(new EventEmitter(), { statusCode, headers: {} });
    return Object.assign(new EventEmitter(), {
      write,
      end() {
        queueMicrotask(() => {
          respond(response as unknown as IncomingMessage);
          response.emit('end');
        });
      },
    }) as unknown as ClientRequest;
  };
  const request = vi.spyOn(https, 'request').mockImplementation(handler as typeof https.request);
  return { request, write };
}

describe('Web Push delivery', () => {
  it('sends an encrypted RFC Web Push request using the configured VAPID keys', async () => {
    const { request, write } = interceptPush(201);
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('delivered');
    expect(request).toHaveBeenCalledTimes(1);
    const options = request.mock.calls[0][0] as https.RequestOptions;
    expect(options).toMatchObject({
      hostname: 'fcm.googleapis.com',
      path: '/fcm/send/browser-token',
      method: 'POST',
      timeout: 5_000,
      headers: { 'Content-Encoding': 'aes128gcm', TTL: 300, 'Content-Type': 'application/octet-stream' },
    });
    const authorization = (options.headers as OutgoingHttpHeaders | undefined)?.Authorization;
    expect(typeof authorization === 'string' && authorization.startsWith('vapid t=') && authorization.includes(`k=${config.publicKey}`)).toBe(true);
    const body = write.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.includes(Buffer.from(payload.conversationTitle))).toBe(false);
  });

  it.each([404, 410])('marks an HTTP %i subscription expired', async (status) => {
    interceptPush(status);
    await expect(sendWebPushNotification(config, subscription, payload)).resolves.toBe('expired');
  });

  it.each([301, 429, 503])('reports an HTTP %i as a delivery failure after one request', async (status) => {
    const { request } = interceptPush(status);
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
