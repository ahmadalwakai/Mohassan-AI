import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { CodingEdits, Project, SandboxTestResult } from "@mohassan/contracts";
import { CodingEngine, createDemoProject, inspectProject, snapshotHash, type CodingContext, type SandboxRunner } from "./index.ts";
import { git } from "./git.ts";

// These test adapters never execute a project file. Actual OS-isolation proof
// belongs to the sandbox package and the separate AppContainer integration run.
function fakeSandbox(options: { failAlways?: boolean; forgedReceipt?: boolean } = {}): SandboxRunner {
  return {
    available: async () => ({ available: true, provider: "test-boundary-adapter", message: "Unit-test receipt adapter; no project code is executed." }),
    run: async ({ files }): Promise<SandboxTestResult> => ({
      exitCode: options.failAlways || files.find((file) => file.path === "src/sum.mjs")!.content.includes("a - b") ? 1 : 0,
      stdout: "Synthetic bounded test output", stderr: "", timedOut: false, durationMs: 1,
      provider: "test-boundary-adapter", network: "denied", isolation: "appcontainer", isolationVerified: true,
      snapshotHash: options.forgedReceipt ? "0".repeat(64) : snapshotHash(files),
    }),
  };
}

function fixedEdits(context: CodingContext): CodingEdits {
  return { summary: "تصحيح الجمع ضمن الملف المصرح دون تغيير الاختبارات.", model: "unit-test-model", usage: { inputTokens: 10, outputTokens: 20 },
    edits: [{ path: "src/sum.mjs", expectedHash: context.files.find((file) => file.path === "src/sum.mjs")!.hash, content: "export function sum(a, b) {\n  return a + b;\n}\n" }] };
}

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-coding-unit-")); directories.push(directory);
  const demo = await createDemoProject(directory);
  const project: Project = { ...demo, id: randomUUID(), ownerId: "owner", name: "Unit demo", createdAt: new Date().toISOString() };
  return { directory, project };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory); const base = resolve(tmpdir());
    if (!target.startsWith(base + sep) || !target.includes("mohassan-coding-unit-")) throw new Error("Unsafe test cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

describe("trusted Git worktrees and bounded edit security", () => {
  it("creates a deterministic, clean demo without executing its failing tests", async () => {
    const { directory, project } = await fixture();
    const repeated = await createDemoProject(directory);
    expect(repeated.baseCommit).toBe(project.baseCommit);
    const inspected = await inspectProject(project.path, [directory]);
    expect(inspected.files).toHaveLength(4);
    expect(inspected.testFiles).toEqual(["test/sum.test.mjs"]);
    expect(inspected.candidateEditablePaths).toEqual(["src/sum.mjs"]);
  });

  it("rejects projects outside their explicit local roots", async () => {
    const { directory, project } = await fixture();
    const other = join(directory, "allowed-other"); await mkdir(other);
    await expect(inspectProject(project.path, [other])).rejects.toMatchObject({ code: "PROJECT_OUTSIDE_ROOTS" });
  });

  it("rejects dirty files even if they have no staging entry", async () => {
    const { directory, project } = await fixture();
    await writeFile(join(project.path, "src", "sum.mjs"), "export const sum = () => 99;\n");
    await expect(inspectProject(project.path, [directory])).rejects.toMatchObject({ code: "DIRTY_PROJECT" });
  });

  it("rejects a sensitive path without reading or exposing its content", async () => {
    const { directory, project } = await fixture();
    const marker = "synthetic-private-value-for-test-only";
    await writeFile(join(project.path, ".env"), marker);
    const error = await inspectProject(project.path, [directory]).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "SENSITIVE_PROJECT_PATH" });
    expect(String(error)).not.toContain(marker);
  });

  it.each([
    "// postgresql://synthetic_user:synthetic-db-password-123@example.invalid/demo\n",
    "// npg_syntheticPassword123456\n",
    "const options = { password: 'synthetic-password-literal-123' };\n",
    "// mongodb+srv://synthetic_user:synthetic-db-password-123@example.invalid/demo\n",
  ])("rejects recognizable credentials in tracked source before sandbox or model access", async (prefix) => {
    const { directory, project } = await fixture();
    const content = prefix + await readFile(join(project.path, "src", "sum.mjs"), "utf8");
    await writeFile(join(project.path, "src", "sum.mjs"), content);
    const oid = (await git(project.path, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).stdout.trim();
    await git(project.path, ["update-index", "--add", "--cacheinfo", "100644", oid, "src/sum.mjs"]);
    const tree = (await git(project.path, ["write-tree"])).stdout.trim();
    const commit = (await git(project.path, ["commit-tree", tree, "-p", project.baseCommit, "-m", "Synthetic credential rejection fixture"])).stdout.trim();
    await git(project.path, ["update-ref", "refs/heads/main", commit, project.baseCommit]);
    let modelCalls = 0; let sandboxCalls = 0;
    const sandbox = fakeSandbox(); const originalRun = sandbox.run.bind(sandbox);
    sandbox.run = async (request) => { sandboxCalls += 1; return originalRun(request); };
    const engine = new CodingEngine({ dataDir: directory, sandbox, generateEdits: async (context) => { modelCalls += 1; return fixedEdits(context); } });
    const error = await engine.execute({ taskId: randomUUID(), ownerId: "owner", project: { ...project, baseCommit: commit }, goal: "صحح الجمع.", signal: new AbortController().signal }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "SENSITIVE_SOURCE_REJECTED" });
    expect(String(error)).not.toContain(prefix.trim());
    expect(modelCalls).toBe(0); expect(sandboxCalls).toBe(0);
  });

  it("rejects junctions and symbolic links in a source tree", async () => {
    const { directory, project } = await fixture();
    const outside = join(directory, "outside"); await mkdir(outside);
    await symlink(outside, join(project.path, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectProject(project.path, [directory])).rejects.toMatchObject({ code: "SYMLINK_REJECTED" });
  });

  it("rejects custom Git filters and private attributes before any checkout", async () => {
    const { directory, project } = await fixture();
    const config = join(project.path, ".git", "config");
    const initial = await readFile(config, "utf8");
    await writeFile(config, initial + "\n[filter \"unsafe\"]\n clean = never-run-this-command\n");
    await expect(inspectProject(project.path, [directory])).rejects.toMatchObject({ code: "UNSAFE_GIT_CONFIGURATION" });
    await writeFile(config, initial);
    await mkdir(join(project.path, ".git", "info"), { recursive: true });
    await writeFile(join(project.path, ".git", "info", "attributes"), "* filter=unsafe\n");
    await expect(inspectProject(project.path, [directory])).rejects.toMatchObject({ code: "UNSAFE_GIT_METADATA" });
  });

  it("rejects hard-linked Git metadata before reading configuration outside the repository", async () => {
    const { directory, project } = await fixture();
    const config = join(project.path, ".git", "config");
    const outside = join(directory, "outside-git-config");
    await rename(config, outside);
    await link(outside, config);
    await expect(inspectProject(project.path, [directory])).rejects.toMatchObject({ code: "UNSAFE_GIT_METADATA" });
  });

  it("keeps the source unchanged, commits only an isolated reviewed branch and independently verifies it", async () => {
    const { directory, project } = await fixture();
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async (context) => fixedEdits(context) });
    const taskId = randomUUID();
    const result = await engine.execute({ taskId, ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal });
    expect(result).toMatchObject({ outcome: "ready_for_review", sourceUnchanged: true, merged: false, worktreeRetained: true });
    expect(result.checkpoint).toMatch(/^[a-f0-9]{40,64}$/);
    expect(result.baselineTests!.exitCode).toBe(1);
    expect(result.tests.exitCode).toBe(0);
    expect(await readFile(join(project.path, "src", "sum.mjs"), "utf8")).toContain("a - b");
    expect((await git(project.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(project.baseCommit);
    expect(await engine.verify(result, { taskId, project })).toEqual(result);
    expect(await engine.verify({ ...result, diffHash: "0".repeat(64) }, { taskId, project })).toBeNull();
    await writeFile(join(directory, "coding-worktrees", taskId, "src", "sum.mjs"), "export const sum = () => 7;\n");
    expect(await engine.verify(result, { taskId, project })).toBeNull();
  });

  it("retains failed test changes for review without a success checkpoint", async () => {
    const { directory, project } = await fixture();
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox({ failAlways: true }), generateEdits: async (context) => fixedEdits(context) });
    const taskId = randomUUID();
    const result = await engine.execute({ taskId, ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal });
    expect(result).toMatchObject({ outcome: "tests_failed", checkpoint: null, worktreeRetained: true, sourceUnchanged: true });
    expect(result.review.passed).toBe(false);
    expect(await engine.verify(result, { taskId, project })).toEqual(result);
  });

  it("rejects a forged sandbox snapshot before asking for a paid edit", async () => {
    const { directory, project } = await fixture(); let calls = 0;
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox({ forgedReceipt: true }), generateEdits: async (context) => { calls += 1; return fixedEdits(context); } });
    await expect(engine.execute({ taskId: randomUUID(), ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal })).rejects.toMatchObject({ code: "UNVERIFIED_SANDBOX" });
    expect(calls).toBe(0);
  });

  it("rejects protected tests in the declared edit scope before generation", async () => {
    const { directory, project } = await fixture(); let calls = 0;
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async (context) => { calls += 1; return fixedEdits(context); } });
    await expect(engine.execute({ taskId: randomUUID(), ownerId: "owner", project: { ...project, allowedPaths: ["test/sum.test.mjs"] }, goal: "صحح الجمع.", signal: new AbortController().signal })).rejects.toMatchObject({ code: "UNSAFE_EDIT_SCOPE" });
    expect(calls).toBe(0);
  });

  it("rejects out-of-scope or stale model edits while preserving actual usage metadata", async () => {
    const { directory, project } = await fixture();
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async (context) => ({ ...fixedEdits(context), edits: [{ path: "test/sum.test.mjs", expectedHash: context.files.find((file) => file.path === "test/sum.test.mjs")!.hash, content: "// bypassed tests" }] }) });
    await expect(engine.execute({ taskId: randomUUID(), ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal })).rejects.toMatchObject({ code: "EDIT_SCOPE_OR_VERSION_MISMATCH", model: "unit-test-model", usage: { inputTokens: 10, outputTokens: 20 } });
    expect((await inspectProject(project.path, [directory])).baseCommit).toBe(project.baseCommit);
  });

  it("preserves a paid provider failure's usage even when its model metadata is unavailable", async () => {
    const { directory, project } = await fixture();
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async () => { throw Object.assign(new Error("private provider text"), { usage: { inputTokens: 12, outputTokens: 8 } }); } });
    const error = await engine.execute({ taskId: randomUUID(), ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "CODING_FAILED", usage: { inputTokens: 12, outputTokens: 8 } });
    expect(String(error)).not.toContain("private provider text");
  });

  it("serializes work on one repository with a process boundary lock", async () => {
    const { directory, project } = await fixture();
    let started!: () => void; const ready = new Promise<void>((resolveReady) => { started = resolveReady; });
    const abort = new AbortController();
    const first = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async () => { started(); return new Promise(() => {}); } });
    const firstTask = first.execute({ taskId: randomUUID(), ownerId: "owner", project, goal: "صحح الجمع.", signal: abort.signal });
    await ready;
    const second = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async (context) => fixedEdits(context) });
    await expect(second.execute({ taskId: randomUUID(), ownerId: "owner", project, goal: "صحح الجمع.", signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROJECT_BUSY" });
    abort.abort();
    await expect(firstTask).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("stops cancellation before creating a checkpoint and never merges into source", async () => {
    const { directory, project } = await fixture(); const abort = new AbortController();
    const engine = new CodingEngine({ dataDir: directory, sandbox: fakeSandbox(), generateEdits: async (context) => fixedEdits(context) });
    const taskId = randomUUID();
    await expect(engine.execute({ taskId, ownerId: "owner", project, goal: "صحح الجمع.", signal: abort.signal, onProgress: async (stage) => { if (stage === "review_finished") abort.abort(); } })).rejects.toMatchObject({ code: "ABORTED", usage: { inputTokens: 10, outputTokens: 20 } });
    expect((await git(join(directory, "coding-worktrees", taskId), ["rev-parse", "HEAD"])).stdout.trim()).toBe(project.baseCommit);
    expect((await git(project.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(project.baseCommit);
  });
});
