import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, constants, sensitiveHeaders, type ClientHttp2Session } from 'node:http2';
import type { Kysely } from 'kysely';
import type { IosPushEnvironment, IosPushPayload } from '@mohassan/contracts';
import { currentApnsDevice, expireIosPushDevice, lockLiveApnsSession, type IosPushDevice } from './ios-push-devices.js';

export { currentApnsDevice, listApnsDevices } from './ios-push-devices.js';
export type { IosPushDevice } from './ios-push-devices.js';

const origins: Record<IosPushEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
const refreshAfterMs = 45 * 60_000;
const requestTimeoutMs = 8_000;

interface ApnsConfig { keyId: string; teamId: string; keyPath: string; bundleId: string }
export type ApnsResponse = 'delivered' | 'expired' | 'failed';
export type ApnsSender = (device: Pick<IosPushDevice, 'token' | 'environment'>,
  payload: IosPushPayload, deliveryId: string) => Promise<ApnsResponse>;

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv): ApnsConfig | undefined {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const keyPath = env.APNS_KEY_PATH?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  if (keyId && teamId && keyPath && bundleId) return { keyId, teamId, keyPath, bundleId };
}

function providerToken(config: ApnsConfig, now: () => number) {
  let cached: { created: number; token: Promise<string> } | undefined;
  return () => {
    const created = now();
    if (cached && created >= cached.created && created - cached.created < refreshAfterMs) return cached.token;
    const token = readFile(config.keyPath).then(contents => {
      const key = createPrivateKey(contents);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('Invalid APNs signing key');
      }
      const base64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = base64({ alg: 'ES256', kid: config.keyId });
      const claims = base64({ iss: config.teamId, iat: Math.floor(created / 1_000) });
      const input = `${header}.${claims}`;
      const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
      return `${input}.${signature.toString('base64url')}`;
    }).catch((error: unknown) => {
      if (cached?.token === token) cached = undefined;
      throw error;
    });
    cached = { created, token };
    return token;
  };
}

function responseOutcome(status: number, body: string): ApnsResponse {
  if (status === 200) return 'delivered';
  if (status === 410) return 'expired';
  if (status === 400) {
    try {
      const reason: unknown = JSON.parse(body)?.reason;
      if (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') return 'expired';
    } catch { /* A malformed response cannot identify an invalid device. */ }
  }
  return 'failed';
}

function sendRequest(client: ClientHttp2Session, device: Parameters<ApnsSender>[0], config: ApnsConfig,
  bearer: string, payload: string, deliveryId: string) {
  return new Promise<ApnsResponse>(resolve => {
    const stream = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.token}`,
      'authorization': `bearer ${bearer}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': deliveryId,
      'content-type': 'application/json',
      [sensitiveHeaders]: ['authorization'],
    });
    let status = 0;
    let body = '';
    const timer = setTimeout(() => {
      finish('failed');
      stream.close(constants.NGHTTP2_CANCEL);
    }, requestTimeoutMs);
    timer.unref();
    function finish(outcome: ApnsResponse) {
      clearTimeout(timer);
      resolve(outcome);
    }
    stream.once('response', headers => { status = Number(headers[':status']); });
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { if (body.length < 1_024) body += chunk.slice(0, 1_024 - body.length); });
    stream.once('end', () => finish(responseOutcome(status, body)));
    stream.once('error', () => finish('failed'));
    stream.once('close', () => finish('failed'));
    stream.end(payload);
  });
}

export function createApnsSender(config: ApnsConfig, options: {
  connect?: (origin: string) => ClientHttp2Session; now?: () => number;
} = {}): ApnsSender & { close: () => void } {
  const connectTo = options.connect ?? connect;
  const getBearer = providerToken(config, options.now ?? Date.now);
  const sessions = new Map<IosPushEnvironment, ClientHttp2Session>();
  let closed = false;

  function sessionFor(environment: IosPushEnvironment) {
    const active = sessions.get(environment);
    if (active && !active.closed && !active.destroyed) return active;
    const client = connectTo(origins[environment]);
    sessions.set(environment, client);
    const detach = () => { if (sessions.get(environment) === client) sessions.delete(environment); };
    client.on('error', detach);
    client.once('close', detach);
    client.once('goaway', () => { detach(); client.close(); });
    client.setTimeout(60_000, () => client.close());
    return client;
  }

  const send: ApnsSender = async (device, payload, deliveryId) => {
    try {
      const bearer = await getBearer();
      if (closed) return 'failed';
      const json = JSON.stringify(payload);
      if (Buffer.byteLength(json) > 4_096) return 'failed';
      return await sendRequest(sessionFor(device.environment), device, config, bearer, json, deliveryId);
    } catch {
      return 'failed';
    }
  };
  return Object.assign(send, { close: () => {
    closed = true;
    for (const client of sessions.values()) client.destroy();
    sessions.clear();
  } });
}

export async function sendToApnsDevice(db: Kysely<any>, send: ApnsSender, device: IosPushDevice,
  payload: IosPushPayload, deliveryId: string) {
  const registered = await currentApnsDevice(db, device.user_id, device.registration_id);
  if (!registered || !await lockLiveApnsSession(db, registered)) return 'expired';
  const result = await send(registered, payload, deliveryId);
  if (result === 'expired') await expireIosPushDevice(db, registered);
  return result;
}
