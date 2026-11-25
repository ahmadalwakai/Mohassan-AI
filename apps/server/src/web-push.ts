import { createECDH, ECDH } from 'node:crypto';
import { sendNotification, WebPushError, type PushSubscription, type RequestOptions } from 'web-push';
import type { NotificationPayload } from '@mohassan/contracts';

export type VapidDetails = NonNullable<RequestOptions['vapidDetails']>;
export type WebPushPayload = NotificationPayload | (Omit<NotificationPayload, 'kind' | 'conversationId'> & {
  kind: 'reminder_due';
  conversationId: string;
});
export type PushSender<Payload extends WebPushPayload = WebPushPayload> = (
  subscription: PushSubscription, payload: Payload,
) => ReturnType<typeof sendWebPushNotification>;

const curveName = 'prime256v1';
const pushToken = '[A-Za-z0-9._~:%=-]+';
const googlePath = new RegExp(`^/fcm/send/${pushToken}$`);
const mozillaPath = new RegExp(`^/wpush/v[12]/${pushToken}$`);
const applePath = new RegExp(`^/${pushToken}$`);

function decodeKey(value: string | undefined, bytes: number) {
  if (!value || value.length !== Math.ceil(bytes * 4 / 3)) return undefined;
  const key = Buffer.from(value, 'base64url');
  return key.length === bytes && key.toString('base64url') === value ? key : undefined;
}

function validSubject(subject: string) {
  const url = URL.parse(subject);
  if (!url || url.hash || url.username || url.password) return false;
  if (url.protocol === 'mailto:') return !url.search && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.pathname);
  return url.protocol === 'https:' && url.hostname !== 'localhost';
}

export function webPushConfigFromEnv(env: NodeJS.ProcessEnv): VapidDetails | undefined {
  const { WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: privateKey, WEB_PUSH_VAPID_SUBJECT: subject } = env;
  if (!publicKey || !privateKey || !subject || !validSubject(subject)) return undefined;
  const publicBytes = decodeKey(publicKey, 65);
  const privateBytes = decodeKey(privateKey, 32);
  if (!publicBytes || !privateBytes) return undefined;
  try {
    const curve = createECDH(curveName);
    curve.setPrivateKey(privateBytes);
    if (curve.getPublicKey().equals(publicBytes)) return { publicKey, privateKey, subject };
  } catch {
    return undefined;
  }
}

function isBrowserPushEndpoint(endpoint: string) {
  const url = URL.parse(endpoint);
  if (!url || url.protocol !== 'https:' || url.href !== endpoint || url.username || url.password || url.port || url.hash) return false;

  // Subscription URLs are supplied by clients. Restrict outbound POSTs to browser push services.
  if (/^wns[0-9]*-[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname)) {
    return url.pathname === '/w/' && !!url.searchParams.get('token');
  }
  if (url.search) return false;
  if (url.hostname === 'fcm.googleapis.com') return googlePath.test(url.pathname);
  if (url.hostname === 'updates.push.services.mozilla.com') return mozillaPath.test(url.pathname);
  if (url.hostname === 'web.push.apple.com') return applePath.test(url.pathname);
  return false;
}

export function isBrowserPushSubscription(subscription: PushSubscription) {
  if (!isBrowserPushEndpoint(subscription.endpoint) || !decodeKey(subscription.keys.auth, 16)) return false;
  const publicKey = decodeKey(subscription.keys.p256dh, 65);
  if (publicKey?.[0] !== 4) return false;
  try {
    ECDH.convertKey(publicKey, curveName);
    return true;
  } catch {
    return false;
  }
}

export async function sendWebPushNotification(config: VapidDetails, subscription: PushSubscription, payload: WebPushPayload) {
  if (!isBrowserPushSubscription(subscription)) return 'failed';
  try {
    await sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: config,
      contentEncoding: 'aes128gcm',
      TTL: 5 * 60,
      timeout: 5_000,
    });
    return 'delivered';
  } catch (error) {
    if (error instanceof WebPushError && (error.statusCode === 404 || error.statusCode === 410)) return 'expired';
    return 'failed';
  }
}
