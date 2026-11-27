import { setImmediate } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { decodeCheckpointData, encodeCheckpointData, extendClaimArchive, readClaimArchive, type ClaimArchive } from './claim-archive.js';
import {
  buildConversationSummary, emptyLedger, extendLedger, SUMMARY_MIN_MESSAGES, validSummary,
  type ConversationLedger, type ConversationSummary, type LedgerProgress, type ReviewMessage,
} from './ledger.js';

export const REVIEW_MESSAGE_WINDOW = 200;

interface Cursor {
  id: string;
  createdAt: string;
}

type LedgerEvidence = Omit<ConversationLedger, 'messages' | 'messageOffset' | 'summary' | 'archivedClaims'>;

interface CheckpointState {
  evidence: LedgerEvidence;
  progress: LedgerProgress;
  claims: ClaimArchive;
}

interface Checkpoint {
  version: 1;
  cursor: Cursor;
  messageCount: number;
  data: string;
}

type StoredSummary = ConversationSummary & { checkpoint?: Checkpoint };
type MessageRow = Cursor & { role: ReviewMessage['role']; text: string };

interface ReviewSnapshot {
  stored: StoredSummary | null;
  checkpoint?: Checkpoint;
  state?: CheckpointState;
  cursor?: Cursor;
  pages: MessageRow[][];
  revision: string;
}

interface PreparedReview {
  ledger: ConversationLedger;
  revision: string;
  summary?: string;
}

const conversationRevision = sql<string>`xmin::text`;

function messageQuery(db: Kysely<any>, id: string) {
  return db.selectFrom('chat_messages').where('conversation_id', '=', id);
}

function cursorTuple(cursor: Cursor) {
  return sql`(${cursor.createdAt}::timestamptz, ${cursor.id}::text)`;
}

async function validCheckpoint(db: Kysely<any>, id: string, summary: StoredSummary | null): Promise<Checkpoint | undefined> {
  const checkpoint = summary?.checkpoint;
  const cursor = checkpoint?.cursor;
  if (summary?.version !== 1 || checkpoint?.version !== 1 || !cursor || typeof cursor.createdAt !== 'string'
    || typeof cursor.id !== 'string' || !cursor.id
    || !Number.isSafeInteger(summary.messageCount) || summary.messageCount < SUMMARY_MIN_MESSAGES
    || !Array.isArray(summary.openRequests) || typeof checkpoint.data !== 'string'
    || !Number.isSafeInteger(checkpoint.messageCount) || checkpoint.messageCount < SUMMARY_MIN_MESSAGES
    || checkpoint.messageCount > summary.messageCount || summary.messageCount - checkpoint.messageCount >= REVIEW_MESSAGE_WINDOW) return;

  // Messages are immutable in command chat, but a writer can supply a timestamp
  // earlier than the cursor. Check its rank without transferring that prefix.
  const { count, anchor } = await messageQuery(db, id)
    .select([sql<string>`count(*)`.as('count'), sql<boolean>`bool_or((created_at, id) = ${cursorTuple(cursor)})`.as('anchor')])
    .where(sql<boolean>`(created_at, id) <= ${cursorTuple(cursor)}`).executeTakeFirstOrThrow();
  if (anchor && Number(count) === checkpoint.messageCount) return checkpoint;
}

async function readPage(db: Kysely<any>, id: string, cursor?: Cursor) {
  const query = messageQuery(db, id).select(['id', 'role', 'text', sql<string>`created_at::text`.as('createdAt')]);
  return (cursor ? query.where(sql<boolean>`(created_at, id) > ${cursorTuple(cursor)}`) : query)
    .orderBy('created_at', 'asc').orderBy('id', 'asc').limit(REVIEW_MESSAGE_WINDOW).execute() as Promise<MessageRow[]>;
}

