import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorCard, MonitorCondition, MonitorRead } from "@mohassan/contracts";
import { GET, POST } from "../apps/web/app/api/[...path]/route";
import { changeMonitor, followMonitorChanges, listMonitors, mergeMonitors } from "../apps/web/components/monitors-client";
import { ConversationMonitors, MonitorSettings, SmartMonitorCard } from "../apps/web/components/smart-monitors";

const timestamp = "2026-11-25T12:00:00.000Z";
const nextCheckAt = "2026-11-25T12:15:00.000Z";
const proposal: MonitorCard = {
  id: "10000000-0000-4000-8000-000000000001",
  conversationId: "10000000-0000-4000-8000-000000000002",
  spec: {
    title: "USD/SAR exchange rate", source: { kind: "currency", base: "USD", quote: "SAR" },
    read: { kind: "number" }, condition: { kind: "threshold", direction: "below", value: 3.7, hysteresis: 0.01 },
    timing: { urgency: "normal", lifetimeMs: 86_400_000, initialIntervalMs: 900_000, maxChecks: 48, maxNotifications: 1 },
    language: "en", message: "USD/SAR fell below 3.70.",
  },
  offer: "explicit", status: "proposed", note: "I’ll notify you when the rate falls below 3.70.",
  current: { value: 3.75, excerpt: "USD/SAR <market quote>", observedAt: timestamp },
  lastCheckedAt: timestamp, nextCheckAt: null, expiresAt: "2026-11-26T12:00:00.000Z",
};
const active: MonitorCard = { ...proposal, status: "active", nextCheckAt };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("web monitor cards", () => {
  it("shows the approval plan and safe evidence before offering to start", () => {
    const html = renderToStaticMarkup(createElement(ConversationMonitors, {
      conversationId: proposal.conversationId, proposal,
    }));
    expect(html).toContain("Monitoring plan");
    expect(html).toContain("Current value");
    expect(html).toContain("3.75");
    expect(html).toContain("&lt;market quote&gt;");
    expect(html).toContain("the reading is below 3.70");
    expect(html).toContain("15 minutes");
    expect(html).toContain("1 day");
    expect(html).toContain("Start monitoring");
    expect(html).toContain("Not now");
    expect(html).not.toContain("Stop monitoring");
  });

  it.each([
    ["implicit", "عرض مراقبة"],
    ["agent-initiated", "عرض مراقبة لمتابعة المهمة"],
  ] as const)("offers %s monitoring in Arabic", (offer, heading) => {
    const html = renderToStaticMarkup(createElement(SmartMonitorCard, { monitor: {
      ...proposal, offer, spec: { ...proposal.spec, language: "ar" }, current: null,
    } }));
    expect(html).toContain('lang="ar" dir="rtl"');
    expect(html).toContain(heading);
    expect(html).toContain("القراءة غير متاحة");
    expect(html).toContain("بدء المراقبة");
  });

  it.each([
    [{ kind: "change" }, { kind: "main" }, "reading changes"],
    [{ kind: "equals", value: "open" }, { kind: "status" }, "reading is “open”"],
    [{ kind: "contains", value: "tickets available" }, { kind: "main" }, "reading includes “tickets available”"],
    [{ kind: "appears" }, { kind: "phrase", phrase: "book now" }, "“book now” appears"],
    [{ kind: "disappears" }, { kind: "phrase", phrase: "Sold out" }, "“Sold out” disappears"],
    [{ kind: "crossing", direction: "above", value: 22, hysteresis: 0.1 }, { kind: "number" }, "reading crosses above 22"],
    [{ kind: "percent", direction: "below", value: 5 }, { kind: "number" }, "reading falls by at least 5%"],
    [{ kind: "new-item" }, { kind: "items" }, "a new item appears"],
  ] satisfies [MonitorCondition, MonitorRead, string][])("explains the %j condition in the approval card", (condition, read, expected) => {
    const monitor: MonitorCard = {
      ...proposal, spec: { ...proposal.spec, source: { kind: "page", url: "https://example.org" }, condition, read },
    };
    expect(renderToStaticMarkup(createElement(SmartMonitorCard, { monitor }))).toContain(expected);
  });

  it("displays check times and management actions appropriate to each status", () => {
    const render = (monitor: MonitorCard) => renderToStaticMarkup(createElement(SmartMonitorCard, { monitor }));
    const html = render(active);
    expect(html).toContain(`<time dateTime="${timestamp}">`);
    expect(html).toContain(`<time dateTime="${nextCheckAt}">`);
    expect(html).toContain(">Pause</button>");
    expect(html).toContain(">Stop monitoring</button>");
    expect(render({ ...active, status: "paused", nextCheckAt: null })).toContain(">Resume</button>");
    expect(render({ ...active, status: "completed", nextCheckAt: null })).not.toContain("Stop monitoring");
    expect(renderToStaticMarkup(createElement(MonitorSettings, { onOpenConversation: vi.fn() }))).toContain('aria-haspopup="dialog"');
  });
});

