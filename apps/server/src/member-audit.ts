import { sql, type Kysely, type Transaction } from 'kysely';
import type { MemberAuditAction, MemberAuditEntry } from '@mohassan/contracts';

export async function recordMemberAudit(
  db: Kysely<any>, entry: { actorId: string | null; targetId: string; action: MemberAuditAction },
): Promise<void> {
  await db.insertInto('workspace_member_audit').values({
    actor_id: entry.actorId, target_id: entry.targetId, action: entry.action,
  }).execute();
}

export async function listMemberAudit(db: Kysely<any>, { beforeId, limit = 50 }: { beforeId?: string; limit?: number } = {}) {
  let query = db.selectFrom('workspace_member_audit')
    .select([sql<string>`id::text`.as('id'), 'actor_id', 'target_id', 'action', 'occurred_at'])
    .orderBy(sql`workspace_member_audit.id`, 'desc').limit(limit + 1);
  if (beforeId !== undefined) query = query.where('workspace_member_audit.id', '<', sql`${beforeId}::bigint`);
  const rows = await query.execute();
  const entries: MemberAuditEntry[] = rows.slice(0, limit).map(row => ({
    id: row.id,
    actorId: row.actor_id,
    targetId: row.target_id,
    action: row.action,
    occurredAt: new Date(row.occurred_at).toISOString(),
  }));
  return { entries, nextBeforeId: rows.length > limit ? entries.at(-1)!.id : null };
}

/** Associates a verified owner with the membership audit triggers for one transaction. */
export function withMemberAuditActor<T>(db: Kysely<any>, actorId: string, operation: (tx: Transaction<any>) => Promise<T>) {
  return db.transaction().execute(async tx => {
    await sql`SELECT set_config('mohassan.member_audit_actor', ${actorId}, true)`.execute(tx);
    return operation(tx);
  });
}

/** Installed by 037 after the membership and audit tables exist. */
export async function installMemberAdministrationAudit(db: Transaction<any>): Promise<void> {
  await sql`CREATE FUNCTION audit_workspace_invite() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO workspace_member_audit (actor_id, target_id, action)
          VALUES (NEW.created_by, NEW.id, 'invite_created');
      ELSE
        IF OLD.consumed_by IS NULL AND NEW.consumed_by IS NOT NULL THEN
          INSERT INTO workspace_member_audit (actor_id, target_id, action)
            VALUES (NEW.consumed_by, NEW.id, 'invite_used');
        END IF;
        IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
          INSERT INTO workspace_member_audit (actor_id, target_id, action)
            VALUES (NULLIF(current_setting('mohassan.member_audit_actor', true), ''), NEW.id, 'invite_revoked');
        END IF;
      END IF;
      RETURN NEW;
    END;
  $$`.execute(db);
  await sql`CREATE TRIGGER workspace_invites_audit AFTER INSERT OR UPDATE OF consumed_by, revoked_at
    ON workspace_invites FOR EACH ROW EXECUTE FUNCTION audit_workspace_invite()`.execute(db);

  await sql`CREATE FUNCTION audit_workspace_member_access() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO workspace_member_audit (actor_id, target_id, action)
        VALUES (NULLIF(current_setting('mohassan.member_audit_actor', true), ''), NEW.user_id,
          CASE WHEN NEW.disabled_at IS NULL THEN 'member_unsuspended' ELSE 'member_suspended' END);
      RETURN NEW;
    END;
  $$`.execute(db);
  await sql`CREATE TRIGGER workspace_members_access_audit AFTER UPDATE OF disabled_at ON workspace_members
    FOR EACH ROW WHEN (NEW.role = 'member' AND (OLD.disabled_at IS NULL) <> (NEW.disabled_at IS NULL))
    EXECUTE FUNCTION audit_workspace_member_access()`.execute(db);
}
