import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsAppContainerSandbox } from "@mohassan/sandbox";
import type { Project } from "@mohassan/contracts";
import { CodingEngine, createDemoProject } from "./index.ts";

it.skipIf(process.platform !== "win32")("verifies the complete worktree flow using actual AppContainer tests, never host project execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-coding-native-"));
  try {
    const sandbox = new WindowsAppContainerSandbox();
    expect((await sandbox.available()).available).toBe(true);
    const demo = await createDemoProject(directory);
    const project: Project = { ...demo, id: randomUUID(), ownerId: "integration-owner", name: "Actual isolated demo", createdAt: new Date().toISOString() };
    const engine = new CodingEngine({ dataDir: directory, sandbox, generateEdits: async (context) => ({
      summary: "تصحيح الجمع في نسخة منفصلة؛ النموذج محاكاة والاختبارات داخل AppContainer فعلية.",
      model: "integration-fixture", usage: { inputTokens: 0, outputTokens: 0 },
      edits: [{ path: "src/sum.mjs", expectedHash: context.files.find((file) => file.path === "src/sum.mjs")!.hash, content: "export function sum(a, b) {\n  return a + b;\n}\n" }],
    }) });
    const taskId = randomUUID();
    const result = await engine.execute({ taskId, ownerId: project.ownerId, goal: "صحح الجمع دون تعديل الاختبارات.", project, signal: new AbortController().signal });
    expect(result.outcome).toBe("ready_for_review");
    expect(result.baselineTests).toMatchObject({ exitCode: 1, isolationVerified: true, provider: "windows-appcontainer", network: "denied" });
    expect(result.tests).toMatchObject({ exitCode: 0, isolationVerified: true, provider: "windows-appcontainer", network: "denied" });
    expect(result.tests.stdout).toContain("adds positive values");
    expect(result.sourceUnchanged).toBe(true);
    expect(result.merged).toBe(false);
    expect(await readFile(join(project.path, "src", "sum.mjs"), "utf8")).toContain("a - b");
    expect(await engine.verify(result, { taskId, project })).toEqual(result);
  } finally {
    const target = resolve(directory); const base = resolve(tmpdir());
    if (!target.startsWith(base + sep) || !target.includes("mohassan-coding-native-")) throw new Error("Unsafe integration cleanup target");
    await rm(target, { recursive: true, force: true });
  }
}, 90_000);
