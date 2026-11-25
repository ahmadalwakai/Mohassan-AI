import { sql, type Kysely } from 'kysely';

export const MONITOR_MIGRATION = '043_smart_monitors';

/** Runs after 042. The rollout controls use of the additive storage. */
export async function migrateMonitors(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', MONITOR_MIGRATION).executeTakeFirst()) return;
    await sql`CREATE TABLE smart_monitors (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      conversation_id text NOT NULL,
      spec jsonb NOT NULL,
      spec_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('proposed', 'active', 'paused', 'stopped', 'completed', 'expired')),
      offer text CHECK (offer IN ('explicit', 'implicit', 'agent-initiated')),
      note text,
      evaluation jsonb,
      source_cache jsonb,
      last_checked_at timestamptz,
      next_check_at timestamptz,
      interval_ms integer NOT NULL CHECK (interval_ms > 0),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      approved_at timestamptz,
      lease_token uuid,
      lease_until timestamptz,
      checks integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
      notifications integer NOT NULL DEFAULT 0 CHECK (notifications >= 0),
      failure_kind text CHECK (failure_kind IN ('missing', 'unreachable')),
      consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      pending_notice jsonb,
      notice_due_at timestamptz,
      FOREIGN KEY (conversation_id, user_id) REFERENCES chat_conversations(id, owner_id) ON DELETE CASCADE,
      CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
      CHECK ((pending_notice IS NULL) = (notice_due_at IS NULL))
    )`.execute(tx);
    await sql`CREATE INDEX smart_monitors_account_idx ON smart_monitors(user_id, created_at DESC, id)`.execute(tx);
    await sql`CREATE INDEX smart_monitors_conversation_idx ON smart_monitors(conversation_id, user_id)`.execute(tx);
    await sql`CREATE INDEX smart_monitors_due_idx ON smart_monitors(next_check_at, id) WHERE status = 'active'`.execute(tx);
    await sql`CREATE INDEX smart_monitors_expiry_idx ON smart_monitors(expires_at, id) WHERE status IN ('proposed', 'active', 'paused')`.execute(tx);
    await sql`CREATE INDEX smart_monitors_notice_idx ON smart_monitors(notice_due_at, id) WHERE pending_notice IS NOT NULL`.execute(tx);
    await sql`CREATE TABLE smart_monitor_budgets (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      budget_day date NOT NULL,
      checks integer NOT NULL DEFAULT 0 CHECK (checks >= 0),
      previews integer NOT NULL DEFAULT 0 CHECK (previews >= 0),
      notifications integer NOT NULL DEFAULT 0 CHECK (notifications >= 0)
    )`.execute(tx);
    await sql`CREATE TABLE smart_monitor_hosts (
      host_key text PRIMARY KEY,
      eligible_at timestamptz NOT NULL
    )`.execute(tx);
    await sql`CREATE INDEX smart_monitor_hosts_expiry_idx ON smart_monitor_hosts(eligible_at)`.execute(tx);
    await sql`ALTER TABLE chat_notifications ADD COLUMN monitor_id uuid REFERENCES smart_monitors(id) ON DELETE CASCADE`.execute(tx);
    await sql`CREATE INDEX chat_notifications_monitor_idx ON chat_notifications(monitor_id) WHERE monitor_id IS NOT NULL`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: MONITOR_MIGRATION }).execute();
  });
}
