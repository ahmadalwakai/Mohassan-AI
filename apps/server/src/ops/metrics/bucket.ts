import {
  answerPaths, resourceMetrics, statusClasses, trafficRoles,
  type AnswerPath, type ChatMetrics, type MetricWindow, type ResourceMetric,
  type RouteMetrics, type TrafficRole, type WorkingRunPhase,
} from '@mohassan/contracts';
import {createHistogram, mergeHistograms, summarizeHistogram, type Histogram} from './histogram';

export type ChatTiming = 'firstProgress' | 'finalAnswer' | WorkingRunPhase;
export type TimingData = {histogram?: Histogram};
export type RequestData = TimingData & {statuses: number[]};
type ResourceData = {samples: number; sum: number; max: number};
type RoleData = {
  routes: Map<string, RequestData>;
  chat: {runs: number; timings: Map<ChatTiming, TimingData>; paths: Record<AnswerPath, number>};
};

export type MetricBucket = {
  roles: Record<TrafficRole, RoleData>;
  resources: Map<ResourceMetric, ResourceData>;
};

export function createBucket(): MetricBucket {
  const role = (): RoleData => ({
    routes: new Map(),
    chat: {runs: 0, timings: new Map(), paths: {web: 0, local_computation: 0, skill_reader: 0, memory: 0, browser: 0, refusal: 0}},
  });
  return {roles: {owner: role(), member: role()}, resources: new Map()};
}

export function routeData(routes: RoleData['routes'], route: string): RequestData {
  let request = routes.get(route);
  if (!request) {
    request = {statuses: [0, 0, 0, 0, 0]};
    routes.set(route, request);
  }
  return request;
}

export function timingData(timings: RoleData['chat']['timings'], name: ChatTiming): TimingData {
  let timing = timings.get(name);
  if (!timing) {
    timing = {};
    timings.set(name, timing);
  }
  return timing;
}

export function resourceData(resources: MetricBucket['resources'], metric: ResourceMetric): ResourceData {
  let data = resources.get(metric);
  if (!data) {
    data = {samples: 0, sum: 0, max: 0};
    resources.set(metric, data);
  }
  return data;
}

export function forEachHistogram(bucket: MetricBucket, visit: (histogram: Histogram) => void): void {
  for (const role of trafficRoles) {
    for (const data of bucket.roles[role].routes.values()) if (data.histogram) visit(data.histogram);
    for (const data of bucket.roles[role].chat.timings.values()) if (data.histogram) visit(data.histogram);
  }
}

export function mergeBucket(target: MetricBucket, source: MetricBucket, allocate = createHistogram as () => Histogram | undefined): void {
  function mergeTiming(data: TimingData, histogram?: Histogram): void {
    if (!histogram) return;
    data.histogram ??= allocate();
    if (data.histogram) mergeHistograms(data.histogram, histogram);
  }

  for (const role of trafficRoles) {
    for (const [route, sourceRoute] of source.roles[role].routes) {
      const request = routeData(target.roles[role].routes, route);
      for (let index = 0; index < statusClasses.length; index++) request.statuses[index] += sourceRoute.statuses[index];
      mergeTiming(request, sourceRoute.histogram);
    }
    const incoming = source.roles[role].chat;
    const chat = target.roles[role].chat;
    chat.runs += incoming.runs;
    for (const name of answerPaths) chat.paths[name] += incoming.paths[name];
    for (const [name, timing] of incoming.timings) mergeTiming(timingData(chat.timings, name), timing.histogram);
  }
  for (const [metric, incoming] of source.resources) {
    const data = resourceData(target.resources, metric);
    data.samples += incoming.samples;
    data.sum += incoming.sum;
    data.max = Math.max(data.max, incoming.max);
  }
}

export function summarizeRoutes(bucket: MetricBucket, role: TrafficRole): RouteMetrics[] {
  return [...bucket.roles[role].routes].map(([route, data]) => ({
    route,
    count: data.statuses.reduce((sum, count) => sum + count, 0),
    statusClasses: {
      '1xx': data.statuses[0], '2xx': data.statuses[1], '3xx': data.statuses[2], '4xx': data.statuses[3], '5xx': data.statuses[4],
    },
    latency: summarizeHistogram(data.histogram),
  })).sort((left, right) => left.route.localeCompare(right.route));
}

function summarizeChat(data: RoleData['chat']): ChatMetrics {
  const phases: ChatMetrics['phases'] = {};
  for (const [name, timing] of data.timings) {
    if (name !== 'firstProgress' && name !== 'finalAnswer' && timing.histogram) phases[name] = summarizeHistogram(timing.histogram);
  }
  return {
    runs: data.runs,
    firstProgress: summarizeHistogram(data.timings.get('firstProgress')?.histogram),
    finalAnswer: summarizeHistogram(data.timings.get('finalAnswer')?.histogram),
    phases,
    paths: {...data.paths},
  };
}

export function summarizeWindow(bucket: MetricBucket, startMs: number, endMs: number): MetricWindow {
  function summarizeRole(role: TrafficRole): MetricWindow['roles'][TrafficRole] {
    return {routes: summarizeRoutes(bucket, role), chat: summarizeChat(bucket.roles[role].chat)};
  }
  const resources = Object.fromEntries(resourceMetrics.map(metric => {
    const data = bucket.resources.get(metric);
    return [metric, data && data.samples > 0
      ? {samples: data.samples, average: data.sum / data.samples, max: data.max}
      : {samples: 0, average: null, max: null}];
  })) as MetricWindow['resources'];
  return {startMs, endMs, roles: {owner: summarizeRole('owner'), member: summarizeRole('member')}, resources};
}
