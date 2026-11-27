import type { FastifyInstance } from 'fastify';
import type { ModelRuntime } from '../../../../packages/model-relations/src/runtime.js';
import { attachMemberCouncilMetrics, createMemberCouncilMetrics } from './member-council-metrics.js';
import { MODEL_COUNCIL_LIMITS, MODEL_COUNCIL_WINDOW_MS } from './model-council-limits.js';
import { createModelCouncilQueue } from './model-council-queue.js';
import {
  createModelCouncil,
  type CouncilOutcome, type CouncilTurn, type ModelCouncilOptions, type ModelCouncilService,
} from './model-council.js';

type TurnAccount = { full: boolean; controller: AbortController; deadlineAt?: number; request?: string };
type PrepareTurn = (signal: AbortSignal) => Promise<CouncilTurn>;
type ChatCouncilResult = { outcome?: CouncilOutcome; note?: string };
type AccountCouncil = {
  runForAccount: (account: TurnAccount, prepare: PrepareTurn) => Promise<ChatCouncilResult>;
};
export type ChatModelCouncil = ModelCouncilService | AccountCouncil;
type ChatModelCouncilOptions = Omit<ModelCouncilOptions, 'runner'> & { runner: Pick<ModelRuntime, 'run'> };

export function councilRunsForMembers(council: ChatModelCouncil | undefined): council is AccountCouncil {
  return Boolean(council && 'runForAccount' in council);
}

export function createChatModelCouncil(app: FastifyInstance, mode: string | undefined, options: ChatModelCouncilOptions): ChatModelCouncil | undefined {
  if (mode !== 'owner' && mode !== 'all') return undefined;
  if (mode === 'owner') return createModelCouncil(options);

  const queue = createModelCouncilQueue(MODEL_COUNCIL_LIMITS);
  const metrics = createMemberCouncilMetrics();
  attachMemberCouncilMetrics(app, metrics);
  const budgetMs = Math.min(options.budgetMs ?? MODEL_COUNCIL_WINDOW_MS, MODEL_COUNCIL_WINDOW_MS);
  return {
    async runForAccount(account, prepare) {
      // Leave at least half of the remaining turn time for publication when nearing the chat deadline.
      const availableMs = Math.floor(((account.deadlineAt ?? Date.now()) - Date.now()) / 2);
      // Preparing a turn can read its own conversation. Do it only after admission.
      try {
        const result = await queue.run(account.full, account.controller.signal, Math.min(availableMs, budgetMs), async (signal, track) => {
          const turn = await prepare(signal);
          signal.throwIfAborted();
          const search = turn.search ?? options.search;
          const v5 = account.full ? options.v5 : undefined;
          const localCouncil = createModelCouncil({
            ...options,
            runner: { run: (id, input) => track(() => options.runner.run(id, input, signal)) },
            v5: v5 ? (history, signal) => track(() => v5(history, signal)) : undefined,
          });
          return localCouncil.deliberate({
            ...turn, signal, v5MayAnswer: account.full && turn.v5MayAnswer,
            search: search ? (text, signal) => track(() => search(text, signal)) : undefined,
          });
        });
        if ('outcome' in result) {
          if (!account.full) metrics.record(result.outcome.changed ? 'changed' : 'completed');
          return result;
        }
        if (account.full) return {};
        metrics.record(result.skipped === 'load' ? 'skippedLoad' : 'skippedDeadline');
        return result.skipped === 'load' ? { note: busyNote(account.request) } : {};
      } catch {
        if (!account.full) metrics.record('failed');
        return {};
      }
    },
  };
}

function busyNote(question?: string): string {
  return question && /\p{Script=Arabic}/u.test(question)
    ? 'تخطّينا نقاش النماذج بسبب انشغال الخادم.'
    : 'The models’ discussion was skipped because the server is busy.';
}

export async function deliberateChatCouncil(council: ChatModelCouncil, account: TurnAccount, prepare: PrepareTurn,
  assertActive: () => Promise<void>): Promise<ChatCouncilResult> {
  if (councilRunsForMembers(council)) return council.runForAccount(account, async signal => {
    if (!account.full) await assertActive();
    signal.throwIfAborted();
    return prepare(signal);
  });
  return { outcome: await council.deliberate(await prepare(account.controller.signal)) };
}
