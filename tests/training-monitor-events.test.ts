import type { TrainingRun } from '@mohassan/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTrainingMonitorEvents } from '../apps/server/src/training-monitor/events.js';

const time = '2026-11-25T00:07:28Z';

function run(overrides: Partial<TrainingRun> = {}): TrainingRun {
  return { run: 'fixture-run', shape: '85m', status: 'running', currentAttempt: 'attempt-1',
    step: 1, processedTokens: 50, totalTokens: 1000, percentDone: 5, updatedAt: time, etaAt: null,
    speed: null, lastValidation: {}, bestValidation: {}, lastCheckpoint: null, nextCheckpoint: null,
    stopRequested: false, attempts: [], ...overrides };
}

describe('training monitor events', () => {
  it('emits newly seen checkpoints, stops, restarts and finish once after taking a baseline', () => {
    const { emitter, observe } = createTrainingMonitorEvents();
    const checkpoint = vi.fn(), stopped = vi.fn(), restarted = vi.fn(), finished = vi.fn();
    emitter.on('training_checkpoint', checkpoint);
    emitter.on('training_stopped', stopped);
    emitter.on('training_restarted', restarted);
    emitter.on('training_finished', finished);
    const snapshot = (active: TrainingRun, recent: TrainingRun[] = []) => observe({ active, recent, gpuLock: null }, time);
    const first = run({ lastCheckpoint: { tokens: 50, savedAt: null } });
    snapshot(first, [run({ run: 'old-run', status: 'completed' })]);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();

    const second = { ...first, lastCheckpoint: { tokens: 100, savedAt: time } };
    snapshot({ ...second, stopRequested: true });
    expect(stopped).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledExactlyOnceWith({ run: first.run, shape: first.shape, attempt: 'attempt-1', observedAt: time, tokens: 100 });
    snapshot({ ...second, lastCheckpoint: null });
    snapshot(second, [second]);
    expect(checkpoint).toHaveBeenCalledTimes(1);

    snapshot(run({ ...second, status: 'paused_by_stop_file' }));
    expect(stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'paused_by_stop_file', attempt: 'attempt-1' }));
    const next = run({ ...second, currentAttempt: 'attempt-2' });
    snapshot(next);
    snapshot(next);
    expect(restarted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ previousAttempt: 'attempt-1', attempt: 'attempt-2' }));

    const completed = run({ ...next, status: 'completed' });
    observe({ active: null, recent: [run({ run: 'another-run', status: 'completed' })], gpuLock: null }, time);
    observe({ active: null, recent: [completed], gpuLock: null }, time);
    observe({ active: null, recent: [completed], gpuLock: null }, time);
    expect(finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed', attempt: 'attempt-2' }));
  });

  it('detects a crashed attempt followed by a restart between snapshots', () => {
    const { emitter, observe } = createTrainingMonitorEvents();
    const received: string[] = [];
    emitter.on('training_stopped', event => received.push(`${event.attempt}:${event.status}`));
    emitter.on('training_restarted', event => received.push(`${event.previousAttempt}:${event.attempt}`));
    observe({ active: run(), recent: [], gpuLock: null }, time);
    const active = run({ currentAttempt: 'attempt-2', attempts: [
      { id: 'attempt-1', startedAt: time, endedAt: time, status: 'crashed', resumed: false },
    ] });
    observe({ active, recent: [], gpuLock: null }, time);
    expect(received).toEqual(['attempt-1:crashed', 'attempt-1:attempt-2']);
  });
});
