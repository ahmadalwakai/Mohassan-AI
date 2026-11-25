import {
  answerPaths, resourceMetrics, runPhases, terminalRunPhases,
  type AnswerPath, type MetricsView, type ResourceMetric, type TrafficRole, type WorkingRunPhase,
} from '@mohassan/contracts';
import {
  createBucket, forEachHistogram, mergeBucket, resourceData, routeData, summarizeRoutes, summarizeWindow, timingData,
  type ChatTiming, type MetricBucket, type TimingData,
} from './bucket';
import {addLatency, createHistogram, histogramBytes, latencyBucketIndex} from './histogram';
import {createMonitorMetricBucket, mergeMonitorMetricBucket, summarizeMonitorMetrics} from './monitor-buckets.js';
import type {MonitorMetricEvent} from './monitor-events.js';

export type {AnswerPath, Latency, MetricsView, MetricWindow, RouteMetrics, TrafficRole, WorkingRunPhase} from '@mohassan/contracts';

export const minuteMs = 60_000;
export const hourMs = 60 * minuteMs;
export const minuteSlots = 60;
export const hourlySlots = 7 * 24;
export const defaultHistogramCapBytes = 32 * 1024 * 1024;

const terminalPhases = new Set<string>(terminalRunPhases);
export const workingPhases = runPhases.filter((phase): phase is WorkingRunPhase => !terminalPhases.has(phase));
const answerPathSet = new Set<string>(answerPaths);

export type ChatObservation = {
  started?: boolean;
  firstProgressMs?: number;
  finalAnswerMs?: number;
  phases?: Partial<Record<WorkingRunPhase, number>>;
  paths?: readonly AnswerPath[];
};

type StoreOptions = {now?: () => number; memoryCapBytes?: number};
export type MinuteBuckets = Map<number, MetricBucket>;

export function bucketStart(ms: number, resolutionMs: number): number {
  return Math.floor(ms / resolutionMs) * resolutionMs;
}

function getBucket(buckets: MinuteBuckets, startMs: number): MetricBucket {
  let bucket = buckets.get(startMs);
  if (!bucket) {
    bucket = createBucket();
    buckets.set(startMs, bucket);
  }
  return bucket;
}

export class MetricsStore {
  readonly #clock: () => number;
  readonly #memoryCapBytes: number;
  readonly #minutes: MinuteBuckets = new Map();
  readonly #hours: MinuteBuckets = new Map();
  #completedMonitorEdge = createMonitorMetricBucket();
  readonly #pending = new Map<number, MinuteBuckets>();
  #histogramBytes = 0;
  #capacityReached = false;
  #snapshots = false;
  #currentMinute = -1;
  #latestTime = 0;
  #recordBuckets?: MetricBucket[];

  constructor({now = Date.now, memoryCapBytes = defaultHistogramCapBytes}: StoreOptions = {}) {
    this.#clock = now;
    this.#memoryCapBytes = Math.max(0, memoryCapBytes);
    this.#capacityReached = this.#memoryCapBytes < histogramBytes * 2;
  }

  nowMs(): number {
    // A wall-clock adjustment must not move writes into a snapshot being flushed.
    this.#latestTime = Math.max(this.#latestTime, this.#clock());
    return this.#latestTime;
  }

  enableSnapshots(): void {
    this.#snapshots = true;
    this.#recordBuckets = undefined;
  }

  recordRequest(role: TrafficRole, route: string, statusCode: number, durationMs: number): void {
    const status = Math.floor(statusCode / 100) - 1;
    if (!Number.isInteger(status) || status < 0 || status >= 5) return;
    const buckets = this.#buckets();
    const targets = [];
    for (const bucket of buckets) {
      const request = routeData(bucket.roles[role].routes, route);
      request.statuses[status]++;
      targets.push(request);
    }
    this.#observe(targets, durationMs);
  }

  recordChat(role: TrafficRole, observation: ChatObservation): void {
    this.#recordChat(this.#buckets(), role, observation);
  }

  recordPersistedChat(role: TrafficRole, observation: ChatObservation, atMs: number): void {
    // The ledger and message receipts already persist this observation.
    this.#recordChat(this.#historicalBuckets(atMs), role, observation);
  }

