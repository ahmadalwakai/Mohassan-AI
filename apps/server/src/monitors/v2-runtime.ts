import { monitorV2Targets, type MonitorSpec } from '@mohassan/contracts';
import type { Kysely } from 'kysely';
import type { WorkspaceRole } from '../members.js';
import type { MonitorMetricEvent } from '../ops/metrics/monitor-events.js';
import { monitorHealth, monitorV2Trigger, publishMonitorNotice } from './delivery.js';
import { evaluateMonitorV2, monitorV2DigestDueAt, monitorV2SourceSpec } from './evaluation-v2.js';
import { MONITOR_LIMITS, monitorTiming } from './schedule.js';
import { GITHUB_API_HOST } from './sources/github-network.js';
import { learnMonitorSchedule, nextPredictiveMonitorCheck } from './schedule-v2.js';
import type { MonitorRow } from './store.js';
import type { MonitorReadOptions } from './sources.js';
import type { createMonitorReader } from './sources.js';
import type { MonitorV2Preview, MonitorV2State } from './v2-runtime-types.js';

type Read = ReturnType<typeof createMonitorReader>['read'];

export function monitorSourceSpec(spec: MonitorSpec, index: number): MonitorSpec {
  return monitorV2SourceSpec(spec, monitorV2Targets(spec)[index]!);
}

/** Ordinary previews share a host slot. GitHub budgets every adapter batch separately. */
export async function prepareMonitorV2Preview(read: Read, spec: MonitorSpec,
  options: MonitorReadOptions): Promise<{ preview: MonitorV2Preview } | { result: Awaited<ReturnType<Read>> }> {
  const { reserveHost } = options;
  const reservations = new Map<string, Promise<number | null>>();
  const reserve: MonitorReadOptions['reserveHost'] = reserveHost && ((host, delay) => {
    if (host === GITHUB_API_HOST && delay !== undefined) return reserveHost(host, delay);
    const existing = reservations.get(host);
    if (existing) return existing;
    const reservation = reserveHost(host, delay);
    reservations.set(host, reservation);
    return reservation;
  });
  const sources = monitorV2Targets(spec);
  const preview: MonitorV2Preview = { samples: [], caches: sources.map(() => null) };
  for (let index = 0; index < sources.length; index++) {
    const result = await read(monitorSourceSpec(spec, index), { ...options, reserveHost: reserve, v2: true });
    if (result.kind === 'clarify') {
      const clarification = { index, candidates: result.candidates, cache: result.cache };
      if (preview.clarification) (preview.additionalClarifications ??= []).push(clarification);
      else preview.clarification = clarification;
    } else if (result.kind !== 'value') {
      return { result };
    } else {
      preview.samples.push({ index, observation: result.observation });
      preview.caches[index] = result.cache ?? null;
      if (result.publicationTimes?.length) preview.publicationTimes = [...(preview.publicationTimes ?? []), ...result.publicationTimes];
    }
  }
  return { preview };
}

type ReadResult = Awaited<ReturnType<Read>>;
type RunningResult = Exclude<ReadResult, { kind: 'deferred' }>;
const MAX_RELOCATIONS = 20;

export function v2ReadState(row: MonitorRow): MonitorV2State {
  if (row.v2_state) return row.v2_state;
  const observation = row.evaluation?.observation;
  const targets = monitorV2Targets(row.spec);
  const caches = targets.map(() => null);
  return { cursor: 0, caches, ...(observation && {
    evaluation: evaluateMonitorV2(row.spec, undefined, [{ index: 0, observation }], new Date(observation.observedAt), { canDeliver: false }).state,
    schedule: learnMonitorSchedule(undefined, new Date(observation.observedAt), { changed: false }),
  }) };
}

