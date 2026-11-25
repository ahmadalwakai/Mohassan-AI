import type { Latency, MonitorHealthMetrics, ProductionMetricsResponse } from '@mohassan/contracts';

const columns = [
  'window', 'start_utc', 'end_utc', 'role', 'section', 'name', 'count', 'samples', 'p50_ms', 'p90_ms', 'p99_ms',
  '1xx', '2xx', '3xx', '4xx', '5xx', 'average', 'max', 'enabled', 'counting_only', 'snapshot_available', 'chat_available', 'p95_ms', 'rate',
] as const;
type Row = Partial<Record<typeof columns[number], string | number | boolean | null>>;

// Fields with delimiters, quotes or newlines are double-quoted per RFC 4180 §2.
// https://www.rfc-editor.org/rfc/rfc4180.html#section-2 (retrieved 2026-11-25)
function field(value: Row[keyof Row]) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function metricsCsv(view: ProductionMetricsResponse) {
  const output = [columns.join(',')];
  const flags = { enabled: view.enabled, counting_only: view.countingOnly, snapshot_available: view.snapshotAvailable, chat_available: view.chatAvailable };
  function write(row: Row) {
    const values = { ...flags, ...row };
    output.push(columns.map(column => field(values[column])).join(','));
  }
  function period(window: string, { startMs, endMs }: { startMs: number; endMs: number }): Row {
    return { window, start_utc: new Date(startMs).toISOString(), end_utc: new Date(endMs).toISOString() };
  }
  function latency(value: Latency): Row {
    return { samples: value.samples, p50_ms: value.p50, p90_ms: value.p90, p99_ms: value.p99 };
  }
  function monitor(bounds: Row, data?: MonitorHealthMetrics) {
    if (!data) return;
    const writeMonitor = (section: string, name: string, values: Row) => write({ ...bounds, section, name, ...values });
    const { samples, p50, p95 } = data.checkLatenessMs;
    writeMonitor('monitor_checks', 'lateness', { samples, p50_ms: p50, p95_ms: p95 });
    writeMonitor('monitor_checks', 'success', { count: data.checks.succeeded, samples: data.checks.attempted, rate: data.checks.successRate });
    if (data.alerts) {
      const { reasons, ...ratings } = data.alerts;
      for (const [name, count] of Object.entries(ratings)) writeMonitor('monitor_alerts', name, { count });
      for (const [name, count] of Object.entries(reasons)) writeMonitor('monitor_feedback_reason', name, { count });
    }
    for (const [name, count] of Object.entries(data.delivered)) writeMonitor('monitor_delivery', name, { count });
    for (const [name, count] of Object.entries(data.pauses)) writeMonitor('monitor_pause', name, { count });
  }
  for (const [window, data] of Object.entries(view.windows)) {
    const bounds = period(window, data);
    write({ ...bounds, section: 'window' });
    for (const [role, { routes, chat }] of Object.entries(data.roles)) {
      const base = { ...bounds, role };
      for (const route of routes) {
        write({ ...base, section: 'request', name: route.route, count: route.count, ...route.statusClasses, ...latency(route.latency) });
      }
      write({ ...base, section: 'chat', name: 'runs', count: chat.runs });
      write({ ...base, section: 'chat', name: 'first_progress', ...latency(chat.firstProgress) });
      write({ ...base, section: 'chat', name: 'final_answer', ...latency(chat.finalAnswer) });
      for (const [name, phase] of Object.entries(chat.phases)) {
        if (phase) write({ ...base, section: 'chat_phase', name, ...latency(phase) });
      }
      for (const [name, count] of Object.entries(chat.paths)) write({ ...base, section: 'answer_path', name, count });
    }
    for (const [name, resource] of Object.entries(data.resources)) write({ ...bounds, section: 'resource', name, ...resource });
    monitor(bounds, data.monitors);
  }
  if (view.completedMonitorWeek) monitor(period('completed_monitor_week', view.completedMonitorWeek), view.completedMonitorWeek.monitors);
  for (const hour of view.hourlyRoutes) {
    const bounds = period('hourly_route', hour);
    for (const [role, routes] of Object.entries(hour.roles)) {
      for (const route of routes) {
        write({ ...bounds, role, section: 'request', name: route.route, count: route.count, ...route.statusClasses, ...latency(route.latency) });
      }
    }
  }
  return `${output.join('\r\n')}\r\n`;
}
