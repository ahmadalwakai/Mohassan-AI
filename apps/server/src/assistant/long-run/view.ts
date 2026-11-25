import { LONG_RUN_ACTIVE, LONG_RUN_WORKER, restoreLongRunState } from './state.js';

type Run = { id: string; worker_id: string | null; status: string; state: unknown; goal: string; created_at: Date | string };

export function backgroundRunView(run: Run | undefined, activeRunId: string | null) {
  if (!run || run.id !== activeRunId || run.worker_id !== LONG_RUN_WORKER || !LONG_RUN_ACTIVE.some(status => status === run.status)) return {};
  const state = restoreLongRunState(run.state, run.id);
  const step = state?.agentRun.plan?.steps[state.longRun.next];
  if (!state?.longRun.background || !step) return {};
  return {
    backgroundRun: {
      id: run.id,
      task: run.goal.replace(/\s+/gu, ' ').trim().slice(0, 200),
      step: step.outcome,
      startedAt: new Date(run.created_at).toISOString(),
      language: state.longRun.language,
    },
  };
}
