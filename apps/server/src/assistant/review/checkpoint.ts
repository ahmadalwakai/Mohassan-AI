import { setImmediate } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { extendClaimArchive, readClaimArchive, type ClaimArchive } from './claim-archive.js';
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
  cursor: Cursor;
  messageCount: number;
  state: CheckpointState;
}

interface CachedCheckpoint {
  checkpoint: Checkpoint;
  bytes: number;
}

type MessageRow = Cursor & { role: ReviewMessage['role']; text: string };

interface ReviewSnapshot {
  stored: ConversationSummary | null;
  checkpoint?: Checkpoint;
  cursor?: Cursor;
  pages: MessageRow[][];
  revision: string;
}

interface PreparedReview {
  ledger: ConversationLedger;
  revision: string;
  summary?: string;
  prefix?: CachedCheckpoint;
}

const conversationRevision = sql<string>`xmin::text`;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

class PrefixCache {
  private readonly entries = new Map<string, CachedCheckpoint>();
  private bytes = 0;

  get(id: string): Checkpoint | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.checkpoint;
  }

  set(id: string, value: CachedCheckpoint): void {
    const { bytes } = value;
    const previous = this.entries.get(id);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(id);
    if (bytes > MAX_CACHE_BYTES) return;
    for (const [key, entry] of this.entries) {
      if (this.bytes + bytes <= MAX_CACHE_BYTES) break;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
    this.entries.set(id, value);
    this.bytes += bytes;
  }
}

// Transactions and Kysely plugins share the database's dialect adapter. Keep
// the cache distinct across databases, including independent embedded handles.
const prefixes = new WeakMap<object, PrefixCache>();

function prefixCache(db: Kysely<any>): PrefixCache {
  const adapter = db.getExecutor().adapter;
  let cache = prefixes.get(adapter);
  if (!cache) {
    cache = new PrefixCache();
    prefixes.set(adapter, cache);
  }
  return cache;
}

function messageQuery(db: Kysely<any>, id: string) {
  return db.selectFrom('chat_messages').where('conversation_id', '=', id);
}

function cursorTuple(cursor: Cursor) {
  return sql`(${cursor.createdAt}::timestamptz, ${cursor.id}::text)`;
}

async function validCheckpoint(db: Kysely<any>, id: string, summary: ConversationSummary | null): Promise<Checkpoint | undefined> {
  const checkpoint = prefixCache(db).get(id);
  if (!checkpoint || summary?.version !== 1 || !Number.isSafeInteger(summary.messageCount) || !Array.isArray(summary.openRequests)
    || checkpoint.messageCount > summary.messageCount || summary.messageCount - checkpoint.messageCount >= REVIEW_MESSAGE_WINDOW) return;

  // An out-of-order insert changes the cursor's rank. Look up that position
  // with the transcript index and transfer only the anchor, without its text.
  const { cursor } = checkpoint;
  const anchor = await messageQuery(db, id).select(['id', sql<string>`created_at::text`.as('createdAt')])
    .orderBy('created_at', 'asc').orderBy('id', 'asc').offset(checkpoint.messageCount - 1).limit(1).executeTakeFirst();
  if (anchor?.id === cursor.id && anchor.createdAt === cursor.createdAt) return checkpoint;
}

async function readPage(db: Kysely<any>, id: string, cursor?: Cursor) {
  const query = messageQuery(db, id).select(['id', 'role', 'text', sql<string>`created_at::text`.as('createdAt')]);
  return (cursor ? query.where(sql<boolean>`(created_at, id) > ${cursorTuple(cursor)}`) : query)
    .orderBy('created_at', 'asc').orderBy('id', 'asc').limit(REVIEW_MESSAGE_WINDOW).execute() as Promise<MessageRow[]>;
}

