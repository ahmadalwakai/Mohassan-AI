import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { metricsCsv } from '../apps/server/src/ops/metrics/csv.js';
import { MetricsSnapshots } from '../apps/server/src/ops/metrics/snapshots.js';
import { MetricsStore } from '../apps/server/src/ops/metrics/store.js';

function report(store: MetricsStore) {
  return { ...store.view(), enabled: true, snapshotAvailable: true, chatAvailable: true };
}

it('exports and restores only owner v5 totals, and omits them with the switch off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v5-chat-metrics-'));
  const options = { now: () => Date.UTC(2026, 10, 26, 1, 30) };
  try {
    const store = new MetricsStore(options);
    const snapshots = new MetricsSnapshots(store, directory, { restoreChat: false });
    await snapshots.load();
    store.recordRequest('owner', 'GET /api/access', 200, 32);
    const before = report(store);
    store.recordV5Chat({ generation: true, latencyMs: 1024, stopReason: 'eos' });
    store.recordV5Chat({ generation: true, latencyMs: 2048, stopReason: 'length', loopCut: true });
    store.recordV5Chat({ generation: true, latencyMs: 4096, timeout: true, fallback: true });
    store.recordV5Chat({ fallback: true });
    const totals = {
      generations: 3, latency: { samples: 3, p50: 2048, p90: 4096, p99: 4096 },
      eosStops: 1, lengthStops: 1, loopCuts: 1, timeouts: 1, fallbacks: 2,
    };
    const active = report(store);
    for (const window of Object.values(active.windows)) {
      expect(window.roles.owner.chat.v5).toEqual(totals);
      expect(window.roles.member.chat).not.toHaveProperty('v5');
    }
    const csv = metricsCsv(active);
    expect(csv).toContain('owner,v5_chat,generations,3');
    expect(csv).toContain('owner,v5_chat,latency,,3,2048,4096,4096');
    expect(csv).not.toContain('member,v5_chat');

    await snapshots.flush({ includeCurrentHour: true });
    const [file] = await readdir(directory);
    const disk = JSON.parse(await readFile(join(directory, file), 'utf8'));
    expect(disk.minutes[0][1].v5Chat).toEqual({
      generations: 3, eosStops: 1, lengthStops: 1, loopCuts: 1, timeouts: 1, fallbacks: 2,
      latency: { maxMs: 4096, counts: [[26, 1], [28, 1], [30, 1]] },
    });

    const reopened = new MetricsStore(options);
    await new MetricsSnapshots(reopened, directory, { restoreChat: false }).load();
    expect(report(reopened)).toEqual(active);

    const disabled = new MetricsStore(options);
    await new MetricsSnapshots(disabled, directory, { restoreChat: false, restoreV5Chat: false }).load();
    expect(JSON.stringify(report(disabled))).toBe(JSON.stringify(before));
    expect(metricsCsv(report(disabled))).toBe(metricsCsv(before));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