export async function readReviewSnapshot(db: Kysely<any>, id: string): Promise<ReviewSnapshot> {
  const row = await db.selectFrom('chat_conversations').select(['review_summary', conversationRevision.as('revision')])
    .where('id', '=', id).executeTakeFirstOrThrow();
  const stored = row.review_summary as StoredSummary | null;
  const checkpoint = await validCheckpoint(db, id, stored);
  let state: CheckpointState | undefined;
  if (checkpoint) {
    try {
      const decoded = decodeCheckpointData<CheckpointState>(checkpoint.data);
      if (Array.isArray(decoded.evidence?.fullOpenRequests) && decoded.progress && decoded.claims?.buckets) state = decoded;
    } catch {
      // A malformed checkpoint can be rebuilt from the transcript.
    }
  }
  const pages: MessageRow[][] = [];
  let cursor = state ? checkpoint?.cursor : undefined;
  for (;;) {
    const rows = await readPage(db, id, cursor);
    pages.push(rows);
    const last = rows.at(-1);
    if (last) cursor = { id: last.id, createdAt: last.createdAt };
    if (rows.length < REVIEW_MESSAGE_WINDOW) break;
  }
  return { stored, checkpoint: state ? checkpoint : undefined, state, cursor, pages, revision: row.revision };
}

export async function prepareReview(snapshot: ReviewSnapshot, clean: (text: string) => string): Promise<PreparedReview> {
  const { stored, checkpoint, state, cursor, pages, revision } = snapshot;
  const offset = checkpoint?.messageCount ?? 0;
  const messages: ReviewMessage[] = [];
  const ledger: ConversationLedger = state
    ? { ...state.evidence, messages, messageOffset: offset, archivedClaims: readClaimArchive(state.claims) }
    : { ...emptyLedger(messages), messageOffset: 0, fullOpenRequests: [] };
  const progress: LedgerProgress = state?.progress ?? {};
  for (const rows of pages) {
    const page = rows.map(row => ({ id: row.id, role: row.role, content: clean(row.text) }));
    extendLedger(ledger, page, offset + messages.length, progress);
    messages.push(...page);
    if (rows.length === REVIEW_MESSAGE_WINDOW) await setImmediate();
  }

  const messageCount = offset + messages.length;
  if (messageCount >= SUMMARY_MIN_MESSAGES && stored) {
    const anchored = checkpoint
      ? (stored.messageCount === offset ? checkpoint.cursor.id : messages[stored.messageCount - offset - 1]?.id) === stored.throughMessageId
      : validSummary(stored, messages);
    if (anchored) ledger.summary = stored;
  }
  if (!cursor || messageCount < SUMMARY_MIN_MESSAGES || (checkpoint && ledger.summary?.messageCount === messageCount)) {
    return { ledger, revision };
  }

  const summary = buildConversationSummary(ledger);
  // Reuse the compressed prefix across publications. A bounded tail bridges
  // the most recent evidence compaction and the latest publication cursor.
  if (checkpoint && messages.length < REVIEW_MESSAGE_WINDOW) {
    const next: StoredSummary = { ...summary, checkpoint };
    return { ledger, revision, summary: JSON.stringify(next) };
  }
  const { messages: _messages, messageOffset: _offset, summary: _prior, archivedClaims: _archive, ...evidence } = ledger;
  // Retain sources for the current request, summary retrieval and requests
  // that can enter a later summary when the latest answer is rejected.
  const requestKey = ({ messageIndex, text }: ConversationSummary['openRequests'][number]) => `${messageIndex}:${text}`;
  const retrievable = new Set([...summary.openRequests, ...ledger.fullOpenRequests ?? [], ...progress.beforeLatestAnswer ?? []].map(requestKey));
  evidence.requests = ledger.requests.filter(part => part.messageIndex === ledger.currentRequestIndex
    || retrievable.has(requestKey(part)));
  evidence.claims = [];
  // Other conversation queries also read this JSONB column. Keep the evidence
  // compact and decode it only on the review path.
  const data = encodeCheckpointData({ evidence, progress, claims: extendClaimArchive(state?.claims, ledger.claims) } satisfies CheckpointState);
  const next: StoredSummary = { ...summary, checkpoint: { version: 1, cursor, messageCount, data } };
  return { ledger, revision, summary: JSON.stringify(next) };
}

export async function commitReview(tx: Kysely<any>, id: string, prepared: PreparedReview): Promise<boolean> {
  const unchanged = sql<boolean>`${conversationRevision} = ${prepared.revision}`;
  if (!prepared.summary) {
    return Boolean(await tx.selectFrom('chat_conversations').select('id').where('id', '=', id).where(unchanged).executeTakeFirst());
  }
  return Boolean(await tx.updateTable('chat_conversations').set({ review_summary: prepared.summary })
    .where('id', '=', id).where(unchanged).returning('id').executeTakeFirst());
}
