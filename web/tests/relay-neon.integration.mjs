// Opt in explicitly after installing the relay schema in a private test database:
// WASLA_RUN_NEON_TEST=1 node --test tests/relay-neon.integration.mjs
// DATABASE_URL may be supplied, otherwise the task-private connection file is read.
// This tests the real Neon broker with synthetic data, not a Python worker or model.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { extname } from "node:path";

test("Neon relay encrypts, leases once, rejects tampering and completes", {
  skip: process.env.WASLA_RUN_NEON_TEST !== "1" ? "Set WASLA_RUN_NEON_TEST=1 for the private database integration" : false,
  timeout: 39_000,
}, async () => {
  const libURL = new URL("../lib/", import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(libURL) && specifier.startsWith(".") && !extname(specifier)) {
        return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  const names = ["DATABASE_URL", "WASLA_RELAY_INSTALLATION_ID", "WASLA_RELAY_KEY_BASE64", "WASLA_RELAY_TOKEN"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const installation = `wasla-hybrid-review-${randomUUID()}`;
  const key = randomBytes(32);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  let phaseSignal = deadline.signal;
  let neonConfig;
  let originalFetchFunction;
  let sql;
  let pending;
  let pendingOutcome;
  let stage = "configuration";
  let mainFailure;
  let cleanupFailed = false;
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  try {
    let databaseURL = process.env.DATABASE_URL;
    if (!databaseURL) {
      const path = process.env.WASLA_NEON_CONFIG || new URL("../../../../work/hybrid-cloud-private/connection.json", import.meta.url);
      const configuration = JSON.parse(await readFile(path, "utf8"));
      databaseURL = configuration.database_url;
    }
    if (typeof databaseURL !== "string" || !/^postgres(?:ql)?:\/\//.test(databaseURL)) throw new Error("Missing database configuration");
    process.env.DATABASE_URL = databaseURL;
    process.env.WASLA_RELAY_INSTALLATION_ID = installation;
    process.env.WASLA_RELAY_KEY_BASE64 = key.toString("base64");
    process.env.WASLA_RELAY_TOKEN = randomBytes(32).toString("base64url");

    const driver = await import("@neondatabase/serverless");
    neonConfig = driver.neonConfig;
    originalFetchFunction = neonConfig.fetchFunction;
    // All calls still reach Neon. Bounds prevent a network failure hanging this test.
    neonConfig.fetchFunction = (url, options = {}) => fetch(url, {
      ...options,
      signal: AbortSignal.any([phaseSignal, AbortSignal.timeout(6000), ...(options.signal ? [options.signal] : [])]),
    });
    sql = driver.neon(databaseURL);
    const { relayRequest, pollWorker, completeWorker } = await import("../lib/relay.ts");
    const { seal, unseal } = await import("../lib/security.ts");
    const aad = (direction, id) => `wasla:${direction}:v1:${installation}:${id}`;

    stage = "schema check";
    await sql.query("SELECT id FROM wasla_relay_jobs WHERE installation_id=$1 LIMIT 1", [installation]);
    const request = { method: "GET", path: "/v1/status", authorization: "Bearer synthetic-integration-credential" };
    const expected = { status: 200, body: { name: "Relay integration fixture", model: "synthetic-broker-response", busy: null, marker: randomUUID() } };
    stage = "enqueue";
    // Attach both handlers immediately; failures must never become unhandled rejections.
    pending = relayRequest(request).then(
      (value) => { pendingOutcome = { value }; },
      () => { pendingOutcome = { failed: true }; },
    );
    let queued = false;
    for (let attempt = 0; attempt < 18 && !deadline.signal.aborted; attempt++) {
      if (pendingOutcome?.failed) throw new Error("Broker request failed");
      const rows = await sql.query("SELECT id FROM wasla_relay_jobs WHERE installation_id=$1 AND state='queued'", [installation]);
      if (rows.length) { queued = true; break; }
      await pause(150);
    }
    assert.equal(queued, true, "the request must be queued in the real database");

    stage = "concurrent lease";
    const leases = await Promise.all([
      pollWorker({ installation_id: installation, worker_id: "integration-worker-a" }),
      pollWorker({ installation_id: installation, worker_id: "integration-worker-b" }),
    ]);
    const jobs = leases.map((result) => result.job).filter(Boolean);
    assert.equal(jobs.length, 1, "concurrent workers must receive one lease in total");
    const job = jobs[0];
    const decoded = unseal(job.request, key, aad("request", job.id));
    assert.equal(decoded.method, request.method);
    assert.equal(decoded.path, request.path);
    assert.equal(decoded.authorization, request.authorization);
    assert.equal(Number.isInteger(decoded.expires_at) && decoded.expires_at > Date.now() / 1000, true);
    assert.equal(JSON.stringify(job.request).includes("synthetic-integration-credential"), false, "queue payload must remain encrypted");
    assert.equal((await pollWorker({ installation_id: installation, worker_id: "integration-worker-c" })).job, null, "leased work must not be offered again");

    stage = "authenticated completion";
    const response = seal(expected, key, aad("response", job.id));
    const bytes = Buffer.from(response.ciphertext, "base64url"); bytes[0] ^= 1;
    const finish = { installation_id: installation, job_id: job.id, lease_token: job.lease_token };
    await assert.rejects(completeWorker({ ...finish, response: { ...response, ciphertext: bytes.toString("base64url") } }), "tampered encrypted responses must be rejected");
    assert.deepEqual(await completeWorker({ ...finish, lease_token: randomBytes(32).toString("base64url"), response }), { accepted: false }, "a different lease token cannot finish this job");
    assert.deepEqual(await completeWorker({ ...finish, response }), { accepted: true });
    assert.deepEqual(await completeWorker({ ...finish, response }), { accepted: false }, "duplicate completion must not have a second effect");
    await pending;
    assert.equal(pendingOutcome?.failed, undefined, "the broker must receive the valid response");
    assert.deepEqual(pendingOutcome?.value, expected);
    assert.equal((await pollWorker({ installation_id: installation, worker_id: "integration-idle" })).job, null);
    const remaining = await sql.query("SELECT id FROM wasla_relay_jobs WHERE installation_id=$1", [installation]);
    assert.equal(remaining.length, 0, "the completed transport row must be removed");
  } catch (error) {
    // Database errors can contain connection details. Never print them or their cause.
    mainFailure = error instanceof assert.AssertionError ? error : new Error(`Private Neon integration failed during ${stage}; connection details omitted.`);
  } finally {
    clearTimeout(timer);
    deadline.abort();
    phaseSignal = AbortSignal.timeout(5000);
    if (sql) {
      try {
        // Remove only this invocation's random installation. Never clear another queue.
        await sql.query("DELETE FROM wasla_relay_jobs WHERE installation_id=$1", [installation]);
      } catch { cleanupFailed = true; }
      // Keep bounded fetches and this test's environment until the broker settles.
      if (pending) await pending;
      try { await sql.query("DELETE FROM wasla_relay_jobs WHERE installation_id=$1", [installation]); }
      catch { cleanupFailed = true; }
    }
    if (neonConfig) neonConfig.fetchFunction = originalFetchFunction;
    hooks.deregister();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    key.fill(0);
  }
  if (mainFailure) throw mainFailure;
  assert.equal(cleanupFailed, false, "cleanup of this test's transport rows must succeed");
});
