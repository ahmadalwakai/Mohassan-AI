import { sql, type Kysely } from 'kysely';

/** Runs under the command chat migration's schema lock, after the chat tables exist. */
export async function migrateConversationShares(tx: Kysely<any>) {
  const version = '038_conversation_shares';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;

  await sql`ALTER TABLE chat_messages ADD COLUMN run_id text REFERENCES chat_runs(id) ON DELETE SET NULL`.execute(tx);
  // The identifier is kept for the sharer's list. The snapshot does not read from or depend on live chat rows.
  await sql`CREATE TABLE conversation_shares (
    id text PRIMARY KEY, sharer_id text NOT NULL, conversation_id text NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'), snapshot jsonb NOT NULL,
    shared_at timestamptz NOT NULL, expires_at timestamptz, revoked_at timestamptz
  )`.execute(tx);
  await sql`CREATE INDEX conversation_shares_sharer_idx ON conversation_shares(sharer_id, shared_at DESC, id DESC)
    WHERE revoked_at IS NULL`.execute(tx);
  await sql`CREATE TABLE conversation_share_settings (
    id integer PRIMARY KEY CHECK (id = 1), member_sharing_enabled boolean NOT NULL
  )`.execute(tx);
  await tx.insertInto('conversation_share_settings').values({ id: 1, member_sharing_enabled: true }).execute();
  await tx.insertInto('schema_migrations').values({ version }).execute();
}
