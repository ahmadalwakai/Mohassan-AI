import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CodingEditsSchema, CodingResultSchema, SandboxTestResultSchema, type CodingEdits, type CodingResult, type Project, type SandboxTestResult } from "@mohassan/contracts";
import { git } from "./git.ts";
import { inspectProject, type ProjectFile } from "./project.ts";
import { CodingError, assertNoLinks, boundedText, containsPath, credentialLike, editablePath, limits, safeRelative, sha256, snapshotHash, sourcePaths, type SnapshotFile } from "./security.ts";

export interface SandboxRunner {
  available(): Promise<{ available: boolean; provider: string | null; message: string }>;
  run(request: { files: SnapshotFile[]; testFiles: string[]; syntaxFiles?: string[]; signal?: AbortSignal; timeoutMs?: number }): Promise<SandboxTestResult>;
}
export interface CodingContext {
  taskId: string;
  goal: string;
  baseCommit: string;
  files: { path: string; content: string; hash: string; editable: boolean }[];
  signal: AbortSignal;
  onModelReceipt?: (receipt: { model: string; usage: { inputTokens: number; outputTokens: number } }) => Promise<void>;
}
export interface CodingEngineOptions {
  dataDir: string;
  allowedRoots?: readonly string[];
  sandbox: SandboxRunner;
  generateEdits(context: CodingContext): Promise<CodingEdits>;
}
export interface CodingRequest {
  taskId: string;
  ownerId: string;
  goal: string;
  project: Project;
  signal: AbortSignal;
  onProgress?: (stage: string, message: string) => Promise<void>;
  onModelReceipt?: (receipt: { model: string; usage: { inputTokens: number; outputTokens: number } }) => Promise<void>;
}

interface RunManifest {
  version: 1;
  taskId: string;
  ownerId: string;
  projectId: string;
  sourcePath: string;
  baseSnapshotHash: string;
  finalSnapshotHash: string;
  fileHashes: { path: string; hash: string }[];
  tree: string;
  result: CodingResult;
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolveValue, reject) => {
    const abort = () => reject(new CodingError("ABORTED", "أُلغيت مهمة البرمجة."));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then(resolveValue, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function projectLock(dataDir: string, repoPath: string, taskId: string): Promise<() => Promise<void>> {
  const directory = join(dataDir, "coding-locks");
  await assertNoLinks(directory); await mkdir(directory, { recursive: true });
  const key = sha256(process.platform === "win32" ? repoPath.toLowerCase() : repoPath);
  const path = join(directory, `${key}.json`);
  const token = randomUUID();
  let releaseBoundary: () => Promise<void>;
  if (process.platform === "win32") {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolveLock, reject) => {
        server.once("error", reject);
        server.listen(`\\\\.\\pipe\\mohassan-coding-${key}`, () => { server.removeListener("error", reject); resolveLock(); });
      });
    } catch { throw new CodingError("PROJECT_BUSY", "توجد مهمة برمجة أخرى تملك قفل المشروع."); }
    server.unref();
    releaseBoundary = () => new Promise<void>((resolveLock, reject) => server.close((error) => error ? reject(error) : resolveLock()));
  } else {
    try { const lock = await open(`${path}.lock`, "wx", 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, taskId, token })); await lock.close(); }
    catch { throw new CodingError("PROJECT_BUSY", "المشروع مقفل؛ راجع المحاولة السابقة قبل استعادة القفل."); }
    releaseBoundary = () => unlink(`${path}.lock`);
  }
  try {
    await assertNoLinks(path);
    await writeFile(path, JSON.stringify({ pid: process.pid, taskId, token }), { mode: 0o600 });
  } catch (error) { await releaseBoundary(); throw error; }
  return async () => {
    try {
      if (JSON.parse(await readFile(path, "utf8")).token === token) await unlink(path);
    } finally { await releaseBoundary(); }
  };
}

function retainUsage(error: CodingError, value: unknown): CodingError {
  const receipt = z.object({ model: z.string().min(1).max(100).optional(), usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }) }).safeParse(value);
  if (receipt.success) { if (receipt.data.model) error.model = receipt.data.model; error.usage = receipt.data.usage; }
  return error;
}

