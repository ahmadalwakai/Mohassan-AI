import { sql, type Kysely } from 'kysely';

/** The chat table shared by the central reviewer migration and command chat's 013 migration. */
export async function ensureChatConversationsTable(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS chat_conversations (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'idle',
    active_run_id text,
    session_id text,
    question jsonb,
    approval jsonb,
    progress text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
}
