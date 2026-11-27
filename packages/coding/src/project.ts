import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import ts from "typescript";
import { git, inspectGitMetadata } from "./git.ts";
import { PROJECT_INSTRUCTIONS_PATH, matchesProjectInstructions, parseProjectInstructions, type ProjectInstructions } from "./instructions.ts";
import { CodingError, assertNoLinks, boundedText, canonicalDirectory, editablePath, limits, safeRelative, sha256, snapshotHash, sourcePaths } from "./security.ts";

export interface ProjectFile { path: string; content: string; hash: string; mode: string }
export interface ProjectTypecheck { project?: string }
export interface ProjectInspection {
  path: string;
  baseCommit: string;
  files: ProjectFile[];
  testFiles: string[];
  candidateEditablePaths: string[];
  protectedPaths: string[];
  instructions?: ProjectInstructions;
  snapshotHash: string;
  testProfile: "node-test";
  typecheck?: ProjectTypecheck;
  eslintConfig?: string;
}

const runnableTestPath = /\.(?:[cm]?js|ts)$/i;
const conventionalTestPath = /\.(?:test|spec)\.(?:[cm]?js|ts)$/i;
const eslintConfigs = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scriptPath(argument: string, allowGlob = false): string {
  const path = argument.replace(/^(?:"([^"\s]+)"|'([^'\s]+)')$/, "$1$2").replace(/^\.\//, "");
  safeRelative(allowGlob ? path.replace(/[*?]/g, "x") : path);
  return path;
}

function detectTests(script: unknown, paths: string[]): string[] {
  const fallback = paths.filter((path) => conventionalTestPath.test(path));
  if (script === undefined) return fallback;
  const unsupported = () => new CodingError("UNSUPPORTED_TEST_SCRIPT", "سكربت test المدعوم هو node --test مع مسارات اختبارات محفوظة اختيارية، دون أوامر shell.");
  if (typeof script !== "string") throw unsupported();
  const [executable, flag, ...args] = script.trim().split(/\s+/);
  if (executable !== "node" || flag !== "--test") throw unsupported();
  if (!args.length) return fallback;
  const testFiles = new Set<string>();
  for (const argument of args) {
    let pattern: string;
    try { pattern = scriptPath(argument, true); } catch { throw unsupported(); }
    if (pattern.startsWith("-")) throw unsupported();
    const matches = paths.filter((path) => runnableTestPath.test(path) && (path === pattern || posix.matchesGlob(path, pattern)));
    if (matches.length === 0) throw unsupported();
    for (const path of matches) testFiles.add(path);
  }
  return [...testFiles].sort();
}

function detectTypecheck(script: unknown, paths: string[]): ProjectTypecheck | undefined {
  if (script === undefined) return undefined;
  const unsupported = () => new CodingError("UNSUPPORTED_TYPECHECK_SCRIPT", "سكربت typecheck المدعوم هو tsc مع --noEmit ومسار إعدادات JSON محفوظ اختياري، دون أوامر shell.");
  if (typeof script !== "string") throw unsupported();
  const [executable, ...args] = script.trim().split(/\s+/);
  if (executable !== "tsc") throw unsupported();
  if (args[0] === "--noEmit") args.shift();
  else if (args.at(-1) === "--noEmit") args.pop();
  if (!args.length) return {};
  if (args.length !== 2 || !["-p", "--project"].includes(args[0]!)) throw unsupported();
  let project: string;
  try { project = scriptPath(args[1]!); } catch { throw unsupported(); }
  if (project.startsWith("-") || !/\.json$/i.test(project) || !paths.includes(project)) throw unsupported();
  return { project };
}

function detectProjectTools(files: ProjectFile[], paths: string[]) {
  const manifest = files.find((file) => file.path === "package.json");
  let pkg: Record<string, unknown> | undefined;
  if (manifest) {
    try { pkg = record(JSON.parse(manifest.content)); } catch { /* Report invalid package.json below. */ }
    if (!pkg) throw new CodingError("INVALID_PACKAGE", "ملف package.json غير صالح.");
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const names = Object.keys(record(pkg[key]) ?? {});
      if (names.some((name) => !["eslint", "typescript"].includes(name))) {
        throw new CodingError("DEPENDENCIES_UNSUPPORTED", "تدعم بيئة العزل أدوات Node وTypeScript وESLint المثبتة مع المحرك دون تثبيت تبعيات المشروع أو استخدام الشبكة.");
      }
    }
  }
  const scripts = record(pkg?.scripts);
  const typecheck = detectTypecheck(scripts && (Object.hasOwn(scripts, "typecheck") ? scripts.typecheck : scripts["type-check"]), paths);
  const eslintConfig = eslintConfigs.find((name) => paths.includes(name)) ?? (record(pkg?.eslintConfig) ? "package.json" : undefined);
  return { testFiles: detectTests(scripts?.test, paths), typecheck, eslintConfig };
}

