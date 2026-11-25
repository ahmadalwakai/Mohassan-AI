import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { assertMemberFeatureAccess } from './member-deletion.js';
import { IOS_PUSH_MEMBER_ROUTES, registerIosPushRoutes } from './ios-push-routes.js';
import { apnsConfigFromEnv, createApnsSender } from './apns.js';
import { dispatchBackgroundApns } from './background-apns-delivery.js';
import {
  NotificationClaimRequestSchema, NotificationPreferencesSchema, NotificationSyncRequestSchema, PushSubscribeRequestSchema,
  type NotificationClaimResponse, type NotificationPayload, type NotificationSettingsResponse, type PushSubscribeResponse,
  type PushTestResponse, type PushUnsubscribeResponse,
} from '@mohassan/contracts';
import {
  claimNotification, createTestNotification, dispatchBackgroundWebPush, listPushDevices, notificationPreferences, ownsPushNotification, pendingPushNotifications,
  saveNotificationPreferences, sendToPushDevice, subscribePushDevice, syncNotifications,
  unsubscribePushDevice,
} from './notifications-store.js';
import { isBrowserPushSubscription, sendWebPushNotification, webPushConfigFromEnv, type PushSender } from './web-push.js';

const base = '/api/notifications';
const settings = `${base}/settings`, subscribe = `${base}/subscribe`, device = `${base}/devices/:id`;
const sync = `${base}/sync`, test = `${base}/test`, event = `${base}/events/:id`, claim = `${event}/claim`;
export const NOTIFICATION_MEMBER_ROUTES = [
  ...IOS_PUSH_MEMBER_ROUTES,
  `GET ${settings}`, `POST ${settings}`, `POST ${subscribe}`, `DELETE ${device}`, `POST ${sync}`,
  `POST ${test}`, `GET ${event}`, `POST ${claim}`,
];

const pushUnavailable = { error: { code: 'PUSH_UNAVAILABLE', message: 'إرسال الإشعارات إلى الأجهزة غير مهيّأ.' } };

export async function dispatchPushNotifications(db: Kysely<any>, send: PushSender<NotificationPayload>,
  isActive: (userId: string) => Promise<boolean>, now = new Date()) {
  const pending = await pendingPushNotifications(db, now, true);
  await Promise.all([dispatchBackgroundWebPush(db, send, isActive, now), ...pending.map(async ({ user_id: userId, task_id: id }) => {
    if (!await isActive(userId)) return;
    const payload = await claimNotification(db, userId, id, 'push', now);
    if (payload) await sendToPushDevice(db, send, userId, payload);
  })]);
}

export function registerNotificationRoutes(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
  isActive: (userId: string) => Promise<boolean>;
  recoverChatRuns: () => Promise<void>;
}) {
  const { db, owner, isActive, recoverChatRuns } = options;
  registerIosPushRoutes(app, db, owner);
  const config = webPushConfigFromEnv(process.env);
  const send: PushSender | undefined = config ? (subscription, payload) => sendWebPushNotification(config, subscription, payload) : undefined;
  const apns = apnsConfigFromEnv(process.env);
  const sendIos = apns && createApnsSender(apns);
  async function getSettings(userId: string): Promise<NotificationSettingsResponse> {
    const [preferences, devices] = await Promise.all([notificationPreferences(db, userId), listPushDevices(db, userId)]);
    return { preferences, devices, publicKey: config?.publicKey ?? null };
  }
  app.get(settings, async request => getSettings((await owner(request)).id));
  app.post(settings, async request => {
    const { id } = await owner(request);
    await saveNotificationPreferences(db, id, NotificationPreferencesSchema.parse(request.body));
    return getSettings(id);
  });
  app.post(subscribe, async (request, reply) => {
    const { id } = await owner(request);
    const input = PushSubscribeRequestSchema.parse(request.body);
    if (!isBrowserPushSubscription(input)) return reply.code(400).send({ error: { code: 'INVALID_PUSH_SUBSCRIPTION', message: 'اشتراك المتصفح غير صالح.' } });
    if (!send) return reply.code(503).send(pushUnavailable);
    const own = await db.transaction().execute(async tx => {
      await assertMemberFeatureAccess(tx, id);
      return subscribePushDevice(tx as Kysely<any>, id, input);
    });
    if (!own) return reply.code(409).send({ error: { code: 'PUSH_ENDPOINT_IN_USE', message: 'هذا الاشتراك مرتبط بحساب آخر.' } });
    return { device: own } satisfies PushSubscribeResponse;
  });
  app.delete<{ Params: { id: string } }>(device, async request => ({
    removed: await unsubscribePushDevice(db, (await owner(request)).id, z.uuid().parse(request.params.id)),
  } satisfies PushUnsubscribeResponse));
  app.post(sync, async request => syncNotifications(db, (await owner(request)).id, NotificationSyncRequestSchema.parse(request.body)));
  app.post<{ Params: { id: string } }>(claim, async request => {
    const { id } = await owner(request);
    const { tabId, acknowledge } = NotificationClaimRequestSchema.parse(request.body);
    return { notification: await claimNotification(db, id, z.uuid().parse(request.params.id), 'tab', new Date(), tabId, acknowledge) } satisfies NotificationClaimResponse;
  });
  app.get<{ Params: { id: string } }>(event, async (request, reply) => {
    const found = await ownsPushNotification(db, (await owner(request)).id, z.uuid().parse(request.params.id));
    return reply.code(found ? 204 : 404).send();
  });
  app.post(test, { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { id } = await owner(request);
    if (!send) return reply.code(503).send(pushUnavailable);
    const delivered = await sendToPushDevice(db, send, id, await createTestNotification(db, id));
    return { delivered } satisfies PushTestResponse;
  });

  if (send || sendIos) {
    let inFlight: Promise<void> | undefined;
    let recoverAfter = Date.now() + 15_000;
    async function drain() {
      if (send && Date.now() >= recoverAfter) {
        recoverAfter = Date.now() + 15_000;
        await recoverChatRuns().catch(() => { app.log.error('Chat notification recovery could not finish.'); });
      }
      const now = new Date();
      await Promise.all([
        send && dispatchPushNotifications(db, send, isActive, now),
        sendIos && dispatchBackgroundApns(db, sendIos, isActive, now),
      ]);
    }
    function poll() {
      if (inFlight) return;
      inFlight = drain().catch(() => {
        app.log.error('Notification dispatch could not finish.');
      }).finally(() => { inFlight = undefined; });
    }
    let timer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => { timer = setInterval(poll, 2_000); timer.unref(); });
    app.addHook('preClose', async () => { clearInterval(timer); await inFlight; sendIos?.close(); });
  }
}
