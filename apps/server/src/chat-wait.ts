import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

/**
 * Waiting for a conversation to change (2026-11-23). The chat screen polled the conversation every 450 ms, so a reply the
 * server wrote in 40 ms reached the screen about half a second later (measured: settle − server = 422 ms median on the
 * 107 real requests of 2026-11-23 01:13). `GET /api/chat/conversations/:id?since=<version>&wait=<ms>` now holds the request
 * until the conversation's version differs from `since`, the wait runs out or the caller goes away, and then answers with
 * the same detail as before. The version is read from the database every CHAT_WAIT_INTERVAL_MS: indexed single-row reads,
 * no in-process events, so it holds for a run another worker leads and across restarts.
 */

/** The longest hold of one request: under Vercel's 10-second default function limit and the web proxy's 15-second GET timeout. */
export const CHAT_WAIT_MAX_MS = 8000;
/** How often a held request reads the version. */
export const CHAT_WAIT_INTERVAL_MS = 50;
const VERSION = /^[0-9a-f]{24}$/u;

export const ChatWaitQuerySchema = z.object({
  since: z.string().regex(VERSION).optional(),
  wait: z.coerce.number().int().min(0).max(CHAT_WAIT_MAX_MS).optional(),
}).passthrough();

/**
 * What a conversation's view shows, as one short opaque string: its status and last update, its newest message, the newest
 * step of its latest run and its newest Ads campaign event. Equal strings mean an unchanged view; new messages, steps and
 * events have new ids. Null when the conversation is not this owner's (deleted while it was waited on).
 *
 * The step is looked up through the conversation's own index (chat_events_conversation_idx), not by run id alone, which
 * has no index.
 */
export async function conversationVersion(db: Kysely<any>, ownerId: string, id: string): Promise<string | null> {
  const row = await db.selectFrom('chat_conversations as c')
    .select(eb => [
      'c.status',
      'c.updated_at',
      eb.selectFrom('chat_messages as m').select('m.id').whereRef('m.conversation_id', '=', 'c.id')
        .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(1).as('last_message'),
      eb.selectFrom('chat_events as e').select('e.id').whereRef('e.conversation_id', '=', 'c.id').where('e.kind', '=', 'step')
        .where('e.run_id', '=', eb.selectFrom('chat_runs as r').select('r.id').whereRef('r.conversation_id', '=', 'c.id').orderBy('r.created_at', 'desc').limit(1))
        .orderBy('e.created_at', 'desc').orderBy('e.id', 'desc').limit(1).as('last_step'),
      eb.selectFrom('chat_campaign_events as k').select(sql<string>`k.task_id || ':' || k.seq`.as('mark')).whereRef('k.conversation_id', '=', 'c.id')
        .orderBy('k.created_at', 'desc').orderBy('k.seq', 'desc').limit(1).as('last_campaign'),
    ])
    .where('c.id', '=', id).where('c.owner_id', '=', ownerId)
    .executeTakeFirst() as { status: string; updated_at: Date | string; last_message: string | null; last_step: string | null; last_campaign: string | null } | undefined;
  if (!row) return null;
  const updated = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return createHash('sha256').update([row.status, updated, row.last_message ?? '', row.last_step ?? '', row.last_campaign ?? ''].join('\u0000')).digest('hex').slice(0, 24);
}

/**
 * Reads the version until it differs from `since` ('changed', which includes a conversation that is gone, so the detail
 * that follows answers its 404), the wait runs out ('unchanged') or the signal aborts ('aborted').
 */
export async function waitForChange(read: () => Promise<string | null>, since: string, waitMs: number,
  options: { signal?: AbortSignal; intervalMs?: number } = {}): Promise<'changed' | 'unchanged' | 'aborted'> {
  const deadline = Date.now() + Math.min(Math.max(0, waitMs), CHAT_WAIT_MAX_MS);
  const interval = Math.max(10, options.intervalMs ?? CHAT_WAIT_INTERVAL_MS);
  for (;;) {
    if (options.signal?.aborted) return 'aborted';
    if (await read() !== since) return 'changed';
    const left = deadline - Date.now();
    if (left <= 0) return 'unchanged';
    try { await sleep(Math.min(interval, left), undefined, options.signal ? { signal: options.signal } : undefined); }
    catch { return 'aborted'; }
  }
}

/** Aborts when the caller's connection closes before the answer is sent: a closed tab stops its held request. */
export function abortWhenClosed(raw: { once(event: 'close', listener: () => void): unknown; writableFinished?: boolean }): AbortSignal {
  const controller = new AbortController();
  raw.once('close', () => { if (!raw.writableFinished) controller.abort(); });
  return controller.signal;
}
