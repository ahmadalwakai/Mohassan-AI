import { sql, type Kysely } from 'kysely';

export async function migrateStructuredMemory(db: Kysely<any>): Promise<void> {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021107)`.execute(tx);
    const version = '036_structured_memory';
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
    // The standalone structured-memory branch used 035 for this same schema.
    const previous = await tx.updateTable('schema_migrations').set({ version })
      .where('version', '=', '035_structured_memory').returning('version').executeTakeFirst();
    if (previous) return;
    await sql`CREATE TABLE memory_structured_versions (
      item_id text PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      conversation_id text NOT NULL,
      subject text NOT NULL,
      property text NOT NULL,
      value text NOT NULL,
      valid_since text,
      valid_until text
    )`.execute(tx);
    await sql`CREATE INDEX memory_structured_target_idx ON memory_structured_versions(owner_id,subject,property)`.execute(tx);
    await sql`CREATE INDEX memory_structured_conversation_idx ON memory_structured_versions(owner_id,conversation_id)`.execute(tx);
    await sql`CREATE TABLE memory_structured_operations (
      owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      run_id text NOT NULL,
      conversation_id text NOT NULL,
      intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
      outcome text NOT NULL CHECK(outcome IN ('saved','unchanged','forgotten','missing','ambiguous')),
      item_id text REFERENCES memory_items(id) ON DELETE SET NULL,
      PRIMARY KEY(owner_id,run_id)
    )`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version }).execute();
  });
}
