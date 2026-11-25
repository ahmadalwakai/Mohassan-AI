import { sql, type Kysely } from 'kysely';
import { migrateLongRuns } from './assistant/long-run/migration.js';

export const BACKGROUND_RESULTS_MIGRATION = '042_background_results';

export async function migrateBackgroundResults(db: Kysely<any>) {
  await migrateLongRuns(db);
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', BACKGROUND_RESULTS_MIGRATION).executeTakeFirst()) return;
    await sql`CREATE TABLE ios_push_devices (
      registration_id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      registration_generation uuid NOT NULL,
      token text NOT NULL,
      environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
      app_version text NOT NULL,
      registered_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (environment, token)
    )`.execute(tx);
    await sql`CREATE INDEX ios_push_devices_user_idx ON ios_push_devices(user_id)`.execute(tx);
    await sql`ALTER TABLE notification_preferences
      ADD COLUMN completion_sound boolean NOT NULL DEFAULT true,
      ADD COLUMN show_result_preview boolean NOT NULL DEFAULT false`.execute(tx);
    await sql`ALTER TABLE chat_notifications
      ADD COLUMN background_outcome text CHECK (background_outcome IN ('completed', 'approval', 'sign-in', 'payment', 'failed')),
      ADD COLUMN background_language text CHECK (background_language IN ('ar', 'en')),
      ADD COLUMN run_id text REFERENCES chat_runs(id) ON DELETE CASCADE,
      ADD COLUMN result_preview text,
      ADD COLUMN tab_claim_id uuid,
      ADD COLUMN tab_claim_until timestamptz,
      ADD COLUMN web_push_after timestamptz,
      ADD COLUMN web_push_device_id text,
      ADD COLUMN web_push_attempts integer NOT NULL DEFAULT 0 CHECK (web_push_attempts >= 0)`.execute(tx);
    await sql`CREATE TABLE background_apns_deliveries (
      event_id text NOT NULL REFERENCES chat_notifications(task_id) ON DELETE CASCADE,
      registration_id uuid NOT NULL REFERENCES ios_push_devices(registration_id) ON DELETE CASCADE,
      next_at timestamptz NOT NULL,
      delivered_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      PRIMARY KEY (event_id, registration_id)
    )`.execute(tx);
    await sql`CREATE INDEX background_apns_deliveries_due_idx ON background_apns_deliveries(next_at)
      WHERE delivered_at IS NULL`.execute(tx);
    await sql`CREATE INDEX background_apns_deliveries_device_idx ON background_apns_deliveries(registration_id)`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: BACKGROUND_RESULTS_MIGRATION }).execute();
  });
}
