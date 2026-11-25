import { EventEmitter } from 'node:events';
import type { TrainingRun, TrainingRuns } from '@mohassan/contracts';

type StoppedStatus = 'failed' | 'paused_by_stop_file' | 'paused_time_limit' | 'interrupted' | 'crashed';
type FinishedStatus = 'completed' | 'early_stopped';

interface TrainingEventContext {
  run: string;
  shape: string;
  attempt: string | null;
  observedAt: string;
}

export interface TrainingMonitorEvents {
  training_checkpoint: [TrainingEventContext & { tokens: number }];
  training_stopped: [TrainingEventContext & { status: StoppedStatus }];
  training_restarted: [TrainingEventContext & { previousAttempt: string }];
  training_finished: [TrainingEventContext & { status: FinishedStatus }];
}

function isStopped(status: string): status is StoppedStatus {
  return status === 'failed' || status === 'paused_by_stop_file' || status === 'paused_time_limit'
    || status === 'interrupted' || status === 'crashed';
}

type PreviousRun = Pick<TrainingRun, 'status' | 'currentAttempt'> & { checkpoint: number };
const RETAINED_RUNS = 32;

export function createTrainingMonitorEvents() {
  const emitter = new EventEmitter<TrainingMonitorEvents>();
  let previous = new Map<string, PreviousRun>();

  function observe({ active, recent }: TrainingRuns, observedAt: string) {
    const seen = new Set<string>();
    const runs = active ? [active, ...recent] : recent;

    for (const run of runs) {
      const key = JSON.stringify([run.run, run.shape]);
      if (seen.has(key)) continue;
      seen.add(key);

      const prior = previous.get(key);
      const checkpoint = run.lastCheckpoint?.tokens ?? 0;
      const attempt = run.currentAttempt ?? prior?.currentAttempt ?? null;
      previous.delete(key);
      previous.set(key, { status: run.status, currentAttempt: attempt, checkpoint: Math.max(prior?.checkpoint ?? 0, checkpoint) });
      if (!prior) continue;

      const context = { run: run.run, shape: run.shape, attempt, observedAt };
      const restarted = Boolean(prior.currentAttempt && attempt && prior.currentAttempt !== attempt);
      if (restarted && prior.currentAttempt) {
        const lastAttempt = run.attempts.find(item => item.id === prior.currentAttempt);
        if (prior.status === 'running' && lastAttempt && isStopped(lastAttempt.status)) {
          emitter.emit('training_stopped', { ...context, attempt: lastAttempt.id, status: lastAttempt.status });
        }
        emitter.emit('training_restarted', { ...context, previousAttempt: prior.currentAttempt });
      }
      if (checkpoint > prior.checkpoint) emitter.emit('training_checkpoint', { ...context, tokens: checkpoint });
      if (run.status === prior.status && !restarted) continue;
      if (isStopped(run.status)) emitter.emit('training_stopped', { ...context, status: run.status });
      if (run.status === 'completed' || run.status === 'early_stopped') {
        emitter.emit('training_finished', { ...context, status: run.status });
      }
    }

    // A status being replaced can disappear from one refresh while other runs remain readable.
    if (previous.size > RETAINED_RUNS) previous = new Map([...previous].slice(-RETAINED_RUNS));
  }

  return { emitter, observe };
}
