import type { MonitorSpec } from '@mohassan/contracts';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export const MONITOR_LIMITS = {
  defaultLifetimeMs: 7 * day,
  maxLifetimeMs: 30 * day,
  proposalLifetimeMs: 30 * minute,
  maxIntervalMs: 6 * hour,
  hostIntervalMs: minute,
  deadlineWindowMs: hour,
  maxNotifications: 3,
  consecutiveFailures: 3,
  pollMs: 30_000,
  readTimeoutMs: 30_000,
  leaseMs: 2 * minute,
  workPerPoll: 10,
  concurrentReads: 4,
  listLimit: 100,
  account: {
    owner: { monitors: 10, previews: 40, checks: 240, notifications: 40 },
    member: { monitors: 3, previews: 12, checks: 96, notifications: 12 },
  },
} as const;

const intervals = {
  page: { normal: 15 * minute, urgent: 5 * minute },
  currency: { normal: hour, urgent: 15 * minute },
  weather: { normal: 30 * minute, urgent: 10 * minute },
  search: { normal: hour, urgent: 30 * minute },
  run: { normal: 2 * minute, urgent: minute },
} satisfies Record<MonitorSpec['source']['kind'], Record<MonitorSpec['timing']['urgency'], number>>;

export function monitorTiming(
  source: MonitorSpec['source']['kind'], urgency: MonitorSpec['timing']['urgency'],
  { now, lifetimeMs = MONITOR_LIMITS.defaultLifetimeMs, deadline, requestedIntervalMs }: {
    now: Date; lifetimeMs?: number; deadline?: string; requestedIntervalMs?: number;
  },
): MonitorSpec['timing'] {
  const deadlineAt = deadline ? Date.parse(deadline) : NaN;
  const maxLifetime = Math.min(MONITOR_LIMITS.maxLifetimeMs, Math.max(minute, Math.floor(lifetimeMs)));
  const duration = deadlineAt > now.getTime() ? Math.min(maxLifetime, deadlineAt - now.getTime()) : maxLifetime;
  const interval = requestedIntervalMs === undefined ? intervals[source][urgency]
    : Math.max(intervals[source].urgent, Math.min(MONITOR_LIMITS.maxIntervalMs, Math.floor(requestedIntervalMs)));
  return {
    urgency, lifetimeMs: duration, initialIntervalMs: interval,
    ...(deadlineAt > now.getTime() && { deadline: new Date(deadlineAt).toISOString() }),
    // One check per maximum quiet interval plus room for four extra checks on each of the first six days.
    maxChecks: Math.ceil(duration / MONITOR_LIMITS.maxIntervalMs) + 24,
    maxNotifications: MONITOR_LIMITS.maxNotifications,
  };
}

export function monitorExpiry(timing: MonitorSpec['timing'], at: Date): Date {
  return new Date(Math.min(at.getTime() + timing.lifetimeMs, timing.deadline ? Date.parse(timing.deadline) : Infinity));
}

export function initialMonitorCheck(spec: MonitorSpec, at: Date, expiry: Date) {
  return nextMonitorCheck(spec, at, spec.timing.initialIntervalMs, { changed: true, expiry });
}

export function nextMonitorCheck(spec: MonitorSpec, at: Date, priorIntervalMs: number, {
  changed, expiry,
}: { changed: boolean; expiry: Date }) {
  const earliest = intervals[spec.source.kind].urgent;
  const deadline = spec.timing.deadline ? Date.parse(spec.timing.deadline) : Infinity;
  const nearDeadline = deadline - at.getTime() <= MONITOR_LIMITS.deadlineWindowMs;
  const intervalMs = nearDeadline ? earliest : changed ? spec.timing.initialIntervalMs
    : Math.min(MONITOR_LIMITS.maxIntervalMs, priorIntervalMs * 2);
  const tightenAt = nearDeadline ? Infinity : Math.max(at.getTime() + earliest, deadline - MONITOR_LIMITS.deadlineWindowMs);
  const dueAt = new Date(Math.min(expiry.getTime(), at.getTime() + intervalMs, tightenAt));
  return { intervalMs, dueAt };
}

export function nextMonitorBudgetDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}
