import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { councilRunsForMembers, createChatModelCouncil, deliberateChatCouncil } from '../apps/server/src/assistant/chat-model-council.js';
import { readMemberCouncilMetrics } from '../apps/server/src/assistant/member-council-metrics.js';
import type { CouncilRunner } from '../apps/server/src/assistant/model-council.js';

const runner: CouncilRunner = { run: async () => ({ ok: false, reason: 'absent', elapsedMs: 0 }) };

it('keeps the switch off by default and requires an exact value', async () => {
  const app = fastify();
  for (const mode of [undefined, '', 'off', 'ALL', 'on', ' owner']) {
    expect(createChatModelCouncil(app, mode, { runner })).toBeUndefined();
  }
  const owner = createChatModelCouncil(app, 'owner', { runner });
  expect(owner).toBeDefined();
  expect(councilRunsForMembers(owner)).toBe(false);
  expect(readMemberCouncilMetrics(app)).toBeUndefined();
  await app.close();
});

it('uses at most half of the remaining member turn budget even while preparing the discussion', async () => {
  const app = fastify();
  vi.useFakeTimers();
  try {
    const council = createChatModelCouncil(app, 'all', { runner })!;
    const turn = { full: false, controller: new AbortController(), deadlineAt: Date.now() + 100 };
    const prepare = vi.fn((signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const checkAccess = vi.fn(async () => {});
    const result = deliberateChatCouncil(council, turn, prepare, checkAccess);
    await vi.advanceTimersByTimeAsync(49);
    expect(checkAccess).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({});
    expect(prepare.mock.calls[0]?.[0].aborted).toBe(true);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(readMemberCouncilMetrics(app)).toMatchObject({ skippedDeadline: 1, failed: 0 });
  } finally {
    vi.useRealTimers();
    await app.close();
  }
});
