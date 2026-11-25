import { sql, type Kysely } from 'kysely';
import { LONG_RUN_WORKER } from './state.js';

export const LONG_RUN_MIGRATION = '041_long_run_checkpoints';

export async function migrateLongRuns(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', LONG_RUN_MIGRATION).executeTakeFirst()) return;
    const worker = sql.lit(LONG_RUN_WORKER);
    await sql`CREATE UNIQUE INDEX chat_long_runs_active_owner ON chat_runs(owner_id)
      WHERE worker_id = ${worker} AND status IN ('running', 'waiting_approval', 'waiting_input')`.execute(tx);
    await sql`CREATE INDEX chat_long_runs_due ON chat_runs(((state->'longRun'->>'dueAt')::bigint))
      WHERE worker_id = ${worker} AND status IN ('running', 'waiting_approval', 'waiting_input')`.execute(tx);
    await sql`ALTER TABLE chat_notifications DROP CONSTRAINT chat_notifications_kind_check,
      ADD CONSTRAINT chat_notifications_kind_check
      CHECK (kind IN ('task_completed', 'needs_you', 'task_failed', 'reminder_due', 'task_progress'))`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: LONG_RUN_MIGRATION }).execute();
  });
}
