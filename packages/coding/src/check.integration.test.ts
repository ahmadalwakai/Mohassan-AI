import { expect, it } from "vitest";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsAppContainerSandbox } from "@mohassan/sandbox";
import type { Project } from "@mohassan/contracts";
import { CodingEngine, createRepairDemoProject, generateDeterministicEdits } from "./index.ts";

it.skipIf(process.platform !== "win32")("checks a project once in the actual AppContainer and explains the failure, changing nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-coding-check-native-"));
  try {
    const sandbox = new WindowsAppContainerSandbox();
    expect((await sandbox.available()).available).toBe(true);
    const demo = await createRepairDemoProject(directory);
    const project: Project = { ...demo, id: randomUUID(), ownerId: "integration-owner", name: "Actual isolated repair demo", createdAt: new Date().toISOString() };
    const engine = new CodingEngine({ dataDir: join(directory, "data"), allowedRoots: [directory], sandbox, generateEdits: generateDeterministicEdits });
    const result = await engine.check({ ownerId: project.ownerId, project, signal: new AbortController().signal });
    expect(result.receipt).toMatchObject({ provider: "windows-appcontainer", isolationVerified: true, network: "denied", exitCode: 1, timedOut: false });
    expect(result.report.status).toBe("failed");
    expect(result.report.counts).toMatchObject({ tests: 2, pass: 0, fail: 2 });
    expect(result.report.failures.map((failure) => [failure.test, failure.location?.path, failure.location?.line, failure.error, failure.origin?.path, failure.origin?.line])).toEqual([
      ["adds positive values", "test/sum.test.mjs", 5, "ReferenceError: rightHandVaule is not defined", "src/sum.ts", 2],
      ["adds negative values", "test/sum.test.mjs", 6, "ReferenceError: rightHandVaule is not defined", "src/sum.ts", 2],
    ]);
    expect(result.diagnostics.map((diagnostic) => `${diagnostic.path}:${diagnostic.line} ${diagnostic.code}`)).toEqual(["src/sum.ts:2 TS2552"]);
    expect(JSON.stringify(result)).not.toContain("mohassan-sandbox-");
    await expect(lstat(join(directory, "data", "coding-worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(demo.path, "src", "sum.ts"), "utf8")).toContain("rightHandVaule");
  } finally {
    const target = resolve(directory); const base = resolve(tmpdir());
    if (!target.startsWith(base + sep) || !target.includes("mohassan-coding-check-native-")) throw new Error("Unsafe integration cleanup target");
    await rm(target, { recursive: true, force: true });
  }
}, 120_000);
