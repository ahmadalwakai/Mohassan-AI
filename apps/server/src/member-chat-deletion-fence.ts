import { sql, type Kysely } from 'kysely';
import { memberDeletionPending } from './member-deletion.js';

interface ChatAccountAccess {
  accountActive?: (ownerId: string, tx: Kysely<any>) => Promise<boolean>;
}

export async function withMemberChatDeletionFence<T extends ChatAccountAccess>(db: Kysely<any>, config: T): Promise<T> {
  if (!config.accountActive) return config;
  const { rows } = await sql<{ available: boolean }>`
    SELECT to_regclass('member_deletion_requests') IS NOT NULL AS available
  `.execute(db);
  if (!rows[0]?.available) return config;
  const accountActive = config.accountActive.bind(config);
  // Keep the membership lock taken by the existing check through the deletion-state read.
  return {
    ...config,
    accountActive: async (ownerId: string, tx: Kysely<any>) =>
      await accountActive(ownerId, tx) && !await memberDeletionPending(tx, ownerId),
  };
}