describe("web monitor proxy", () => {
  it("forwards the session and conversation scope, and accepts a pause POST without a body", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "monitor-web-fixture");
    vi.stubEnv("MOHASSAN_SERVER_URL", "http://127.0.0.1:4200");
    const outbound = vi.fn(async (_target: URL, _options: RequestInit) => Response.json({}));
    vi.stubGlobal("fetch", outbound);
    const headers = { Cookie: "fixture=browser" };
    const origin = "https://example.test";
    const filter = `?conversationId=${proposal.conversationId}`;
    const list = await GET(new NextRequest(`${origin}/api/chat/monitors${filter}`, { headers }), {
      params: Promise.resolve({ path: ["chat", "monitors"] }),
    });
    expect(list.ok).toBe(true);
    expect(outbound.mock.calls[0]![0].search).toBe(filter);
    expect(new Headers(outbound.mock.calls[0]![1].headers).get("Cookie")).toBe(headers.Cookie);
    const path = ["chat", "monitors", proposal.id, "pause"];
    const paused = await POST(new NextRequest(`${origin}/api/${path.join("/")}`, { headers, method: "POST" }), {
      params: Promise.resolve({ path }),
    });
    expect(paused.ok).toBe(true);
    const [target, options] = outbound.mock.calls[1]!;
    expect(target.pathname).toBe(`/api/${path.join("/")}`);
    expect(options.method).toBe("POST");
    expect(options.body).toBeUndefined();
  });
});

describe("web monitor requests", () => {
  it("scopes refreshes by conversation and replaces old monitor snapshots on update", async () => {
    const fetcher = vi.fn(async () => Response.json({ monitors: [active] }));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();
    expect(await listMonitors(signal, "Could not load monitors", proposal.conversationId)).toEqual([active]);
    expect(fetcher).toHaveBeenCalledWith(`/api/chat/monitors?conversationId=${proposal.conversationId}`, {
      signal, credentials: "same-origin", cache: "no-store",
    });
    expect(mergeMonitors([proposal], [active])).toEqual([active]);
  });

  it("sends the proposal ID and lifecycle operations through the chat route", async () => {
    const fetcher = vi.fn(async () => Response.json(active));
    vi.stubGlobal("fetch", fetcher);
    const update = vi.fn();
    const unlisten = followMonitorChanges(update);
    await changeMonitor(proposal.id, "approve", "Could not save");
    expect(fetcher).toHaveBeenLastCalledWith("/api/chat/monitors", {
      method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id }),
    });
    expect(update).toHaveBeenCalledWith(active);
    unlisten();
    for (const action of ["pause", "resume", "stop"] as const) {
      await changeMonitor(proposal.id, action, "Could not save");
      expect(fetcher).toHaveBeenLastCalledWith(`/api/chat/monitors/${proposal.id}/${action}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
      });
    }
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server error when approval fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Monitor quota reached" } }, { status: 429 })));
    await expect(changeMonitor(proposal.id, "approve", "Could not save")).rejects.toThrow("Monitor quota reached");
  });
});
