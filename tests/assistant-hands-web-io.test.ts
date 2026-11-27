import { expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { newBrainState } from '../apps/server/src/assistant/brain.js';
import { runHands, webQuestion, type HandsIO } from '../apps/server/src/assistant/hands.js';
import { createHandsWebIO } from '../apps/server/src/assistant/hands-web-io.js';

it('returns a fatal search error while ignoring the late observation from an already-dispatched read', async () => {
  const cancelled = new Error('search aborted');
  let markReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  const pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const state = newBrainState();
  const observePage = vi.fn();
  const active = vi.fn(async () => {});
  const step = vi.fn(async () => {});
  const io: HandsIO = {
    ...createHandsWebIO({
      ownerId: 'batch-test-owner', signal: new AbortController().signal, state, active, step, observePage,
      live: false, assertPublicSearch() {},
      search: { name: 'batch-test-search', async search() { throw cancelled; } },
      async readPage(url) {
        markReadStarted();
        await pendingRead;
        return { url, title: 'Test page', status: 200, text: 'A page from the pending read.' };
      },
    }),
    step,
    async page() { return null; },
    async prepare() { return null; },
    async settle(page) { return page; },
    act: vi.fn(async () => { throw new Error('unexpected browser action'); }),
    async approve() {},
    async hold() {},
  };

  try {
    const outcome = runHands({ steps: webQuestion('ما عاصمة اليابان؟')!, next: 0 }, io);
    await readStarted;
    await expect(outcome).rejects.toBe(cancelled);
  } finally {
    releaseRead();
  }
  await setImmediate();
  expect(active).toHaveBeenCalledTimes(2);
  expect(io.act).not.toHaveBeenCalled();
  expect(observePage).not.toHaveBeenCalled();
  expect(state.trail).toEqual([]);
});
