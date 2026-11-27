import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CouncilMetrics, MetricWindow, ProductionMetricsResponse, ReplyFeedbackMetrics, RouteMetrics } from "@mohassan/contracts";
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

  it("shows monitor health when monitor observations are the only traffic", () => {
    const data = report(false);
    data.windows.day.monitors = {
      checkLatenessMs: { samples: 4, p50: 4096, p95: 8192 },
      checks: { attempted: 4, succeeded: 3, successRate: 0.75 },
      alerts: { total: 2, unrated: 1, helpful: 1, notHelpful: 0, reasons: { no_meaningful_change: 0, late: 0, wrong_value: 0 } },
      delivered: { conversation: 2, tab: 1, webPush: 0, apns: 1 },
      pauses: { manual: 0, missing: 0, unreachable: 1 },
    };
    const markup = render({ kind: "ready", report: data });
    expect(markup).toContain("صحة المراقبات");
    expect(markup).toContain("<bdi>p95</bdi>");
    expect(markup).toContain("لم يتغير شيء مهم");
    expect(markup).toContain("إشعارات آيفون");
    expect(markup).not.toContain("لا توجد قياسات في الفترة المحددة");
  });

  it("renders council results and reply ratings even without in-memory observations", () => {
    const data = report(false);
    const { owner, member } = data.windows.day.roles;
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-council.ts#L81 (retrieved 2026-11-27)
    const v5Model = "chat-v5";
    const council: CouncilMetrics = {
      turns: 3, changedReplies: 1, chosenByModel: { pipeline: 2, [v5Model]: 1 },
      memberOutcomes: { [v5Model]: { ok: 2, abstained: 0, timeout: 1, failed: 0 } },
      elapsedMs: { samples: 3, p50: 240, p90: 720, p99: 720 },
      v5: { attempted: 3, answered: 2, unusedAnswers: 1 },
    };
    const feedback: ReplyFeedbackMetrics = {
      pipeline: { replies: 4, useful: 1, wrong: 1, incomplete: 1, unrated: 1 },
      v5: { replies: 1, useful: 0, wrong: 1, incomplete: 0, unrated: 0 },
      councilChanged: { replies: 1, useful: 0, wrong: 0, incomplete: 1, unrated: 0 },
    };
    owner.chat = { ...owner.chat, council, feedback };
    member.chat = { ...member.chat, feedback: {
      ...feedback, pipeline: { replies: 12, useful: 0, wrong: 0, incomplete: 0, unrated: 12 },
    } };

    const markup = render({ kind: "ready", report: data });
    const format = new Intl.NumberFormat("ar").format;
    const cells = (values: number[]) => values.map(value => `<td>${format(value)}</td>`).join("");
    expect(markup).not.toContain("لا توجد قياسات في الفترة المحددة");
    expect(markup).toContain("مجلس النماذج");
    expect(markup).toContain(`<dd>${format(council.v5.unusedAnswers)} من ${format(council.v5.answered)}</dd>`);
    expect(markup).toContain(`<bdi>p99</bdi></dt><dd>${format(council.elapsedMs.p99!)}</dd>`);
    expect(markup).toContain(`<bdi>${v5Model}</bdi></th>${cells([council.chosenByModel[v5Model]!, ...Object.values(council.memberOutcomes[v5Model]!)])}`);
    expect(markup).toContain("تقييم الردود · المالك");
    expect(markup).toContain(`<bdi>ردود غيّرها المجلس</bdi></th>${cells(Object.values(feedback.councilChanged))}`);
    expect(markup).not.toContain(cells(Object.values(member.chat.feedback!.pipeline)));
  });

  it("shows zero reply counts when feedback is available and omits unavailable council counts", () => {
    const data = report(false);
    const owner = data.windows.day.roles.owner;
    const counts = { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 };
    owner.chat = { ...owner.chat, feedback: { pipeline: counts, v5: counts, councilChanged: counts } };

    const markup = render({ kind: "ready", report: data });
    expect(markup).toContain("لا توجد قياسات في الفترة المحددة");
    expect(markup).toContain("تقييم الردود · المالك");
    const zeroCell = `<td>${new Intl.NumberFormat("ar").format(counts.replies)}</td>`;
    expect(markup).toContain(`<bdi>مسار الإجابة المعتاد</bdi></th>${zeroCell.repeat(Object.keys(counts).length)}`);
    expect(markup).not.toContain("مجلس النماذج");
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
