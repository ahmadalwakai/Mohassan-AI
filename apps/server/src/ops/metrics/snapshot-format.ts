import {answerPaths, monitorDeliveryChannels, monitorPauseReasons, resourceMetrics, trafficRoles, type TrafficRole} from '@mohassan/contracts';
import {z} from 'zod';
import {createBucket, resourceData, routeData, timingData, v5ChatData, type MetricBucket} from './bucket';
import {createHistogram, histogramBucketCount, type Histogram} from './histogram';
import {workingPhases, type MinuteBuckets} from './store';

const count = z.number().int().nonnegative();
const sample = z.number().nonnegative();
const histogramSchema = z.object({
  maxMs: sample,
  counts: z.array(z.tuple([count.max(histogramBucketCount - 1), count.positive()])).min(1).max(histogramBucketCount),
}).strict();
const roleSchema = z.object({
  routes: z.array(z.tuple([
    z.string().regex(/^[A-Z]+ \/[A-Za-z0-9_:/.*~()+-]*$/),
    z.tuple([count, count, count, count, count]),
    histogramSchema.nullable(),
  ])),
  chat: z.object({
    runs: count,
    paths: z.record(z.enum(answerPaths), count),
    timings: z.array(z.tuple([z.enum(['firstProgress', 'finalAnswer', ...workingPhases]), histogramSchema])),
  }).strict(),
}).strict();
const monitorSchema = z.object({
  checked: count,
  succeeded: count,
  delivered: z.record(z.enum(monitorDeliveryChannels), count),
  pauses: z.record(z.enum(monitorPauseReasons), count),
  lateness: histogramSchema.optional(),
}).strict();
const v5ChatSchema = z.object({
  generations: count,
  eosStops: count,
  lengthStops: count,
  loopCuts: count,
  timeouts: count,
  fallbacks: count,
  latency: histogramSchema.optional(),
}).strict();
const bucketSchema = z.object({
  roles: z.object({owner: roleSchema, member: roleSchema}).strict(),
  resources: z.array(z.tuple([z.enum(resourceMetrics), count.positive(), sample, sample])),
  monitors: monitorSchema.optional(),
  v5Chat: v5ChatSchema.optional(),
}).strict();
const snapshotSchema = z.object({
  version: z.literal(1),
  hourStartMs: count,
  minutes: z.array(z.tuple([count, bucketSchema])).max(60),
}).strict();

type Snapshot = z.infer<typeof snapshotSchema>;
type SerializedBucket = z.infer<typeof bucketSchema>;
type SerializedHistogram = z.infer<typeof histogramSchema>;

function encodeHistogram(data: Histogram): SerializedHistogram {
  const counts: SerializedHistogram['counts'] = [];
  data.counts.forEach((samples, index) => {
    if (samples) counts.push([index, samples]);
  });
  return {maxMs: data.maxMs, counts};
}

function decodeHistogram(data: SerializedHistogram): Histogram {
  const histogram = createHistogram();
  histogram.maxMs = data.maxMs;
  for (const [index, count] of data.counts) {
    histogram.counts[index] += count;
    histogram.samples += count;
  }
  return histogram;
}

function encodeBucket(bucket: MetricBucket): SerializedBucket {
  function encodeRole(role: TrafficRole): SerializedBucket['roles'][TrafficRole] {
    const data = bucket.roles[role];
    const timings: SerializedBucket['roles'][TrafficRole]['chat']['timings'] = [];
    for (const [name, timing] of data.chat.timings) {
      if (timing.histogram) timings.push([name, encodeHistogram(timing.histogram)]);
    }
    return {
      routes: [...data.routes].map(([route, {statuses, histogram}]) => [
        route,
        [statuses[0], statuses[1], statuses[2], statuses[3], statuses[4]],
        histogram ? encodeHistogram(histogram) : null,
      ]),
      chat: {runs: data.chat.runs, paths: data.chat.paths, timings},
    };
  }
  const { checked, succeeded, delivered, pauses, lateness } = bucket.monitors;
  const monitors = checked || Object.values(delivered).some(Boolean) || Object.values(pauses).some(Boolean)
    ? { checked, succeeded, delivered, pauses, ...(lateness && {lateness: encodeHistogram(lateness)}) } : undefined;
  let v5Chat: SerializedBucket['v5Chat'];
  if (bucket.v5Chat) {
    const {histogram, ...counts} = bucket.v5Chat;
    v5Chat = {...counts, ...(histogram && {latency: encodeHistogram(histogram)})};
  }
  return {
    monitors,
    roles: {owner: encodeRole('owner'), member: encodeRole('member')},
    resources: [...bucket.resources].map(([metric, data]) => [metric, data.samples, data.sum, data.max]),
    v5Chat,
  };
}

export function encodeSnapshot(hourStartMs: number, minutes: MinuteBuckets): string {
  const snapshot: Snapshot = {version: 1, hourStartMs, minutes: [...minutes].map(([startMs, bucket]) => [startMs, encodeBucket(bucket)])};
  return JSON.stringify(snapshot);
}

export function decodeSnapshot(line: string): Snapshot | undefined {
  try {
    const decoded = snapshotSchema.safeParse(JSON.parse(line));
    return decoded.success ? decoded.data : undefined;
  } catch {
    // Power loss can leave a partial last line. Other complete lines still count.
    return;
  }
}

export function decodeBucket(value: SerializedBucket, restoreChat: boolean, restoreV5Chat: boolean): MetricBucket {
  const bucket = createBucket();
  for (const role of trafficRoles) {
    const data = value.roles[role];
    for (const [route, statuses, histogram] of data.routes) {
      const request = routeData(bucket.roles[role].routes, route);
      request.statuses = statuses;
      if (histogram) request.histogram = decodeHistogram(histogram);
    }
    if (!restoreChat) continue;
    const {chat} = bucket.roles[role];
    chat.runs = data.chat.runs;
    chat.paths = data.chat.paths;
    for (const [name, histogram] of data.chat.timings) {
      timingData(chat.timings, name).histogram = decodeHistogram(histogram);
    }
  }
  for (const [metric, samples, sum, max] of value.resources) {
    Object.assign(resourceData(bucket.resources, metric), {samples, sum, max});
  }
  if (value.monitors) {
    const { lateness, ...counts } = value.monitors;
    Object.assign(bucket.monitors, counts, lateness && {lateness: decodeHistogram(lateness)});
  }
  if (restoreV5Chat && value.v5Chat) {
    const {latency, ...counts} = value.v5Chat;
    Object.assign(v5ChatData(bucket), counts, latency && {histogram: decodeHistogram(latency)});
  }
  return bucket;
}
