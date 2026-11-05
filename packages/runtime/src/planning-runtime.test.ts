import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, migrate, sql } from "@mohassan/database";
import type { CreateTaskInput, PlanningResult, RawCognitivePlan } from "@mohassan/contracts";
import { PlanningEngine, PlanningError } from "@mohassan/cognitive";
import { Runtime, createCapabilities } from "./index.ts";

const input: CreateTaskInput = {
  title: "إنشاء خطة قابلة للتحقق", goal: "ضع خطة لفحص مساحة العمل ثم مراجعة أدلتها وإعداد تقرير.",
  capabilityId: "plan.draft", autonomy: "scoped",
};
const rawPlan: RawCognitivePlan = {
  summary: "خطة فحص ومراجعة لا تنفذ أي إجراء.",
  goal: {
    objective: "فحص مساحة العمل ومراجعة أدلة الفحص.",
    successCriteria: [{ id: "verified", description: "تحديد أدلة يمكن مراجعتها.", evidence: "نتيجة فحص مستقلة ومراجعة بشرية." }],
    constraints: ["لا تنفيذ ضمن مهمة التخطيط."], assumptions: [], clarifyingQuestions: [],
  },
  uncertainties: [], confidence: 0.9,
  steps: [
    { id: "inspect", title: "افحص مساحة العمل", description: "استخدم التشخيص المصرح عند بدء مهمة تنفيذ مستقلة.", dependsOn: [], capabilityId: "system.diagnostic", requiredScopes: [], requiresApproval: false, acceptanceCriteria: ["وجود نتيجة فحص موثقة."] },
    { id: "review", title: "راجع الأدلة", description: "مراجعة بشرية للنتيجة المسجلة.", dependsOn: ["inspect"], capabilityId: null, requiredScopes: [], requiresApproval: false, acceptanceCriteria: ["تأكيد صلاحية الأدلة."] },
    { id: "report", title: "جهز تقريرًا", description: "اجمع نتيجة التشخيص في تقرير قابل للمراجعة.", dependsOn: ["inspect"], capabilityId: null, requiredScopes: [], requiresApproval: false, acceptanceCriteria: ["تقرير لا يدعي تنفيذ الخطة."] },
  ],
};

