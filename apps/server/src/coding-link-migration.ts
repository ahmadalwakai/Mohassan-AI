import { sql, type Kysely } from 'kysely';

export const CODING_DEVICE_MIGRATION = '070_coding_device_link';

export async function migrateCodingDeviceLink(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    const applied = await tx.selectFrom('schema_migrations').select('version')
      .where('version', '=', CODING_DEVICE_MIGRATION).executeTakeFirst();
    if (applied) return;

    await sql`ALTER TABLE coding_projects ADD COLUMN location text NOT NULL DEFAULT 'server'
      CHECK (location IN ('server', 'device'))`.execute(tx);
    await sql`CREATE TABLE coding_devices (
      id text PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name text NOT NULL,
      key_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at timestamptz,
      last_seen_at timestamptz,
      protocol_version integer,
      sandbox jsonb
    )`.execute(tx);
    await sql`CREATE UNIQUE INDEX coding_devices_active_owner_idx ON coding_devices(owner_id)
      WHERE revoked_at IS NULL`.execute(tx);
    await sql`CREATE TABLE coding_device_pairings (
      id text PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      code_hash text NOT NULL UNIQUE,
      session_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz
    )`.execute(tx);
    await sql`CREATE INDEX coding_device_pairings_owner_idx ON coding_device_pairings(owner_id)`.execute(tx);
    await sql`CREATE INDEX coding_device_pairings_expiry_idx ON coding_device_pairings(expires_at)`.execute(tx);
    await sql`CREATE TABLE coding_device_nonces (
      device_id text NOT NULL REFERENCES coding_devices(id) ON DELETE CASCADE,
      nonce text NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (device_id, nonce)
    )`.execute(tx);
    await sql`CREATE INDEX coding_device_nonces_expiry_idx ON coding_device_nonces(expires_at)`.execute(tx);
    await sql`CREATE TABLE coding_device_jobs (
      id text PRIMARY KEY,
      device_id text NOT NULL REFERENCES coding_devices(id) ON DELETE CASCADE,
      project_id text REFERENCES coding_projects(id) ON DELETE SET NULL,
      task_id text UNIQUE,
      kind text NOT NULL CHECK (kind IN ('inspect', 'demo', 'check', 'execute', 'verify', 'search', 'imports', 'instructions', 'trackedPaths')),
      status text NOT NULL CHECK (status IN ('queued', 'dispatched', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown')),
      payload jsonb,
      result jsonb,
      progress jsonb NOT NULL DEFAULT '[]',
      result_code text,
      result_message text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deadline_at timestamptz NOT NULL,
      dispatched_at timestamptz,
      finished_at timestamptz,
      cancel_requested_at timestamptz
    )`.execute(tx);
    await sql`CREATE INDEX coding_device_jobs_queue_idx ON coding_device_jobs(device_id, created_at, id)
      WHERE status = 'queued'`.execute(tx);
    await sql`CREATE INDEX coding_device_jobs_deadline_idx ON coding_device_jobs(deadline_at)
      WHERE status IN ('queued', 'dispatched')`.execute(tx);
    await sql`CREATE UNIQUE INDEX coding_device_jobs_in_flight_idx ON coding_device_jobs(device_id)
      WHERE status = 'dispatched'`.execute(tx);
    await sql`CREATE TABLE coding_device_audit (
      id text PRIMARY KEY,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      device_id text,
      job_id text,
      kind text,
      project_id text,
      event text NOT NULL CHECK (event IN ('pairing_created', 'paired', 'revoked', 'dispatch', 'result')),
      outcome_code text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(tx);
    await sql`CREATE INDEX coding_device_audit_owner_idx ON coding_device_audit(owner_id, created_at DESC)`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version: CODING_DEVICE_MIGRATION }).execute();
  });
}
