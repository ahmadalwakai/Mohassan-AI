import { BrowserError } from '@mohassan/browser';
import { sql, type Kysely, type Transaction } from 'kysely';

export async function removeConversationImages(tx: Transaction<any>, ownerId: string, conversationId: string) {
  // A reused upload keeps its ID in every message, while its row points at the last chat to attach it.
  // Hold a surviving chat's key until commit so its own removal sees the reassigned image.
  await sql`
    UPDATE chat_images AS target
    SET conversation_id = retained.id
    FROM chat_images AS owned
    CROSS JOIN LATERAL (
      SELECT conversation.id
      FROM chat_conversations AS conversation
      CROSS JOIN LATERAL (
        SELECT 1 FROM chat_messages AS message
        WHERE message.conversation_id = conversation.id
          AND message.images @> jsonb_build_array(jsonb_build_object('id', owned.id))
        LIMIT 1
      ) AS reference
      WHERE conversation.owner_id = ${ownerId} AND conversation.id <> ${conversationId}
      ORDER BY conversation.updated_at DESC, conversation.id
      LIMIT 1 FOR KEY SHARE OF conversation
    ) AS retained
    WHERE owned.conversation_id = ${conversationId} AND owned.owner_id = ${ownerId}
      AND target.id = owned.id AND target.conversation_id = ${conversationId}
  `.execute(tx);
  await tx.deleteFrom('chat_images')
    .where('conversation_id', '=', conversationId)
    .where('owner_id', '=', ownerId)
    .execute();
}

export async function attachConversationImages(tx: Transaction<any>, ownerId: string, conversationId: string, imageIds: string[]) {
  const { numUpdatedRows } = await tx.updateTable('chat_images')
    .set({ conversation_id: conversationId, expires_at: null })
    .where('id', 'in', imageIds)
    .where('owner_id', '=', ownerId)
    .executeTakeFirstOrThrow();
  // Expiry can remove an upload while the image reader works outside this transaction.
  if (numUpdatedRows !== BigInt(imageIds.length)) {
    throw new BrowserError('CHAT_IMAGE_MISSING', 'إحدى الصور لم تعد موجودة؛ أعد إرفاقها.', 409);
  }
}

export async function sweepExpiredChatImages(db: Kysely<any>, now: () => Date = () => new Date()) {
  await db.deleteFrom('chat_images')
    .where('expires_at', '<=', now())
    .where('conversation_id', 'is', null)
    .execute();
}
