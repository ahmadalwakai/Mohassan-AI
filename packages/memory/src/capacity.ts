import type { Kysely } from 'kysely';
import { MemoryError } from './errors.ts';

// Preserve the existing per-owner limit for user saves and give automatic outcomes
// a separate budget of the same size. Retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/memory/src/index.ts#L54-L61
export const MAX_LIVE_USER_MEMORY_VERSIONS = 2_000;
export const MAX_AUTOMATIC_TASK_OUTCOMES = MAX_LIVE_USER_MEMORY_VERSIONS;

/** Check for one new live version while holding the owner's write lock. */
export async function assertLiveUserMemoryCapacity(tx: Kysely<any>, ownerId: string, now: Date): Promise<void> {
  const count = await tx.selectFrom('memory_items').select(eb => eb.fn.countAll().as('n'))
    .where('owner_id', '=', ownerId).where('confidence_kind', '=', 'user_asserted')
    .where('status', '=', 'active').where('expires_at', '>', now).executeTakeFirstOrThrow();
  if (Number(count.n) >= MAX_LIVE_USER_MEMORY_VERSIONS) {
    throw new MemoryError('MEMORY_LIMIT', 'بلغت الذاكرة حد ألفي إصدار محفوظ.', 409);
  }
}

/** Prune expired automatic items and count remaining space under the owner's write lock. */
export async function pruneExpiredTaskOutcomes(tx: Kysely<any>, ownerId: string, now: Date): Promise<number> {
  // Outcome evidence can still be cited by user items and retains the task sync key.
  await tx.deleteFrom('memory_items').where('owner_id', '=', ownerId)
    .where('confidence_kind', '=', 'task_observed').where('expires_at', '<=', now).execute();
  const count = await tx.selectFrom('memory_items').select(eb => eb.fn.countAll().as('n'))
    .where('owner_id', '=', ownerId).where('confidence_kind', '=', 'task_observed').executeTakeFirstOrThrow();
  return Math.max(0, MAX_AUTOMATIC_TASK_OUTCOMES - Number(count.n));
}
