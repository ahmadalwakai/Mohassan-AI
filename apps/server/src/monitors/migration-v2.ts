import { sql, type Kysely } from 'kysely';

import { migrateMonitorV2ChatTables } from './v2-chat-migration.js';

export const MONITOR_V2_MIGRATION = '044_smart_monitors_v2';

export async function migrateMonitorsV2InTransaction(tx: Kysely<any>) {
  const applied = await tx.selectFrom('schema_migrations').select('version')
    .where('version', '=', MONITOR_V2_MIGRATION).executeTakeFirst();
  if (applied) return;
  await sql`ALTER TABLE smart_monitors ADD COLUMN v2_state jsonb, ADD COLUMN v2_digest_due_at timestamptz`.execute(tx);
  await sql`CREATE INDEX smart_monitors_v2_digest_idx ON smart_monitors(v2_digest_due_at, id)
    WHERE v2_digest_due_at IS NOT NULL`.execute(tx);
  await migrateMonitorV2ChatTables(tx);
  await tx.insertInto('schema_migrations').values({ version: MONITOR_V2_MIGRATION }).execute();
}
