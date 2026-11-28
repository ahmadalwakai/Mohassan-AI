import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely, type SqlBool } from 'kysely';
import {
  ConversationShareTokenSchema, ConversationSnapshotSchema,
  type ConversationShareExpiry, type ConversationShareSummary, type ConversationSnapshot, type PublicConversationShare,
} from '@mohassan/contracts';
import type { WorkspaceRole } from './members.js';
import type { BrainState } from './assistant/brain.js';
import {
  conversationPublicToolQuotes, conversationRunPrivacy, hasConversationPromptPrivacy, visibleConversationText, type ConversationPrivateOrigin,
} from './conversation-share-privacy.js';

const SETTINGS_ID = 1;
const expiryDays = { '1d': 1, '7d': 7, '30d': 30, never: null } as const satisfies Record<ConversationShareExpiry, number | null>;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const iso = (at: Date | string) => new Date(at).toISOString();
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });

// Match the chat renderer's inline and bare HTTP(S) citations, including a balanced pair in a Wikipedia slug.
const address = String.raw`https?:\/\/(?:[^\s()]|\([^\s()]*\)|\()+`;
const bareAddress = String.raw`https?:\/\/(?:[^\s<>()\[\]]|\([^\s<>()]*\))*(?:[^\s<>()\[\].,،;؛؟!?]|\([^\s<>()]*\))`;
const citations = new RegExp(String.raw`(!?)\[([^\]\n]+)\]\((${address})\)|(${bareAddress})`, 'giu');
const citationOnlyLabel = /^\s*(?:\*\*)?(?:المصدر|المصادر|رابط المصدر|للمزيد|مصدر ثانٍ يؤكد|Sources?|Source link|See also|A second source agrees):(?:\*\*)?\s*/iu;

function visibleAnswer(text: string): Pick<ConversationSnapshot['messages'][number], 'text' | 'sources'> {
  const sources = new Map<string, { title: string; url: string }>();
  let code = false;
  const lines = visibleConversationText(text).split('\n').filter(line => {
    if (line.trimStart().startsWith('```')) {
      code = !code;
      return true;
    }
    if (code) return true;

    const label = citationOnlyLabel.exec(line);
    let linked = false;
    const rest = line.slice(label?.[0].length ?? 0).replace(citations,
      (original: string, image: string | undefined, title: string | undefined, address: string | undefined, bare: string | undefined) => {
        if (image) return original;
        const url = address ?? bare;
        if (!url || !URL.canParse(url)) return original;
        if (!sources.has(url) || (title && sources.get(url)?.title === url)) sources.set(url, { title: title ?? url, url });
        linked = true;
        return '';
      });
    return !label || !linked || !/^[\s·,،<>]*$/u.test(rest);
  });
  return { text: lines.join('\n'), sources: [...sources.values()] };
}

type StoredMessage = {
  role: 'user' | 'assistant';
  text: string;
  created_at: Date | string;
  run_id: string | null;
  has_images: boolean;
};
type StoredRun = {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
  state: Partial<BrainState> | null;
  called_model: SqlBool;
};
type ShareSummaryRow = {
  id: string;
  conversation_id: string;
  title: string;
  shared_at: Date | string;
  expires_at: Date | string | null;
};

