import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "@mohassan/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDeterministicEdits } from "./deterministic.ts";
import type { CodingContextFile } from "./edit-generator.ts";
import { CodingEngine, type SandboxRunner } from "./engine.ts";
import { git } from "./git.ts";
import { sha256, snapshotHash, type SnapshotFile } from "./security.ts";
import { selectContextFiles } from "./selection.ts";
import { inspectTypeScript } from "./typescript-repair.ts";

const sumPath = "src/sum.ts";
const positivePath = "src/positive.ts";
const negativePath = "src/negative.ts";
const testPath = "test/sum.test.mjs";
const originalSum = "export function sum(a: number, b: number) { return a + b; }\n";
const useSum = 'import { sum } from "./sum.ts";\n';
const sources = {
  [sumPath]: originalSum,
  [positivePath]: `${useSum}export const addPositive = () => sum(2, 3);\n`,
  [negativePath]: `${useSum}export const addNegative = () => sum(-3, 1);\nexport const implementationName = () => sum.name;\n`,
};
const renamed = {
  [sumPath]: "export function add(a: number, b: number) { return a + b; }\n",
  [positivePath]: 'import { add } from "./sum.ts";\nexport const addPositive = () => add(2, 3);\n',
  [negativePath]: 'import { add } from "./sum.ts";\nexport const addNegative = () => add(-3, 1);\nexport const implementationName = () => add.name;\n',
};
const tests = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { addPositive } from "../src/positive.ts";',
  'import { addNegative, implementationName } from "../src/negative.ts";',
  'test("adds positive values", () => assert.equal(addPositive(), 5));',
  'test("adds negative values", () => assert.equal(addNegative(), -2));',
  "",
].join("\n");
const observesName = 'test("retains the implementation name", () => assert.equal(implementationName(), "sum"));\n';

