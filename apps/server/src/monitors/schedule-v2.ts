import type { MonitorSpec } from '@mohassan/contracts';
import { MONITOR_LIMITS, monitorTiming, nextMonitorCheck } from './schedule.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const week = 7 * day;
const phaseStep = 15 * minute;
const recentHorizon = 6 * hour;
const observationLimit = 64;
const publicationLimit = 144;
const publicationHistory = 4 * week;

interface ChangeWindow { from: number; to: number }

export interface MonitorScheduleState {
  firstAt: number;
  lastAt: number;
  changes: number;
  windows: ChangeWindow[];
  publications: number[];
}

type ScheduleSpec = Pick<MonitorSpec, 'source' | 'timing'> & Partial<Pick<MonitorSpec, 'condition'>>;

export function learnMonitorSchedule(previous: MonitorScheduleState | null | undefined, at: Date,
  { changed, publicationTimes = [] }: { changed: boolean; publicationTimes?: readonly string[] },
): MonitorScheduleState {
  const timestamp = at.getTime();
  if (previous && timestamp <= previous.lastAt) return previous;
  const publications = [...new Set([
    ...(previous?.publications ?? []),
    ...publicationTimes.map(value => Date.parse(value)),
  ])].filter(time => time >= timestamp - publicationHistory && time <= timestamp)
    .sort((left, right) => left - right).slice(-publicationLimit);
  if (!previous) return { firstAt: timestamp, lastAt: timestamp, changes: 0, windows: [], publications };

  const published = publications.filter(time => time > previous.lastAt).length;
  const windows = changed && published === 0
    ? [...previous.windows, { from: previous.lastAt, to: timestamp }].slice(-observationLimit) : previous.windows;
  return { ...previous, lastAt: timestamp, changes: previous.changes + Math.max(published, Number(changed)), windows, publications };
}

function phaseBin(at: number, period: number) {
  return Math.floor(((at % period) + period) % period / phaseStep);
}

function addPhase(histogram: Float64Array, at: number, period: number, weight: number) {
  const bin = phaseBin(at, period);
  // Spread each observation across adjacent bins to tolerate modest publication jitter.
  histogram[bin] += weight / 2;
  histogram[(bin + 1) % histogram.length] += weight / 4;
  histogram[(bin + histogram.length - 1) % histogram.length] += weight / 4;
}

function concentration(histogram: Float64Array, window: number, samples: number): number {
  if (!samples) return 0;
  let mass = 0;
  let peak = 0;
  for (let index = 0; index < histogram.length + window - 1; index++) {
    mass += histogram[index % histogram.length];
    if (index >= window) mass -= histogram[(index - window) % histogram.length];
    peak = Math.max(peak, mass);
  }
  const uniform = window / histogram.length;
  return Math.max(0, (peak / samples - uniform) / (1 - uniform));
}

function forecast(state: MonitorScheduleState | null | undefined, now: number) {
  if (!state || (!state.publications.length && !state.windows.length)) return;
  const daily = new Float64Array(day / phaseStep);
  const weekly = new Float64Array(week / phaseStep);
  const days = new Set<number>();
  const weeks = new Set<number>();
  let recent = 0;
  let samples = 0;
  const add = (from: number, to: number) => {
    if (to < now - publicationHistory) return;
    const midpoint = (from + to) / 2;
    days.add(Math.floor(midpoint / day));
    weeks.add(Math.floor(midpoint / week));
    samples++;
    recent += to >= now - recentHorizon ? 1 : 0;
    const bins = Math.max(1, Math.ceil((to - from) / phaseStep));
    for (let index = 0; index < bins; index++) {
      const time = from + (to - from) * (index + 0.5) / bins;
      addPhase(daily, time, day, 1 / bins);
      addPhase(weekly, time, week, 1 / bins);
    }
  };
  for (const time of state.publications) add(time, time);
  for (const change of state.windows) add(Math.max(change.from, change.to - MONITOR_LIMITS.maxIntervalMs), change.to);

  const weeklyStrength = weeks.size >= 2 ? concentration(weekly, day / phaseStep, samples) : 0;
  const weeklyWeight = 0.75 * weeklyStrength;
  const dailyWeight = days.size >= 2 ? 0.75 * (1 - weeklyStrength) * concentration(daily, 4 * hour / phaseStep, samples) : 0;
  if (!weeklyWeight && !dailyWeight && recent < 2) return;
  const uniformWeight = 1 - dailyWeight - weeklyWeight;
  const density = (at: number) => {
    const dailyDensity = dailyWeight ? dailyWeight * daily[phaseBin(at, day)] * daily.length / samples : 0;
    const weeklyDensity = weeklyWeight ? weeklyWeight * weekly[phaseBin(at, week)] * weekly.length / samples : 0;
    // Two nearby changes are enough to consider a short burst, with a half-life of one quiet interval.
    const burst = recent > 1 ? Math.min(1, (recent - 1) / 2) * 2 ** (-(at - now) / recentHorizon) : 0;
    return uniformWeight + dailyDensity + weeklyDensity + burst;
  };
  // Require three timestamped releases across two weekly cycles before deferring exploratory checks.
  const publicationSpan = (state.publications.at(-1) ?? now) - (state.publications[0] ?? now);
  const trustedWeekly = recent < 2 && state.publications.length >= 3 && publicationSpan >= 2 * week - day && weeklyStrength >= 0.75;
  const currentBin = phaseBin(now, week);
  let quietWeekly = trustedWeekly;
  for (let offset = 0; quietWeekly && offset <= day / phaseStep; offset++) {
    quietWeekly = weekly[(currentBin + offset) % weekly.length] <= samples / weekly.length;
  }
  return { density, quietWeekly };
}

