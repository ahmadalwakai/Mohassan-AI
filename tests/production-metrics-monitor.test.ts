import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MetricsSnapshots } from '../apps/server/src/ops/metrics/snapshots.js';
import { hourMs, MetricsStore } from '../apps/server/src/ops/metrics/store.js';

it('restores only timing samples and fixed counts for the last 168 completed UTC hours', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-metric-snapshots-'));
  const start = Date.UTC(2026, 10, 22);
  let clock = start + 1_000;
  const options = { now: () => clock };
  const store = new MetricsStore(options);
  const snapshots = new MetricsSnapshots(store, directory);
  try {
    await snapshots.load();
    store.recordMonitor({ kind: 'check', latenessMs: 1024, succeeded: true });
    store.recordMonitor({ kind: 'check', latenessMs: 4096, succeeded: false });
    store.recordMonitor({ kind: 'pause', reason: 'unreachable' });
    store.recordMonitor({ kind: 'delivery', channel: 'apns' });
    await snapshots.flush({ includeCurrentHour: true });
    clock = start + 168 * hourMs + 2_000;
    expect(store.view().completedMonitorWeek?.monitors.checks).toEqual({ attempted: 2, succeeded: 1, successRate: 0.5 });

    const reopened = new MetricsStore(options);
    const persisted = new MetricsSnapshots(reopened, directory);
    await persisted.load();
    reopened.recordMonitor({ kind: 'check', latenessMs: 1024, succeeded: true });
    const view = reopened.view();
    expect(view.completedMonitorWeek).toEqual({
      startMs: start, endMs: start + 168 * hourMs,
      monitors: {
        checkLatenessMs: { samples: 2, p50: 1024, p95: 4096 },
        checks: { attempted: 2, succeeded: 1, successRate: 0.5 },
        delivered: { conversation: 0, tab: 0, webPush: 0, apns: 1 },
        pauses: { manual: 0, missing: 0, unreachable: 1 },
      },
    });
    expect(view.windows.week.monitors?.checks).toEqual({ attempted: 1, succeeded: 1, successRate: 1 });

    const [file] = await readdir(directory);
    const disk = JSON.parse(await readFile(join(directory, file), 'utf8'));
    expect(disk.minutes[0][1].monitors).toEqual({
      checked: 2, succeeded: 1,
      delivered: { conversation: 0, tab: 0, webPush: 0, apns: 1 },
      pauses: { manual: 0, missing: 0, unreachable: 1 },
      lateness: { maxMs: 4096, counts: [[26, 1], [30, 1]] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
