import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricWindow, ProductionMetricsResponse, RouteMetrics } from "@mohassan/contracts";
import ProductionMetricsPage from "../apps/web/app/ops/metrics/page";
import { requestMetrics, requestTotals, routeHistory, slowestRoutes, type MetricsState } from "../apps/web/app/ops/metrics/metrics-data";
import { ProductionMetrics } from "../apps/web/app/ops/metrics/production-metrics";

const incoming = vi.hoisted(() => new Headers());
vi.mock("next/headers", () => ({ headers: async () => incoming }));

const hourMs = 60 * 60 * 1000;
const latency = { samples: 0, p50: null, p90: null, p99: null };
const resource = { samples: 0, average: null, max: null };
const route = (path: string, count: number, p90: number | null, clientErrors = 0, serverErrors = 0): RouteMetrics => ({
  route: path,
  count,
  statusClasses: { "1xx": 0, "2xx": count - clientErrors - serverErrors, "3xx": 0, "4xx": clientErrors, "5xx": serverErrors },
  latency: { ...latency, samples: p90 === null ? 0 : count, p90 },
});
const routes = [
  route("GET /api/chat/conversations", 4, 8, 1, 1),
  route("GET /api/chat/conversations/:id", 1, 16),
  route("GET /api/workspace", 3, null),
];
const memberRoute = route("POST /api/chat", 5, 32);

function createWindow(endMs: number, ownerRoutes: RouteMetrics[] = [], memberRoutes: RouteMetrics[] = []): MetricWindow {
  const chat = {
    runs: 0, firstProgress: latency, finalAnswer: latency, phases: {},
    paths: { web: 0, local_computation: 0, skill_reader: 0, memory: 0, browser: 0, refusal: 0 },
  };
  return {
    startMs: 0,
    endMs,
    roles: { owner: { routes: ownerRoutes, chat }, member: { routes: memberRoutes, chat } },
    resources: { eventLoopDelayMs: resource, heapUsedBytes: resource, rssBytes: resource, openHandles: resource },
  };
}

function report(withSamples: boolean): ProductionMetricsResponse {
  const day = createWindow(24 * hourMs, withSamples ? routes : [], withSamples ? [memberRoute] : []);
  if (withSamples) {
    day.roles.owner.chat = {
      ...day.roles.owner.chat,
      runs: 1,
      firstProgress: { ...latency, samples: 1, p90: 8 },
      finalAnswer: { ...latency, samples: 1, p90: 16 },
      phases: { understanding: { ...latency, samples: 1, p90: 8 } },
    };
    day.resources.openHandles = { samples: 1, average: 2, max: 2 };
  }
  return {
    enabled: true,
    chatAvailable: true,
    snapshotAvailable: true,
    countingOnly: false,
    generatedAtMs: day.endMs,
    windows: { hour: createWindow(hourMs), day, week: createWindow(7 * day.endMs) },
    hourlyRoutes: Array.from({ length: 24 }, (_, index) => ({
      startMs: index * hourMs,
      endMs: (index + 1) * hourMs,
      roles: index === 0 ? { owner: day.roles.owner.routes, member: day.roles.member.routes } : { owner: [], member: [] },
    })),
  };
}