function typeConfigPaths(files: ProjectFile[], project: string | undefined): Set<string> {
  const paths = new Set(files.map(({ path }) => path).filter((path) => /(?:^|\/)[tj]sconfig(?:\.[^/]+)?\.json$/i.test(path)));
  if (project) paths.add(project);
  const snapshot = new Map(files.map(({ path, content }) => [path, content]));
  const windowsPaths = new Map(files.map(({ path }) => [path.toLowerCase(), path]));
  for (const path of paths) {
    const config = record(ts.parseConfigFileTextToJson(path, snapshot.get(path)!).config);
    const base = config?.extends;
    const parents = (Array.isArray(base) ? base : [base]).filter((value) => typeof value === "string" && value.startsWith("."));
    const references = Array.isArray(config?.references) ? config.references.map((item: unknown) => record(item)?.path) : [];
    for (const dependency of [...parents, ...references]) {
      if (typeof dependency !== "string" || /^[\\/]|^[a-z]:/i.test(dependency)) continue;
      const resolved = posix.join(posix.dirname(path), dependency.replace(/\\/g, "/"));
      for (const target of [resolved, `${resolved}.json`, `${resolved}/tsconfig.json`]) {
        const candidate = windowsPaths.get(target.toLowerCase());
        if (candidate && /\.json$/i.test(candidate)) paths.add(candidate);
      }
    }
  }
  return paths;
}