function provenanceFor(messages: readonly StoredMessage[], runs: readonly StoredRun[]) {
  const provenance = new Map<number, readonly ConversationPrivateOrigin[]>();
  const quotes = new Map<number, readonly string[]>();
  const precedingOrigins = new Set<ConversationPrivateOrigin>();
  const indexed = runs.map(run => {
    // Old receipts indicate a prompt was sent, but do not say which private inputs it received.
    const hasOpaqueModelInput = Boolean(run.called_model) && !hasConversationPromptPrivacy(run.state);
    const origins: ConversationPrivateOrigin[] = hasOpaqueModelInput ? ['memory', 'tool-output']
      : Array.isArray(run.state?.trail) ? conversationRunPrivacy(run.state) : ['tool-output'];
    return {
      id: run.id,
      start: new Date(run.created_at).getTime(),
      end: new Date(run.updated_at).getTime(),
      origins,
      quotes: origins.includes('tool-output') ? [] : conversationPublicToolQuotes(run.state),
      couldRepeatPriorAnswer: Boolean(run.called_model) || (run.state?.agentRun?.modelCalls ?? 0) > 0
        || Array.isArray(run.state?.trail) && run.state.trail.some(entry => entry?.action === 'shorten_previous_answer' || entry?.action === 'explain_previous_answer'),
    };
  });
  const byId = new Map(indexed.map(run => [run.id, run]));
  let nextRun = 0;
  let overlapping: typeof indexed = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue;
    const at = new Date(message.created_at).getTime();
    // Legacy rows have no run ID. Multiple overlapping runs are treated as possible contributors.
    while (indexed[nextRun] && indexed[nextRun]!.start <= at) overlapping.push(indexed[nextRun++]!);
    overlapping = overlapping.filter(run => run.end >= at);
    const recordedRun = message.run_id ? byId.get(message.run_id) : undefined;
    const previous = messages[index - 1];
    const fromImage = !message.run_id && previous?.role === 'user' && previous.has_images;
    const candidates = recordedRun ? [recordedRun] : message.run_id || fromImage ? [] : overlapping;
    const origins = new Set<ConversationPrivateOrigin>(candidates.flatMap(run => run.origins));
    // The direct image answer does not have a run. A missing legacy association is equally opaque.
    if (!candidates.length) origins.add('tool-output');
    if (candidates.some(run => run.couldRepeatPriorAnswer)) {
      for (const origin of precedingOrigins) origins.add(origin);
    }
    const exact = [...new Set(candidates.flatMap(run => run.quotes))];
    if (exact.length) {
      quotes.set(index, exact);
      precedingOrigins.add('tool-output');
    }
    if (origins.size) {
      provenance.set(index, [...origins]);
      for (const origin of origins) precedingOrigins.add(origin);
    }
  }
  return { provenance, quotes };
}

function summary(row: ShareSummaryRow): ConversationShareSummary {
  return {
    id: row.id, conversationId: row.conversation_id, title: row.title,
    sharedAt: iso(row.shared_at), expiresAt: row.expires_at === null ? null : iso(row.expires_at),
  };
}