function render(initialState: MetricsState) {
  return renderToStaticMarkup(createElement(ProductionMetrics, { initialState }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  incoming.delete("cookie");
});

describe("production metrics dashboard", () => {
  it("calculates request totals separately by role and ranks only routes with measured p90", () => {
    const { roles } = report(true).windows.day;
    expect(requestTotals(roles.owner.routes)).toEqual({ count: 8, clientErrors: 1, serverErrors: 1 });
    expect(requestTotals(roles.member.routes)).toEqual({ count: 5, clientErrors: 0, serverErrors: 0 });
    expect(slowestRoutes(roles.owner.routes)).toEqual([routes[1], routes[0]]);
  });

  it("uses request counts to select the main routes and preserves the full 24 hours with gaps", () => {
    const data = report(true);
    const owner = routeHistory(data, "owner");
    expect(owner.map(series => series.route)).toEqual([routes[0]!.route, routes[2]!.route, routes[1]!.route]);
    expect(owner[0]!.hours).toHaveLength(24);
    expect(owner[0]!.hours[0]!.p90).toBe(8);
    expect(owner[0]!.hours[1]).toEqual({ startMs: hourMs, endMs: 2 * hourMs, p90: null });
    expect(routeHistory(data, "member").map(series => series.route)).toEqual([memberRoute.route]);
  });

  it("renders Arabic loading, error, access, disabled and empty states without placeholder metrics", () => {
    expect(render({ kind: "loading" })).toContain('role="status">جارٍ تحميل مقاييس الإنتاج');
    expect(render({ kind: "error" })).toContain("إعادة المحاولة");
    expect(render({ kind: "signin" })).toContain("سجّل الدخول بحساب المالك");
    expect(render({ kind: "forbidden" })).toContain("متاحة لحساب المالك فقط");
    const empty = report(false);
    expect(render({ kind: "ready", report: { ...empty, enabled: false } })).toContain("جمع المقاييس متوقف");
    const markup = render({ kind: "ready", report: empty });
    expect(markup).toContain("لا توجد قياسات في الفترة المحددة");
    expect(markup).not.toContain("أخطاء الخادم");
  });

  it("renders observed periods, role aggregates, chart gaps, chat phases and resource availability", () => {
    const markup = render({
      kind: "ready",
      report: { ...report(true), countingOnly: true, snapshotAvailable: false },
    });
    expect(markup).toContain('dir="rtl" lang="ar"');
    expect(markup).toContain('dateTime="1970-01-02T00:00:00.000Z"');
    expect(markup).toContain("أخطاء الطلبات");
    expect(markup).toContain("الأعضاء");
    expect(markup).toContain("القياسات بالساعة");
    expect(markup).toContain("<td>—</td>");
    expect(markup).toContain("فهم الطلب");
    expect(markup).toContain("مقابض العملية المفتوحة");
    expect(markup).toContain("يجمع الخادم العدّادات فقط الآن");
    expect(markup).toContain("حفظ المقاييس على القرص غير متاح");
    expect(markup).toContain("تنزيل CSV لكل الفترات");
  });

  it("shows replies recorded after a window boundary even when no run start was recorded in that window", () => {
    const data = report(false);
    const owner = data.windows.day.roles.owner;
    owner.chat = { ...owner.chat, finalAnswer: { ...latency, samples: 1, p90: 16 } };
    const markup = render({ kind: "ready", report: data });
    expect(markup).toContain("حتى الرد النهائي");
    expect(markup).not.toContain("لا توجد قياسات في الفترة المحددة");
  });

  it("identifies unavailable chat collection while preserving the latest known observations", () => {
    const data = report(true);
    const notice = "قراءة سجل المحادثات غير متاحة حاليًا";
    expect(render({ kind: "ready", report: data })).not.toContain(notice);
    const markup = render({ kind: "ready", report: { ...data, chatAvailable: false } });
    expect(markup).toContain(`role="status">${notice}`);
    expect(markup).toContain("حتى الرد النهائي");
  });

  it("maps failed or invalid responses to retry and leaves authentication errors distinct", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ enabled: true }))
      .mockRejectedValueOnce(new Error("unreachable"));
    vi.stubGlobal("fetch", fetchMock);
    const path = "/api/ops/metrics";
    for (const kind of ["signin", "forbidden", "error", "error", "error"]) {
      await expect(requestMetrics(path)).resolves.toEqual({ kind });
    }
    expect(fetchMock).toHaveBeenCalledWith(path, { cache: "no-store", redirect: "error" });
  });

  it("sends the session cookie to the normal server-side owner gate before rendering a report", async () => {
    vi.stubEnv("MOHASSAN_SERVER_URL", "http://localhost:4000");
    vi.stubEnv("INTERNAL_API_SECRET", "metrics-test-only");
    incoming.set("cookie", "test-session=owner");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(report(true)))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const owner = renderToStaticMarkup(await ProductionMetricsPage());
    expect(owner).toContain("مراحل الجولة");
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://localhost:4000/api/ops/metrics"), expect.objectContaining({
      headers: { "x-mohassan-internal": "metrics-test-only", cookie: "test-session=owner" },
      cache: "no-store",
    }));
    incoming.set("cookie", "test-session=member");
    const member = renderToStaticMarkup(await ProductionMetricsPage());
    expect(member).toContain("متاحة لحساب المالك فقط");
    expect(member).not.toContain("مراحل الجولة");
  });
});
