import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CodingError, assertNoLinks } from "./security.ts";

let executablePromise: Promise<string> | undefined;
async function gitExecutable(): Promise<string> {
  executablePromise ??= (async () => {
    const candidates = process.platform === "win32"
      ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe"), join(process.env.LOCALAPPDATA ?? "C:\\Users\\Administrator\\AppData\\Local", "Programs", "Git", "cmd", "git.exe")]
      : ["/usr/bin/git", "/usr/local/bin/git"];
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); await assertNoLinks(candidate); return candidate; } catch { /* Try the next trusted installation path. */ }
    }
    throw new CodingError("GIT_UNAVAILABLE", "لم يُعثر على تثبيت Git موثوق بمسار مطلق.");
  })();
  return executablePromise;
}

async function safeConfig(): Promise<{ config: string; hooks: string }> {
  const directory = resolve(tmpdir(), "mohassan-trusted-git");
  await assertNoLinks(directory);
  await mkdir(directory, { recursive: true });
  const config = join(directory, "empty-config");
  const hooks = join(directory, "empty-hooks");
  await assertNoLinks(config);
  await assertNoLinks(hooks);
  await mkdir(hooks, { recursive: true });
  if ((await readdir(hooks)).length) throw new CodingError("UNSAFE_GIT_CONFIGURATION", "مجلد تعطيل Git hooks ليس فارغًا.");
  await writeFile(config, "", { mode: 0o600 });
  return { config, hooks };
}

export interface GitResult { stdout: string; stderr: string; exitCode: number }
export interface GitBytesResult { stdout: Uint8Array; stderr: string; exitCode: number }
export interface GitInvocation { args: string[]; env: NodeJS.ProcessEnv }
export interface GitInvocationOptions {
  executable: string; config: string; hooks: string; deterministicDate?: boolean;
  /** Extra `-c key=value` pairs, appended after the fixed ones. `git()` never sets them. */
  extraConfig?: readonly string[];
}
const DEFAULT_TIMEOUT_MS = 20_000, MAX_TIMEOUT_MS = 60_000, TEXT_LIMIT = 1_048_576, STDERR_LIMIT = 65_536, BYTES_LIMIT = 16 * 1_048_576;

/** Pure: the argument list and environment of one bounded Git call. The fixed options come first, so a later `-c` can only add to them. */
export function buildInvocation(command: readonly string[], options: GitInvocationOptions): GitInvocation {
  const { executable, config, hooks } = options;
  const args = ["--no-pager", "-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
    "-c", `core.attributesFile=${config}`, "-c", "diff.external=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "core.autocrlf=false",
    "-c", "user.name=Mohassan AI", "-c", "user.email=local-demo@mohassan.invalid",
    ...(options.extraConfig ?? []).flatMap((pair) => ["-c", pair]), ...command];
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(executable), SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config, GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    ...(options.deterministicDate ? { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } : {}),
  };
  return { args, env };
}

