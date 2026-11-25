import { sql, type Kysely } from 'kysely';

export const MONITOR_VISUAL_BUDGET_MIGRATION = '046_smart_monitor_visual_budget';

export async function migrateMonitorVisualBudget(tx: Kysely<any>) {
  const applied = await tx.selectFrom('schema_migrations').select('version')
    .where('version', '=', MONITOR_VISUAL_BUDGET_MIGRATION).executeTakeFirst();
  if (applied) return;
  await sql`CREATE TABLE smart_monitor_visual_budget (
    budget_key text PRIMARY KEY CHECK (budget_key = 'visual'),
    budget_day date NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0)
  )`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: MONITOR_VISUAL_BUDGET_MIGRATION }).execute();
}
