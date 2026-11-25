import { createDatabase, migrate } from '@mohassan/database';
import { migrateAuth } from '../../apps/server/src/auth.js';
import { migrateMonitors } from '../../apps/server/src/monitors/migration.js';
import { monitorTiming } from '../../apps/server/src/monitors/schedule.js';
import { GITHUB_BATCH_INTERVAL_MS, GITHUB_BATCH_REQUEST_LIMIT, GITHUB_BATCH_TIMEOUT_MS, GITHUB_PRIMARY_LIMIT, GITHUB_WINDOW_MS } from '../../apps/server/src/monitors/sources/github-network.js';
import { createMonitorReader, type MonitorSourceCache } from '../../apps/server/src/monitors/sources.js';
import { createMonitorStore } from '../../apps/server/src/monitors/store.js';
import { migrateReminders } from '../../apps/server/src/reminders/migration.js';
import { Phase2FixtureNetwork } from './phase2-fixtures.js';
import { githubBudgetSource, githubFixtureResponse } from './phase2-github-fixtures.js';
import type { MonitorSpec } from '@mohassan/contracts';

export async function simulateGithubBudget() {
  const accountCount = 80;
  const workerCount = 8;
  const start = Date.UTC(2026, 10, 9);
  const rounds = Math.ceil(4 * GITHUB_WINDOW_MS / GITHUB_BATCH_INTERVAL_MS);
  const database = await createDatabase();
  let clock = start;
  let deferred = 0;
  let completedBatches = 0;
  let unsuccessfulBatches = 0;
  let conditionalRequests = 0;
  const dispatchTimes: number[] = [];
  const caches = new Map<string, MonitorSourceCache>();
  const spec: MonitorSpec = { source: githubBudgetSource, read: { kind: 'status' }, condition: { kind: 'equals', value: 'success' },
    language: 'en', title: 'Public CI', message: 'CI succeeded.', timing: monitorTiming(githubBudgetSource.kind, 'normal', { now: new Date(start) }),
    v2: { freshnessMs: GITHUB_WINDOW_MS } };

  try {
    await migrateAuth(database.db);
    await migrate(database.db);
    await migrateReminders(database.db);
    await migrateMonitors(database.db);
    let sent = 0;
    const network = new Phase2FixtureNetwork(() => clock, (url, at, options) => {
      // Spread dispatches across the full permitted batch lifetime, including its last millisecond.
      const delay = Math.min(sent, GITHUB_BATCH_REQUEST_LIMIT - 1) * (GITHUB_BATCH_TIMEOUT_MS - 1) / (GITHUB_BATCH_REQUEST_LIMIT - 1);
      dispatchTimes.push(at + delay);
      sent++;
      conditionalRequests += Number(Boolean(options?.headers?.['if-none-match']));
      return githubFixtureResponse(url, at, Infinity, 'open', 'success', GITHUB_BATCH_REQUEST_LIMIT - 2);
    });
    const workers = Array.from({ length: workerCount }, () => ({
      store: createMonitorStore(database.db, { now: () => new Date(clock), v2: true }),
      reader: createMonitorReader({ db: database.db, network, clock: () => clock, flags: { github: true, pdf: false, visual: false } }),
    }));
    for (let round = 0; round < rounds; round++) {
      clock = start + round * GITHUB_BATCH_INTERVAL_MS;
      sent = 0;
      await Promise.all(Array.from({ length: accountCount }, async (_, account) => {
        const { store, reader } = workers[(account + round) % workerCount];
        const ownerId = `fixture-account-${account}`;
        const result = await reader.read(spec, { ownerId, v2: true, reserveHost: store.reserveHost, extendHost: store.extendHost, cache: caches.get(ownerId) });
        if (result.kind === 'deferred') deferred++;
        else if (result.kind === 'value' || result.kind === 'unchanged') {
          completedBatches++;
          if (result.cache) caches.set(ownerId, result.cache);
        } else unsuccessfulBatches++;
      }));
    }
  } finally {
    await database.close();
  }

  dispatchTimes.sort((left, right) => left - right);
  let first = 0;
  let peakRequestsPerRollingHour = 0;
  let budgetViolations = 0;
  dispatchTimes.forEach((time, last) => {
    while (time - dispatchTimes[first] >= GITHUB_WINDOW_MS) first++;
    const count = last - first + 1;
    peakRequestsPerRollingHour = Math.max(count, peakRequestsPerRollingHour);
    if (count > GITHUB_PRIMARY_LIMIT) budgetViolations++;
  });

  return { accountCount, workerCount, rounds, attempts: accountCount * rounds, deferred, completedBatches, unsuccessfulBatches,
    dispatchedRequests: dispatchTimes.length, conditionalRequests, batchLimit: GITHUB_BATCH_REQUEST_LIMIT, batchIntervalMs: GITHUB_BATCH_INTERVAL_MS,
    budgetPerRollingHour: GITHUB_PRIMARY_LIMIT, peakRequestsPerRollingHour, budgetViolations,
    saturated: completedBatches === rounds && dispatchTimes.length === rounds * GITHUB_BATCH_REQUEST_LIMIT };
}
