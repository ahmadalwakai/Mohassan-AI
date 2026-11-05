import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createDatabase, migrate, sql } from "@mohassan/database";
import type { CreateTaskInput } from "@mohassan/contracts";
import { Runtime, type DiagnosticResult } from "./index.ts";

const input: CreateTaskInput = {
  title: "فحص النواة والتخزين", goal: "تحقق من اتصال التخزين وصلاحية أداة التشخيص.",
  capabilityId: "system.diagnostic", autonomy: "scoped",
};

const validResult = (): DiagnosticResult => ({
  kind: "diagnostic", summary: "Test diagnostic evidence", observedAt: new Date().toISOString(),
  checks: [
    { name: "database", passed: true, evidence: "SELECT 1 returned 1" },
    { name: "capability_registry", passed: true, evidence: "Registered diagnostic capability" },
    { name: "permission_scope", passed: true, evidence: "diagnostic:read" },
  ],
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

describe("durable runtime and SQL policy boundaries", () => {
  let handle: Awaited<ReturnType<typeof createDatabase>>;
  let runtime: Runtime;
  beforeAll(async () => { handle = await createDatabase(); await migrate(handle.db); });
  beforeEach(async () => {
    await sql`TRUNCATE TABLE tasks CASCADE`.execute(handle.db);
    runtime = new Runtime(handle.db, { retryDelayMs: 0 });
  });
  afterAll(async () => { await runtime?.stop(); await handle?.close(); });

  it("deduplicates simultaneous request keys and rejects different input", async () => {
    const key = randomUUID();
    const tasks = await Promise.all(Array.from({ length: 8 }, () => runtime.createTask("owner", input, key)));
    expect(new Set(tasks.map((task) => task.id)).size).toBe(1);
    await expect(runtime.createTask("owner", { ...input, goal: "هذه مدخلات مختلفة لنفس مفتاح الطلب." }, key))
      .rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
    const detail = await runtime.detail("owner", tasks[0]!.id);
    expect(detail.events).toHaveLength(1);
  });

  it("isolates all owner-visible operations", async () => {
    const task = await runtime.createTask("owner", input, randomUUID());
    expect((await runtime.snapshot("stranger")).tasks).toEqual([]);
    await expect(runtime.detail("stranger", task.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.cancel("stranger", task.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.approve("stranger", task.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("runs a real SQL diagnostic and records contiguous verification events", async () => {
    const task = await runtime.createTask("owner", input, randomUUID());
    const finished = await runtime.tick();
    expect(finished).toMatchObject({ id: task.id, status: "completed", attempt: 1, error: null });
    expect(finished!.result).toMatchObject({ kind: "diagnostic", verifiedAt: expect.any(String) });
    const detail = await runtime.detail("owner", task.id);
    expect(detail.events.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(detail.events.map((entry) => entry.type)).toEqual(["task_created", "execution_started", "verification_started", "verification_passed"]);
  });

  it("does not run an assisted task without its exact approval", async () => {
    const task = await runtime.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    expect(task.status).toBe("waiting_approval");
    expect(await runtime.tick()).toBeNull();
    await runtime.approve("owner", task.id);
    const finished = await runtime.tick();
    expect(finished!.status).toBe("completed");
    const approval = await handle.db.selectFrom("approvals").selectAll().where("task_id", "=", task.id).executeTakeFirstOrThrow();
    expect(approval.consumed_at).toBeInstanceOf(Date);
    expect(approval.consumed_lease_token).toEqual(expect.any(String));
  });

  it("rejects an expired grant before the executor starts", async () => {
    let executions = 0;
    const worker = new Runtime(handle.db, { executeDiagnostic: async () => { executions += 1; return validResult(); } });
    const task = await worker.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await worker.approve("owner", task.id);
    await handle.db.updateTable("approvals").set({ expires_at: sql`CURRENT_TIMESTAMP - interval '1 second'` }).where("task_id", "=", task.id).execute();
    await worker.tick();
    expect(executions).toBe(0);
    expect((await worker.detail("owner", task.id)).task.status).toBe("waiting_approval");
  });

  it("requires a fresh approval for an assisted retry", async () => {
    let executions = 0;
    const worker = new Runtime(handle.db, {
      retryDelayMs: 0,
      executeDiagnostic: async () => { executions += 1; if (executions === 1) throw new Error("private tool detail"); return validResult(); },
    });
    const task = await worker.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await worker.approve("owner", task.id);
    expect((await worker.tick())!.status).toBe("waiting_approval");
    await worker.tick();
    expect(executions).toBe(1);
    await worker.approve("owner", task.id);
    expect((await worker.tick())!.status).toBe("completed");
    expect(executions).toBe(2);
    const grants = await handle.db.selectFrom("approvals").selectAll().where("task_id", "=", task.id).execute();
    expect(grants).toHaveLength(2);
    expect(new Set(grants.map((grant) => grant.consumed_lease_token)).size).toBe(2);
    expect((await worker.detail("owner", task.id)).events.some((entry) => entry.message.includes("private tool detail"))).toBe(false);
  });

  it("rejects false success and does not mark an unverified result completed", async () => {
    const worker = new Runtime(handle.db, { executeDiagnostic: async () => ({ summary: "completed" }) });
    const task = await worker.createTask("owner", input, randomUUID());
    expect((await worker.tick())!.status).toBe("failed");
    const detail = await worker.detail("owner", task.id);
    expect(detail.task.result).toBeNull();
    expect(detail.events.at(-1)!.type).toBe("verification_failed");
  });

  it("rechecks approval after asynchronous verification and before the success commit", async () => {
    const verified = deferred<void>();
    const resumeCommit = deferred<void>();
    const worker = new Runtime(handle.db);
    // Instrument the asynchronous verifier boundary without production options
    // or a timing race. The real verifier still runs before this pause.
    const boundary = worker as unknown as { verify(raw: unknown, shadow: boolean): Promise<Record<string, unknown> | null> };
    const originalVerify = boundary.verify.bind(worker);
    boundary.verify = async (raw, shadow) => {
      const result = await originalVerify(raw, shadow);
      verified.resolve();
      await resumeCommit.promise;
      return result;
    };
    const task = await worker.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await worker.approve("owner", task.id);
    const tick = worker.tick();
    await verified.promise;
    await handle.db.updateTable("approvals").set({ revoked_at: new Date() }).where("task_id", "=", task.id).execute();
    resumeCommit.resolve();
    expect((await tick)!.status).toBe("waiting_approval");
    const detail = await worker.detail("owner", task.id);
    expect(detail.task.result).toBeNull();
    expect(detail.events.at(-1)!.type).toBe("approval_expired");
    expect(detail.events.some((entry) => entry.type === "verification_passed")).toBe(false);
    const persisted = await handle.db.selectFrom("tasks").select(["lease_token", "lease_expires_at"]).where("id", "=", task.id).executeTakeFirstOrThrow();
    expect(persisted).toEqual({ lease_token: null, lease_expires_at: null });
  });

  it("honors cancellation while a tool is running", async () => {
    const started = deferred<void>();
    const worker = new Runtime(handle.db, {
      executeDiagnostic: async () => { started.resolve(); return new Promise(() => {}); },
    });
    const task = await worker.createTask("owner", input, randomUUID());
    const tick = worker.tick();
    await started.promise;
    const requested = await worker.cancel("owner", task.id);
    expect(requested.cancellationRequested).toBe(true);
    expect((await tick)!.status).toBe("cancelled");
    const detail = await worker.detail("owner", task.id);
    expect(detail.events.at(-1)!.type).toBe("task_cancelled");
    expect(detail.events.some((entry) => entry.type === "verification_passed")).toBe(false);
  });

  it("fences a stale worker after recovery commits a newer attempt", async () => {
    const started = deferred<void>();
    const output = deferred<unknown>();
    const staleWorker = new Runtime(handle.db, { executeDiagnostic: async () => { started.resolve(); return output.promise; } });
    const task = await staleWorker.createTask("owner", input, randomUUID());
    const staleTick = staleWorker.tick();
    await started.promise;
    await handle.db.updateTable("tasks").set({ lease_expires_at: sql`CURRENT_TIMESTAMP - interval '1 second'` }).where("id", "=", task.id).execute();
    const recovered = await runtime.tick();
    expect(recovered).toMatchObject({ status: "completed", attempt: 2 });
    output.resolve({ summary: "stale output cannot overwrite" });
    await staleTick;
    const detail = await runtime.detail("owner", task.id);
    expect(detail.task.result).toEqual(recovered!.result);
    expect(detail.events.filter((entry) => entry.type === "verification_passed")).toHaveLength(1);
    expect(detail.events.map((entry) => entry.sequence)).toEqual(detail.events.map((_, index) => index + 1));
  });

  it("does not reuse a consumed assisted approval after a lease expires", async () => {
    const started = deferred<void>();
    const output = deferred<unknown>();
    const staleWorker = new Runtime(handle.db, { executeDiagnostic: async () => { started.resolve(); return output.promise; } });
    const task = await staleWorker.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await staleWorker.approve("owner", task.id);
    const staleTick = staleWorker.tick();
    await started.promise;
    await handle.db.updateTable("tasks").set({ lease_expires_at: sql`CURRENT_TIMESTAMP - interval '1 second'` }).where("id", "=", task.id).execute();
    await runtime.tick();
    expect((await runtime.detail("owner", task.id)).task.status).toBe("waiting_approval");
    output.resolve(validResult());
    await staleTick;
    expect((await runtime.detail("owner", task.id)).task.status).toBe("waiting_approval");
    await runtime.approve("owner", task.id);
    expect((await runtime.tick())!.status).toBe("completed");
  });

  it("limits retry attempts and redacts executor errors", async () => {
    const worker = new Runtime(handle.db, {
      maxAttempts: 2, retryDelayMs: 0,
      executeDiagnostic: async () => { throw new Error("sensitive-provider-token"); },
    });
    const task = await worker.createTask("owner", input, randomUUID());
    expect((await worker.tick())!.status).toBe("queued");
    expect((await worker.tick())!.status).toBe("failed");
    expect(await worker.tick()).toBeNull();
    const detail = await worker.detail("owner", task.id);
    expect(detail.task.attempt).toBe(2);
    expect(JSON.stringify(detail)).not.toContain("sensitive-provider-token");
  });

  it("never executes a tool in shadow mode", async () => {
    let executions = 0;
    const worker = new Runtime(handle.db, { executeDiagnostic: async () => { executions += 1; return validResult(); } });
    const task = await worker.createTask("owner", { ...input, autonomy: "shadow" }, randomUUID());
    expect((await worker.tick())!.result).toMatchObject({ kind: "shadow", executed: false });
    expect(executions).toBe(0);
    expect((await worker.detail("owner", task.id)).task.status).toBe("completed");
  });

  it("does not run capabilities injected into persisted data", async () => {
    const task = await runtime.createTask("owner", input, randomUUID());
    await handle.db.updateTable("tasks").set({ capability_id: "shell.run" }).where("id", "=", task.id).execute();
    await runtime.tick();
    const detail = await runtime.detail("owner", task.id);
    expect(detail.task.status).toBe("failed");
    expect(detail.events.at(-1)!.type).toBe("permission_denied");
  });
});

describe("embedded SQL persistence and ownership", () => {
  it("persists task/events across a real database close and reopen", async () => {
    const base = resolve(tmpdir());
    const directory = await mkdtemp(join(base, "mohassan-runtime-"));
    let first: Awaited<ReturnType<typeof createDatabase>> | undefined;
    let second: Awaited<ReturnType<typeof createDatabase>> | undefined;
    try {
      first = await createDatabase({ dataDir: directory });
      await migrate(first.db);
      const task = await new Runtime(first.db).createTask("owner", input, randomUUID());
      await expect(createDatabase({ dataDir: directory })).rejects.toThrow(/already open/i);
      await first.close();
      first = undefined;
      second = await createDatabase({ dataDir: directory });
      await migrate(second.db);
      const worker = new Runtime(second.db);
      expect((await worker.detail("owner", task.id)).task.status).toBe("queued");
      expect((await worker.tick())!.status).toBe("completed");
      expect((await worker.detail("owner", task.id)).events).toHaveLength(4);
    } finally {
      await first?.close();
      await second?.close();
      const resolved = resolve(directory);
      if (!resolved.startsWith(base + sep) || !resolved.includes("mohassan-runtime-")) throw new Error("Unsafe test cleanup target");
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
