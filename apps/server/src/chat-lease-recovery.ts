import { sql, type ExpressionBuilder, type Kysely } from 'kysely';

export const WAITING_STATUSES = ['waiting_user', 'waiting_input', 'waiting_approval'];
const recoverableStatuses = ['running', ...WAITING_STATUSES].map(status => sql.lit(status));
// Keep the cadence of the former notification worker sweep, even when push is disabled.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/notifications-routes.ts#L98-L105 (retrieved 2026-11-27).
const SWEEP_INTERVAL_MS = 15_000;
// Keep the existing bounded sweep size.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/command-chat.ts#L699-L705 (retrieved 2026-11-27).
const SWEEP_BATCH_SIZE = 50;

export type ChatRecoveryScope = { ownerId: string; id: string };

export async function migrateChatStatusIndex(tx: Kysely<any>) {
  const version = '059_chat_status_index';
  if (await tx.selectFrom('schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) return;
  await sql`CREATE INDEX IF NOT EXISTS chat_conversations_status_idx ON chat_conversations(status)
    WHERE status IN (${sql.join(recoverableStatuses)})`.execute(tx);
  await tx.insertInto('schema_migrations').values({ version }).execute();
}

function expired(eb: ExpressionBuilder<any, 'r'>, now = sql<Date>`CURRENT_TIMESTAMP`) {
  return eb.or([eb('r.lease_expires_at', '<', now), eb('r.worker_id', 'is', null)]);
}

export function selectExpiredChatLease(eb: ExpressionBuilder<any, 'c'>) {
  return eb.case().when('c.status', 'in', recoverableStatuses)
    .then(eb.exists(eb.selectFrom('chat_runs as r').select('r.id').whereRef('r.id', '=', 'c.active_run_id')
      .whereRef('r.conversation_id', '=', 'c.id').whereRef('r.owner_id', '=', 'c.owner_id').where(expired)))
    .else(false).end().as('lease_expired');
}

export function lockExpiredConversations(tx: Kysely<any>, scope?: ChatRecoveryScope) {
  const matching = tx.selectFrom('chat_conversations as c').innerJoin('chat_runs as r', join => join
    .onRef('r.id', '=', 'c.active_run_id').onRef('r.conversation_id', '=', 'c.id').onRef('r.owner_id', '=', 'c.owner_id'))
    .select(['c.id', 'c.owner_id', 'r.id as run_id']).where('c.status', 'in', recoverableStatuses)
    .where(expired).forUpdate('c');
  // A detail request waits for concurrent recovery of its row so it can return the latest status.
  return (scope ? matching.where('c.id', '=', scope.id).where('c.owner_id', '=', scope.ownerId)
    : matching.skipLocked().limit(SWEEP_BATCH_SIZE)).execute();
}

export function lockStillExpiredRun(tx: Kysely<any>, row: { id: string; owner_id: string; run_id: string }) {
  // After taking the conversation lock, guard against a heartbeat that committed after the sweep's snapshot.
  return tx.selectFrom('chat_runs as r').select('r.state').where('r.id', '=', row.run_id)
    .where('r.conversation_id', '=', row.id).where('r.owner_id', '=', row.owner_id)
    .where(eb => expired(eb, sql<Date>`clock_timestamp()`))
    .forUpdate().executeTakeFirst();
}

export function startChatRecoveryTimer(recover: () => Promise<void>) {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = recover().catch(() => {
      console.error(JSON.stringify({ level: 'error', event: 'chat_recovery_failed' }));
    }).finally(() => { inFlight = undefined; });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
