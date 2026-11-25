import type { Kysely } from 'kysely';

/** Remove a conversation whose first turn was rejected before it wrote a message. */
export async function cleanRejectedChatCreate<T>(db: Kysely<any>, ownerId: string, id: string, start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    await db.transaction().execute(async tx => {
      const created = await tx.selectFrom('chat_conversations').select('id').where('id', '=', id).where('owner_id', '=', ownerId).forUpdate().executeTakeFirst();
      if (!created) return;
      const started = await tx.selectFrom('chat_messages').select('id').where('conversation_id', '=', id).limit(1).executeTakeFirst();
      if (!started) await tx.deleteFrom('chat_conversations').where('id', '=', id).where('owner_id', '=', ownerId).execute();
    }).catch(() => {});
    throw error;
  }
}
