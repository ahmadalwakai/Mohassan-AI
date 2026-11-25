import { sql, type Kysely } from 'kysely';
import { MemberAuditActionSchema } from '@mohassan/contracts';
import { installMemberAdministrationAudit } from './member-audit.js';

const version = '037_member_data_rights';

/** Server migration: auth and workspace membership must already be installed. */
export async function migrateMemberDataRights(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;

    await sql`CREATE TABLE member_deletion_requests (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      requested_at timestamptz NOT NULL,
      purge_after timestamptz NOT NULL CHECK (purge_after > requested_at),
      started_at timestamptz
    )`.execute(tx);
    await sql`CREATE INDEX member_deletion_due_idx ON member_deletion_requests (purge_after, user_id)`.execute(tx);
    await sql`CREATE TABLE member_data_exports (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      requested_at timestamptz NOT NULL
    )`.execute(tx);
    await sql`CREATE TABLE workspace_member_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id text,
      target_id text NOT NULL,
      action text NOT NULL CHECK (action IN (${sql.join(MemberAuditActionSchema.options.map(action => sql.lit(action)))})),
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`.execute(tx);
    await sql`CREATE FUNCTION reject_workspace_member_audit_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Member audit is append only'; END; $$`.execute(tx);
    await sql`CREATE TRIGGER workspace_member_audit_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON workspace_member_audit
      FOR EACH STATEMENT EXECUTE FUNCTION reject_workspace_member_audit_mutation()`.execute(tx);

    await sql`CREATE FUNCTION guard_member_deletion_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        -- Serialize session creation with scheduling and starting the purge.
        PERFORM 1 FROM "user" WHERE id = NEW."userId" FOR KEY SHARE;
        IF EXISTS (SELECT 1 FROM member_deletion_requests AS d
          JOIN workspace_members AS m ON m.user_id = d.user_id AND m.role = 'member'
          WHERE d.user_id = NEW."userId" AND (started_at IS NOT NULL OR purge_after <= clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM workspace_owner WHERE owner_id = NEW."userId")) THEN
          RAISE EXCEPTION 'Member account deletion is due' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$`.execute(tx);
    await sql`CREATE TRIGGER guard_member_deletion_session_insert BEFORE INSERT ON session
      FOR EACH ROW EXECUTE FUNCTION guard_member_deletion_session_insert()`.execute(tx);

    await installMemberAdministrationAudit(tx);
    await tx.insertInto('schema_migrations').values({ version }).execute();
  });
}
