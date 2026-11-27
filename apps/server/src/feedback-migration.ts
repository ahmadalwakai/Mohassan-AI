import { sql, type Kysely } from 'kysely';
import { safeFeedbackText } from './feedback-page-key.js';

export const FEEDBACK_LOOP_MIGRATION = '049_feedback_loop';

/** Runs under the command chat migration lock after the chat tables exist. */
export async function migrateFeedbackInTransaction(tx: Kysely<any>) {
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', FEEDBACK_LOOP_MIGRATION).executeTakeFirst()) return;

  await sql`CREATE TABLE chat_feedback_evidence (
    message_id text PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    question_key text NOT NULL CHECK (question_key ~ '^[a-f0-9]{64}$'),
    question text NOT NULL,
    evidence_urls text[] NOT NULL CHECK (cardinality(evidence_urls) > 0)
  )`.execute(tx);
  await sql`CREATE INDEX chat_feedback_evidence_question_idx ON chat_feedback_evidence(question_key)`.execute(tx);
  await sql`CREATE TABLE chat_feedback_reviews (
    message_id text PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    decision text NOT NULL CHECK (decision IN ('pin', 'block', 'dismiss')),
    source_url text,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((decision = 'dismiss') = (source_url IS NULL))
  )`.execute(tx);

  // Earlier versions also captured feedback in chat_events, without filtering free-text notes.
  let cursor = '';
  for (;;) {
    const { rows } = await sql<{ id: string; note: string }>`SELECT id, data->>'note' AS note FROM chat_events
      WHERE kind = 'feedback' AND jsonb_typeof(data->'note') = 'string' AND id > ${cursor}
      ORDER BY id LIMIT 500`.execute(tx);
    if (!rows.length) break;
    const sensitive = rows.filter(row => safeFeedbackText(row.note) === null && row.note !== '').map(row => row.id);
    if (sensitive.length) await tx.updateTable('chat_events').set({ data: sql`jsonb_set(data, '{note}', 'null'::jsonb)` })
      .where('id', 'in', sensitive).execute();
    cursor = rows[rows.length - 1].id;
  }

  await tx.insertInto('schema_migrations').values({ version: FEEDBACK_LOOP_MIGRATION }).execute();
}
