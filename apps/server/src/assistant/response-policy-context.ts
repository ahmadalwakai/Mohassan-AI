import { sql, type Kysely } from 'kysely';
import { decideResponsePolicy, type ResponsePolicyInput } from './response-policy.js';

export const HISTORY_READ_BUDGET_MS = 100;
export const HISTORY_SCAN_LIMIT = 1000;
const MAX_ENTRY_CHARS = 4000;
const MAX_REFERENCE_CHARS = 4800;
const MAX_REFERENCE_MESSAGES = 12;
const HISTORY_SCAN_BUDGET_MS = 30;

const enabled = (env: NodeJS.ProcessEnv) => env.MOHASSAN_CONTEXT_POLICY_ENABLED === '1';

type Turn = { role: string; text: string };
type RecentTurn = Turn & { id: string; created_at: Date | string };
type RankedTurn = Turn & { order: number };
type ContextTrigger = NonNullable<ReturnType<typeof decideResponsePolicy>['contextTrigger']>;
type EarlierContext = { trigger: ContextTrigger; data: string; ranked: RankedTurn[]; total: number | null };
const earlierByState = new WeakMap<object, EarlierContext>();

const matchWords = (text: string) => new Set(text.normalize('NFKC').toLowerCase()
  .replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي')
  .match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const common = matchWords('the and about that with when what please earlier first previous oldest earliest initial original message messages turn turns used this last said from before conversation chat did was were recap summary tell remind beginning في من عن على هذا ذلك اللي الذي التى الاولي الاول اول سابق سابقا قلت كان كانت المحادثه قبل بداية بدايه صحح ملخص رساله الرساله الرسائل');
const beginning = /\b(?:first|earliest|initial) (?:message|turn|reply|request)|\b(?:start|beginning) of\b|(?:اول|اولي) (?:رساله|طلب|رد)|بدايه المحادثه/iu;

export function rankEarlierTurns(text: string, older: readonly Turn[], trigger: ContextTrigger): RankedTurn[] {
  const terms = [...matchWords(text)].filter(word => !common.has(word));
  const wantsBeginning = trigger === 'older_reference' && beginning.test(text.normalize('NFKC')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي'));
  const seen = new Set<string>();
  return older.map((turn, index) => {
    const words = matchWords(turn.text.slice(0, MAX_ENTRY_CHARS));
    const hits = terms.filter(word => words.has(word)).length;
    // Recency breaks ties. For a recap, use coverage to keep the beginning, middle
    // and end in play even when the request names no particular topic.
    const recency = 1 - index / Math.max(1, older.length);
    const recapPosition = index % Math.max(1, Math.floor(older.length / MAX_REFERENCE_MESSAGES));
    const recap = trigger === 'recap' && recapPosition === 0 ? 1 : 0;
    const score = hits * 4 + recap + (wantsBeginning ? 1 - recency : recency) * 0.5 + (turn.role === 'user' ? 0.25 : 0);
    return { turn, order: older.length - index, hits, score };
  }).filter(entry => trigger !== 'older_reference' || entry.hits > 0 || wantsBeginning)
    .sort((a, b) => b.score - a.score)
    .filter(({ turn }) => {
      const key = turn.role + '\0' + turn.text.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_REFERENCE_MESSAGES).map(({ turn, order }) => ({ ...turn, order }));
}

function scrubEarlier(ranked: readonly RankedTurn[], scrub: (text: string) => string): RankedTurn[] {
  const messages: RankedTurn[] = [];
  let length = 0;
  for (const turn of ranked) {
    if (turn.text.length > MAX_ENTRY_CHARS || !['user', 'assistant'].includes(turn.role)) continue;
    const text = scrub(turn.text);
    if (!text.trim()) continue;
    const entry = { role: turn.role, text, order: turn.order };
    const entryLength = JSON.stringify(entry).length + 1;
    if (length + entryLength > MAX_REFERENCE_CHARS) continue;
    length += entryLength;
    messages.push(entry);
  }
  return messages;
}

export function renderEarlier(ranked: readonly RankedTurn[], total: number | null): string {
  return JSON.stringify({ coverage: total === null ? 'unavailable' : ranked.length === total ? 'all_older_messages' : 'selected_older_messages',
    messages: [...ranked].sort((a, b) => a.order - b.order) });
}

async function queryFullHistory(db: Kysely<any>, ownerId: string, conversationId: string, oldestRecent: RecentTurn): Promise<Turn[]> {
  return db.transaction().execute(async tx => {
    await sql`set local statement_timeout = '80ms'`.execute(tx);
    return tx.selectFrom('chat_messages as m').innerJoin('chat_conversations as c', 'm.conversation_id', 'c.id')
      .where('c.owner_id', '=', ownerId).where('m.conversation_id', '=', conversationId)
      .where(sql<boolean>`(m.created_at, m.id) < (${oldestRecent.created_at}, ${oldestRecent.id})`)
      .select(['m.role', sql<string>`left(m.text, ${MAX_ENTRY_CHARS + 1})`.as('text')])
      .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(HISTORY_SCAN_LIMIT + 1).execute();
  });
}

export async function readResponsePolicyHistory(input: {
  db: Kysely<any>;
  ownerId: string;
  conversationId: string;
  policy: ResponsePolicyInput;
  state: object;
  recentLimit: number;
  scrub: (text: string) => string;
  env?: NodeJS.ProcessEnv;
}): Promise<Turn[]> {
  const { db, conversationId, state, recentLimit, scrub, policy, ownerId } = input;
  const recentQuery = db.selectFrom('chat_messages').select(['role', 'text'])
    .where('conversation_id', '=', conversationId).orderBy('created_at', 'desc').limit(recentLimit);
  if (!enabled(input.env ?? process.env)) return recentQuery.execute() as Promise<Turn[]>;
  earlierByState.delete(state);
  const recent = await recentQuery.select(['id', 'created_at']).orderBy('id', 'desc')
    .where('conversation_id', 'in', db.selectFrom('chat_conversations').select('id').where('id', '=', conversationId)
      .where('owner_id', '=', ownerId)).execute() as RecentTurn[];
  const { contextTrigger, includeEarlierTurns } = decideResponsePolicy({ ...policy, recentTurns: recent.slice(1).filter(turn => turn.role === 'user').length });
  if (!includeEarlierTurns) return recent.slice(0, 1);
  const oldestRecent = recent.length === recentLimit ? recent.at(-1) : undefined;
  if (!contextTrigger || !oldestRecent) return recent;

  const started = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), HISTORY_READ_BUDGET_MS - HISTORY_SCAN_BUDGET_MS); });
  const older = await Promise.race([queryFullHistory(db, ownerId, conversationId, oldestRecent).catch(() => null), timer]);
  clearTimeout(timeout);
  if (older && older.length <= HISTORY_SCAN_LIMIT && performance.now() - started < HISTORY_READ_BUDGET_MS - HISTORY_SCAN_BUDGET_MS) {
    const ranked = scrubEarlier(rankEarlierTurns(policy.text, older, contextTrigger), scrub);
    const data = renderEarlier(ranked, older.length);
    if (performance.now() - started < HISTORY_READ_BUDGET_MS) {
      earlierByState.set(state, { trigger: contextTrigger, data, ranked, total: older.length });
      return recent;
    }
  }
  earlierByState.set(state, { trigger: contextTrigger, data: renderEarlier([], null), ranked: [], total: null });
  return recent;
}

export function responsePolicyEarlierContext(state: object): EarlierContext | undefined {
  return process.env.MOHASSAN_CONTEXT_POLICY_ENABLED === '1' ? earlierByState.get(state) : undefined;
}
