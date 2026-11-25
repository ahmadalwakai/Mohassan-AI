import { sql, type Kysely } from 'kysely';

export const MONITOR_DECISION_MIGRATION = '046_smart_monitor_decisions';

/** Runs after the v2 conversation control tables, under the monitors schema lock. */
export async function migrateMonitorDecisionsInTransaction(tx: Kysely<any>) {
  const applied = await tx.selectFrom('schema_migrations').select('version')
    .where('version', '=', MONITOR_DECISION_MIGRATION).executeTakeFirst();
  if (applied) return;
  await sql`ALTER TABLE smart_monitor_v2_preferences ADD COLUMN decision_recording boolean NOT NULL DEFAULT false`.execute(tx);
  await sql`CREATE UNIQUE INDEX smart_monitors_id_user_idx ON smart_monitors(id, user_id)`.execute(tx);
  await sql`CREATE TABLE smart_monitor_decisions (
    user_id text NOT NULL,
    monitor_id uuid NOT NULL,
    event_key text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('proposal', 'approved', 'declined', 'stopped_early', 'alert_helpful', 'alert_unhelpful')),
    features jsonb,
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (monitor_id, event_key),
    FOREIGN KEY (monitor_id, user_id) REFERENCES smart_monitors(id, user_id) ON DELETE CASCADE,
    CHECK ((decision = 'proposal') = (event_key = 'proposal')),
    CHECK ((decision = 'proposal') = (features IS NOT NULL))
  )`.execute(tx);
  await sql`CREATE INDEX smart_monitor_decisions_user_idx ON smart_monitor_decisions(user_id, happened_at)`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: MONITOR_DECISION_MIGRATION }).execute();
}
