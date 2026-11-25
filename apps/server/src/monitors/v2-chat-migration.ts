import { sql, type Kysely } from 'kysely';

const migration = '045_smart_monitor_conversation_controls';

export async function migrateMonitorV2ChatTables(tx: Kysely<any>) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', migration).executeTakeFirst()) return;
  await sql`CREATE TABLE IF NOT EXISTS smart_monitor_v2_preferences (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    proactive_offers boolean NOT NULL
  )`.execute(tx);
  await sql`CREATE TABLE IF NOT EXISTS smart_monitor_v2_offers (
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    topic_key text NOT NULL,
    PRIMARY KEY (user_id, conversation_id, topic_key),
    FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
  )`.execute(tx);
  await sql`CREATE TABLE IF NOT EXISTS smart_monitor_v2_actions (
    id uuid PRIMARY KEY,
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    operation jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    resolved boolean NOT NULL DEFAULT false,
    FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE
  )`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS smart_monitor_v2_actions_conversation_idx
    ON smart_monitor_v2_actions(user_id, conversation_id)`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: migration }).execute();
}
