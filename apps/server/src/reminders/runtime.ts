import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { migrateReminders } from './migration.js';
import { registerReminderRoutes } from './routes.js';
import { createReminderScheduler } from './scheduler.js';
import { createReminderStore } from './storage.js';

export { createReminderStore };

export async function registerReminderRuntime(app: FastifyInstance, options: {
  db: Kysely<any>;
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
  reminders: ReturnType<typeof createReminderStore>;
}) {
  await migrateReminders(options.db);
  await registerReminderRoutes(app, options);
  const scheduler = createReminderScheduler(options.db);
  app.addHook('onReady', async () => { scheduler.start(); });
  app.addHook('preClose', async () => { await scheduler.stop(); });
}
