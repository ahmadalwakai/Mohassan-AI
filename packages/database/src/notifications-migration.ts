import { sql, type Transaction } from 'kysely';

export async function migrateNotifications(tx: Transaction<any>) {
  const version = '037_notifications';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
  const previous = await tx.updateTable('schema_migrations').set({ version })
    .where('version', '=', '035_notifications').returning('version').executeTakeFirst();
  if (previous) {
    await sql`ALTER TABLE chat_notifications DROP CONSTRAINT chat_notifications_kind_check,
      ADD CONSTRAINT chat_notifications_kind_check
      CHECK (kind IN ('task_completed', 'needs_you', 'task_failed', 'reminder_due'))`.execute(tx);
    return;
  }

  await sql`CREATE TABLE notification_preferences (
    user_id text PRIMARY KEY,
    quiet_start text,
    quiet_end text,
    time_zone text,
    hide_title boolean NOT NULL DEFAULT false,
    CHECK (num_nonnulls(quiet_start, quiet_end, time_zone) IN (0, 3))
  )`.execute(tx);
  await sql`CREATE TABLE push_subscriptions (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,
    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
  )`.execute(tx);
  await sql`CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id, created_at)`.execute(tx);
  await sql`CREATE TABLE notification_tabs (
    user_id text NOT NULL,
    tab_id text NOT NULL,
    visible boolean NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, tab_id)
  )`.execute(tx);
  await sql`CREATE TABLE chat_notifications (
    task_id text PRIMARY KEY,
    user_id text NOT NULL,
    conversation_id text,
    kind text NOT NULL CHECK (kind IN ('task_completed', 'needs_you', 'task_failed', 'reminder_due')),
    started_at timestamptz NOT NULL,
    happened_at timestamptz NOT NULL,
    available_at timestamptz NOT NULL,
    delivery text NOT NULL CHECK (delivery IN ('pending', 'tab', 'push', 'suppressed')),
    CHECK (conversation_id IS NOT NULL OR (kind = 'task_completed' AND delivery = 'push'))
  )`.execute(tx);
  await sql`CREATE INDEX chat_notifications_pending_idx ON chat_notifications(user_id, available_at) WHERE delivery = 'pending'`.execute(tx);
  await sql`CREATE INDEX chat_notifications_test_expiry_idx ON chat_notifications(happened_at) WHERE conversation_id IS NULL`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version }).execute();
}
