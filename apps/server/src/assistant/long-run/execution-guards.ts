import { BrowserError } from '@mohassan/browser';
import type { Kysely } from 'kysely';
import { LONG_RUN_LIMITS, LONG_RUN_WORKER, restoreLongRunState, type LongRunCheckpoint, type LongRunState } from './state.js';

type AccountActive = (ownerId: string, tx: Kysely<any>) => Promise<boolean>;
export type DraftWriteFence = (tx: Kysely<any>) => Promise<() => void>;

export function longRunDraftWriteFence(input: {
  ownerId: string;
  conversationId: string;
  state: Readonly<LongRunState>;
  signal: AbortSignal;
  accountActive?: AccountActive;
}): DraftWriteFence {
  const { ownerId, conversationId, state, signal, accountActive } = input;
  const runId = state.agentRun.runId;
  const lease = state.longRun.inFlight;
  const ended = () => new BrowserError('CHAT_LONG_RUN_ENDED', 'The background run can no longer save this draft.', 409);

  return async tx => {
    const assertLive = () => {
      signal.throwIfAborted();
      if (!lease || Date.now() >= Math.min(lease.expiresAt, state.longRun.deadline)) throw ended();
    };
    assertLive();

    // Hold the same conversation/run locks as cancellation through the draft insert.
    const conversation = await tx.selectFrom('chat_conversations').select('id')
      .where('id', '=', conversationId).where('owner_id', '=', ownerId).where('active_run_id', '=', runId)
      .where('status', '=', 'running').forUpdate().executeTakeFirst();
    if (!conversation) throw ended();
    const run = await tx.selectFrom('chat_runs').select('state')
      .where('id', '=', runId).where('conversation_id', '=', conversationId).where('owner_id', '=', ownerId)
      .where('worker_id', '=', LONG_RUN_WORKER).where('status', '=', 'running').forUpdate().executeTakeFirst();
    const current = restoreLongRunState(run?.state, runId)?.longRun;
    if (!current || current.inFlight?.token !== lease?.token || current.steps[current.next]?.kind !== 'build_site') throw ended();
    if (accountActive && !await accountActive(ownerId, tx)) throw ended();
    assertLive();
    return assertLive;
  };
}

export function nextLongRunDueAt(checkpoint: LongRunCheckpoint, time: number): number {
  if (checkpoint.resources >= LONG_RUN_LIMITS.resourceUnits) return time;
  const next = checkpoint.steps[checkpoint.next];
  const delay = next?.kind === 'monitor' ? next.delayMs : 0;
  return Math.min(checkpoint.deadline, time + delay);
}
