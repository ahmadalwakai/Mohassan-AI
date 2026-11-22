import type { Kysely } from 'kysely';
import { roleOf } from './members.js';

/**
 * HOST ONLY: use the caller's existing transaction, never start another one.
 * A granting row is held FOR SHARE through that transaction's commit, ordering
 * native queue admission against updates/deletion of that particular grant.
 * This does not authorize later companion dispatch or change member chat/memory.
 */
export async function lockOwnerToolAccess(tx: Kysely<any>, ownerId: string): Promise<boolean> {
  // FOR SHARE outside a transaction would release its lock before admission.
  if (!tx.isTransaction) return false;
  const primaryOwner = await tx.selectFrom('workspace_owner').select('owner_id')
    .where('id', '=', 1).where('owner_id', '=', ownerId).forShare().executeTakeFirst();
  if (!primaryOwner) {
    const additionalOwner = await tx.selectFrom('workspace_members').select('user_id')
      .where('user_id', '=', ownerId).where('role', '=', 'owner').where('disabled_at', 'is', null)
      .forShare().executeTakeFirst();
    if (!additionalOwner) return false;
  }
  // Keep canonical owner precedence after locking the row that actually grants
  // it: the primary owner remains owner even with a disabled membership row.
  return await roleOf(tx, ownerId) === 'owner';
}