function crossingAllowance(lifetime: number, initial: number): number {
  let elapsed = 0;
  let count = 0;
  let interval = initial;
  while (elapsed + interval < lifetime && interval < MONITOR_LIMITS.maxIntervalMs) {
    elapsed += interval;
    interval *= 2;
    count++;
  }
  return count + Math.max(0, Math.ceil((lifetime - elapsed) / MONITOR_LIMITS.maxIntervalMs) - 1);
}

function planFirstCheck(now: number, horizon: number, count: number, floor: number, density: (at: number) => number): number {
  // An interval's two prefix sums make its intensity-weighted detection delay constant-time.
  const times = [now];
  const grid = Math.min(phaseStep, Math.max(MONITOR_LIMITS.pollMs, Math.floor((horizon - now) / (2 * count))));
  for (let time = Math.ceil((now + floor) / grid) * grid; time < horizon; time += grid) times.push(time);
  times.push(horizon);
  const mass = new Float64Array(times.length);
  const weightedTime = new Float64Array(times.length);
  for (let index = 1; index < times.length; index++) {
    const start = times[index - 1] - now;
    const end = times[index] - now;
    const middle = (start + end) / 2;
    const volume = density(now + middle) * (end - start) / hour;
    mass[index] = mass[index - 1] + volume;
    weightedTime[index] = weightedTime[index - 1] + volume * middle / hour;
  }

  let costs = new Float64Array(times.length).fill(Infinity);
  let first = new Float64Array(times.length);
  costs[0] = 0;
  for (let used = 1; used <= count; used++) {
    const nextCosts = new Float64Array(times.length).fill(Infinity);
    const nextFirst = new Float64Array(times.length);
    for (let end = used; end < times.length; end++) {
      for (let start = end - 1; start >= used - 1; start--) {
        const gap = times[end] - times[start];
        if (gap > MONITOR_LIMITS.maxIntervalMs) break;
        if (gap < floor) continue;
        const delay = (times[end] - now) / hour * (mass[end] - mass[start]) - weightedTime[end] + weightedTime[start];
        const cost = costs[start] + delay;
        if (cost < nextCosts[end]) {
          nextCosts[end] = cost;
          nextFirst[end] = first[start] || times[end];
        }
      }
    }
    costs = nextCosts;
    first = nextFirst;
  }
  return first.at(-1) || now + Math.min(MONITOR_LIMITS.maxIntervalMs, (horizon - now) / count);
}

