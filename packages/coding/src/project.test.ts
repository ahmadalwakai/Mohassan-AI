import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./git.ts";
import { createDemoProject, createRepairDemoProject, inspectProject } from "./project.ts";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "mohassan-coding-inspection-"));
  directories.push(directory);
  return directory;
}

async function fixture(files: Record<string, string>) {
  const directory = await temporaryDirectory();
  await git(directory, ["init", "--initial-branch=main", "--template=", "."]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    const oid = (await git(directory, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).stdout.trim();
    await git(directory, ["update-index", "--add", "--cacheinfo", "100644", oid, path]);
  }
  const tree = (await git(directory, ["write-tree"])).stdout.trim();
  const commit = (await git(directory, ["commit-tree", tree, "-m", "Project tool inspection fixture"])).stdout.trim();
  await git(directory, ["update-ref", "refs/heads/main", commit]);
  return inspectProject(directory, [directory]);
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("project tool detection", () => {
  it("recognizes bounded scripts and protects their inputs while widening editable source", async () => {
    const project = await fixture({
      "package.json": JSON.stringify({
        devDependencies: { eslint: "^9", typescript: "^5" },
        scripts: { test: 'node --test src/verify.mjs "tests/*.test.ts"', typecheck: "tsc --project checks/compiler.json --noEmit" },
      }),
      "eslint.config.mjs": "export default [];\n",
      "checks/compiler.json": '{ // Project settings\n "extends": "./settings.json", "references": [{ "path": "nested/custom.json" }] }\n',
      "checks/settings.json": '{ "extends": "./more-settings" }\n',
      "checks/more-settings.json": "{}\n",
      "checks/nested/custom.json": "{}\n",
      "tests/existing.test.ts": "export {};\n",
      "src/verify.mjs": "export {};\n",
      "src/app.ts": "export {};\n",
      "src/ui.tsx": "export {};\n",
      "src/data.json": "{}\n",
      "src/util.cjs": "module.exports = {};\n",
      "src/util.js": "export {};\n",
      "src/util.mjs": "export {};\n",
      "tsconfig.base.json": "{}\n",
      ".eslintrc.json": "{}\n",
    });
    expect(project.testFiles).toEqual(["src/verify.mjs", "tests/existing.test.ts"]);
    expect(project.typecheck).toEqual({ project: "checks/compiler.json" });
    expect(project.eslintConfig).toBe("eslint.config.mjs");
    expect(project.candidateEditablePaths).toEqual(["src/app.ts", "src/data.json", "src/ui.tsx", "src/util.cjs", "src/util.js", "src/util.mjs"]);
  });

  it("keeps naming-convention tests and detects legacy package ESLint settings", async () => {
    const project = await fixture({
      "package.json": JSON.stringify({ scripts: { "type-check": "tsc" }, eslintConfig: { rules: { semi: [2, "always"] } } }),
      "test/example.spec.cjs": "module.exports = {};\n",
    });
    expect(project.testFiles).toEqual(["test/example.spec.cjs"]);
    expect(project.typecheck).toEqual({});
    expect(project.eslintConfig).toBe("package.json");
  });

  it.each([
    [{ test: "node --test && arbitrary-command" }, "UNSUPPORTED_TEST_SCRIPT"],
    [{ test: "node --test ../external.test.mjs" }, "UNSUPPORTED_TEST_SCRIPT"],
    [{ test: "node --test --import src/hooks.mjs" }, "UNSUPPORTED_TEST_SCRIPT"],
    [{ typecheck: "tsc --build" }, "UNSUPPORTED_TYPECHECK_SCRIPT"],
    [{ typecheck: "tsc -p ../external.json" }, "UNSUPPORTED_TYPECHECK_SCRIPT"],
  ])("refuses unsupported explicit scripts %j", async (scripts, code) => {
    await expect(fixture({ "package.json": JSON.stringify({ scripts }), "test/example.test.mjs": "export {};\n" })).rejects.toMatchObject({ code });
  });

  it("keeps the repairable demo separate from the existing logic-bug demo", async () => {
    const directory = await temporaryDirectory();
    const [original, repairable] = await Promise.all([createDemoProject(directory), createRepairDemoProject(directory)]);
    expect(original.path).not.toBe(repairable.path);
    expect(original.allowedPaths).toEqual(["src/sum.mjs"]);
    expect(repairable.allowedPaths).toEqual(["src/sum.ts"]);
    expect((await createRepairDemoProject(directory)).baseCommit).toBe(repairable.baseCommit);
  });
});
