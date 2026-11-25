import { sql, type Transaction } from 'kysely';

export async function migrateFeedback(tx: Transaction<any>): Promise<void> {
  const version = '035_feedback_loop';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;

  await sql`CREATE TABLE chat_feedback_cases (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    message_id text NOT NULL UNIQUE,
    question_key text NOT NULL,
    reply_sha256 text NOT NULL,
    snapshot jsonb NOT NULL,
    verdict text NOT NULL CHECK (verdict IN ('useful', 'wrong', 'incomplete')),
    note text,
    wrong_reported_at timestamptz,
    created_at timestamptz NOT NULL,
    decision text CHECK (decision IN ('correct', 'wrong', 'unsure')),
    reviewed_at timestamptz,
    case_sha256 text,
    training_allowed boolean NOT NULL DEFAULT false,
    CHECK ((decision IS NULL) = (reviewed_at IS NULL)),
    CHECK ((decision IS NULL) = (case_sha256 IS NULL)),
    CHECK (NOT training_allowed OR case_sha256 IS NOT NULL)
  )`.execute(tx);
  await sql`CREATE INDEX chat_feedback_user_queue_idx ON chat_feedback_cases(user_id, created_at DESC, id)`.execute(tx);
  await sql`CREATE INDEX chat_feedback_queue_idx ON chat_feedback_cases(created_at DESC, id)`.execute(tx);
  await sql`CREATE INDEX chat_feedback_wrong_idx ON chat_feedback_cases(question_key)
    WHERE wrong_reported_at IS NOT NULL OR decision = 'wrong'`.execute(tx);

  await sql`CREATE TABLE chat_feedback_regression (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    frozen_case jsonb NOT NULL
  )`.execute(tx);
  await sql`ALTER TABLE chat_feedback_cases ADD FOREIGN KEY (case_sha256) REFERENCES chat_feedback_regression(sha256)`.execute(tx);

  await sql`CREATE TABLE chat_feedback_policies (
    id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES chat_feedback_cases(id),
    question_key text NOT NULL,
    reporter_id text,
    page_url text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('block', 'pin')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    cleared_at timestamptz,
    CHECK (reporter_id IS NULL OR kind = 'block')
  )`.execute(tx);
  await sql`CREATE INDEX chat_feedback_policies_case_idx ON chat_feedback_policies(case_id)`.execute(tx);
  await sql`CREATE INDEX chat_feedback_policies_active_idx ON chat_feedback_policies(question_key, expires_at)
    WHERE cleared_at IS NULL`.execute(tx);

  await sql`CREATE TABLE chat_feedback_audit (
    id text PRIMARY KEY,
    case_id text NOT NULL REFERENCES chat_feedback_cases(id),
    policy_id text REFERENCES chat_feedback_policies(id),
    actor_id text NOT NULL,
    action text NOT NULL CHECK (action IN (
      'submitted', 'reviewed', 'policy_created', 'policy_cleared', 'training_allowed', 'training_revoked'
    )),
    at timestamptz NOT NULL,
    details jsonb NOT NULL
  )`.execute(tx);
  await sql`CREATE INDEX chat_feedback_audit_case_idx ON chat_feedback_audit(case_id, at, id)`.execute(tx);

  await sql`CREATE TABLE chat_feedback_answer_metrics (
    message_id text PRIMARY KEY,
    repeated_wrong boolean NOT NULL
  )`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version }).execute();
}
