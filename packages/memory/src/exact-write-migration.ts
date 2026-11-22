import { sql, type Kysely } from 'kysely';

/** Applied after the base memory tables; tombstones deliberately have no item FK. */
export async function memoryExactWriteMigration(db: Kysely<any>): Promise<void> {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
    const version = 'memory_exact_writes_v1';
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
    await sql`CREATE TABLE memory_exact_operations (
      owner_id text NOT NULL,
      operation_key text NOT NULL CHECK(operation_key ~ '^[a-f0-9]{64}$'),
      payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
      payload_bytes integer NOT NULL CHECK(payload_bytes > 0 AND payload_bytes <= 16000),
      item_id text NOT NULL,
      root_id text NOT NULL,
      item_version integer NOT NULL CHECK(item_version > 0),
      evidence_id text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(owner_id,operation_key),
      UNIQUE(owner_id,item_id)
    )`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version }).execute();
  });
}