export async function inspectProject(repoPath: string, allowedRoots: readonly string[]): Promise<ProjectInspection> {
  const path = await canonicalDirectory(repoPath, allowedRoots);
  await inspectGitMetadata(path);
  const baseCommit = (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new CodingError("INVALID_GIT_HEAD", "المشروع لا يملك HEAD صالحًا.");
  if ((await git(path, ["rev-parse", "--is-bare-repository"])).stdout.trim() !== "false") throw new CodingError("BARE_REPOSITORY_REJECTED", "المستودعات bare غير مدعومة.");
  const top = (await git(path, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (resolve(top).toLowerCase() !== resolve(path).toLowerCase()) throw new CodingError("PROJECT_ROOT_REQUIRED", "يلزم جذر المستودع نفسه.");
  const entries = (await git(path, ["ls-tree", "-r", "-z", "--full-tree", baseCommit])).stdout.split("\0").filter(Boolean);
  if (!entries.length || entries.length > limits.files) throw new CodingError("PROJECT_TOO_LARGE", "يلزم مشروع صغير بملفات نصية ضمن حدود الشريحة.");
  const tracked = entries.map((entry) => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1]!)) throw new CodingError("SPECIAL_GIT_ENTRY_REJECTED", "الروابط الرمزية وsubmodules غير مدعومة.");
    const file = safeRelative(match[4]!);
    if (file.split("/").some((part) => [".gitattributes", ".gitmodules", ".lfsconfig"].includes(part.toLowerCase()))) {
      throw new CodingError("UNSAFE_ATTRIBUTES", "ملفات attributes وsubmodules وGit LFS غير مدعومة.");
    }
    return { path: file, mode: match[1]! };
  });
  const paths = await sourcePaths(path);
  if (JSON.stringify(paths) !== JSON.stringify(tracked.map((file) => file.path).sort())) {
    throw new CodingError("DIRTY_PROJECT", "المشروع يملك ملفات غير محفوظة أو غير متتبعة؛ احفظ نقطة Git نظيفة أولًا.");
  }
  if ((await git(path, ["diff", "--cached", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", baseCommit, "--"])).stdout.trim()) {
    throw new CodingError("DIRTY_PROJECT", "المشروع يحتوي تغييرات staged غير محفوظة.");
  }
  const files: ProjectFile[] = [];
  let size = 0;
  for (const trackedFile of tracked) {
    // Never run checkout/status/add on source: all comparisons use raw blobs,
    // avoiding user-defined clean/smudge filters and skip-worktree assumptions.
    const content = await boundedText(join(path, ...trackedFile.path.split("/")));
    const committed = (await git(path, ["cat-file", "blob", `${baseCommit}:${trackedFile.path}`])).stdout;
    if (sha256(content) !== sha256(committed)) throw new CodingError("DIRTY_PROJECT", "ملفات المشروع تختلف عن HEAD؛ التغييرات غير المحفوظة لا تدخل المهمة.");
    size += Buffer.byteLength(content);
    if (size > limits.totalBytes) throw new CodingError("PROJECT_TOO_LARGE", "تجاوزت ملفات المشروع حد المحتوى المدعوم.");
    files.push({ ...trackedFile, content, hash: sha256(content) });
  }
  const { testFiles, typecheck, eslintConfig } = detectProjectTools(files, paths);
  if (!testFiles.length) throw new CodingError("TESTS_REQUIRED", "يلزم اختبار Node مدمج محفوظ ضمن المشروع.");
  const instructionsFile = files.find((file) => file.path === PROJECT_INSTRUCTIONS_PATH);
  const instructions = instructionsFile && parseProjectInstructions(instructionsFile.content);
  const protectedPaths = new Set([...testFiles, ...typeConfigPaths(files, typecheck?.project)]);
  if (eslintConfig) protectedPaths.add(eslintConfig);
  if (instructions) {
    protectedPaths.add(PROJECT_INSTRUCTIONS_PATH);
    for (const file of paths) if (matchesProjectInstructions(file, instructions)) protectedPaths.add(file);
  }
  const candidateEditablePaths = paths.filter((file) => editablePath(file) && !protectedPaths.has(file));
  return { path, baseCommit, files, testFiles, candidateEditablePaths, protectedPaths: [...protectedPaths].sort(), instructions,
    snapshotHash: snapshotHash(files), testProfile: "node-test", typecheck, eslintConfig };
}

const demoFiles: Record<string, string> = {
  "package.json": JSON.stringify({ name: "mohassan-coding-demo", private: true, type: "module", version: "1.0.0" }, null, 2) + "\n",
  "src/sum.mjs": "export function sum(a, b) {\n  return a - b;\n}\n",
  "test/sum.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\n\ntest('adds positive values', () => assert.equal(sum(2, 3), 5));\ntest('adds negative values', () => assert.equal(sum(-3, 1), -2));\n",
  "README.md": "# Mohassan AI coding demo\n\nA deliberately failing, dependency-free Node.js project.\nThe requested repair is limited to src/sum.mjs; tests are immutable.\n",
};

const repairDemoFiles: Record<string, string> = {
  "package.json": demoFiles["package.json"]!,
  "src/sum.ts": "export function sum(leftHandValue: number, rightHandValue: number) {\n  return leftHandValue + rightHandVaule;\n}\n",
  "test/sum.test.mjs": demoFiles["test/sum.test.mjs"]!.replace("../src/sum.mjs", "../src/sum.ts"),
  "README.md": "# Mohassan AI coding repair demo\n\nA deliberately misspelled identifier in src/sum.ts has one TypeScript code fix. The Node.js tests are immutable.\n",
};

interface BuiltInProject { path: string; baseCommit: string; allowedPaths: string[]; testProfile: "node-test" }

export function createDemoProject(rootDataDir: string): Promise<BuiltInProject> {
  return createBuiltInProject(rootDataDir, "demo-project", demoFiles);
}

export function createRepairDemoProject(rootDataDir: string): Promise<BuiltInProject> {
  return createBuiltInProject(rootDataDir, "repair-demo-project", repairDemoFiles);
}

async function createBuiltInProject(rootDataDir: string, directory: string, files: Record<string, string>): Promise<BuiltInProject> {
  const dataDir = resolve(rootDataDir);
  await assertNoLinks(dataDir);
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, directory);
  let created = false;
  try { await mkdir(path); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created) {
    await mkdir(join(path, "src")); await mkdir(join(path, "test"));
    for (const [file, content] of Object.entries(files)) await writeFile(join(path, ...file.split("/")), content, { flag: "wx" });
    await git(path, ["init", "--initial-branch=main", "--template=", "."]);
    // Fixed, owned files only. No user root repository is ever staged here.
    for (const [file, content] of Object.entries(files)) {
      const oid = (await git(path, ["hash-object", "-w", "--no-filters", "--stdin"], { input: content })).stdout.trim();
      await git(path, ["update-index", "--add", "--cacheinfo", "100644", oid, file]);
    }
    const tree = (await git(path, ["write-tree"])).stdout.trim();
    const commit = (await git(path, ["commit-tree", tree, "-m", "Mohassan AI: immutable demo baseline"], { deterministicDate: true })).stdout.trim();
    await git(path, ["update-ref", "refs/heads/main", commit]);
  }
  await assertNoLinks(path);
  if (!(await lstat(path)).isDirectory()) throw new CodingError("DEMO_PATH_CONFLICT", "مسار المشروع التجريبي ليس مجلدًا.");
  const inspected = await inspectProject(path, [dataDir]);
  if (inspected.files.length !== Object.keys(files).length
    || inspected.files.some((file) => file.content !== files[file.path])) {
    throw new CodingError("DEMO_PATH_CONFLICT", "المجلد الموجود لا يطابق المشروع التجريبي؛ لم يُعدل محتواه.");
  }
  return { path: inspected.path, baseCommit: inspected.baseCommit, allowedPaths: inspected.candidateEditablePaths, testProfile: "node-test" };
}