export async function readReviewSnapshot(db: Kysely<any>, id: string): Promise<ReviewSnapshot> {
  const row = await db.selectFrom('chat_conversations').select(['review_summary', conversationRevision.as('revision')])
    .where('id', '=', id).executeTakeFirstOrThrow();
  const stored = row.review_summary as ConversationSummary | null;
  const checkpoint = await validCheckpoint(db, id, stored);
  const pages: MessageRow[][] = [];
  let cursor = checkpoint?.cursor;
  for (;;) {
    const rows = await readPage(db, id, cursor);
    pages.push(rows);
    const last = rows.at(-1);
    if (last) cursor = { id: last.id, createdAt: last.createdAt };
    if (rows.length < REVIEW_MESSAGE_WINDOW) break;
  }
  return { stored, checkpoint, cursor, pages, revision: row.revision };
}

export async function prepareReview(snapshot: ReviewSnapshot, clean: (text: string) => string): Promise<PreparedReview> {
  const { stored, checkpoint, cursor, pages, revision } = snapshot;
  const state = checkpoint?.state;
  const offset = checkpoint?.messageCount ?? 0;
  const messages: ReviewMessage[] = [];
  const ledger: ConversationLedger = state
    ? {
      ...state.evidence, messages, messageOffset: offset, archivedClaims: readClaimArchive(state.claims),
      claims: [], requests: [...state.evidence.requests], userClaims: [...state.evidence.userClaims],
      corrections: [...state.evidence.corrections], rejectedAnswers: [...state.evidence.rejectedAnswers],
      fullOpenRequests: [...state.evidence.fullOpenRequests ?? []],
    }
    : { ...emptyLedger(messages), messageOffset: 0, fullOpenRequests: [] };
  const progress: LedgerProgress = state ? {
    ...state.progress, beforeLatestAnswer: state.progress.beforeLatestAnswer?.slice(),
  } : {};
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
  if (!cursor || messageCount < SUMMARY_MIN_MESSAGES || (checkpoint && ledger.summary?.messageCount === messageCount
    && !Object.hasOwn(ledger.summary, 'checkpoint'))) {
    return { ledger, revision };
  }

  const summary = buildConversationSummary(ledger);
  const serialized = JSON.stringify(summary);
  // The persisted summary is the original bounded version. Exact derived
  // evidence is reusable while cached, or rebuilt from committed messages.
  if (checkpoint && messages.length < REVIEW_MESSAGE_WINDOW) {
    return { ledger, revision, summary: serialized };
  }
  const { messages: _messages, messageOffset: _offset, summary: _prior, archivedClaims: _archive, ...evidence } = ledger;
  // Retain sources for the current request, summary retrieval and requests
  // that can enter a later summary when the latest answer is rejected.
  const requestKey = ({ messageIndex, text }: ConversationSummary['openRequests'][number]) => `${messageIndex}:${text}`;
  const retrievable = new Set([...summary.openRequests, ...ledger.fullOpenRequests ?? [], ...progress.beforeLatestAnswer ?? []].map(requestKey));
  evidence.requests = ledger.requests.filter(part => part.messageIndex === ledger.currentRequestIndex
    || retrievable.has(requestKey(part)));
  evidence.claims = [];
  const next = { cursor, messageCount, state: { evidence, progress, claims: extendClaimArchive(state?.claims, ledger.claims) } };
  const prefix = { checkpoint: next, bytes: Buffer.byteLength(JSON.stringify(next)) };
  return { ledger, revision, summary: serialized, prefix };
}

export async function commitReview(tx: Kysely<any>, id: string, prepared: PreparedReview): Promise<boolean> {
  const unchanged = sql<boolean>`${conversationRevision} = ${prepared.revision}`;
  if (!prepared.summary) {
    return Boolean(await tx.selectFrom('chat_conversations').select('id').where('id', '=', id).where(unchanged).executeTakeFirst());
  }
  const updated = await tx.updateTable('chat_conversations').set({ review_summary: prepared.summary })
    .where('id', '=', id).where(unchanged).returning('id').executeTakeFirst();
  if (updated && prepared.prefix) prefixCache(tx).set(id, prepared.prefix);
  return Boolean(updated);
}
