import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

/** Acquire before every family/version lock. Lifecycle never takes the quota
 * user-row lock, so import/Forge may safely order user -> lifecycle -> family. */
export async function acquireSkillLifecycleLock(tx: Kysely<any>, ownerId: string): Promise<void> {
  if (!tx.isTransaction) throw new Error('SKILL_LIFECYCLE_TRANSACTION_REQUIRED');
  z.string().min(1).max(200).parse(ownerId);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-lifecycle:${ownerId}`}, 0))`.execute(tx);
}
