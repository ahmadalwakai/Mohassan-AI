import { describe, expect, it, vi } from 'vitest';
import type { ChatMetricsCursor, PersistedChatSample } from '../apps/server/src/ops/metrics/chat.js';
import { createChatMetricsRefresh } from '../apps/server/src/ops/metrics/chat-refresh.js';
import { hourMs, hourlySlots } from '../apps/server/src/ops/metrics/store.js';

const noon = Date.UTC(2026, 10, 25, 12);
const sample = (key: string, atMs: number): PersistedChatSample => ({ key, atMs, role: 'owner', observation: { started: true } });

describe('persisted chat metrics refresh', () => {
  it('finishes paging the same range before advancing and deduplicates overlap while collecting late commits', async () => {
    let now = noon;
    const recorded = vi.fn();
    const cursor: ChatMetricsCursor = { at: new Date(noon - 100).toISOString(), runId: 'fixture-cursor', kind: 'start' };
    const previous = sample('already-seen', noon - 100);
    const late = sample('late-commit', noon - 200);
    const next = sample('fresh', noon + 100);
    const firstRange = { fromMs: noon - (hourlySlots - 1) * hourMs, toMs: noon };
    const read = vi.fn<Parameters<typeof createChatMetricsRefresh>[0]>()
      .mockImplementationOnce(async request => {
        expect(request).toEqual(firstRange);
        return { samples: [previous], nextCursor: cursor };
      })
      .mockImplementationOnce(async request => {
        expect(request).toEqual({ ...firstRange, cursor });
        return { samples: [] };
      })
      .mockImplementationOnce(async request => {
        expect(request).toEqual({ fromMs: noon - 30_000, toMs: now });
        return { samples: [late, previous, next] };
      });
    const collector = createChatMetricsRefresh(read, recorded, () => now);
    expect(collector.isAvailable()).toBe(false);
    expect(await collector.refreshPage()).toBe(true);
    now += 15_000;
    expect(await collector.refreshPage()).toBe(false);
    expect(collector.isAvailable()).toBe(true);
    expect(await collector.refreshPage()).toBe(false);
    expect(recorded.mock.calls).toEqual([previous, late, next].map(row => [row.role, row.observation, row.atMs]));
  });

  it('retains cached measurements and resumes the same failed range when the database recovers', async () => {
    let now = noon;
    const recorded = vi.fn();
    const read = vi.fn<Parameters<typeof createChatMetricsRefresh>[0]>()
      .mockResolvedValueOnce({ samples: [sample('first', now - 1)] })
      .mockRejectedValueOnce(new Error('fixture outage'))
      .mockResolvedValueOnce({ samples: [sample('second', now + 1)] });
    const collector = createChatMetricsRefresh(read, recorded, () => now);
    await collector.refreshPage();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(collector.isAvailable()).toBe(true);
    now += 15_000;
    await collector.refreshPage();
    expect(collector.isAvailable()).toBe(false);
    expect(recorded).toHaveBeenCalledTimes(1);
    now += 15_000;
    await collector.refreshPage();
    expect(read.mock.calls[2]).toEqual(read.mock.calls[1]);
    expect(collector.isAvailable()).toBe(true);
    expect(recorded).toHaveBeenCalledTimes(2);
  });

  it('skips older samples already applied when a page has to be retried', async () => {
    const first = sample('first', noon - hourMs);
    const second = sample('retry', noon - hourMs + 10);
    const record = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
      throw new Error('fixture interruption during aggregation');
    });
    const collector = createChatMetricsRefresh(async () => ({ samples: [first, second] }), record, () => noon);
    await collector.refreshPage();
    expect(collector.isAvailable()).toBe(false);
    await collector.refreshPage();
    expect(collector.isAvailable()).toBe(true);
    expect(record.mock.calls.map(call => call[2])).toEqual([first.atMs, second.atMs, second.atMs]);
  });
});
