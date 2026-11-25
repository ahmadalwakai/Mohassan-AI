import type { ChatMetrics, ProductionMetricsResponse, RouteMetrics, TrafficRole } from "@mohassan/contracts";

export const metricsPath = "/api/ops/metrics";
export const metricsCsvPath = "/api/ops/metrics.csv";

export type MetricsState =
  | { kind: "loading" | "error" | "signin" | "forbidden" }
  | { kind: "ready"; report: ProductionMetricsResponse };

export async function requestMetrics(path: string | URL, options?: RequestInit): Promise<MetricsState> {
  try {
    const response = await fetch(path, { ...options, cache: "no-store", redirect: "error" });
    if (response.status === 401) return { kind: "signin" };
    if (response.status === 403) return { kind: "forbidden" };
    if (!response.ok) return { kind: "error" };
    const report = await response.json() as ProductionMetricsResponse | null;
    if (typeof report?.enabled !== "boolean" || !report.windows || !Array.isArray(report.hourlyRoutes)) {
      return { kind: "error" };
    }
    return { kind: "ready", report };
  } catch {
    return { kind: "error" };
  }
}

export function requestTotals(routes: RouteMetrics[]) {
  let count = 0;
  let clientErrors = 0;
  let serverErrors = 0;
  for (const route of routes) {
    count += route.count;
    clientErrors += route.statusClasses["4xx"];
    serverErrors += route.statusClasses["5xx"];
  }
  return { count, clientErrors, serverErrors };
}

export function hasChatSamples(chat: ChatMetrics) {
  return chat.runs > 0 || chat.firstProgress.samples > 0 || chat.finalAnswer.samples > 0
    || Object.values(chat.phases).some(latency => latency.samples > 0)
    || Object.values(chat.paths).some(count => count > 0);
}

export function slowestRoutes(routes: RouteMetrics[]) {
  return routes.flatMap(route => route.latency.p90 === null ? [] : [{ route, p90: route.latency.p90 }])
    .sort((first, second) => second.p90 - first.p90 || second.route.count - first.route.count)
    .map(({ route }) => route);
}

export function routeHistory(report: ProductionMetricsResponse, role: TrafficRole) {
  const hourlyRoutes = report.hourlyRoutes.map(hour => ({
    startMs: hour.startMs,
    endMs: hour.endMs,
    routes: new Map(hour.roles[role].map(route => [route.route, route.latency])),
  }));
  const mainRoutes = [...report.windows.day.roles[role].routes]
    .sort((first, second) => second.count - first.count || first.route.localeCompare(second.route));
  return mainRoutes.slice(0, 6).map(({ route }) => ({
    route,
    hours: hourlyRoutes.map(hour => ({
      startMs: hour.startMs,
      endMs: hour.endMs,
      p90: hour.routes.get(route)?.p90 ?? null,
    })),
  }));
}
