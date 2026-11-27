import type { Kysely } from 'kysely';

/** Include suspended members so they can still download their own discussion records. */
export async function isInvitedMemberAccount(db: Kysely<any>, userId: string): Promise<boolean> {
  return Boolean(await db.selectFrom('workspace_members').select('user_id')
    .where('user_id', '=', userId).where('role', '=', 'member')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner')
      .select('id').where('owner_id', '=', userId))))
    .executeTakeFirst());
}
