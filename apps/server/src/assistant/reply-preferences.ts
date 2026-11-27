import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { mergeReplyConstraints, parseReplyRequest, type ReplyConstraints, type ReplyPreferences, type ReplyPreferencePatch, type ReplyRequest } from './reply-directive.js';

const replyPreferencesSchema = z.object({
  lang: z.enum(['ar', 'en']).optional(),
  sentences: z.number().int().min(1).max(3).optional(),
  brief: z.boolean().optional(),
  list: z.boolean().optional(),
  links: z.number().int().nonnegative().optional(),
});

export const ReplyConstraintsSchema = replyPreferencesSchema.extend({
  fields: z.array(z.enum(['title', 'link', 'heading', 'first_sentence'])).optional(),
});

const migrationVersion = '060_reply_preferences';

/** Runs under the chat schema lock after chat_conversations exists. */
export async function migrateReplyPreferences(tx: Kysely<any>): Promise<void> {
  const applied = await tx.selectFrom('schema_migrations').select('version').where('version', '=', migrationVersion).executeTakeFirst();
  if (applied) return;
  await sql`ALTER TABLE chat_conversations ADD COLUMN reply_preferences jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(reply_preferences) = 'object')`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version: migrationVersion }).execute();
}

function storedPreferences(value: unknown): ReplyPreferences {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  const parsed = replyPreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export async function loadReplyPreferences(db: Kysely<any>, ownerId: string, conversationId: string): Promise<ReplyPreferences> {
  const row = await db.selectFrom('chat_conversations').select('reply_preferences')
    .where('id', '=', conversationId).where('owner_id', '=', ownerId).executeTakeFirst();
  return storedPreferences(row?.reply_preferences);
}

async function updateReplyPreferences(db: Kysely<any>, ownerId: string, conversationId: string, patch: ReplyPreferencePatch): Promise<ReplyPreferences> {
  // Apply only the named keys to the locked row, including removals represented by null.
  const row = await db.updateTable('chat_conversations')
    .set({ reply_preferences: sql`jsonb_strip_nulls(reply_preferences || ${JSON.stringify(patch)}::jsonb)` })
    .where('id', '=', conversationId).where('owner_id', '=', ownerId).returning('reply_preferences').executeTakeFirst();
  return storedPreferences(row?.reply_preferences);
}

/** Resolve one accepted user turn inside the transaction that records it. */
export async function resolveReplyTurn(db: Kysely<any>, ownerId: string, conversationId: string, text: string | ReplyRequest, prior?: ReplyConstraints) {
  const request = typeof text === 'string' ? parseReplyRequest(text) : text;
  const saved = Object.keys(request.preferences).length
    ? await updateReplyPreferences(db, ownerId, conversationId, request.preferences)
    : await loadReplyPreferences(db, ownerId, conversationId);
  return { ...request, constraints: mergeReplyConstraints(request, prior ? { ...saved, ...prior } : saved) };
}
