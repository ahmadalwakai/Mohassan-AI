import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@mohassan/contracts";
import { WindowsAppContainerSandbox } from "@mohassan/sandbox";
import { CodingEngine, generateDeterministicEdits, snapshotHash, type EditGenerator, type SandboxRunner } from "./index.ts";
import { git } from "./git.ts";
import { sha256, type SnapshotFile } from "./security.ts";
import { inspectTypeScript } from "./typescript-repair.ts";

const testPath = "test/answer.test.mjs";
const jsPath = "src/answer.mjs";
const tsPath = "src/answer.ts";
const configPath = "eslint.config.mjs";
const sourceTest = (path: string) => [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  `import { answer } from "../${path}";`,
  'test("returns the expected answer", () => assert.equal(answer(), 42));',
].join("\n") + "\n";
const base = { "package.json": '{"type":"module","scripts":{"test":"node --test test/answer.test.mjs"}}\n' };

const examples = [
  {
    name: "missing import", target: tsPath, before: "export const answer = () => answerValue;\n",
    after: 'import { answerValue } from "./values.mjs";\n\nexport const answer = () => answerValue;\n', files: { "src/values.mjs": "export const answerValue = 42;\n" },
  },
  {
    name: "single spelling correction", target: tsPath, before: "const expectedValue = 42;\nexport const answer = () => expcetedValue;\n",
    after: "const expectedValue = 42;\nexport const answer = () => expectedValue;\n", files: {
      "package.json": '{"type":"module","scripts":{"test":"node --test","typecheck":"tsc --noEmit -p config/typecheck.json"}}\n',
      "config/typecheck.json": '{"files":["../src/answer.ts"]}\n',
    },
  },
  {
    name: "ESLint rule", target: jsPath,
    before: "export function answer() {\n  if (!!true) return 42;\n}\n",
    after: "export function answer() {\n  if (true) return 42;\n}\n", files: { [configPath]: 'export default [{ rules: { "no-extra-boolean-cast": "error" } }];\n' },
  },
] as const;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(target: string, before: string, files: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-deterministic-"));
  roots.push(directory);
  const path = join(directory, "project");
  await mkdir(path);
  const contents = { ...base, [target]: before, [testPath]: sourceTest(target), ...files };
  await git(path, ["init", "--initial-branch=main", "--template=", "."]);
  for (const [relative, content] of Object.entries(contents)) {
    const absolute = join(path, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    const oid = (await git(path, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).stdout.trim();
    await git(path, ["update-index", "--add", "--cacheinfo", "100644", oid, relative]);
  }
  const tree = (await git(path, ["write-tree"])).stdout.trim();
  const baseCommit = (await git(path, ["commit-tree", tree, "-m", "Repair fixture baseline"])).stdout.trim();
  await git(path, ["update-ref", "refs/heads/main", baseCommit]);
  const project: Project = { id: randomUUID(), ownerId: "fixture-owner", name: "Repair fixture", path, baseCommit,
    allowedPaths: [target], testProfile: "node-test", createdAt: new Date().toISOString() };
  return { directory, project, contents };
}

function receipt(files: SnapshotFile[], exitCode: number) {
  return { exitCode, stdout: "", stderr: "", timedOut: false, durationMs: 1, provider: "receipt-fixture",
    network: "denied" as const, isolation: "appcontainer" as const, isolationVerified: true, snapshotHash: snapshotHash(files) };
}

// This adapter checks fingerprints and tool requests without executing repository code.
function boundaryAdapter(before: string, baselineExitCode = 1): SandboxRunner {
  return {
    available: async () => ({ available: true, provider: "receipt-fixture", message: "Synthetic receipt" }),
    run: async (request) => {
      expect(request.testFiles).toEqual([testPath]);
      if (request.files.some(({ path }) => path === "config/typecheck.json")) expect(request.typecheck).toEqual({ project: "config/typecheck.json" });
      return receipt(request.files, request.files.some(({ content }) => content === before) ? baselineExitCode : 0);
    },
    lintFix: async (request) => {
      expect(request.configPath).toBe(configPath);
      expect(request.fixFiles).toEqual([jsPath]);
      expect(request.formatting).toBe(false);
      expect(request.files.map(({ path }) => path)).toContain(testPath);
      return { ...receipt(request.files, 0), fixes: [{ path: jsPath, content: before.replace("!!true", "true") }] };
    },
  };
}

function execute(input: Awaited<ReturnType<typeof fixture>>, sandbox: SandboxRunner,
  generateEdits: EditGenerator = generateDeterministicEdits, goal = `Repair ${input.project.allowedPaths[0]}`) {
  const engine = new CodingEngine({ dataDir: input.directory, allowedRoots: [input.directory], sandbox, generateEdits });
  const request = { project: input.project, taskId: randomUUID(), ownerId: input.project.ownerId, goal, signal: new AbortController().signal };
  return { engine, request };
}

async function assertRepair(example: typeof examples[number], sandbox: SandboxRunner) {
  const input = await fixture(example.target, example.before, example.files);
  const { engine, request } = execute(input, sandbox);
  const result = await engine.execute(request);
  expect(result).toMatchObject({ outcome: "ready_for_review", sourceUnchanged: true, usage: { inputTokens: 0, outputTokens: 0 } });
  const original = Object.entries(input.contents).map(([path, content]) => ({ path, content }));
  const provider = (await sandbox.available()).provider;
  expect(result.baselineTests).toMatchObject({
    snapshotHash: snapshotHash(original), isolationVerified: true, network: "denied", provider,
    exitCode: example.target === tsPath ? 1 : 0,
  });
  const repaired = await readFile(join(input.directory, "coding-worktrees", request.taskId, example.target), "utf8");
  expect(repaired).toBe(example.after);
  expect(result.changes).toEqual([{ path: example.target, beforeHash: sha256(example.before), afterHash: sha256(repaired) }]);
  const updated = original.map((file) => file.path === example.target ? { ...file, content: repaired } : file);
  expect(result.tests).toMatchObject({ snapshotHash: snapshotHash(updated), isolationVerified: true, network: "denied", provider, exitCode: 0 });
  if (example.target === tsPath) {
    const project = Object.hasOwn(example.files, "config/typecheck.json") ? "config/typecheck.json" : undefined;
    const before = inspectTypeScript(original, request.signal, project).diagnosticPaths;
    const after = inspectTypeScript(updated, request.signal, project).diagnosticPaths;
    expect(before).toContain(example.target);
    expect(after).not.toContain(example.target);
    expect(after.length).toBeLessThan(before.length);
  }
  expect(await readFile(join(input.project.path, example.target), "utf8")).toBe(example.before);
  expect(await engine.verify(result, request)).toEqual(result);
}

async function assertLogicRefused(makeSandbox: (before: string) => SandboxRunner) {
  const before = "export const answer = () => 40 - 2;\n";
  const input = await fixture(jsPath, before);
  const sandbox = makeSandbox(before);
  const run = vi.spyOn(sandbox, "run");
  const { engine, request } = execute(input, sandbox);
  await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX", message: /لم تجد الأدوات إصلاحًا/ });
  expect(run).toHaveBeenCalledTimes(1);
  await expect(run.mock.results[0]?.value).resolves.toMatchObject({
    exitCode: 1, snapshotHash: snapshotHash(Object.entries(input.contents).map(([path, content]) => ({ path, content }))),
  });
  expect(await readFile(join(input.directory, "coding-worktrees", request.taskId, jsPath), "utf8")).toBe(before);
  expect(await readFile(join(input.project.path, jsPath), "utf8")).toBe(before);
}

describe("deterministic repair and engine fingerprints", () => {
  it.each(examples)("applies a proven $name fix to a separate Git worktree", async (example) => {
    await assertRepair(example, boundaryAdapter(example.before, example.target === tsPath ? 1 : 0));
  });

  it.each(examples)("rejects a stale expected hash for $name", async (example) => {
    const input = await fixture(example.target, example.before, example.files);
    const stale: EditGenerator = Object.assign(async (context: Parameters<EditGenerator>[0]) => {
      const result = await generateDeterministicEdits(context);
      if ("kind" in result) throw new Error("Expected a candidate from the repair tool.");
      return { ...result, edits: result.edits.map((edit) => ({ ...edit, expectedHash: "0".repeat(64) })) };
    }, { mode: "deterministic" as const });
    const { engine, request } = execute(input, boundaryAdapter(example.before), stale);
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "EDIT_SCOPE_OR_VERSION_MISMATCH" });
    expect(await readFile(join(input.directory, "coding-worktrees", request.taskId, example.target), "utf8")).toBe(example.before);
  });

  it("rejects a changed worktree file just before writing the proven fix", async () => {
    const example = examples[1];
    const input = await fixture(example.target, example.before);
    const { engine, request } = execute(input, boundaryAdapter(example.before));
    const file = join(input.directory, "coding-worktrees", request.taskId, example.target);
    await expect(engine.execute({ ...request, onProgress: async (stage) => {
      if (stage === "edits_validated") await writeFile(file, "// user change\n");
    } })).rejects.toMatchObject({ code: "CONCURRENT_EDIT" });
    expect(await readFile(file, "utf8")).toBe("// user change\n");
  });

  it("refuses a logic bug that tests expose but tools cannot repair", async () => {
    await assertLogicRefused(boundaryAdapter);
  });

  it("rejects a lint receipt for a different snapshot", async () => {
    const example = examples[2];
    const input = await fixture(example.target, example.before, example.files);
    const sandbox = boundaryAdapter(example.before);
    const lintFix = sandbox.lintFix!;
    sandbox.lintFix = async (request) => ({ ...await lintFix(request), snapshotHash: "0".repeat(64) });
    const { engine, request } = execute(input, sandbox);
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "UNVERIFIED_SANDBOX" });
  });

  it("refuses when the configured lint rules cannot be verified", async () => {
    const example = examples[2];
    const input = await fixture(example.target, example.before, example.files);
    const sandbox = boundaryAdapter(example.before);
    sandbox.lintFix = async () => { throw Object.assign(new Error("Unsupported lint configuration"), { code: "ESLINT_CONFIG_UNSUPPORTED" }); };
    const { engine, request } = execute(input, sandbox);
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX" });
  });

  it.each(["Fix answer without formatting src/data.json", "أصلح الملف دون تنسيق src/data.json"])("honors an explicit formatting exclusion in %s", async (goal) => {
    const input = await fixture("src/data.json", '{"value":42}\n', { [testPath]: 'import test from "node:test"; test("exists", () => {});\n' });
    const { engine, request } = execute(input, boundaryAdapter("unmatched"), generateDeterministicEdits, goal);
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX" });
  });

  it("does not treat a formatting-like file name as a formatting request", async () => {
    const path = "src/data.format.json";
    const input = await fixture(path, '{"value":42}\n', { [testPath]: 'import test from "node:test"; test("exists", () => {});\n' });
    const { engine, request } = execute(input, boundaryAdapter("unmatched"), generateDeterministicEdits, `Fix ${path}`);
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX" });
  });

  it("formats a named JSON file only on request and passes typecheck and JSON checks to the sandbox", async () => {
    const before = '{"value":42}\n';
    const input = await fixture("src/data.json", before, {
      "package.json": '{"scripts":{"test":"node --test","typecheck":"tsc --noEmit -p config/typecheck.json"}}\n',
      "config/typecheck.json": '{"files":["../src/entry.ts"]}\n',
      "src/entry.ts": "export const answer = 42;\n",
      [testPath]: 'import test from "node:test"; test("exists", () => {});\n',
    });
    const sandbox = boundaryAdapter("unmatched");
    const run = sandbox.run;
    sandbox.run = async (request) => {
      expect(request.jsonFiles).toEqual(["src/data.json"]);
      return run(request);
    };
    const { engine, request } = execute(input, sandbox, generateDeterministicEdits, "نسّق ./src/data.json.");
    const result = await engine.execute(request);
    expect(result).toMatchObject({ outcome: "ready_for_review", changes: [{ path: "src/data.json", beforeHash: sha256(before) }] });
    const repaired = await readFile(join(input.directory, "coding-worktrees", request.taskId, "src/data.json"), "utf8");
    expect(JSON.parse(repaired)).toEqual(JSON.parse(before));
    expect(repaired).not.toBe(before);
  });
});

describe.skipIf(process.platform !== "win32")("real deterministic repair in Windows AppContainer (Windows required)", () => {
  it.each(examples)("verifies a $name repair using the native boundary", async (example) => {
    await assertRepair(example, new WindowsAppContainerSandbox());
  }, 90_000);

  it("refuses a real failing logic test without guessing a change", async () => {
    await assertLogicRefused(() => new WindowsAppContainerSandbox());
  }, 90_000);
});