export async function finishV2Check(tx: Kysely<any>, row: MonitorRow, role: WorkspaceRole,
  result: RunningResult, at: Date, expiry: Date, observe: (event: MonitorMetricEvent) => void) {
  const state = v2ReadState(row);
  const targets = monitorV2Targets(row.spec);
  const index = state.cursor;
  const count = targets.length;
  const nextIndex = (index + 1) % count;
  const remaining = row.spec.timing.maxChecks - row.checks;
  const canDeliver = row.notifications < row.spec.timing.maxNotifications && !row.pending_notice;
  const attempts = state.failures ??= [];
  const last = { lease_token: null, lease_until: null, last_checked_at: at };
  const needsChoice = result.kind === 'clarify';
  const unsafe = result.kind === 'unsafe-target';
  const failed = result.kind === 'unreachable' || result.kind === 'missing';
  attempts[index] = failed ? (attempts[index] ?? 0) + 1 : 0;
  const pause = needsChoice || unsafe || (failed && (attempts[index] >= MONITOR_LIMITS.consecutiveFailures || !remaining));
  if (needsChoice) state.clarification = { index, candidates: result.candidates, cache: result.cache, resume: 'active' };
  const previous = state.evaluation;
  const sample = result.kind === 'value' ? result.observation
    : result.kind === 'unchanged' ? previous?.sources[index]?.evaluation.observation : undefined;
  if ('cache' in result && result.cache && !needsChoice) state.caches[index] = result.cache;
  if (result.kind === 'value' && result.relocation) {
    state.relocations = [...(state.relocations ?? []), { ...result.relocation, index }].slice(-MAX_RELOCATIONS);
  }
  const evaluation = evaluateMonitorV2(row.spec, previous, sample ? [{ index, observation: sample,
    revalidated: result.kind === 'unchanged' }] : [], at, { canDeliver: canDeliver && !pause,
    invalidated: needsChoice || unsafe ? [index] : [],
  });
  state.evaluation = evaluation.state;
  if (sample && evaluation.state.sources[index]?.confirmed?.observedAt === (result.kind === 'unchanged' ? at.toISOString() : sample.observedAt)) {
    state.schedule = learnMonitorSchedule(state.schedule, at, {
      changed: evaluation.changed, publicationTimes: 'publicationTimes' in result ? result.publicationTimes : undefined,
    });
  }
  state.cursor = nextIndex;
  const lastReads = state.lastReads ??= targets.map(() => null);
  lastReads[index] = at.getTime();
  const notice = pause ? monitorHealth(row, unsafe ? result.reason ?? result.kind : result.kind as 'clarify' | 'unreachable' | 'missing', at)
    : evaluation.notice ? monitorV2Trigger(row, evaluation.notice, at) : undefined;
  const receipt = notice && canDeliver ? await publishMonitorNotice(tx, row, role, notice, at, observe) : undefined;
  if (pause) observe({ kind: 'pause', reason: result.kind === 'unreachable' ? 'unreachable' : 'missing' });
  const notifications = row.notifications + Number(Boolean(receipt));
  const exhaustedNotices = notifications >= row.spec.timing.maxNotifications;
  const completed = Boolean(evaluation.notice) && ((row.spec.v2?.delivery ?? 'once') === 'once' || exhaustedNotices);
  const digestDue = monitorV2DigestDueAt(row.spec, state.evaluation);
  const next = nextIndex
    ? { dueAt: new Date(Math.min(expiry.getTime(), at.getTime() + MONITOR_LIMITS.hostIntervalMs)), intervalMs: row.interval_ms }
    : nextPredictiveMonitorCheck(row.spec, at, { state: state.schedule, expiry, checksUsed: row.checks,
      failed, changed: evaluation.changed, priorIntervalMs: row.interval_ms,
      needsConfirmation: evaluation.needsConfirmation, confirmNoEarlierThan: evaluation.confirmNoEarlierThan });
  const previousRead = lastReads[nextIndex];
  const floor = monitorTiming(targets[nextIndex].source.kind, 'urgent', { now: at }).initialIntervalMs;
  const dueAt = previousRead === null ? next.dueAt
    : new Date(Math.min(expiry.getTime(), Math.max(next.dueAt.getTime(), previousRead + floor)));
  return {
    ...last, ...receipt, v2_state: JSON.stringify(state),
    v2_digest_due_at: exhaustedNotices ? null : digestDue ?? null,
    failure_kind: failed ? result.kind : needsChoice || unsafe ? 'missing' : null,
    consecutive_failures: attempts[index], ...(receipt && { notifications }),
    ...(pause ? { status: 'paused', next_check_at: null, note: notice?.message }
      : completed ? { status: 'completed', next_check_at: null }
        : !remaining ? { status: 'expired', next_check_at: null }
          : { next_check_at: dueAt, interval_ms: next.intervalMs }),
  };
}