interface SpawnOptions {
  signal?: AbortSignal; input?: string; allowedExitCodes?: readonly number[];
  /** Capped at 60 s. `git()` keeps its fixed 20 s. */
  timeoutMs?: number;
  /** `bytes` collects raw chunks up to `maxBytes`: chunk-by-chunk string decoding would corrupt multi-byte UTF-8 (Arabic) split across chunks. */
  output?: "text" | "bytes"; maxBytes?: number;
}
function spawnBounded(executable: string, cwd: string, invocation: GitInvocation, options: SpawnOptions): Promise<GitResult | GitBytesResult> {
  const bytes = options.output === "bytes";
  const maxBytes = bytes ? Math.min(options.maxBytes ?? TEXT_LIMIT, BYTES_LIMIT) : TEXT_LIMIT;
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return new Promise<GitResult | GitBytesResult>((resolveResult, reject) => {
    const child = spawn(executable, invocation.args, { cwd, env: invocation.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let overflow = false; let tooLarge = false; let collected = 0; const chunks: Buffer[] = [];
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes) { collected += chunk.byteLength; if (collected > maxBytes) { tooLarge = true; child.kill(); return; } chunks.push(chunk); return; }
      stdout += chunk.toString("utf8"); if (Buffer.byteLength(stdout) > TEXT_LIMIT) { overflow = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (Buffer.byteLength(stderr) > STDERR_LIMIT) { overflow = true; child.kill(); } });
    child.once("error", () => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); reject(new CodingError("GIT_FAILED", "تعذر تشغيل عملية Git المحدودة.")); });
    child.once("close", (code) => {
      clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) { reject(new CodingError("ABORTED", "أُلغيت مهمة البرمجة.")); return; }
      if (tooLarge) { reject(new CodingError("GIT_OUTPUT_OVERFLOW", "تجاوز ناتج Git الحد المسموح لهذه القراءة.")); return; }
      if (overflow || code === null || !(options.allowedExitCodes ?? [0]).includes(code)) {
        reject(new CodingError("GIT_FAILED", "رفض Git عملية محدودة أو تجاوزت وقتها؛ حُجبت تفاصيل الإعداد الخاصة.")); return;
      }
      if (bytes) { const joined = Buffer.concat(chunks); resolveResult({ stdout: new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength), stderr, exitCode: code }); return; }
      resolveResult({ stdout, stderr, exitCode: code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

export async function git(cwd: string, command: string[], options: { signal?: AbortSignal; input?: string; allowedExitCodes?: number[]; deterministicDate?: boolean } = {}): Promise<GitResult> {
  options.signal?.throwIfAborted();
  const executable = await gitExecutable();
  const { config, hooks } = await safeConfig();
  const invocation = buildInvocation(command, { executable, config, hooks, deterministicDate: options.deterministicDate });
  return spawnBounded(executable, cwd, invocation, { signal: options.signal, input: options.input, allowedExitCodes: options.allowedExitCodes, output: "text" }) as Promise<GitResult>;
}

export interface BoundedGitOptions extends SpawnOptions { extraConfig?: readonly string[] }
/** Package-internal runner for callers that validate every argument first (see git-remote.ts). The fixed invocation is the same as `git()`. */
export function boundedGit(cwd: string, command: readonly string[], options: BoundedGitOptions & { output: "bytes"; maxBytes: number }): Promise<GitBytesResult>;
export function boundedGit(cwd: string, command: readonly string[], options?: BoundedGitOptions & { output?: "text" }): Promise<GitResult>;
export async function boundedGit(cwd: string, command: readonly string[], options: BoundedGitOptions = {}): Promise<GitResult | GitBytesResult> {
  options.signal?.throwIfAborted();
  const executable = await gitExecutable();
  const { config, hooks } = await safeConfig();
  return spawnBounded(executable, cwd, buildInvocation(command, { executable, config, hooks, extraConfig: options.extraConfig }), options);
}

/** Reject local execution directives and metadata that redirects reads outside the repository. */
export async function inspectGitMetadata(repo: string): Promise<void> {
  const directory = join(repo, ".git");
  await assertNoLinks(directory);
  if (!(await lstat(directory)).isDirectory()) throw new CodingError("STANDALONE_REPOSITORY_REQUIRED", "يلزم مستودع محلي مستقل؛ لا نقبل gitdir خارجيًا أو worktree كمصدر.");
  let entries = 0;
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new CodingError("UNSAFE_GIT_METADATA", "تحتوي بيانات Git رابطًا أو ملفًا غير مدعوم.");
      if (++entries > 10_000) throw new CodingError("PROJECT_TOO_LARGE", "تجاوزت بيانات Git حدود هذه الشريحة.");
      if (stat.isDirectory()) await walk(absolute);
    }
  }
  await walk(directory);
  for (const path of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "info/attributes", "info/grafts"]) {
    try { if ((await lstat(join(directory, ...path.split("/")))).size > 0) throw new CodingError("UNSAFE_GIT_METADATA", "توجيهات Git الخارجية وattributes المخصصة غير مدعومة."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const configPath = join(directory, "config");
  if ((await lstat(configPath)).size > 65_536) throw new CodingError("UNSAFE_GIT_CONFIGURATION", "حجم إعداد Git غير مدعوم.");
  const config = await readFile(configPath, "utf8");
  if (/^\s*\[(?:include|includeIf|filter|diff|merge|credential|alias|submodule|extensions)\b/im.test(config)
    || /^\s*(?:hooksPath|fsmonitor|attributesFile|worktree|sshCommand|editor)\s*=/im.test(config)) {
    throw new CodingError("UNSAFE_GIT_CONFIGURATION", "إعداد Git يحتوي توجيهات تنفيذ أو توجيه خارجي غير مدعومة.");
  }
}