function engine() {
  return new PlanningEngine({
    capabilities: createCapabilities(true),
    providerForModel: (model) => ({ id: "groq", generate: async () => ({ text: JSON.stringify(rawPlan), model, usage: { inputTokens: 123, outputTokens: 87 } }) }),
  });
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

describe("planning runtime: paid request receipts, policy, and persistence", () => {
  let handle: Awaited<ReturnType<typeof createDatabase>>;
  let fixture: PlanningResult;
  beforeAll(async () => {
    handle = await createDatabase();
    await migrate(handle.db);
    fixture = await engine().generate(input.goal);
  });
  beforeEach(async () => { await sql`TRUNCATE TABLE tasks CASCADE`.execute(handle.db); });
  afterAll(async () => { await handle.close(); });

  it("exposes planning as active only when the runtime has a planning callback", async () => {
    const unavailable = new Runtime(handle.db);
    expect(unavailable.getCapabilities().find((capability) => capability.id === "plan.draft")!.status).toBe("needs_configuration");
    await expect(unavailable.createTask("owner", input, randomUUID())).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const available = new Runtime(handle.db, { plan: async () => fixture });
    expect(available.getCapabilities().find((capability) => capability.id === "plan.draft")!.status).toBe("active");
  });

  it("persists the verified plan, dependency graph and actual usage without executing its steps", async () => {
    let providerCalls = 0;
    let toolCalls = 0;
    const planner = engine();
    const runtime = new Runtime(handle.db, {
      plan: async (goal, context) => { providerCalls += 1; return planner.generate(goal, context); },
      executeDiagnostic: async () => { toolCalls += 1; throw new Error("planned tools must not run"); },
    });
    const task = await runtime.createTask("owner", input, randomUUID());
    expect((await runtime.tick())!.status).toBe("completed");
    const detail = await runtime.detail("owner", task.id);
    expect(providerCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(detail.task.result).toMatchObject({ kind: "plan", executionAllowed: false, executionBatches: [["inspect"], ["review", "report"]] });
    expect(detail.steps).toHaveLength(3);
    expect(detail.steps!.every((step) => step.status === "planned")).toBe(true);
    expect(detail.steps!.find((step) => step.stepId === "review")!.dependsOn).toEqual(["inspect"]);
    expect(detail.modelRuns).toEqual([expect.objectContaining({ status: "succeeded", inputTokens: 123, outputTokens: 87, resultCommitted: true })]);
    expect(detail.events.map((entry) => entry.type)).toContain("plan_verified");
    expect(detail.events.map((entry) => entry.sequence)).toEqual(detail.events.map((_, index) => index + 1));
    await expect(runtime.detail("stranger", task.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("uses an exact model:generate grant for assisted planning", async () => {
    let calls = 0;
    const runtime = new Runtime(handle.db, { plan: async () => { calls += 1; return fixture; } });
    const task = await runtime.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await runtime.tick();
    expect(calls).toBe(0);
    await runtime.approve("owner", task.id);
    await handle.db.updateTable("approvals").set({ scope: "diagnostic:read" }).where("task_id", "=", task.id).execute();
    await runtime.tick();
    expect(calls).toBe(0);
    expect((await runtime.detail("owner", task.id)).task.status).toBe("waiting_approval");
    await runtime.approve("owner", task.id);
    expect((await runtime.tick())!.status).toBe("completed");
    expect(calls).toBe(1);
  });

  it("makes no provider request and creates no usage receipt in shadow mode", async () => {
    let calls = 0;
    const runtime = new Runtime(handle.db, { plan: async () => { calls += 1; return fixture; } });
    const task = await runtime.createTask("owner", { ...input, autonomy: "shadow" }, randomUUID());
    expect((await runtime.tick())!.status).toBe("completed");
    const detail = await runtime.detail("owner", task.id);
    expect(calls).toBe(0);
    expect(detail.task.result).toMatchObject({ kind: "shadow", capabilityId: "plan.draft", executed: false });
    expect(detail.steps).toEqual([]);
    expect(detail.modelRuns).toEqual([]);
  });

  it("rejects a tampered plan while preserving the response's known usage", async () => {
    const runtime = new Runtime(handle.db, { plan: async () => ({ ...fixture, executionBatches: [["report", "inspect", "review"]] }) });
    const task = await runtime.createTask("owner", input, randomUUID());
    expect((await runtime.tick())!.status).toBe("failed");
    const detail = await runtime.detail("owner", task.id);
    expect(detail.task.result).toBeNull();
    expect(detail.steps).toEqual([]);
    expect(detail.modelRuns![0]).toMatchObject({ status: "succeeded", inputTokens: 123, outputTokens: 87, resultCommitted: false });
    expect(detail.events.at(-1)!.type).toBe("verification_failed");
  });

  it("rolls back every planned step and success marker if graph storage fails", async () => {
    let calls = 0;
    const runtime = new Runtime(handle.db, { plan: async () => { calls += 1; return fixture; } });
    const task = await runtime.createTask("owner", input, randomUUID());
    await sql`ALTER TABLE task_plan_steps ADD CONSTRAINT test_graph_storage_failure CHECK(step_id <> 'report')`.execute(handle.db);
    try {
      expect((await runtime.tick())!.status).toBe("waiting_approval");
      const detail = await runtime.detail("owner", task.id);
      expect(detail.task.result).toBeNull();
      expect(detail.steps).toEqual([]);
      expect(detail.modelRuns![0]).toMatchObject({ status: "succeeded", inputTokens: 123, outputTokens: 87, resultCommitted: false });
      expect(detail.events.some((entry) => entry.type === "verification_passed")).toBe(false);
      await runtime.tick();
      expect(calls).toBe(1);
    } finally {
      await sql`ALTER TABLE task_plan_steps DROP CONSTRAINT test_graph_storage_failure`.execute(handle.db);
    }
  });

  it("preserves a paid validation-failure receipt without retrying automatically", async () => {
    let calls = 0;
    const runtime = new Runtime(handle.db, { plan: async () => {
      calls += 1;
      throw new PlanningError("INVALID_PLAN", "private raw provider response", { model: fixture.model, usage: fixture.usage });
    } });
    const task = await runtime.createTask("owner", input, randomUUID());
    expect((await runtime.tick())!.status).toBe("waiting_approval");
    await runtime.tick();
    const detail = await runtime.detail("owner", task.id);
    expect(calls).toBe(1);
    expect(detail.modelRuns![0]).toMatchObject({ status: "failed", inputTokens: 123, outputTokens: 87, resultCommitted: false });
    expect(JSON.stringify(detail)).not.toContain("private raw provider response");
  });

  it("does not repeat an ambiguous paid request even for scoped autonomy", async () => {
    let calls = 0;
    const runtime = new Runtime(handle.db, { plan: async () => {
      calls += 1;
      if (calls === 1) throw new Error("sensitive-network-details");
      return fixture;
    } });
    const task = await runtime.createTask("owner", input, randomUUID());
    expect((await runtime.tick())!.status).toBe("waiting_approval");
    await runtime.tick();
    expect(calls).toBe(1);
    const first = await runtime.detail("owner", task.id);
    expect(first.modelRuns![0]).toMatchObject({ status: "unknown", inputTokens: null, outputTokens: null, resultCommitted: false });
    expect(JSON.stringify(first)).not.toContain("sensitive-network-details");
    await runtime.approve("owner", task.id);
    expect((await runtime.tick())!.status).toBe("completed");
    expect(calls).toBe(2);
    const final = await runtime.detail("owner", task.id);
    expect(final.modelRuns).toHaveLength(2);
    expect(final.modelRuns![1]).toMatchObject({ attempt: 2, resultCommitted: true });
  });

  it("cancels an in-flight planning request and records unknown usage", async () => {
    const started = deferred<void>();
    const runtime = new Runtime(handle.db, { plan: async () => { started.resolve(); return new Promise(() => {}); } });
    const task = await runtime.createTask("owner", input, randomUUID());
    const tick = runtime.tick();
    await started.promise;
    await runtime.cancel("owner", task.id);
    expect((await tick)!.status).toBe("cancelled");
    const detail = await runtime.detail("owner", task.id);
    expect(detail.task.result).toBeNull();
    expect(detail.steps).toEqual([]);
    expect(detail.modelRuns![0]).toMatchObject({ status: "unknown", inputTokens: null, outputTokens: null, resultCommitted: false });
  });

  it("blocks completion after grant revocation during verification while preserving known usage", async () => {
    const verified = deferred<void>();
    const resume = deferred<void>();
    const runtime = new Runtime(handle.db, { plan: async () => fixture });
    const boundary = runtime as unknown as { verify(raw: unknown, shadow: boolean, capabilityId?: string): Promise<Record<string, unknown> | null> };
    const original = boundary.verify.bind(runtime);
    boundary.verify = async (...args) => { const result = await original(...args); verified.resolve(); await resume.promise; return result; };
    const task = await runtime.createTask("owner", { ...input, autonomy: "assisted" }, randomUUID());
    await runtime.approve("owner", task.id);
    const tick = runtime.tick();
    await verified.promise;
    await handle.db.updateTable("approvals").set({ revoked_at: new Date() }).where("task_id", "=", task.id).execute();
    resume.resolve();
    expect((await tick)!.status).toBe("waiting_approval");
    const detail = await runtime.detail("owner", task.id);
    expect(detail.task.result).toBeNull();
    expect(detail.steps).toEqual([]);
    expect(detail.modelRuns![0]).toMatchObject({ status: "succeeded", inputTokens: 123, outputTokens: 87, resultCommitted: false });
    expect(detail.events.some((entry) => entry.type === "verification_passed")).toBe(false);
  });

  it("recovers an expired paid request without duplicate calls and fences a late response", async () => {
    const started = deferred<void>();
    const output = deferred<PlanningResult>();
    let firstCalls = 0;
    let replacementCalls = 0;
    const stale = new Runtime(handle.db, { plan: async () => { firstCalls += 1; started.resolve(); return output.promise; } });
    const replacement = new Runtime(handle.db, { plan: async () => { replacementCalls += 1; return fixture; } });
    const task = await stale.createTask("owner", input, randomUUID());
    const staleTick = stale.tick();
    await started.promise;
    await handle.db.updateTable("tasks").set({ lease_expires_at: sql`CURRENT_TIMESTAMP - interval '1 second'` }).where("id", "=", task.id).execute();
    await replacement.tick();
    expect(firstCalls).toBe(1);
    expect(replacementCalls).toBe(0);
    expect((await replacement.detail("owner", task.id)).task.status).toBe("waiting_approval");
    output.resolve(fixture);
    await staleTick;
    const recovered = await replacement.detail("owner", task.id);
    expect(recovered.task.status).toBe("waiting_approval");
    expect(recovered.task.result).toBeNull();
    expect(recovered.steps).toEqual([]);
    expect(recovered.modelRuns![0]).toMatchObject({ status: "succeeded", inputTokens: 123, outputTokens: 87, resultCommitted: false });
    await replacement.approve("owner", task.id);
    expect((await replacement.tick())!.status).toBe("completed");
    expect(replacementCalls).toBe(1);
    expect((await replacement.detail("owner", task.id)).modelRuns).toHaveLength(2);
  });
});