function validReceipt(raw: unknown, files: SnapshotFile[], provider: string | null): SandboxTestResult {
  const parsed = SandboxTestResultSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.isolationVerified || parsed.data.snapshotHash !== snapshotHash(files)
    || !provider || parsed.data.provider !== provider) throw new CodingError("UNVERIFIED_SANDBOX", "لم تقدم بيئة الاختبار دليل عزل مطابقًا للملفات المرسلة.");
  return parsed.data;
}

async function worktreeFiles(path: string): Promise<SnapshotFile[]> {
  const paths = await sourcePaths(path);
  let size = 0;
  const files: SnapshotFile[] = [];
  for (const file of paths) {
    const content = await boundedText(join(path, ...file.split("/")));
    size += Buffer.byteLength(content);
    if (size > limits.totalBytes) throw new CodingError("PROJECT_TOO_LARGE", "تجاوز محتوى بيئة العمل الحد المسموح.");
    files.push({ path: file, content });
  }
  return files;
}

async function stageEdits(path: string, files: ProjectFile[], edits: CodingEdits["edits"], signal: AbortSignal): Promise<string> {
  for (const edit of edits) {
    const file = files.find((item) => item.path === edit.path)!;
    const oid = (await git(path, ["hash-object", "-w", "--no-filters", "--stdin"], { signal, input: edit.content })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new CodingError("INVALID_GIT_OBJECT", "تعذر إنشاء كائن Git محدد.");
    await git(path, ["update-index", "--add", "--cacheinfo", file.mode, oid, edit.path], { signal });
  }
  return (await git(path, ["write-tree"], { signal })).stdout.trim();
}

async function treeDiff(path: string, baseCommit: string, tree: string, signal?: AbortSignal) {
  const diff = (await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", baseCommit, tree, "--"], { signal })).stdout;
  if (Buffer.byteLength(diff) > limits.diffBytes) throw new CodingError("DIFF_TOO_LARGE", "تجاوز فرق الكود حجم المراجعة المدعوم.");
  const paths = (await git(path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseCommit, tree, "--"], { signal })).stdout.split("\0").filter(Boolean).sort();
  const whitespace = await git(path, ["diff", "--check", "--no-ext-diff", "--no-textconv", baseCommit, tree, "--"], { signal, allowedExitCodes: [0, 2] });
  return { diff, paths, whitespacePassed: whitespace.exitCode === 0 };
}

export class CodingEngine {
  private readonly dataDir: string;
  constructor(private readonly options: CodingEngineOptions) { this.dataDir = resolve(options.dataDir); }

  private paths(taskId: string) {
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new CodingError("INVALID_TASK_ID", "معرف مهمة البرمجة غير صالح.");
    return { worktree: join(this.dataDir, "coding-worktrees", taskId), manifest: join(this.dataDir, "coding-runs", `${taskId}.json`) };
  }

  private async saveManifest(path: string, manifest: RunManifest): Promise<void> {
    await assertNoLinks(path); await mkdir(resolve(path, ".."), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }

  async execute(request: CodingRequest): Promise<CodingResult> {
    const { signal, project, taskId } = request;
    signal.throwIfAborted();
    if (project.ownerId !== request.ownerId || project.testProfile !== "node-test") throw new CodingError("PROJECT_FORBIDDEN", "المشروع أو ملف الاختبار خارج النطاق المصرح.");
    const paths = this.paths(taskId);
    const progress = async (stage: string, message: string) => { signal.throwIfAborted(); await request.onProgress?.(stage, message); signal.throwIfAborted(); };
    const sandbox = await this.options.sandbox.available();
    if (!sandbox.available) throw new CodingError("SANDBOX_UNAVAILABLE", "بيئة تنفيذ معزولة مثبتة غير متاحة؛ لم يُشغل كود المشروع على المضيف.");
    await assertNoLinks(this.dataDir); await mkdir(this.dataDir, { recursive: true });
    const roots = this.options.allowedRoots ?? [join(this.dataDir, "demo-project")];
    const initial = await inspectProject(project.path, roots);
    if (initial.baseCommit !== project.baseCommit) throw new CodingError("PROJECT_HEAD_CHANGED", "تغير HEAD منذ تسجيل المشروع؛ يلزم تحديث التسجيل قبل العمل.");
    const allowed = new Set(project.allowedPaths.map(safeRelative));
    if (!allowed.size || allowed.size > 5 || allowed.size !== project.allowedPaths.length
      || [...allowed].some((path) => !editablePath(path) || !initial.files.some((file) => file.path === path))) {
      throw new CodingError("UNSAFE_EDIT_SCOPE", "نطاق التعديل يجب أن يحدد ملفات تنفيذ موجودة؛ الاختبارات والإعدادات محمية.");
    }
    const release = await projectLock(this.dataDir, initial.path, taskId);
    let proposal: unknown;
    try {
      await progress("project_inspected", "فُحصت نقطة Git النظيفة ونطاق الملفات المسموح.");
      try { await lstat(paths.worktree); throw new CodingError("RUN_ALREADY_EXISTS", "بيئة هذه المحاولة محفوظة للمراجعة؛ أنشئ مهمة جديدة بدل الكتابة فوقها."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const baseline = validReceipt(await abortable(() => this.options.sandbox.run({ files: initial.files.map(({ path, content }) => ({ path, content })), testFiles: initial.testFiles, syntaxFiles: initial.files.filter((file) => /\.(?:[cm]?js|ts)$/i.test(file.path)).map((file) => file.path), signal, timeoutMs: 20_000 }), signal), initial.files, sandbox.provider);
      await progress("baseline_tested", "حُفظت نتيجة اختبارات الأساس داخل بيئة معزولة.");
      await assertNoLinks(paths.worktree); await mkdir(resolve(paths.worktree, ".."), { recursive: true });
      const branch = `mohassan/${taskId}`;
      await git(initial.path, ["worktree", "add", "--no-checkout", "-b", branch, "--", paths.worktree, initial.baseCommit], { signal });
      await git(paths.worktree, ["read-tree", initial.baseCommit], { signal });
      for (const file of initial.files) {
        const target = join(paths.worktree, ...file.path.split("/"));
        if (!containsPath(paths.worktree, target)) throw new CodingError("UNSAFE_PATH", "تجاوز مسار الملف حدود بيئة العمل.");
        await assertNoLinks(target); await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, file.content, { flag: "wx" });
      }
      await progress("worktree_created", "أُنشئت بيئة Git منفصلة من النسخة المحفوظة؛ ملفات المصدر لم تُعدل.");
      await progress("edits_requested", "يجري طلب تعديل نصي محدود؛ لا يملك النموذج حق تشغيل أوامر.");
      proposal = await abortable(() => this.options.generateEdits({ taskId, goal: request.goal, baseCommit: initial.baseCommit, signal, onModelReceipt: request.onModelReceipt,
        files: initial.files.map((file) => ({ path: file.path, content: file.content, hash: file.hash, editable: allowed.has(file.path) })) }), signal);
      const parsed = CodingEditsSchema.safeParse(proposal);
      if (!parsed.success) throw retainUsage(new CodingError("INVALID_EDITS", "رد التعديل لا يحقق العقد المحدود."), proposal);
      const edits = parsed.data;
      if (new Set(edits.edits.map((edit) => edit.path)).size !== edits.edits.length
        || credentialLike(edits.summary)
        || edits.edits.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.content), 0) > limits.editsBytes) throw new CodingError("INVALID_EDITS", "تكرر مسار تعديل أو تجاوز المحتوى حد المراجعة.");
      for (const edit of edits.edits) {
        safeRelative(edit.path);
        const before = initial.files.find((file) => file.path === edit.path);
        if (!allowed.has(edit.path) || !editablePath(edit.path) || !before || edit.expectedHash !== before.hash
          || credentialLike(edit.content) || edit.content.includes("\0") || sha256(edit.content) === before.hash) {
          throw new CodingError("EDIT_SCOPE_OR_VERSION_MISMATCH", "تعديل خارج النطاق أو الاختبارات أو نسخة الملف؛ لم يطبق المقترح.");
        }
        const current = await boundedText(join(paths.worktree, ...edit.path.split("/")));
        if (sha256(current) !== edit.expectedHash) throw new CodingError("CONCURRENT_EDIT", "تغير ملف بيئة العمل قبل التطبيق؛ توقف التنفيذ.");
      }
      await progress("edits_validated", "اجتاز المقترح فحص المسارات وبصمات الملفات وحماية الاختبارات.");
      for (const edit of edits.edits) {
        signal.throwIfAborted(); const target = join(paths.worktree, ...edit.path.split("/")); await assertNoLinks(target); await writeFile(target, edit.content);
      }
      const tree = await stageEdits(paths.worktree, initial.files, edits.edits, signal);
      await progress("edits_applied", "طُبقت التغييرات في بيئة العمل المنفصلة فقط.");
      const changedSnapshot = await worktreeFiles(paths.worktree);
      const expectedPaths = initial.files.map((file) => file.path).sort();
      if (JSON.stringify(changedSnapshot.map((file) => file.path).sort()) !== JSON.stringify(expectedPaths)) throw new CodingError("UNEXPECTED_FILES", "تغيرت مجموعة ملفات بيئة العمل دون تصريح.");
      await progress("tests_started", "بدأ فحص الصياغة والاختبارات المحمية داخل بيئة معزولة دون شبكة.");
      const tests = validReceipt(await abortable(() => this.options.sandbox.run({ files: changedSnapshot, testFiles: initial.testFiles, syntaxFiles: changedSnapshot.filter((file) => /\.(?:[cm]?js|ts)$/i.test(file.path)).map((file) => file.path), signal, timeoutMs: 20_000 }), signal), changedSnapshot, sandbox.provider);
      await progress("tests_finished", "وصلت نتيجة الاختبارات مع بصمة الملفات ودليل العزل.");
      const compared = await treeDiff(paths.worktree, initial.baseCommit, tree, signal);
      let sourceUnchanged = false;
      try { const after = await inspectProject(initial.path, roots); sourceUnchanged = after.baseCommit === initial.baseCommit && after.snapshotHash === initial.snapshotHash; } catch { /* A concurrent user edit invalidates delivery; it is never overwritten. */ }
      const afterSnapshot = await worktreeFiles(paths.worktree);
      const testsPassed = tests.exitCode === 0 && !tests.timedOut;
      const checks = [
        { id: "source_unchanged", passed: sourceUnchanged, message: "HEAD وملفات المشروع الأصلي يطابقان الأساس." },
        { id: "allowed_paths", passed: JSON.stringify(compared.paths) === JSON.stringify(edits.edits.map((edit) => edit.path).sort()), message: "فرق Git يقتصر على الملفات المصرح بها." },
        { id: "immutable_tests", passed: initial.testFiles.every((path) => sha256(afterSnapshot.find((file) => file.path === path)!.content) === initial.files.find((file) => file.path === path)!.hash), message: "ملفات الاختبار المحفوظة لم تتغير." },
        { id: "snapshot_unchanged", passed: snapshotHash(afterSnapshot) === tests.snapshotHash, message: "الملفات الحالية تطابق النسخة التي اختُبرت." },
        { id: "isolated_tests", passed: testsPassed && tests.isolationVerified && tests.network === "denied", message: "نجحت الاختبارات والصياغة داخل الحد المعزول دون شبكة." },
        { id: "diff_whitespace", passed: compared.whitespacePassed, message: "فرق Git يجتاز فحص أخطاء المسافات." },
      ];
      const reviewPassed = checks.every((check) => check.passed);
      await progress("review_finished", "اكتملت مراجعة مستقلة للنطاق والاختبارات وحالة المصدر.");
      let checkpoint: string | null = null;
      if (reviewPassed) {
        signal.throwIfAborted();
        checkpoint = (await git(paths.worktree, ["commit-tree", tree, "-p", initial.baseCommit, "-m", `Mohassan AI reviewed task ${taskId}`], { signal })).stdout.trim();
        await git(paths.worktree, ["update-ref", `refs/heads/${branch}`, checkpoint, initial.baseCommit], { signal });
        await progress("checkpoint_created", "حُفظت نقطة مراجعة في فرع مستقل؛ لا دمج أو رفع أو نشر.");
      }
      const result = CodingResultSchema.parse({
        kind: "coding", summary: edits.summary, projectId: project.id, baseCommit: initial.baseCommit, branch, checkpoint,
        worktreeRetained: true, diff: compared.diff, diffHash: sha256(compared.diff),
        changes: edits.edits.map((edit) => ({ path: edit.path, beforeHash: edit.expectedHash, afterHash: sha256(edit.content) })),
        baselineTests: baseline, tests, review: { passed: reviewPassed, checks },
        outcome: reviewPassed ? "ready_for_review" : testsPassed ? "review_failed" : "tests_failed",
        model: edits.model, usage: edits.usage, sourceUnchanged, merged: false, verifiedAt: new Date().toISOString(),
      });
      await this.saveManifest(paths.manifest, { version: 1, taskId, ownerId: request.ownerId, projectId: project.id, sourcePath: initial.path,
        baseSnapshotHash: initial.snapshotHash, finalSnapshotHash: snapshotHash(afterSnapshot), fileHashes: afterSnapshot.map((file) => ({ path: file.path, hash: sha256(file.content) })), tree, result });
      return result;
    } catch (error) {
      if (error instanceof CodingError) throw retainUsage(error, proposal ?? error);
      throw retainUsage(new CodingError(signal.aborted ? "ABORTED" : "CODING_FAILED", signal.aborted ? "أُلغيت مهمة البرمجة؛ لم يُدمج أي تعديل." : "تعذر إكمال مهمة البرمجة ضمن حدود الأمان؛ احتُفظ ببيئة المراجعة إن أُنشئت."), proposal ?? error);
    } finally { await release(); }
  }

  /** Re-reads disk and trusted sandbox receipts; model review flags cannot authorize success. */
  async verify(raw: unknown, context: { taskId: string; project: Project; signal?: AbortSignal }): Promise<CodingResult | null> {
    try {
      context.signal?.throwIfAborted();
      const parsed = CodingResultSchema.safeParse(raw); if (!parsed.success) return null;
      const result = parsed.data;
      const paths = this.paths(context.taskId);
      await assertNoLinks(paths.manifest); await assertNoLinks(paths.worktree);
      const manifest = JSON.parse(await boundedText(paths.manifest, 524_288)) as RunManifest;
      if (manifest.version !== 1 || manifest.taskId !== context.taskId || manifest.projectId !== context.project.id
        || manifest.ownerId !== context.project.ownerId || manifest.sourcePath !== context.project.path
        || JSON.stringify(manifest.result) !== JSON.stringify(result) || result.baseCommit !== context.project.baseCommit
        || result.branch !== `mohassan/${context.taskId}` || !result.worktreeRetained || result.merged) return null;
      const source = await inspectProject(context.project.path, this.options.allowedRoots ?? [join(this.dataDir, "demo-project")]);
      const sourceUnchanged = source.baseCommit === context.project.baseCommit && source.snapshotHash === manifest.baseSnapshotHash;
      const files = await worktreeFiles(paths.worktree);
      if (snapshotHash(files) !== manifest.finalSnapshotHash || snapshotHash(files) !== result.tests.snapshotHash) return null;
      if (JSON.stringify(files.map((file) => ({ path: file.path, hash: sha256(file.content) }))) !== JSON.stringify(manifest.fileHashes)) return null;
      if (!result.baselineTests || result.baselineTests.snapshotHash !== manifest.baseSnapshotHash || !result.baselineTests.isolationVerified) return null;
      if (!result.tests.isolationVerified || result.tests.network !== "denied") return null;
      const head = (await git(paths.worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { signal: context.signal })).stdout.trim();
      if ((await git(paths.worktree, ["symbolic-ref", "--short", "HEAD"], { signal: context.signal })).stdout.trim() !== result.branch) return null;
      const tree = (await git(paths.worktree, ["write-tree"], { signal: context.signal })).stdout.trim();
      if (tree !== manifest.tree || head !== (result.checkpoint ?? result.baseCommit)) return null;
      if (result.checkpoint && (await git(paths.worktree, ["rev-parse", `${result.checkpoint}^`], { signal: context.signal })).stdout.trim() !== result.baseCommit) return null;
      const compared = await treeDiff(paths.worktree, result.baseCommit, tree, context.signal);
      if (compared.diff !== result.diff || sha256(compared.diff) !== result.diffHash
        || JSON.stringify(compared.paths) !== JSON.stringify(result.changes.map((change) => change.path).sort())) return null;
      for (const change of result.changes) {
        if (!context.project.allowedPaths.includes(change.path) || !editablePath(change.path)
          || source.files.find((file) => file.path === change.path)?.hash !== change.beforeHash
          || sha256(files.find((file) => file.path === change.path)!.content) !== change.afterHash) return null;
      }
      if (sourceUnchanged !== result.sourceUnchanged) return null;
      const passed = sourceUnchanged && compared.whitespacePassed && result.tests.exitCode === 0 && !result.tests.timedOut
        && result.review.checks.every((check) => check.passed);
      if (passed !== result.review.passed || (result.outcome === "ready_for_review") !== passed || passed !== Boolean(result.checkpoint)) return null;
      return result;
    } catch { return null; }
  }
}
