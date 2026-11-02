import test from "node:test";
import assert from "node:assert/strict";
import { normalizePairCode, safeSourceURL, requestJSON, RequestError } from "../components/client.ts";

test("pairing preserves leading zeros and normalizes Arabic and Persian digits", () => {
  for (const raw of ["00123456", "٠٠١٢٣٤٥٦", "۰۰۱۲۳۴۵۶", "  0٠۱23456\n"]) assert.equal(normalizePairCode(raw), "00123456");
  assert.equal(normalizePairCode("123456789"), "123456789", "do not silently truncate pasted codes");
});

test("source links reject executable protocols and embedded credentials", () => {
  for (const raw of ["javascript:alert(1)", "data:text/html,hello", "https://name:secret@example.com/", "/relative"]) assert.equal(safeSourceURL(raw), null);
  assert.equal(safeSourceURL("https://example.com/article?q=one")?.hostname, "example.com");
});

test("mutation uses same-origin cookies and CSRF header, and preserves request id", async (context) => {
  let calls = 0;
  const body = JSON.stringify({ request_id: "test-stable-id", remember: false });
  context.mock.method(globalThis, "fetch", async (path, options) => {
    calls++;
    assert.equal(path, "/api/chat");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.get("X-Wasla-Web"), "1");
    assert.equal(options.body, body);
    return Response.json({ content: "answer" });
  });
  assert.deepEqual(await requestJSON("/api/chat", { method: "POST", body }), { content: "answer" });
  assert.equal(calls, 1);
});

test("failed request is surfaced without an automatic retry", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: { code: "busy", message: "Try later" } }, { status: 429 }); });
  await assert.rejects(requestJSON("/api/chat", { method: "POST", body: "{}" }), (error) => error instanceof RequestError && error.status === 429 && error.code === "busy");
  assert.equal(calls, 1);
});

test("request deadline aborts waiting and produces a timeout error", async (context) => {
  context.mock.method(globalThis, "fetch", async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(requestJSON("/api/pair", { method: "POST", body: "{}" }, 15), (error) => error instanceof RequestError && error.code === "timeout");
});

test("explicit cancellation stays distinguishable from a timeout", async (context) => {
  context.mock.method(globalThis, "fetch", async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const controller = new AbortController();
  const pending = requestJSON("/api/chat", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("client cannot send through an external API URL", async () => {
  await assert.rejects(requestJSON("https://example.com/api/chat"), /Invalid endpoint/);
});
