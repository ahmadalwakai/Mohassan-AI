import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { seal, unseal, packSession, unpackSession, keyFrom, requireSameOrigin, boundedJSON } from "../lib/security.ts";

test("relay encryption authenticates payload, key, job and direction", () => {
  const key = randomBytes(32);
  const data = { body: { messages: [{ role: "user", content: "private prompt" }] }, authorization: "Bearer private" };
  const encoded = seal(data, key, "wasla:request:v1:installation:job");
  assert.equal(JSON.stringify(encoded).includes("private"), false);
  assert.deepEqual(unseal(encoded, key, "wasla:request:v1:installation:job"), data);
  for (const aad of ["wasla:response:v1:installation:job", "wasla:request:v1:installation:other"]) assert.throws(() => unseal(encoded, key, aad));
  assert.throws(() => unseal(encoded, randomBytes(32), "wasla:request:v1:installation:job"));
  const raw = Buffer.from(encoded.ciphertext, "base64url"); raw[0] ^= 1;
  assert.throws(() => unseal({ ...encoded, ciphertext: raw.toString("base64url") }, key, "wasla:request:v1:installation:job"));
});
test("browser session rejects expired, tampered and wrong-key cookies", () => {
  const key = randomBytes(32); const value = { token: "a".repeat(32), device_id: "phone", exp: Date.now() + 60_000 };
  const cookie = packSession(value, key);
  assert.deepEqual(unpackSession(cookie, key), value);
  assert.equal(unpackSession(cookie, randomBytes(32)), null);
  assert.equal(unpackSession(cookie.slice(1), key), null);
  assert.equal(unpackSession(packSession({ ...value, exp: Date.now() - 1 }, key), key), null);
  assert.equal(unpackSession("x".repeat(5000), key), null);
  assert.throws(() => keyFrom("short"));
});
test("mutations require both same origin and explicit UI header", () => {
  const previous = process.env.WASLA_WEB_ORIGIN;
  process.env.WASLA_WEB_ORIGIN = "https://wasla.example";
  try {
    const req = (origin, header) => new Request("https://wasla.example/api/chat", { method: "POST", headers: { origin, "x-wasla-web": header } });
    assert.doesNotThrow(() => requireSameOrigin(req("https://wasla.example", "1")));
    assert.throws(() => requireSameOrigin(req("https://evil.example", "1")));
    assert.throws(() => requireSameOrigin(req("https://wasla.example", "")));
  } finally { if (previous === undefined) delete process.env.WASLA_WEB_ORIGIN; else process.env.WASLA_WEB_ORIGIN = previous; }
});
test("body size is bounded even without Content-Length", async () => {
  const req = (body) => new Request("https://wasla.example/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.deepEqual(await boundedJSON(req('{"value":1}')), { value: 1 });
  await assert.rejects(boundedJSON(req(JSON.stringify({ value: "x".repeat(65_536) }))), (error) => error.status === 413);
  await assert.rejects(boundedJSON(req("broken")), (error) => error.code === "invalid_json");
});
