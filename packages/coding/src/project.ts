import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git, inspectGitMetadata } from "./git.ts";
import { CodingError, assertNoLinks, boundedText, canonicalDirectory, editablePath, limits, safeRelative, sha256, snapshotHash, sourcePaths } from "./security.ts";

export interface ProjectFile { path: string; content: string; hash: string; mode: string }
export interface ProjectInspection {
  path: string;
  baseCommit: string;
  files: ProjectFile[];
  testFiles: string[];
  candidateEditablePaths: string[];
  snapshotHash: string;
  testProfile: "node-test";
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
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest) {
    let pkg: unknown;
    try { pkg = JSON.parse(manifest.content); } catch { throw new CodingError("INVALID_PACKAGE", "ملف package.json غير صالح."); }
    if (!pkg || typeof pkg !== "object") throw new CodingError("INVALID_PACKAGE", "ملف package.json غير صالح.");
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const value = (pkg as Record<string, unknown>)[key];
      if (value && typeof value === "object" && Object.keys(value).length) throw new CodingError("DEPENDENCIES_UNSUPPORTED", "هذه الشريحة تستخدم Node المدمج دون تثبيت حزم أو شبكة.");
    }
  }
  const testFiles = files.filter((file) => /\.(?:test|spec)\.(?:[cm]?js|ts)$/i.test(file.path)).map((file) => file.path);
  if (!testFiles.length) throw new CodingError("TESTS_REQUIRED", "يلزم اختبار Node مدمج محفوظ ضمن المشروع.");
  return { path, baseCommit, files, testFiles, candidateEditablePaths: files.filter((file) => editablePath(file.path)).map((file) => file.path), snapshotHash: snapshotHash(files), testProfile: "node-test" };
}

const demoFiles: Record<string, string> = {
  "package.json": JSON.stringify({ name: "mohassan-coding-demo", private: true, type: "module", version: "1.0.0" }, null, 2) + "\n",
  "src/sum.mjs": "export function sum(a, b) {\n  return a - b;\n}\n",
  "test/sum.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\n\ntest('adds positive values', () => assert.equal(sum(2, 3), 5));\ntest('adds negative values', () => assert.equal(sum(-3, 1), -2));\n",
  "README.md": "# Mohassan AI coding demo\n\nA deliberately failing, dependency-free Node.js project.\nThe requested repair is limited to src/sum.mjs; tests are immutable.\n",
};

export async function createDemoProject(rootDataDir: string): Promise<{ path: string; baseCommit: string; allowedPaths: string[]; testProfile: "node-test" }> {
  const dataDir = resolve(rootDataDir);
  await assertNoLinks(dataDir);
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "demo-project");
  let created = false;
  try { await mkdir(path); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created) {
    await mkdir(join(path, "src")); await mkdir(join(path, "test"));
    for (const [file, content] of Object.entries(demoFiles)) await writeFile(join(path, ...file.split("/")), content, { flag: "wx" });
    await git(path, ["init", "--initial-branch=main", "--template=", "."]);
    // Fixed, owned files only. No user root repository is ever staged here.
    for (const [file, content] of Object.entries(demoFiles)) {
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
  if (inspected.files.length !== Object.keys(demoFiles).length
    || inspected.files.some((file) => file.content !== demoFiles[file.path])) {
    throw new CodingError("DEMO_PATH_CONFLICT", "المجلد الموجود لا يطابق المشروع التجريبي؛ لم يُعدل محتواه.");
  }
  return { path: inspected.path, baseCommit: inspected.baseCommit, allowedPaths: ["src/sum.mjs"], testProfile: "node-test" };
}
