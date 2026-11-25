import type {RunPhase, TerminalRunPhase} from './agent-run';

export const trafficRoles = ['owner', 'member'] as const;
export type TrafficRole = (typeof trafficRoles)[number];

export const answerPaths = ['web', 'local_computation', 'skill_reader', 'memory', 'browser', 'refusal'] as const;
export type AnswerPath = (typeof answerPaths)[number];
export type WorkingRunPhase = Exclude<RunPhase, TerminalRunPhase>;

export const statusClasses = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
export type StatusClass = (typeof statusClasses)[number];

export const resourceMetrics = ['eventLoopDelayMs', 'heapUsedBytes', 'rssBytes', 'openHandles'] as const;
export type ResourceMetric = (typeof resourceMetrics)[number];

export type Latency = {
  samples: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
};

export type RouteMetrics = {
  route: string;
  count: number;
  statusClasses: Record<StatusClass, number>;
  latency: Latency;
};

export type ChatMetrics = {
  runs: number;
  firstProgress: Latency;
  finalAnswer: Latency;
  phases: Partial<Record<WorkingRunPhase, Latency>>;
  paths: Record<AnswerPath, number>;
};

export type MetricWindow = {
  startMs: number;
  endMs: number;
  roles: Record<TrafficRole, {routes: RouteMetrics[]; chat: ChatMetrics}>;
  resources: Record<ResourceMetric, {samples: number; average: number | null; max: number | null}>;
};

export type MetricsView = {
  generatedAtMs: number;
  countingOnly: boolean;
  windows: {hour: MetricWindow; day: MetricWindow; week: MetricWindow};
  hourlyRoutes: {startMs: number; endMs: number; roles: Record<TrafficRole, RouteMetrics[]>}[];
};

export type ProductionMetricsResponse = MetricsView & {enabled: boolean; snapshotAvailable: boolean; chatAvailable: boolean};
