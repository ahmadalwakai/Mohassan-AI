import type {RunPhase, TerminalRunPhase} from './agent-run';
import type {MemberCouncilMetrics} from './models';

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

export type V5ChatMetrics = {
  generations: number;
  latency: Latency;
  eosStops: number;
  lengthStops: number;
  loopCuts: number;
  timeouts: number;
  fallbacks: number;
};

export type ChatMetrics = {
  runs: number;
  firstProgress: Latency;
  finalAnswer: Latency;
  phases: Partial<Record<WorkingRunPhase, Latency>>;
  paths: Record<AnswerPath, number>;
  /** Present only in the owner's metrics when the v5 experiment has activity. */
  v5?: V5ChatMetrics;
};

export const monitorDeliveryChannels = ['conversation', 'tab', 'webPush', 'apns'] as const;
export type MonitorDeliveryChannel = (typeof monitorDeliveryChannels)[number];
export const monitorPauseReasons = ['manual', 'missing', 'unreachable'] as const;
export type MonitorPauseReason = (typeof monitorPauseReasons)[number];

export type MonitorAlertFeedbackMetrics = {
  total: number;
  helpful: number;
  notHelpful: number;
  unrated: number;
  reasons: Record<'no_meaningful_change' | 'late' | 'wrong_value', number>;
};

export type MonitorHealthMetrics = {
  checkLatenessMs: {samples: number; p50: number | null; p95: number | null};
  checks: {attempted: number; succeeded: number; successRate: number | null};
  delivered: Record<MonitorDeliveryChannel, number>;
  pauses: Record<MonitorPauseReason, number>;
  alerts?: MonitorAlertFeedbackMetrics;
};

export type MonitorMetricWindow = {startMs: number; endMs: number; monitors: MonitorHealthMetrics};

export type MetricWindow = {
  startMs: number;
  endMs: number;
  roles: Record<TrafficRole, {routes: RouteMetrics[]; chat: ChatMetrics}>;
  resources: Record<ResourceMetric, {samples: number; average: number | null; max: number | null}>;
  monitors?: MonitorHealthMetrics;
};

export type MetricsView = {
  generatedAtMs: number;
  countingOnly: boolean;
  windows: {hour: MetricWindow; day: MetricWindow; week: MetricWindow};
  completedMonitorWeek?: MonitorMetricWindow;
  hourlyRoutes: {startMs: number; endMs: number; roles: Record<TrafficRole, RouteMetrics[]>}[];
};

export type ProductionMetricsResponse = MetricsView & {
  enabled: boolean;
  snapshotAvailable: boolean;
  chatAvailable: boolean;
  memberCouncil?: MemberCouncilMetrics;
};
