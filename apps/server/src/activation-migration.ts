import { sql, type Kysely } from 'kysely';

export async function migrateActivationConsole(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    const version = '035_activation_console';
    await sql`LOCK TABLE schema_migrations IN EXCLUSIVE MODE`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;

    await sql`CREATE TABLE activation_reviews (
      actor_id text NOT NULL,
      sample_id text NOT NULL,
      capability_id text NOT NULL,
      label text NOT NULL CHECK (label IN ('better', 'worse', 'same')),
      training_allowed boolean NOT NULL DEFAULT false,
      reviewed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_id, sample_id)
    )`.execute(tx);
    await sql`CREATE INDEX activation_reviews_capability_idx ON activation_reviews(actor_id, capability_id, label)`.execute(tx);
    await sql`CREATE TABLE activation_changes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      capability_id text NOT NULL,
      enabled boolean NOT NULL,
      actor_id text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      reason text NOT NULL CHECK (length(trim(reason)) > 0),
      gate_sha256 text CHECK (gate_sha256 ~ '^[0-9a-f]{64}$'),
      evidence jsonb NOT NULL
    )`.execute(tx);
    await sql`CREATE INDEX activation_changes_capability_idx ON activation_changes(capability_id, id DESC)`.execute(tx);
    await sql`CREATE FUNCTION refuse_activation_history_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Activation history is append-only';
      END;
    $$`.execute(tx);
    await sql`CREATE TRIGGER activation_history_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON activation_changes
      FOR EACH STATEMENT EXECUTE FUNCTION refuse_activation_history_rewrite()`.execute(tx);
    await sql`CREATE TABLE activation_observations (
      id text PRIMARY KEY,
      capability_id text NOT NULL,
      owner_id text,
      created_at timestamptz NOT NULL,
      changed boolean,
      category text,
      latency_ms double precision,
      baseline text,
      shadow text,
      error boolean NOT NULL
    )`.execute(tx);
    await sql`CREATE INDEX activation_observations_time_idx ON activation_observations(created_at)`.execute(tx);
    await sql`CREATE INDEX activation_chat_events_kind_time_idx ON chat_events(kind, created_at DESC, id DESC)`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version }).execute();
  });
}
