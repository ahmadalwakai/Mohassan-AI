import { sql, type Kysely } from 'kysely';
import { MemberAuditActionSchema } from '@mohassan/contracts';

const version = '055_member_account_recovery';

export async function migrateMemberAccountRecovery(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;

    await sql`ALTER TABLE workspace_member_audit
      DROP CONSTRAINT workspace_member_audit_action_check,
      ADD CONSTRAINT workspace_member_audit_action_check
        CHECK (action IN (${sql.join(MemberAuditActionSchema.options.map(action => sql.lit(action)))}))`.execute(tx);
    await sql`CREATE TABLE workspace_member_password_resets (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL
    )`.execute(tx);
    await tx.insertInto('schema_migrations').values({ version }).execute();
  });
}
