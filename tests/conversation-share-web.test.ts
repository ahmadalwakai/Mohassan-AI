import { createHash, randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getPublicShare } from "../apps/web/app/share/[token]/route";
import { GET as getApi } from "../apps/web/app/api/[...path]/route";
import { ConversationActions } from "../apps/web/components/conversation-actions";
import { ConversationShareSettings } from "../apps/web/components/conversation-share-settings";

const token = Buffer.alloc(16).toString("base64url");
const request = () => new Request(`http://localhost/share/${token}`, { headers: { Cookie: "fixture=browser" } });
const params = (value: string) => ({ params: Promise.resolve({ token: value }) });
const stamp = new Date(Date.UTC(2026, 10, 25, 10)).toISOString();
const secret = randomBytes(16).toString("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectPrivateResponse(response: Response) {
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none';");
}

describe("public conversation route", () => {
  it("renders Arabic RTL with escaped content and a hash-pinned stylesheet without sending a session", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", secret);
    // example.org is reserved for examples by RFC 2606 §3 (retrieved 2026-11-25).
    // https://www.rfc-editor.org/rfc/rfc2606#section-3
    const source = "https://example.org/page?a=1&b=2";
    const fetcher = vi.fn((_url: URL, _options: RequestInit) => Promise.resolve(Response.json({
      snapshot: {
        title: "<script>محادثة</script>", createdAt: stamp,
        messages: [
          { role: "user", text: "السؤال الأول", createdAt: stamp, sources: [] },
          { role: "assistant", text: "<a>الجواب الثاني</a>", createdAt: stamp, sources: [
            { title: "<em>مصدر</em>", url: source },
            { title: "رابط غير آمن", url: "https://user@www.example.org/" },
          ] },
        ],
      },
      sharedAt: stamp,
    })));
    vi.stubGlobal("fetch", fetcher);
    const response = await getPublicShare(request(), params(token));
    expect(response.status).toBe(200);
    expectPrivateResponse(response);
    const [target, options] = fetcher.mock.calls[0]!;
    expect(target.pathname.endsWith(`/public/${token}`)).toBe(true);
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    const upstreamHeaders = new Headers(options.headers);
    expect(upstreamHeaders.has("Cookie")).toBe(false);
    expect(upstreamHeaders.get("x-mohassan-internal") === secret).toBe(true);

    const html = await response.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("&lt;script&gt;محادثة&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;a&gt;الجواب الثاني&lt;/a&gt;");
    expect(html.indexOf("السؤال الأول")).toBeLessThan(html.indexOf("الجواب الثاني"));
    expect(html).toContain('href="https://example.org/page?a=1&amp;b=2"');
    expect(html).toContain("&lt;em&gt;مصدر&lt;/em&gt;");
    expect(html).not.toContain("رابط غير آمن");
    expect(html).toContain(`<footer>مشاركة من موحسن · <time datetime="${stamp}">`);
    const css = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? "";
    const hash = createHash("sha256").update(css).digest("base64");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  });

  it("applies public security headers when links are unavailable or the service is down", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", secret);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockRejectedValueOnce(new Error());
    vi.stubGlobal("fetch", fetcher);
    const invalid = await getPublicShare(request(), params("bad-format"));
    expect(invalid.status).toBe(404);
    expectPrivateResponse(invalid);
    expect(fetcher).not.toHaveBeenCalled();
    const unavailable = await getPublicShare(request(), params(token));
    expect(unavailable.status).toBe(404);
    expectPrivateResponse(unavailable);
    const serviceFailure = await getPublicShare(request(), params(token));
    expect(serviceFailure.status).toBe(503);
    expectPrivateResponse(serviceFailure);
  });
});

describe("web API proxy", () => {
  it("forwards the conversation export attachment and never proxies the raw public lookup", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", secret);
    const disposition = `attachment; filename="conversation.md"; filename*=UTF-8''${encodeURIComponent("محادثة.md")}`;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("# محادثة", {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": disposition },
    }));
    vi.stubGlobal("fetch", fetcher);
    const path = ["chat", "conversations", "fixture", "export"];
    const target = new URL(`/api/${path.join("/")}?format=markdown`, "http://localhost");
    const response = await getApi(new NextRequest(target), { params: Promise.resolve({ path }) });
    expect(response.headers.get("Content-Disposition")).toBe(disposition);
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(await response.text()).toBe("# محادثة");

    fetcher.mockClear();
    const rawPath = ["chat", "conversation-shares", "public", token];
    const raw = await getApi(new NextRequest(new URL(`/api/${rawPath.join("/")}`, "http://localhost")), { params: Promise.resolve({ path: rawPath }) });
    expect(raw.status).toBe(404);
    expect(raw.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("conversation controls", () => {
  it("offers export for a selected conversation and preserves link management after deselection", () => {
    const selected = renderToStaticMarkup(createElement(ConversationActions, { conversationId: "fixture" }));
    expect(selected).toContain("مشاركة");
    expect(selected).toContain("تصدير");
    const noSelection = renderToStaticMarkup(createElement(ConversationActions, {}));
    expect(noSelection).toContain("روابط المشاركة");
    expect(noSelection).not.toContain("تصدير");
  });

  it("renders an owner switch that stays disabled until the setting is loaded", () => {
    const settings = renderToStaticMarkup(createElement(ConversationShareSettings, { offline: false }));
    expect(settings).toContain("السماح للأعضاء بإنشاء روابط مشاركة");
    expect(settings).toMatch(/<input[^>]+disabled=""[^>]*>/u);
  });
});