  recordMonitor(event: MonitorMetricEvent): void {
    const monitors = this.#buckets().map(bucket => bucket.monitors);
    if (event.kind === 'delivery') {
      for (const bucket of monitors) bucket.delivered[event.channel]++;
      return;
    }
    if (event.kind === 'pause') {
      for (const bucket of monitors) bucket.pauses[event.reason]++;
      return;
    }
    const timings = monitors.map(bucket => ({histogram: bucket.lateness}));
    for (const bucket of monitors) {
      bucket.checked++;
      bucket.succeeded += Number(event.succeeded);
    }
    this.#observe(timings, event.latenessMs);
    monitors.forEach((bucket, index) => { bucket.lateness = timings[index].histogram; });
  }

  recordResources(values: Partial<Record<ResourceMetric, number>>): void {
    if (this.#capacityReached) this.#advance(this.nowMs());
    if (this.#capacityReached) return;
    const buckets = this.#buckets();
    for (const metric of resourceMetrics) {
      const value = values[metric];
      if (value === undefined || !Number.isFinite(value) || value < 0) continue;
      for (const bucket of buckets) {
        const data = resourceData(bucket.resources, metric);
        data.samples++;
        data.sum += value;
        data.max = Math.max(data.max, value);
      }
    }
  }

  view(): MetricsView {
    const now = this.nowMs();
    this.#advance(now);
    const currentMinute = bucketStart(now, minuteMs);
    const currentHour = bucketStart(now, hourMs);
    const dayStart = currentHour - 23 * hourMs;
    const aggregate = (buckets: MinuteBuckets, startMs: number) => {
      const combined = createBucket();
      for (const [start, bucket] of buckets) if (start >= startMs) mergeBucket(combined, bucket);
      return summarizeWindow(combined, startMs, now);
    };
    const hourlyRoutes = [];
    for (let startMs = dayStart; startMs <= currentHour; startMs += hourMs) {
      const bucket = this.#hours.get(startMs);
      hourlyRoutes.push({
        startMs, endMs: Math.min(startMs + hourMs, now),
        roles: {owner: bucket ? summarizeRoutes(bucket, 'owner') : [], member: bucket ? summarizeRoutes(bucket, 'member') : []},
      });
    }
    const completedStart = currentHour - hourlySlots * hourMs;
    const completedMonitors = createMonitorMetricBucket();
    mergeMonitorMetricBucket(completedMonitors, this.#completedMonitorEdge);
    for (const [start, bucket] of this.#hours) {
      if (start >= completedStart && start < currentHour) mergeMonitorMetricBucket(completedMonitors, bucket.monitors);
    }
    return {
      generatedAtMs: now,
      completedMonitorWeek: {startMs: completedStart, endMs: currentHour, monitors: summarizeMonitorMetrics(completedMonitors)},
      countingOnly: this.#capacityReached,
      windows: {
        hour: aggregate(this.#minutes, currentMinute - (minuteSlots - 1) * minuteMs),
        day: aggregate(this.#hours, dayStart),
        week: aggregate(this.#hours, currentHour - (hourlySlots - 1) * hourMs),
      },
      hourlyRoutes,
    };
  }

  get pendingHours(): number[] {
    this.#advance(this.nowMs());
    return [...this.#pending.keys()].sort((left, right) => left - right);
  }

  takePendingHour(startMs: number): MinuteBuckets | undefined {
    const minutes = this.#pending.get(startMs);
    this.#pending.delete(startMs);
    this.#recordBuckets = undefined;
    return minutes;
  }

  releasePendingHour(minutes: MinuteBuckets): void {
    for (const bucket of minutes.values()) this.#release(bucket);
  }

  restorePendingHour(startMs: number, minutes: MinuteBuckets): void {
    const current = this.#pending.get(startMs);
    if (!current) {
      this.#pending.set(startMs, minutes);
      return;
    }
    for (const [minute, bucket] of minutes) {
      const existing = current.get(minute);
      if (!existing) current.set(minute, bucket);
      else {
        this.#release(bucket);
        mergeBucket(existing, bucket, this.#allocateHistogram);
      }
    }
  }

  loadMinute(startMs: number, bucket: MetricBucket): void {
    const now = this.nowMs();
    this.#advance(now);
    if (bucketStart(startMs, hourMs) === bucketStart(now, hourMs) - hourlySlots * hourMs) {
      mergeMonitorMetricBucket(this.#completedMonitorEdge, bucket.monitors, this.#allocateHistogram);
      return;
    }
    for (const target of this.#historicalBuckets(startMs)) {
      mergeBucket(target, bucket, this.#allocateHistogram);
    }
  }

  #historicalBuckets(atMs: number): MetricBucket[] {
    const now = this.nowMs();
    this.#advance(now);
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > now) return [];
    const hour = bucketStart(atMs, hourMs);
    const currentHour = bucketStart(now, hourMs);
    if (hour < currentHour - (hourlySlots - 1) * hourMs) return [];
    const targets = [getBucket(this.#hours, hour)];
    const minute = bucketStart(atMs, minuteMs);
    if (minute >= this.#currentMinute - (minuteSlots - 1) * minuteMs) {
      targets.push(getBucket(this.#minutes, minute));
    }
    return targets;
  }

  #recordChat(buckets: MetricBucket[], role: TrafficRole, observation: ChatObservation): void {
    if (!buckets.length) return;
    const chats = buckets.map(bucket => bucket.roles[role].chat);
    if (observation.started) for (const chat of chats) chat.runs++;
    if (observation.paths?.length) {
      for (const path of new Set(observation.paths)) {
        if (answerPathSet.has(path)) for (const chat of chats) chat.paths[path]++;
      }
    }
    const timing = (name: ChatTiming, ms?: number) => {
      if (ms !== undefined && Number.isFinite(ms) && ms >= 0 && !this.#capacityReached) {
        this.#observe(chats.map(chat => timingData(chat.timings, name)), ms);
      }
    };
    timing('firstProgress', observation.firstProgressMs);
    timing('finalAnswer', observation.finalAnswerMs);
    for (const phase of workingPhases) timing(phase, observation.phases?.[phase]);
  }

  #observe(targets: TimingData[], ms: number): void {
    if (this.#capacityReached || !Number.isFinite(ms) || ms < 0) return;
    let needed = 0;
    for (const target of targets) if (!target.histogram) needed += histogramBytes;
    if (this.#histogramBytes + needed > this.#memoryCapBytes) {
      this.#capacityReached = true;
      return;
    }
    this.#histogramBytes += needed;
    const index = latencyBucketIndex(ms);
    for (const target of targets) {
      target.histogram ??= createHistogram();
      addLatency(target.histogram, index, ms);
    }
  }

  #allocateHistogram = () => {
    if (this.#histogramBytes + histogramBytes > this.#memoryCapBytes) {
      this.#capacityReached = true;
      return;
    }
    this.#histogramBytes += histogramBytes;
    return createHistogram();
  };

  #release(bucket: MetricBucket): void {
    forEachHistogram(bucket, () => { this.#histogramBytes -= histogramBytes; });
    this.#resumeTimingsIfSpace();
  }

  #resumeTimingsIfSpace(): void {
    const nextObservationBytes = histogramBytes * (this.#snapshots ? 3 : 2);
    if (this.#histogramBytes + nextObservationBytes <= this.#memoryCapBytes) this.#capacityReached = false;
  }

  #advance(now: number): void {
    const minute = bucketStart(now, minuteMs);
    if (minute === this.#currentMinute) return;
    const hour = bucketStart(now, hourMs);
    if (hour !== bucketStart(this.#currentMinute, hourMs)) {
      if (this.#completedMonitorEdge.lateness) {
        this.#histogramBytes -= histogramBytes;
        this.#resumeTimingsIfSpace();
      }
      const departing = this.#hours.get(hour - hourlySlots * hourMs);
      this.#completedMonitorEdge = departing?.monitors ?? createMonitorMetricBucket();
      if (departing) departing.monitors = createMonitorMetricBucket();
    }
    this.#currentMinute = minute;
    this.#recordBuckets = undefined;
    const evict = (buckets: MinuteBuckets, earliest: number) => {
      for (const [start, bucket] of buckets) {
        if (start >= earliest) continue;
        buckets.delete(start);
        this.#release(bucket);
      }
    };
    evict(this.#minutes, minute - (minuteSlots - 1) * minuteMs);
    evict(this.#hours, hour - (hourlySlots - 1) * hourMs);
    for (const [start, buckets] of this.#pending) {
      if (start >= hour - hourMs) continue;
      this.#pending.delete(start);
      this.releasePendingHour(buckets);
    }
  }

  #buckets(): MetricBucket[] {
    this.#advance(this.nowMs());
    if (this.#recordBuckets) return this.#recordBuckets;
    const hour = bucketStart(this.#currentMinute, hourMs);
    const buckets = [getBucket(this.#minutes, this.#currentMinute), getBucket(this.#hours, hour)];
    if (this.#snapshots) {
      let pending = this.#pending.get(hour);
      if (!pending) {
        pending = new Map();
        this.#pending.set(hour, pending);
      }
      buckets.push(getBucket(pending, this.#currentMinute));
    }
    this.#recordBuckets = buckets;
    return buckets;
  }
}
