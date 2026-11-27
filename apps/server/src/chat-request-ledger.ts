import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type Kysely } from 'kysely';
import { BrowserError } from '@mohassan/browser';

type Claim = { ownerId: string; key: string; createdAt: Date };
const activeRequest = new AsyncLocalStorage<Claim | undefined>();

export function withChatRequest<T>(claim: Claim, work: () => T): T {
  return activeRequest.run(claim, work);
}

export function withoutChatRequestCommit<T>(work: () => T): T {
  return activeRequest.run(undefined, work);
}

function payloadConversationId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  return typeof value.id === 'string' ? value.id : undefined;
}

function hasOwnerOnlyReply(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'messages' in value && Array.isArray(value.messages)
    && value.messages.some(message => message?.experiment === 'v5' || message?.council != null));
}

const marker = (id: string) => JSON.stringify({ replayConversationId: id });

/** Bind the request receipt to the accepted mutation in the same transaction. */
export async function commitChatRequest(tx: Kysely<any>, ownerId: string, conversationId: string) {
  const claim = activeRequest.getStore();
  if (claim?.ownerId !== ownerId) return;
  const changed = await tx.updateTable('chat_request_keys').set({ status: 'done', response: marker(conversationId) })
    .where('owner_id', '=', ownerId).where('request_key', '=', claim.key).where('created_at', '=', claim.createdAt)
    .where('status', '=', 'running').executeTakeFirst();
  if (!changed.numUpdatedRows) throw new BrowserError('CHAT_REQUEST_IN_PROGRESS', 'تغيرت حالة الطلب. تحقّق بعد لحظة.', 409);
}

export async function cacheChatResponse(db: Kysely<any>, claim: Claim, response: unknown, replayFromConversation = false) {
  await db.transaction().execute(async tx => {
    const id = payloadConversationId(response);
    const live = id ? await tx.selectFrom('chat_conversations').select('id').where('owner_id', '=', claim.ownerId)
      .where('id', '=', id).forShare().executeTakeFirst() : null;
    await tx.updateTable('chat_request_keys').set({ status: 'done', response: id && (!live || replayFromConversation || hasOwnerOnlyReply(response)) ? marker(id) : JSON.stringify(response ?? null) })
      .where('owner_id', '=', claim.ownerId).where('request_key', '=', claim.key).where('created_at', '=', claim.createdAt).execute();
  });
}

export async function replayChatResponse<T>(db: Kysely<any>, ownerId: string, raw: unknown, detail: (ownerId: string, id: string) => Promise<unknown>) {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof value === 'object' && value !== null && 'replayConversationId' in value && typeof value.replayConversationId === 'string') {
    return await detail(ownerId, value.replayConversationId) as T;
  }
  const id = payloadConversationId(value);
  if (id && hasOwnerOnlyReply(value)) return await detail(ownerId, id) as T;
  if (id && !await db.selectFrom('chat_conversations').select('id').where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst()) {
    throw new BrowserError('CHAT_NOT_FOUND', 'لم يُعثر على المحادثة.', 404);
  }
  return value as T;
}

/** Keep a replay marker while removing the cached contents with the conversation. */
export async function scrubChatRequestResponses(tx: Kysely<any>, ownerId: string, id: string) {
  await tx.updateTable('chat_request_keys').set({ response: marker(id) }).where('owner_id', '=', ownerId)
    .where(sql<string>`response->>'id'`, '=', id).execute();
}
