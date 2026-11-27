import type { Kysely } from 'kysely';

export function suspendedReminderMemberQuery(db: Kysely<any>) {
  return db.selectFrom('workspace_members as m').select('m.user_id')
    .where('m.disabled_at', 'is not', null)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner as o').select('o.id')
      .whereRef('o.owner_id', '=', 'm.user_id'))));
}

// Read under the account access lock. The audit preserves re-enabling after disabled_at is cleared.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/member-audit.ts (retrieved 2026-11-27)
export async function reminderAccountResumedAfter(db: Kysely<any>, userId: string, after: Date) {
  const resumed = await db.selectFrom('workspace_member_audit as a').select('a.id')
    .where('a.target_id', '=', userId).where('a.action', '=', 'member_unsuspended')
    .where('a.occurred_at', '>', after)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner as o').select('o.id')
      .whereRef('o.owner_id', '=', 'a.target_id'))))
    .limit(1).executeTakeFirst();
  return Boolean(resumed);
}
