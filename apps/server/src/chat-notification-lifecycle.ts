import type { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import { recordNotificationOutcome } from './notifications-store.js';

function notificationKind(status: string) {
  switch (status) {
    case 'waiting_approval':
    case 'waiting_input':
    case 'waiting_user':
      return 'needs_you';
    case 'completed':
      return 'task_completed';
    case 'partial':
    case 'blocked':
    case 'failed':
    case 'interrupted':
      return 'task_failed';
    default:
      return null;
  }
}

/** Enqueue at the same commit boundary as the chat state and its reply or card. */
export async function recordChatNotification(tx: Kysely<any>, runId: string, status: string): Promise<void> {
  const kind = notificationKind(status);
  if (!kind) return;

  const run = await tx.selectFrom('chat_runs').select(['owner_id', 'conversation_id', 'created_at'])
    .where('id', '=', runId).where('status', '=', status).executeTakeFirst();
  if (!run) return;
  await recordNotificationOutcome(tx, {
    taskId: runId,
    userId: run.owner_id,
    conversationId: run.conversation_id,
    startedAt: new Date(run.created_at),
    kind,
  });
}

/** The deadline stops work immediately. The failure transaction keeps its account and lease checks with a fresh signal. */
export function finalizeChatFailure<Execution extends { controller: AbortController }, Args extends unknown[]>(
  execution: AsyncLocalStorage<Execution>,
  timedOut: boolean,
  finalize: (...args: Args) => Promise<unknown>,
  ...args: Args
): Promise<unknown> {
  const current = execution.getStore();
  if (!timedOut || !current) return finalize(...args);
  return execution.run({ ...current, controller: new AbortController() }, () => finalize(...args));
}