// Stable excerpts recorded from Node 24 running these fixture tests on the original and renamed files.
const passing = "ℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\n";
const passingWithName = "ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\n";
const failingWithName = "ℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\n";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(extra: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mohassan-rename-fixture-")));
  roots.push(root);
  const path = join(root, "project");
  await mkdir(path);
  await git(path, ["init", "--initial-branch=main", "--template=", "."]);
  const contents = { "package.json": '{"type":"module","scripts":{"test":"node --test"}}\n', ...sources,
    [testPath]: tests, ...extra };
  for (const [name, content] of Object.entries(contents)) {
    const file = join(path, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    const blob = (await git(path, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).stdout.trim();
    await git(path, ["update-index", "--add", "--cacheinfo", "100644", blob, name]);
  }
  const tree = (await git(path, ["write-tree"])).stdout.trim();
  const baseCommit = (await git(path, ["commit-tree", tree, "-m", "Rename fixture baseline"])).stdout.trim();
  await git(path, ["update-ref", "refs/heads/main", baseCommit]);
  const project: Project = { id: randomUUID(), ownerId: "fixture-owner", name: "Rename fixture", path, baseCommit,
    allowedPaths: Object.keys(sources), testProfile: "node-test", createdAt: new Date().toISOString() };
  return { root, project, contents };
}

const provider = "recorded-output-fixture";
function receipt(files: SnapshotFile[], stdout: string, exitCode: number) {
  return { exitCode, stdout, stderr: "", timedOut: false, durationMs: 1, provider, network: "denied" as const,
    isolation: "appcontainer" as const, isolationVerified: true, snapshotHash: snapshotHash(files) };
}

function execute(input: Awaited<ReturnType<typeof fixture>>, goal: string, run: SandboxRunner["run"]) {
  const sandbox: SandboxRunner = { available: async () => ({ available: true, provider, message: "Recorded Node output" }), run };
  const engine = new CodingEngine({ dataDir: input.root, allowedRoots: [input.root], sandbox, generateEdits: generateDeterministicEdits });
  const request = { project: input.project, taskId: randomUUID(), ownerId: input.project.ownerId, goal, signal: new AbortController().signal };
  return { engine, request, worktree: join(input.root, "coding-worktrees", request.taskId) };
}

describe("rename through the coding engine", () => {
  it("prepares a review branch when the rename changes both callers and the protected checks pass", async () => {
    const input = await fixture();
    const run = vi.fn<SandboxRunner["run"]>().mockImplementation(async ({ files }) => receipt(files, passing, 0));
    const { engine, request, worktree } = execute(input, "غيّر اسم الدالة sum إلى add", run);
    const result = await engine.execute(request);

    expect(result).toMatchObject({ outcome: "ready_for_review", sourceUnchanged: true, merged: false,
      model: "deterministic-tools", usage: { inputTokens: 0, outputTokens: 0 }, review: { passed: true } });
    expect(result.checkpoint).toMatch(/^[a-f0-9]{40,64}$/);
    expect(result.changes.map(({ path }) => path).sort()).toEqual(Object.keys(sources).sort());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([{ testFiles }]) => testFiles)).toEqual([[testPath], [testPath]]);
    for (const [position, expected] of [input.contents, { ...input.contents, ...renamed }].entries()) {
      const sent = run.mock.calls[position]![0].files;
      expect(Object.fromEntries(sent.map(({ path, content }) => [path, content]))).toEqual(expected);
    }
    for (const path of [sumPath, positivePath, negativePath] as const) {
      expect(await readFile(join(worktree, path), "utf8")).toBe(renamed[path]);
      expect(await readFile(join(input.project.path, path), "utf8")).toBe(sources[path]);
    }
    expect(await engine.verify(result, request)).toEqual(result);
  });

  it("withholds a review checkpoint when an immutable test observes the function name", async () => {
    const input = await fixture({ [testPath]: tests + observesName });
    const run = vi.fn<SandboxRunner["run"]>()
      .mockImplementationOnce(async ({ files }) => receipt(files, passingWithName, 0))
      .mockImplementationOnce(async ({ files }) => receipt(files, failingWithName, 1));
    const { engine, request, worktree } = execute(input, "rename sum to add", run);
    const result = await engine.execute(request);

    expect(result).toMatchObject({ outcome: "tests_failed", checkpoint: null, sourceUnchanged: true, review: { passed: false } });
    expect(result.review.checks).toContainEqual(expect.objectContaining({ id: "isolated_tests", passed: false }));
    expect(run.mock.calls[1]![0].files).toContainEqual({ path: sumPath, content: renamed[sumPath] });
    expect(await readFile(join(worktree, testPath), "utf8")).toBe(tests + observesName);
    expect(await engine.verify(result, request)).toEqual(result);
  });

  it("refuses a reference in a tracked test outside the typecheck roots", async () => {
    const testContent = tests + 'import { sum } from "../src/sum.ts";\ntest("adds positive values directly", () => assert.equal(sum(2, 3), 5));\n';
    const input = await fixture({ [testPath]: testContent, "tsconfig.json": '{"compilerOptions":{"allowJs":false},"include":["src"]}\n' });
    const run = vi.fn<SandboxRunner["run"]>().mockImplementation(async ({ files }) => receipt(files, passingWithName, 0));
    const { engine, request, worktree } = execute(input, "أعد تسمية sum إلى add", run);

    await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX", message: /ملف محمي.*test\/sum\.test\.mjs/u });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readFile(join(worktree, sumPath), "utf8")).toBe(originalSum);
    expect(await readFile(join(worktree, testPath), "utf8")).toBe(testContent);
  });

  it("checks the complete snapshot when a reference falls outside the ranked context", async () => {
    const protectedPath = "outside/unregistered.ts";
    const distractors = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`src/filler${index}/sum.ts`, "export {};\n"]));
    const input = await fixture({ ...distractors, [sumPath]: originalSum.replace("export ", ""),
      [positivePath]: "export const addPositive = () => 2 + 3;\n", [negativePath]: "export const addNegative = () => -3 + 1;\nexport const implementationName = () => 'sum';\n",
      "tsconfig.json": '{"compilerOptions":{"moduleDetection":"legacy"}}\n',
      [protectedPath]: "sum(2, 3);\n" });
    const run = vi.fn<SandboxRunner["run"]>().mockImplementation(async ({ files }) => receipt(files, passing, 0));
    const { engine, request } = execute(input, "rename sum to add", run);
    const files = Object.entries(input.contents).map(([path, content]) => file(path, content, input.project.allowedPaths.includes(path)));
    const { diagnosticPaths, imports } = inspectTypeScript(files);
    const ranked = selectContextFiles(files, request.goal, diagnosticPaths, imports);
    expect(ranked.some(({ path }) => path === protectedPath)).toBe(false);

    await expect(engine.execute(request)).rejects.toMatchObject({ code: "NO_PROVEN_FIX", message: /ملف محمي.*outside\/unregistered\.ts/u });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

function file(path: string, content: string, editable = true): CodingContextFile {
  return { path, content, editable, hash: sha256(content) };
}

function propose(goal: string, files: CodingContextFile[], tools = { repairTypeScript: vi.fn(() => new Map<string, string>()) }) {
  return generateDeterministicEdits({ taskId: randomUUID(), goal, files, signal: new AbortController().signal,
    baseCommit: "a".repeat(40), tools });
}

describe("rename proposal proof", () => {
  it("changes identifiers without replacing comments and unrelated string literals", async () => {
    const before = `${originalSum}// sum is a label.\nexport const label = "sum";\n`;
    const source = file(sumPath, before);
    const repairTypeScript = vi.fn(() => new Map<string, string>());
    const proposal = await propose("أعد تسمية sum إلى add", [source], { repairTypeScript });

    expect(proposal).toMatchObject({ edits: [{ path: sumPath, expectedHash: source.hash,
      content: `${renamed[sumPath]}// sum is a label.\nexport const label = "sum";\n` }] });
    expect(repairTypeScript).not.toHaveBeenCalled();
  });

  it("renames an indexed property reference that TypeScript links to the declaration", async () => {
    const source = file(positivePath, 'interface Cart { amount: number }\nexport const read = (cart: Cart) => cart["amount"];\n');
    const proposal = await propose("rename amount to total", [source]);

    expect(proposal).toMatchObject({ edits: [{ path: positivePath, expectedHash: source.hash,
      content: 'interface Cart { total: number }\nexport const read = (cart: Cart) => cart["total"];\n' }] });
  });

  it("preserves a shorthand property key while renaming the local binding", async () => {
    const source = file(positivePath, "const amount = 42;\nexport const cart = { amount };\n");
    const proposal = await propose("rename amount to total", [source]);

    expect(proposal).toMatchObject({ edits: [{ path: positivePath, expectedHash: source.hash,
      content: "const total = 42;\nexport const cart = { amount: total };\n" }] });
  });

  it("preserves explicit export aliases when the new local name matches an unrelated export", async () => {
    const source = file(positivePath, "const amount = 42;\nconst limit = 45;\nexport { amount as value, limit as total };\n");
    const proposal = await propose("rename amount to total", [source]);

    expect(proposal).toMatchObject({ edits: [{ path: positivePath, expectedHash: source.hash,
      content: "const total = 42;\nconst limit = 45;\nexport { total as value, limit as total };\n" }] });
  });

  it.each([
    ["missing declaration", "rename missing to add", [file(sumPath, originalSum)], /لم أجد تصريحًا/u],
    ["multiple declarations", "rename sum to add", [file(sumPath, originalSum), file("src/more.ts", originalSum)], /أكثر من تصريح/u],
    ["overload declarations", "rename sum to add", [file(sumPath, `export function sum(a: number, b: number): number;\n${originalSum}`)], /أكثر من تصريح/u],
    ["invalid identifier", "rename sum to total-value", [file(sumPath, originalSum)], /ليس معرّف TypeScript صالحًا/u],
    ["reserved word", "rename sum to class", [file(sumPath, originalSum)], /ليس معرّف TypeScript صالحًا/u],
    ["declaration-scope collision", "rename sum to add", [file(sumPath, `${originalSum}export const add = 42;`)], /موجود بالفعل في النطاق/u],
    ["reference-scope collision", "rename sum to add", [file(sumPath, originalSum), file(positivePath,
      `${useSum}export function useSum() { const add = (a: number, b: number) => a - b; return sum(2, 3) + add(2, 3); }`)], /موجود بالفعل في النطاق/u],
    ["same-class member collision", "rename amount to total", [file(positivePath,
      'export class Cart { amount = 42; total = 5; }\nexport const read = () => new Cart().amount;\n')], /موجود بالفعل في النطاق/u],
    ["inherited static member collision", "rename amount to total", [file(positivePath,
      "class Base { static total() { return 1; } }\nexport class Derived extends Base { static amount() { return 2; } }\n")], /موجود بالفعل في النطاق/u],
    ["enum member collision", "rename amount to total", [file(positivePath,
      "export enum Values { amount = 1, total = 2 }\n")], /موجود بالفعل في النطاق/u],
    ["method collision in a derived class with no named references", "rename amount to total", [file(positivePath,
      "export class Base { amount() { return 1; } }\nexport class Derived extends Base { total() { return 2; } }\n")], /موجود بالفعل في النطاق/u],
    ["object property rename to __proto__", "rename amount to __proto__", [file(positivePath,
      "export const cart = { amount: 42 };\n")], /موجود بالفعل في النطاق/u],
    ["settings reference", "rename sum to add", [file(sumPath, originalSum), file("eslint.config.mjs",
      'import { sum } from "./src/sum.ts"; export default [{ settings: { result: sum(2, 3) } }];', false)], /ملف محمي.*eslint\.config\.mjs/u],
    ["unregistered source reference", "rename sum to add", [file(sumPath, originalSum), file(positivePath, sources[positivePath], false)], /ملف محمي.*src\/positive\.ts/u],
    ["new in-memory diagnostic", "rename _unused to unused", [file("tsconfig.json", '{"compilerOptions":{"noUnusedParameters":true}}', false),
      file(sumPath, "export function sum(_unused: number) { return 42; }")], /زادت تشخيصات TypeScript/u],
  ] as const)("refuses %s before running any other repair", async (_name, goal, files, reason) => {
    const repairTypeScript = vi.fn(() => new Map<string, string>());
    await expect(propose(goal, [...files], { repairTypeScript })).resolves.toMatchObject({ kind: "refused", code: "NO_PROVEN_FIX", reason });
    expect(repairTypeScript).not.toHaveBeenCalled();
  });
});