export function nextPredictiveMonitorCheck(spec: ScheduleSpec, at: Date, {
  state, expiry, checksUsed, failed = false, needsConfirmation = false, confirmNoEarlierThan, priorIntervalMs, changed = false,
}: {
  state?: MonitorScheduleState | null; expiry: Date; checksUsed: number; failed?: boolean; needsConfirmation?: boolean;
  confirmNoEarlierThan?: number; priorIntervalMs?: number; changed?: boolean;
}) {
  const now = at.getTime();
  const floor = monitorTiming(spec.source.kind, 'urgent', { now: at }).initialIntervalMs;
  const end = expiry.getTime();
  const hardRemaining = spec.timing.maxChecks - checksUsed;
  const deadline = spec.timing.deadline ? Date.parse(spec.timing.deadline) : Infinity;
  const deadlineWindow = deadline - MONITOR_LIMITS.deadlineWindowMs;
  const latestCheck = end - MONITOR_LIMITS.pollMs;
  function result(due: number) {
    const next = Math.min(end, Math.max(now + floor, due));
    return { dueAt: new Date(next), intervalMs: Math.min(MONITOR_LIMITS.maxIntervalMs, Math.max(floor, next - now)) };
  }
  if (hardRemaining <= 0 || end - now <= floor) return result(end);
  // A brief weather excursion can revert before the next check. Use the responsive cadence until publication timing is known.
  const crossing = spec.condition?.kind === 'crossing' || spec.condition?.kind === 'threshold';
  const transientWeather = spec.source.kind === 'weather' && crossing && (state?.publications.length ?? 0) < 2;
  // A queued run can complete before a cadence can be learned. Keep its initial backoff until a transition is observed.
  const coldRun = spec.source.kind === 'run' && !state?.changes;
  if (transientWeather || coldRun) {
    return nextMonitorCheck(spec, at, priorIntervalMs ?? spec.timing.initialIntervalMs, { changed: !checksUsed || failed || changed, expiry });
  }
  if (deadlineWindow <= now) return result(now + Math.max(floor, Math.floor((latestCheck - now) / hardRemaining)));

  const planningEnd = Math.min(latestCheck, deadlineWindow);
  const minimumChecks = Math.ceil((planningEnd - now) / MONITOR_LIMITS.maxIntervalMs);
  const deadlineChecks = Math.max(0, Math.floor((latestCheck - deadlineWindow) / floor));
  const availableBeforeDeadline = Math.max(1, hardRemaining - Math.min(deadlineChecks, Math.max(0, hardRemaining - minimumChecks)));
  // A measured crossing can disappear between reads. Keep its quick-start checks as additional planning capacity.
  const quiet = crossing ? crossingAllowance(spec.timing.lifetimeMs, spec.timing.initialIntervalMs)
    : Math.ceil(spec.timing.lifetimeMs / MONITOR_LIMITS.maxIntervalMs) + 1;
  const reserve = Math.max(0, spec.timing.maxChecks - quiet);
  const history = state?.publications.filter(time => time < state.firstAt) ?? [];
  const historyExposure = state && history.length > 1 ? state.firstAt - history[0] : 0;
  const exposure = state ? state.lastAt - state.firstAt + historyExposure : 0;
  // One unobserved day of exposure regularizes the rate so early changes cannot spend the lifetime allowance.
  const rate = ((state?.changes ?? 0) + Math.max(0, history.length - 1)) / (day + exposure);
  const extra = Math.min(reserve, Math.floor(rate * spec.timing.lifetimeMs));
  const remaining = Math.min(availableBeforeDeadline, Math.max(1, quiet + extra - checksUsed, minimumChecks));
  if (failed && remaining > minimumChecks) return result(Math.min(deadlineWindow, now + spec.timing.initialIntervalMs));
  // An unconfirmed observation cannot raise the learned rate. Allow it to spend the hard reserve to become evidence.
  if (needsConfirmation && availableBeforeDeadline > minimumChecks) {
    return result(Math.min(deadlineWindow, now + MONITOR_LIMITS.maxIntervalMs, confirmNoEarlierThan ?? now + floor));
  }
  if (!checksUsed && (state?.publications.length ?? 0) < 2) return result(Math.min(deadlineWindow, now + spec.timing.initialIntervalMs));
  if (state?.windows.at(-1)?.to === now && remaining > minimumChecks) {
    return result(Math.min(deadlineWindow, now + spec.timing.initialIntervalMs));
  }
  const prediction = forecast(state, now);
  if (spec.condition?.kind === 'new-item' && prediction?.quietWeekly) {
    return result(Math.min(planningEnd, now + MONITOR_LIMITS.maxIntervalMs));
  }
  const gap = Math.max(floor, Math.min(MONITOR_LIMITS.maxIntervalMs, Math.floor((planningEnd - now) / remaining)));
  const count = Math.min(remaining, Math.ceil(day / gap));
  const horizon = Math.min(planningEnd, now + gap * count);
  const due = prediction ? planFirstCheck(now, horizon, count, floor, prediction.density) : now + gap;
  return result(Math.min(deadlineWindow, due));
}