export function createConversationShareStorage(db: Kysely<any>, now: () => number = Date.now) {
  async function requireShareableConversation(tx: Kysely<any>, conversationId: string) {
    const experimental = await tx.selectFrom('chat_messages as m').select('m.id')
      .where('m.conversation_id', '=', conversationId)
      // A reply the owner's model council took from an experimental model is the same kind of owner-only reply as v5's.
      .where(sql<boolean>`(to_jsonb(m)->>'experiment' = 'v5' OR to_jsonb(m)->'council'->>'changed' = 'true')`).limit(1).executeTakeFirst();
    if (experimental) throw failure(409, 'CONVERSATION_SHARE_EXPERIMENTAL', 'هذه المحادثة تتضمن ردًا تجريبيًا خاصًا بحساب المالك.');
  }

  async function ownedSnapshot(ownerId: string, conversationId: string, forSharing = false) {
    return db.transaction().execute(async tx => {
      // The embedded PGlite dialect ignores Kysely transaction settings.
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(tx);
      const conversation = await tx.selectFrom('chat_conversations').select(['title', 'created_at'])
        .where('id', '=', conversationId).where('owner_id', '=', ownerId).executeTakeFirst();
      if (!conversation) return null;
      if (forSharing) await requireShareableConversation(tx, conversationId);
      const messages: StoredMessage[] = await tx.selectFrom('chat_messages').select(['role', 'text', 'created_at', 'run_id'])
        .select(sql<boolean>`CASE WHEN jsonb_typeof(images) = 'array' THEN jsonb_array_length(images) > 0 ELSE false END`.as('has_images'))
        .where('conversation_id', '=', conversationId).orderBy('created_at').orderBy('id').execute();
      const runs: StoredRun[] = await tx.selectFrom('chat_runs as run').select(['run.id', 'run.state', 'run.created_at', 'run.updated_at'])
        .select(eb => eb.exists(eb.selectFrom('chat_model_receipts as receipt').select('receipt.id')
          .whereRef('receipt.run_id', '=', 'run.id')).as('called_model'))
        .where('run.conversation_id', '=', conversationId).where('run.owner_id', '=', ownerId)
        .orderBy('run.created_at').orderBy('run.id').execute();
      const snapshot: ConversationSnapshot = {
        title: conversation.title,
        createdAt: iso(conversation.created_at),
        messages: messages.map(row => ({
          role: row.role,
          createdAt: iso(row.created_at),
          ...(row.role === 'assistant' ? visibleAnswer(row.text) : { text: row.text, sources: [] }),
        })),
      };
      return { snapshot, ...provenanceFor(messages, runs) };
    });
  }

  async function createShare(ownerId: string, conversationId: string, snapshot: ConversationSnapshot, expiry: ConversationShareExpiry,
    role: WorkspaceRole, beforeCreate?: (tx: Kysely<any>, userId: string) => Promise<void>) {
    const checkedSnapshot = ConversationSnapshotSchema.parse(snapshot);
    return db.transaction().execute(async tx => {
      await beforeCreate?.(tx, ownerId);
      const conversation = await tx.selectFrom('chat_conversations').select('id')
        .where('id', '=', conversationId).where('owner_id', '=', ownerId).forShare().executeTakeFirst();
      if (!conversation) throw failure(404, 'CHAT_NOT_FOUND', 'لم يُعثر على المحادثة.');
      await requireShareableConversation(tx, conversationId);
      if (role === 'member') {
        const settings = await tx.selectFrom('conversation_share_settings').select('member_sharing_enabled')
          .where('id', '=', SETTINGS_ID).forShare().executeTakeFirstOrThrow();
        if (!settings.member_sharing_enabled) throw failure(403, 'CONVERSATION_SHARE_DISABLED', 'أوقف المالك مشاركة المحادثات للأعضاء.');
      }
      // Random 128-bit bearer credential. The separate share ID is safe to list for revocation.
      const token = randomBytes(16).toString('base64url');
      const sharedAt = now();
      const days = expiryDays[expiry];
      const share = summary({
        id: randomUUID(), conversation_id: conversationId, title: checkedSnapshot.title,
        shared_at: new Date(sharedAt), expires_at: days === null ? null : new Date(sharedAt + days * millisecondsPerDay),
      });
      await tx.insertInto('conversation_shares').values({
        id: share.id, sharer_id: ownerId, conversation_id: conversationId,
        token_hash: hashToken(token), snapshot: JSON.stringify(checkedSnapshot),
        shared_at: share.sharedAt, expires_at: share.expiresAt,
      }).execute();
      return { share, token };
    });
  }

  async function listShares(ownerId: string): Promise<ConversationShareSummary[]> {
    const rows: ShareSummaryRow[] = await db.selectFrom('conversation_shares')
      .select(['id', 'conversation_id', 'shared_at', 'expires_at']).select(sql<string>`snapshot ->> 'title'`.as('title'))
      .where('sharer_id', '=', ownerId).where('revoked_at', 'is', null)
      .where(eb => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date(now()))]))
      .orderBy('shared_at', 'desc').orderBy('id', 'desc').execute();
    return rows.map(summary);
  }

  async function revokeShare(ownerId: string, id: string) {
    const row = await db.updateTable('conversation_shares').set({ revoked_at: new Date(now()) })
      .where('sharer_id', '=', ownerId).where('id', '=', id).where('revoked_at', 'is', null)
      .returning('id').executeTakeFirst();
    return Boolean(row);
  }

  async function lookupShare(token: string): Promise<PublicConversationShare | null> {
    if (!ConversationShareTokenSchema.safeParse(token).success || Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
    const row = await db.selectFrom('conversation_shares').select(['snapshot', 'shared_at'])
      .where('token_hash', '=', hashToken(token)).where('revoked_at', 'is', null)
      .where(eb => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date(now()))])).executeTakeFirst();
    return row ? { snapshot: ConversationSnapshotSchema.parse(row.snapshot), sharedAt: iso(row.shared_at) } : null;
  }

  async function getMemberSharingEnabled(): Promise<boolean> {
    const row = await db.selectFrom('conversation_share_settings').select('member_sharing_enabled').where('id', '=', SETTINGS_ID).executeTakeFirstOrThrow();
    return row.member_sharing_enabled;
  }

  async function setMemberSharingEnabled(enabled: boolean) {
    await db.updateTable('conversation_share_settings').set({ member_sharing_enabled: enabled }).where('id', '=', SETTINGS_ID).execute();
  }

  return { ownedSnapshot, createShare, listShares, revokeShare, lookupShare, getMemberSharingEnabled, setMemberSharingEnabled };
}
