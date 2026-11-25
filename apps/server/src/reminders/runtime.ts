import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { sendWebPushNotification, webPushConfigFromEnv } from '../web-push.js';
import { registerReminderChat } from './chat-turn.js';
import { migrateReminders } from './migration.js';
import { registerReminderRoutes } from './routes.js';
import { createReminderScheduler } from './scheduler.js';
import { createReminderStore } from './storage.js';

export async function registerReminderRuntime(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
}) {
  await migrateReminders(options.db);
  const reminders = createReminderStore(options.db);
  registerReminderChat(options.db, reminders);
  registerReminderRoutes(app, { owner: options.owner, reminders });
  const push = webPushConfigFromEnv(process.env);
  const scheduler = createReminderScheduler(options.db, {
    sendPush: push ? (subscription, payload) => sendWebPushNotification(push, subscription, payload) : undefined,
  });
  app.addHook('onReady', async () => { scheduler.start(); });
  app.addHook('preClose', async () => { await scheduler.stop(); });
}
