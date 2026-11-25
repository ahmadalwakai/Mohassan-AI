import { describe, expect, it } from 'vitest';
import type { MonitorSpec } from '@mohassan/contracts';
import { MONITOR_LIMITS, monitorExpiry, monitorTiming, nextMonitorCheck } from '../apps/server/src/monitors/schedule.js';
import { learnMonitorSchedule, nextPredictiveMonitorCheck } from '../apps/server/src/monitors/schedule-v2.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = new Date(Date.UTC(2026, 10, 25, 6));
const offset = (ms: number) => new Date(now.getTime() + ms);

function pageSpec(deadline?: string): MonitorSpec {
  return {
    source: { kind: 'page', url: 'https://fixture.example.test' }, read: { kind: 'items' }, condition: { kind: 'new-item' },
    title: 'Local fixture', message: 'New item', language: 'en', timing: monitorTiming('page', 'normal', { now, deadline }),
  };
}

describe('predictive smart monitor schedules', () => {
  it('learns elapsed exposure and keeps unique publication times within bounded history', () => {
    const time = offset(-hour).toISOString();
    const preview = learnMonitorSchedule(undefined, now, { changed: false, publicationTimes: [
      time, time, offset(-29 * day).toISOString(), offset(4 * hour).toISOString(), 'invalid',
    ] });
    expect(preview.publications).toEqual([Date.parse(time)]);
    expect(preview.changes).toBe(0);

    const firstPublication = offset(hour).toISOString();
    const secondPublication = offset(80 * minute).toISOString();
    const observed = learnMonitorSchedule(preview, offset(2 * hour), { changed: true, publicationTimes: [firstPublication, secondPublication] });
    expect(observed.changes).toBe(2);
    expect(observed.windows).toEqual([]);
    expect(learnMonitorSchedule(observed, offset(hour), { changed: true })).toBe(observed);

    const confirmed = learnMonitorSchedule(observed, offset(3 * hour), { changed: true, publicationTimes: [secondPublication] });
    expect(confirmed.changes).toBe(3);
    expect(confirmed.windows).toEqual([{ from: offset(2 * hour).getTime(), to: offset(3 * hour).getTime() }]);
    expect(confirmed.firstAt).toBe(now.getTime());
    expect(confirmed.lastAt).toBe(offset(3 * hour).getTime());
  });

  it('uses the same quiet-work allowance as v1 and visits the entire lifetime within the six-hour cap', () => {
    const spec = pageSpec();
    const expiry = monitorExpiry(spec.timing, now);
    let at = now;
    let checks = 0;
    let state = learnMonitorSchedule(undefined, now, { changed: false });
    while (checks < spec.timing.maxChecks) {
      const next = nextPredictiveMonitorCheck(spec, at, { state, expiry, checksUsed: checks });
      expect(next.intervalMs).toBeGreaterThanOrEqual(monitorTiming('page', 'urgent', { now }).initialIntervalMs);
      expect(next.intervalMs).toBeLessThanOrEqual(MONITOR_LIMITS.maxIntervalMs);
      if (next.dueAt >= expiry) break;
      at = next.dueAt;
      state = learnMonitorSchedule(state, at, { changed: false });
      checks++;
    }

    let legacyAt = now;
    let legacyInterval = spec.timing.initialIntervalMs;
    let legacyChecks = 0;
    while (legacyChecks < spec.timing.maxChecks) {
      const next = nextMonitorCheck(spec, legacyAt, legacyInterval, { changed: legacyChecks === 0, expiry });
      if (next.dueAt >= expiry) break;
      legacyAt = next.dueAt;
      legacyInterval = next.intervalMs;
      legacyChecks++;
    }
    expect(checks).toBe(legacyChecks);
    expect(at.getTime()).toBeGreaterThanOrEqual(legacyAt.getTime());
    expect(at.getTime()).toBeLessThan(expiry.getTime());
  });

  it('moves work near a learned publication phase and reduces that preference on other weekdays', () => {
    const spec = pageSpec();
    const expiry = monitorExpiry(spec.timing, now);
    const publishOffset = 2 * hour;
    const seed = (daysAgo: number[]) => learnMonitorSchedule(undefined, now, { changed: false,
      publicationTimes: daysAgo.map(days => offset(-days * day + publishOffset).toISOString()) });
    const predict = (daysAgo: number[]) => nextPredictiveMonitorCheck(spec, now, { state: seed(daysAgo), expiry, checksUsed: 0 }).dueAt;
    const publication = offset(publishOffset).getTime();
    const daily = predict([1, 2, 3, 4]).getTime();
    const weeklyToday = predict([7, 14, 21]).getTime();
    const weeklyTomorrow = predict([6, 13, 20]).getTime();
    expect(daily).toBeGreaterThan(publication);
    expect(daily).toBeLessThan(weeklyTomorrow);
    expect(weeklyToday).toBeGreaterThan(publication);
    expect(weeklyToday).toBeLessThan(weeklyTomorrow);
    // A forecast from one monitor never influences the next monitor's cold start.
    expect(nextPredictiveMonitorCheck(spec, now, { expiry, checksUsed: 0 }).intervalMs).toBe(spec.timing.initialIntervalMs);
  });

  it('shortens the next gap for an observed burst and keeps failed or provisional reads out of learning', () => {
    const spec = pageSpec();
    const expiry = monitorExpiry(spec.timing, now);
    let steady = learnMonitorSchedule(undefined, offset(-7 * hour), { changed: false });
    let burst = structuredClone(steady);
    for (let ago = 6; ago >= 0; ago--) {
      steady = learnMonitorSchedule(steady, offset(-ago * hour), { changed: false });
      burst = learnMonitorSchedule(burst, offset(-ago * hour), { changed: true });
    }
    const predict = (state: typeof steady) => nextPredictiveMonitorCheck(spec, now, { state, expiry, checksUsed: 7 }).intervalMs;
    expect(predict(burst)).toBeLessThan(predict(steady));
    const failure = nextPredictiveMonitorCheck(spec, now, { state: burst, expiry, checksUsed: 7, failed: true });
    expect(failure.intervalMs).toBe(spec.timing.initialIntervalMs);
    const confirmation = nextPredictiveMonitorCheck(spec, now, { state: burst, expiry, checksUsed: 7, needsConfirmation: true });
    expect(confirmation.intervalMs).toBe(monitorTiming('page', 'urgent', { now }).initialIntervalMs);
    const confirmNoEarlierThan = offset(hour).getTime();
    const separated = nextPredictiveMonitorCheck(spec, now, { state: burst, expiry, checksUsed: 7, needsConfirmation: true, confirmNoEarlierThan });
    expect(separated.dueAt.getTime()).toBe(confirmNoEarlierThan);
    expect(burst.changes).toBe(7);
  });

  it('reserves coverage before a deadline and uses a final useful slot when only one check remains', () => {
    const expiry = offset(4 * hour);
    const spec = pageSpec(expiry.toISOString());
    const deadlineWindow = new Date(expiry.getTime() - MONITOR_LIMITS.deadlineWindowMs);
    const during = nextPredictiveMonitorCheck(spec, deadlineWindow, { expiry, checksUsed: 1 });
    expect(during.intervalMs).toBe(monitorTiming('page', 'urgent', { now }).initialIntervalMs);

    const final = nextPredictiveMonitorCheck(spec, deadlineWindow, { expiry, checksUsed: spec.timing.maxChecks - 1 });
    expect(final.dueAt.getTime()).toBe(expiry.getTime() - MONITOR_LIMITS.pollMs);
    expect(nextPredictiveMonitorCheck(spec, final.dueAt, { expiry, checksUsed: spec.timing.maxChecks }).dueAt).toEqual(expiry);
  });

  it('retains short-interval weather crossing sensitivity without publication evidence', () => {
    const spec: MonitorSpec = {
      ...pageSpec(), source: { kind: 'weather', location: 'Local observatory', metric: 'temperature' },
      condition: { kind: 'crossing', direction: 'above', value: 31, hysteresis: 0.5 },
      read: { kind: 'number' }, timing: monitorTiming('weather', 'normal', { now }),
    };
    const expiry = monitorExpiry(spec.timing, now);
    let current = now;
    let priorIntervalMs = spec.timing.initialIntervalMs;
    let state = learnMonitorSchedule(undefined, now, { changed: false });
    for (const [index, changed] of [true, false, true, false, false].entries()) {
      const expected = nextMonitorCheck(spec, current, priorIntervalMs, { changed, expiry });
      const next = nextPredictiveMonitorCheck(spec, current, { state, expiry, checksUsed: index, priorIntervalMs, changed });
      expect(next).toEqual(expected);
      current = next.dueAt;
      priorIntervalMs = next.intervalMs;
      state = learnMonitorSchedule(state, current, { changed });
    }
  });
});
