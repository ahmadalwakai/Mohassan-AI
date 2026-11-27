import { sql, type Kysely } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { LONG_RUN_ACTIVE, LONG_RUN_WORKER } from './assistant/long-run/state.js';
import { selectExpiredChatLease } from './chat-lease-recovery.js';
import { selectConversationVersionMarks, type ConversationVersionRow } from './chat-wait.js';

// The detail shows the newest 300 messages (since 2026-11-23), with a count of the earlier messages.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L280-L281 (retrieved 2026-11-27).
const MESSAGE_WINDOW = 300;

export async function readChatMessageWindow(db: Kysely<any>, id: string) {
  const query = db.selectFrom('chat_messages').where('conversation_id', '=', id);
  const newest = await query.selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(MESSAGE_WINDOW).execute();
  const olderMessages = newest.length < MESSAGE_WINDOW ? 0 : Math.max(0, Number((await query
    .select(eb => eb.fn.countAll<string | number>().as('n')).executeTakeFirstOrThrow()).n) - newest.length);
  return { messages: newest.reverse(), olderMessages };
}

export function readOwnedChat(db: Kysely<any>, ownerId: string, id: string, withVersion: boolean) {
  return db.selectFrom('chat_conversations as c').selectAll('c').select(selectExpiredChatLease)
    .$if(withVersion, query => query.select(selectConversationVersionMarks))
    .where('c.id', '=', id).where('c.owner_id', '=', ownerId)
    .$castTo<ConversationVersionRow & { lease_expired: boolean } & Record<string, any>>().executeTakeFirst();
}

export function readLatestChatRun(db: Kysely<any>, id: string, activeRunId: string | null) {
  return db.selectFrom('chat_runs as r').select(['r.id', 'r.status', 'r.created_at', 'r.updated_at', 'r.worker_id', 'r.goal'])
    .select(eb => [
      sql<string | null>`r.state #>> '{routing,route}'`.as('route'),
      sql<unknown>`r.state -> 'agentRun'`.as('agent_run'),
      // The background projection validates the entire long-run checkpoint against its strict schema.
      eb.case().when(eb.and([eb('r.id', '=', activeRunId), eb('r.worker_id', '=', LONG_RUN_WORKER),
        eb('r.status', 'in', LONG_RUN_ACTIVE)])).then(eb.ref('r.state')).end().as('state'),
      eb.case().when(sql<boolean>`coalesce(r.state -> 'agentRun' IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), true)`)
        .then(eb.selectFrom('chat_model_receipts as m').select(count => count.fn.countAll<string | number>().as('n'))
          .whereRef('m.run_id', '=', 'r.id').where('m.status', '=', 'succeeded')).end().as('legacy_model_calls'),
      jsonArrayFrom(eb.selectFrom('chat_events as e').select(['e.id', 'e.message', 'e.created_at'])
        .whereRef('e.conversation_id', '=', 'r.conversation_id').whereRef('e.run_id', '=', 'r.id')
        .where('e.kind', '=', 'step').orderBy('e.created_at', 'desc').limit(40)).as('steps'),
    ]).where('r.conversation_id', '=', id).orderBy('r.created_at', 'desc').limit(1).executeTakeFirst();
}
