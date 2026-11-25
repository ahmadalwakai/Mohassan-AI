import { sql, type Kysely } from 'kysely';

export const MONITOR_ALERT_FEEDBACK_MIGRATION = '044_monitor_alert_feedback';

export async function migrateMonitorAlertFeedback(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', MONITOR_ALERT_FEEDBACK_MIGRATION).executeTakeFirst()) return;

    await sql`CREATE TABLE monitor_alert_feedback (
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      alert_id text NOT NULL REFERENCES chat_notifications(task_id) ON DELETE CASCADE,
      rating text NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
      reason text CHECK (reason IN ('no_meaningful_change', 'late', 'wrong_value')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, alert_id),
      CHECK (reason IS NULL OR rating = 'not_helpful')
    )`.execute(tx);
    await sql`CREATE INDEX monitor_alert_feedback_alert_idx ON monitor_alert_feedback(alert_id)`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: MONITOR_ALERT_FEEDBACK_MIGRATION }).execute();
  });
}
