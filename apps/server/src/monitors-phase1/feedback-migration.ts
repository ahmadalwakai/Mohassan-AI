import { sql, type Kysely } from 'kysely';

export const MONITOR_ALERT_FEEDBACK_MIGRATION = '047_monitor_alert_feedback';

/** Runs under the monitors schema lock. */
export async function migrateMonitorAlertFeedbackInTransaction(tx: Kysely<any>) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', MONITOR_ALERT_FEEDBACK_MIGRATION).executeTakeFirst()) return;
  const legacy = await tx.updateTable('schema_migrations').set({ version: MONITOR_ALERT_FEEDBACK_MIGRATION })
    .where('version', '=', '044_monitor_alert_feedback').returning('version').executeTakeFirst();
  if (legacy) return;

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
}
