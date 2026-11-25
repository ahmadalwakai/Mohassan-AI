import { sql, type Kysely } from 'kysely';

const VERSION = '036_reminders';

export async function migrateReminders(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    const applied = await tx.selectFrom('schema_migrations').select('version').where('version', '=', VERSION).executeTakeFirst();
    if (applied) return;

    await sql`CREATE UNIQUE INDEX chat_conversations_id_owner_idx ON chat_conversations(id, owner_id)`.execute(tx);
    await sql`CREATE TABLE reminders (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      conversation_id text NOT NULL,
      text text NOT NULL,
      due_at timestamptz NOT NULL,
      time_zone text NOT NULL,
      recurrence jsonb,
      status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      delivery_key uuid NOT NULL UNIQUE,
      FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
    )`.execute(tx);
    await sql`CREATE INDEX reminders_user_scheduled_idx ON reminders(user_id, due_at, id) WHERE status = 'scheduled'`.execute(tx);
    await sql`CREATE INDEX reminders_due_idx ON reminders(due_at, id) WHERE status = 'scheduled'`.execute(tx);
    await sql`CREATE INDEX reminders_conversation_idx ON reminders(conversation_id, user_id)`.execute(tx);

    await sql`CREATE TABLE reminder_deliveries (
      delivery_key uuid PRIMARY KEY,
      reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      conversation_id text NOT NULL,
      text text NOT NULL,
      due_at timestamptz NOT NULL,
      time_zone text NOT NULL,
      delivered_at timestamptz NOT NULL,
      late boolean NOT NULL
    )`.execute(tx);
    await sql`CREATE INDEX reminder_deliveries_reminder_idx ON reminder_deliveries(reminder_id)`.execute(tx);
    await sql`CREATE INDEX reminder_deliveries_user_idx ON reminder_deliveries(user_id, delivered_at DESC, delivery_key DESC)`.execute(tx);
    await sql`CREATE TABLE reminder_preferences (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      time_zone text NOT NULL
    )`.execute(tx);

    await tx.insertInto('schema_migrations').values({ version: VERSION }).execute();
  });
}
