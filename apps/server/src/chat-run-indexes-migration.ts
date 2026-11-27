import { sql, type Kysely } from 'kysely';
import { BACKGROUND_RESULTS_MIGRATION } from './background-results-migration.js';

/** Runs under the command chat migration's schema lock. */
export async function migrateChatRunIndexes(tx: Kysely<any>) {
  const version = '058_chat_run_indexes';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
  // The first command chat pass creates chat_runs. A later pass sees the notification FK from 042.
  if (!await tx.selectFrom('schema_migrations').select('version')
    .where('version', '=', BACKGROUND_RESULTS_MIGRATION).executeTakeFirst()) return;

  await sql`CREATE INDEX IF NOT EXISTS chat_events_run_idx ON chat_events(run_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_model_receipts_run_idx ON chat_model_receipts(run_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_effect_receipts_run_idx ON chat_effect_receipts(run_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_messages_run_idx ON chat_messages(run_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_notifications_run_idx ON chat_notifications(run_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_observations_conversation_idx ON chat_observations(conversation_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_images_conversation_idx ON chat_images(conversation_id)`.execute(tx);
  await sql`CREATE INDEX IF NOT EXISTS chat_images_expires_idx ON chat_images(expires_at) WHERE expires_at IS NOT NULL`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version }).execute();
}
