import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_COUNCIL_LIMITS } from '../apps/server/src/assistant/model-council-limits.js';
import { createModelCouncilQueue } from '../apps/server/src/assistant/model-council-queue.js';

const budgetMs = 100;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('council load protection', () => {
  afterEach(() => vi.useRealTimers());

  it('runs one council, holds one queued turn, and gives its slot to a waiting owner', async () => {
    vi.useFakeTimers();
    const queue = createModelCouncilQueue(MODEL_COUNCIL_LIMITS);
    const turn = new AbortController();
    const held = deferred<string>();
    const queuedMember = vi.fn(async () => 'member');
    const ownerWork = vi.fn(async () => 'owner');

    const active = queue.run(false, turn.signal, budgetMs, () => held.promise);
    const waiting = queue.run(false, turn.signal, budgetMs, queuedMember);
    await expect(queue.run(false, turn.signal, budgetMs, queuedMember)).resolves.toEqual({ skipped: 'load' });
    const owner = queue.run(true, turn.signal, budgetMs, ownerWork);
    await expect(waiting).resolves.toEqual({ skipped: 'load' });
    expect(queuedMember).not.toHaveBeenCalled();
    expect(ownerWork).not.toHaveBeenCalled();
    await expect(queue.run(true, turn.signal, budgetMs, ownerWork)).resolves.toEqual({ skipped: 'load' });

    held.resolve('active');
    await expect(active).resolves.toEqual({ outcome: 'active' });
    await expect(owner).resolves.toEqual({ outcome: 'owner' });
    expect(ownerWork).toHaveBeenCalledOnce();
  });

  it('removes a canceled waiting turn and admits another turn before the active one is done', async () => {
    vi.useFakeTimers();
    const queue = createModelCouncilQueue(MODEL_COUNCIL_LIMITS);
    const held = deferred<string>();
    const active = queue.run(false, new AbortController().signal, budgetMs, () => held.promise);
    const cancel = new AbortController();
    const queuedWork = vi.fn(async () => 'canceled');
    const waiting = queue.run(false, cancel.signal, budgetMs, queuedWork);
    cancel.abort();
    await expect(waiting).resolves.toEqual({ skipped: 'deadline' });
    expect(queuedWork).not.toHaveBeenCalled();

    const next = queue.run(false, new AbortController().signal, budgetMs, async () => 'next');
    held.resolve('active');
    await expect(active).resolves.toEqual({ outcome: 'active' });
    await expect(next).resolves.toEqual({ outcome: 'next' });
  });

  it('caps waiting and running work and holds reservations until tracked calls stop', async () => {
    vi.useFakeTimers();
    const queue = createModelCouncilQueue(MODEL_COUNCIL_LIMITS);
    const turn = new AbortController();
    const held = deferred<string>();
    const began = deferred<AbortSignal>();
    const active = queue.run(false, turn.signal, budgetMs, async (signal, track) => {
      began.resolve(signal);
      return track(() => held.promise);
    });
    const signal = await began.promise;
    const shortWait = vi.fn(async () => 'short');
    const waiting = queue.run(false, turn.signal, budgetMs / 2, shortWait);

    await vi.advanceTimersByTimeAsync(budgetMs);
    await expect(waiting).resolves.toEqual({ skipped: 'deadline' });
    await expect(active).resolves.toEqual({ skipped: 'deadline' });
    expect(signal.aborted).toBe(true);
    expect(shortWait).not.toHaveBeenCalled();

    const nextWork = vi.fn(async () => 'next');
    const next = queue.run(true, turn.signal, budgetMs, nextWork);
    await vi.advanceTimersByTimeAsync(0);
    expect(nextWork).not.toHaveBeenCalled();
    held.resolve('late');
    await expect(next).resolves.toEqual({ outcome: 'next' });
  });

  it('keeps capped stage work reserved even if the council returns first', async () => {
    vi.useFakeTimers();
    const queue = createModelCouncilQueue(MODEL_COUNCIL_LIMITS);
    const turn = new AbortController();
    const held = deferred<void>();
    const council = await queue.run(false, turn.signal, budgetMs, async (_signal, track) => {
      void track(() => held.promise);
      return 'pipeline';
    });
    expect(council).toEqual({ outcome: 'pipeline' });

    const nextWork = vi.fn(async () => 'next');
    const next = queue.run(true, turn.signal, budgetMs, nextWork);
    expect(nextWork).not.toHaveBeenCalled();
    held.resolve();
    await expect(next).resolves.toEqual({ outcome: 'next' });
  });
});
