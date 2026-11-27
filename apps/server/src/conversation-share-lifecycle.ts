import { sql, type Kysely } from 'kysely';

// Ended links keep their metadata. The snapshot column is JSONB NOT NULL.
export const emptyConversationShareSnapshot = sql`'{}'::jsonb`;

export async function clearEndedConversationShareSnapshots(db: Kysely<any>, at?: Date) {
  await db.updateTable('conversation_shares').set({ snapshot: emptyConversationShareSnapshot })
    .where(eb => eb.or([
      eb('revoked_at', 'is not', null),
      eb('expires_at', '<=', at ?? sql<Date>`statement_timestamp()`),
    ]))
    .where('snapshot', '!=', emptyConversationShareSnapshot).execute();
}

export async function revokeMemberConversationShares(db: Kysely<any>, userId: string, revokedAt: Date) {
  await db.updateTable('conversation_shares')
    .set({ revoked_at: sql<Date>`COALESCE(revoked_at, ${revokedAt})`, snapshot: emptyConversationShareSnapshot })
    .where('sharer_id', '=', userId)
    .where(eb => eb.or([eb('revoked_at', 'is', null), eb('snapshot', '!=', emptyConversationShareSnapshot)]))
    .execute();
}
