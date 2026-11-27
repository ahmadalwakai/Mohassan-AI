import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductionMetricsPage from "../apps/web/app/ops/metrics/page";

const incoming = vi.hoisted(() => new Headers());
vi.mock("next/headers", () => ({ headers: async () => incoming }));

const apiOrigin = "http://localhost:4000";
const backupUrl = new URL("/api/ops/backup-status", apiOrigin);
const fixtureSecret = "backup-status-web-test-only";
const hourMs = 60 * 60 * 1000;
const dayHours = 24;
// Retrieved 2026-11-27, including the strict greater-than checks:
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/check-cloud.mjs#L4-L5
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/check-cloud.mjs#L114-L125
const dumpLimitHours = 26;
const drillLimitHours = 8 * dayHours;
const healthy = "النسخ الاحتياطي واختبار الاستعادة بحالة سليمة";
const needsAttention = "تحتاج حالة النسخ الاحتياطي إلى الانتباه";
const ages = new Intl.RelativeTimeFormat("ar", { numeric: "always" });

function atAge(hours: number) {
  return new Date(Date.now() - hours * hourMs).toISOString();
}

function report(dumpAge = 5, drillAge = 4 * dayHours, copyAge = 3) {
  return {
    newestDump: { snapshotAt: atAge(dumpAge), finishedAt: atAge(dumpAge - 1), ageHours: dumpAge, sizeBytes: 2 ** 20 },
    lastDrill: { finishedAt: atAge(drillAge), ageHours: drillAge, verdict: "passed" },
    offServerCopy: { downloadedAt: atAge(copyAge) },
  };
}

async function renderStatus(backupResponse: Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    if (url.href === backupUrl.href) return backupResponse;
    if (url.href === new URL("/api/ops/metrics", apiOrigin).href) return new Response(null, { status: 503 });
    throw new Error("Unexpected operations request");
  }));
  return renderToStaticMarkup(await ProductionMetricsPage());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"));
  vi.stubEnv("MOHASSAN_SERVER_URL", apiOrigin);
  vi.stubEnv("INTERNAL_API_SECRET", fixtureSecret);
  incoming.set("cookie", "test-session=owner");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  incoming.delete("cookie");
});

describe("owner backup status panel", () => {
  it("renders healthy status, dump size, localized ages and timestamps on the operations page", async () => {
    const fresh = report();
    const markup = await renderStatus(Response.json(fresh));

    expect(markup).toContain('dir="rtl" lang="ar"');
    expect(markup).toContain(healthy);
    expect(markup).toContain(`dateTime="${fresh.newestDump.snapshotAt}"`);
    expect(markup).toContain(`dateTime="${fresh.lastDrill.finishedAt}"`);
    expect(markup).toContain(ages.format(-fresh.newestDump.ageHours, "hour"));
    expect(markup).toContain(ages.format(-fresh.lastDrill.ageHours / dayHours, "day"));
    expect(markup).toContain(new Intl.NumberFormat("ar").format(fresh.newestDump.sizeBytes));
    expect(markup).toContain("بايت");
    expect(markup).toContain("نجح");
    expect(fetch).toHaveBeenCalledWith(backupUrl, expect.objectContaining({
      headers: { "x-mohassan-internal": fixtureSecret, cookie: "test-session=owner" },
      cache: "no-store",
      redirect: "error",
    }));
  });

  it("preserves healthy status at the freshness limits", async () => {
    const markup = await renderStatus(Response.json(report(dumpLimitHours, drillLimitHours, dumpLimitHours)));
    expect(markup).toContain(healthy);
    expect(markup).not.toContain(needsAttention);
  });

  it("warns about a stale dump even when the other checks are healthy", async () => {
    const markup = await renderStatus(Response.json(report(dumpLimitHours + 1)));
    expect(markup).toContain(needsAttention);
    expect(markup).toContain("النسخة الاحتياطية قديمة");
    expect(markup).not.toContain(healthy);
  });

  it("warns about a stale drill and still shows its successful result", async () => {
    const markup = await renderStatus(Response.json(report(5, drillLimitHours + dayHours)));
    expect(markup).toContain(needsAttention);
    expect(markup).toContain("اختبار الاستعادة قديم");
    expect(markup).toContain("نجح");
  });

  it.each([false, true])("shows a failed drill result regardless of whether it is stale (%s)", async (stale) => {
    const failed = report(5, stale ? drillLimitHours + dayHours : 4 * dayHours);
    failed.lastDrill.verdict = "failed";
    const markup = await renderStatus(Response.json(failed));
    expect(markup).toContain(needsAttention);
    expect(markup).toContain("فشل");
    if (stale) expect(markup).toContain("اختبار الاستعادة قديم");
    else expect(markup).not.toContain("اختبار الاستعادة قديم");
  });

  it("shows each missing record without presenting the system as healthy", async () => {
    const markup = await renderStatus(Response.json({ newestDump: null, lastDrill: null, offServerCopy: null }));
    expect(markup).toContain(needsAttention);
    expect(markup).toContain("لم يُسجَّل أي نسخ احتياطي بعد");
    expect(markup).toContain("لم يُجرَ اختبار استعادة بعد");
    expect(markup).toContain("لم تُسجَّل نسخة خارج الخادم");
    expect(markup).not.toContain("<time");
  });

  it("computes off-server copy age from the receipt and warns when it is stale", async () => {
    const copyAge = dumpLimitHours + 2;
    const markup = await renderStatus(Response.json(report(5, 4 * dayHours, copyAge)));
    expect(markup).toContain(ages.format(-copyAge, "hour"));
    expect(markup).toContain("النسخة خارج الخادم قديمة");
    expect(markup).toContain(needsAttention);
    expect(markup).not.toContain("النسخة الاحتياطية قديمة");
  });

  it("renders older records without a size as healthy with the size unavailable", async () => {
    const legacy = report();
    const { snapshotAt, finishedAt, ageHours } = legacy.newestDump;
    const markup = await renderStatus(Response.json({ ...legacy, newestDump: { snapshotAt, finishedAt, ageHours } }));
    expect(markup).toContain(healthy);
    expect(markup).toContain("حجم النسخة");
    expect(markup).toContain("غير متاح");
    expect(markup).not.toContain("بايت");
  });

  it.each([
    [401, "", "سجّل الدخول بحساب المالك"],
    [403, "test-session=member", "متاحة لحساب المالك فقط"],
  ] as const)("maps %s to the Arabic access state without rendering backup details", async (status, cookie, label) => {
    if (cookie) incoming.set("cookie", cookie);
    else incoming.delete("cookie");
    const markup = await renderStatus(Response.json(report(), { status }));
    expect(markup).toContain(label);
    expect(markup).not.toContain(healthy);
    expect(markup).not.toContain("<time");
    expect(fetch).toHaveBeenCalledWith(backupUrl, expect.objectContaining({
      headers: { "x-mohassan-internal": fixtureSecret, cookie },
    }));
  });

  it("distinguishes an invalid response from a valid report with missing records", async () => {
    const markup = await renderStatus(Response.json({ newestDump: null }));
    expect(markup).toContain("تعذّر تحميل حالة النسخ الاحتياطي");
    expect(markup).not.toContain("لم يُجرَ اختبار استعادة بعد");
  });
});
