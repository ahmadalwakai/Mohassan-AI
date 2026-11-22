import { readdir } from "node:fs/promises";
import { boundedGit } from "./git.ts";
import { CodingError, assertNoLinks, safeRelative } from "./security.ts";

/**
 * Fixed, validated Git operations against one public GitHub repository over HTTPS, plus
 * object reads from a bare mirror. Nothing here checks files out, runs hooks or forwards
 * stderr. Every argv is built from validated parts with `--` before positional values.
 */
export interface RemoteRepo { owner: string; name: string }
export interface RemoteTreeEntry { mode: string; type: "blob" | "tree" | "commit"; objectId: string; size: number | null; path: string }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, OBJECT_ID = /^[a-f0-9]{40}$/;
const CHILD = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s, ENTRY = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/s;
const NETWORK_TIMEOUT_MS = 60_000, LISTING_LIMIT = 1_048_576, MAX_RECORDS = 4000, MAX_BLOB = 16 * 1_048_576;
const PASS_THROUGH = new Set(["ABORTED", "GIT_UNAVAILABLE"]);

const rejected = (message: string): never => { throw new CodingError("GIT_REMOTE_REJECTED", message); };
const unreachable = () => new CodingError("GIT_REMOTE_UNREACHABLE", "تعذر الوصول إلى مستودع المهارات أو رفض Git العملية.");

export function parseRemoteRepo(value: string): RemoteRepo {
  if (typeof value !== "string" || value.length > 140 || value.indexOf("/") < 0) return rejected("اسم المستودع غير صالح.");
  const owner = value.slice(0, value.indexOf("/")), name = value.slice(value.indexOf("/") + 1);
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === ".." || /\.git$/i.test(name)) return rejected("اسم المستودع غير صالح.");
  return { owner, name };
}
export function validRemoteRef(value: string): string {
  if (typeof value !== "string" || !REF.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) return rejected("اسم الفرع غير صالح.");
  return value;
}
export function validRemoteCommit(value: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) return rejected("معرّف الالتزام غير صالح.");
  return value;
}
/** The only URL this module ever contacts. */
export const remoteUrl = (repo: RemoteRepo) => `https://github.com/${repo.owner}/${repo.name}.git`;

/** HTTPS to GitHub is the one transport these pairs open; the base invocation keeps `protocol.allow=never`.
 * The runner disables the system gitconfig that normally names the CA bundle, so Windows uses the OS store. */
export function remoteNetworkConfig(platform: NodeJS.Platform = process.platform): string[] {
  return ["protocol.https.allow=always", "http.followRedirects=false", "credential.helper=", "transfer.fsckObjects=true", "fetch.fsckObjects=true",
    "core.symlinks=false", "http.lowSpeedLimit=1000", "http.lowSpeedTime=20", ...(platform === "win32" ? ["http.sslBackend=schannel"] : [])];
}

function mapped(error: unknown): never {
  if (error instanceof CodingError && PASS_THROUGH.has(error.code)) throw error;
  throw unreachable();
}

/** A bare repository in an existing, empty, link-free directory. */
export async function createMirror(dir: string, signal?: AbortSignal): Promise<void> {
  await assertNoLinks(dir);
  if ((await readdir(dir)).length) rejected("مجلد المرآة ليس فارغًا.");
  await boundedGit(dir, ["init", "--bare", "-q"], { signal }).catch(mapped);
}

/** The commit the branch points at on GitHub. One network request, no objects transferred. */
export async function remoteHead(cwd: string, repo: string, ref: string, signal?: AbortSignal): Promise<string> {
  const target = parseRemoteRepo(repo), branch = validRemoteRef(ref);
  const { stdout } = await boundedGit(cwd, ["ls-remote", "--heads", "--", remoteUrl(target), `refs/heads/${branch}`], { signal, extraConfig: remoteNetworkConfig(), timeoutMs: NETWORK_TIMEOUT_MS }).catch(mapped);
  const lines = stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  if (!lines.length) throw new CodingError("GIT_REMOTE_REF_MISSING", "الفرع المطلوب غير موجود في المستودع.");
  const match = lines.length === 1 ? /^([a-f0-9]{40})\trefs\/heads\/(.+)$/.exec(lines[0]) : null;
  if (!match || match[2] !== branch) throw unreachable();
  return match[1];
}

/** Depth-1 fetch of one branch into the mirror; returns the commit actually stored. */
export async function remoteFetch(mirror: string, repo: string, ref: string, signal?: AbortSignal): Promise<string> {
  const target = parseRemoteRepo(repo), branch = validRemoteRef(ref);
  await boundedGit(mirror, ["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--", remoteUrl(target), `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { signal, extraConfig: remoteNetworkConfig(), timeoutMs: NETWORK_TIMEOUT_MS }).catch(mapped);
  const { stdout } = await boundedGit(mirror, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], { signal }).catch(mapped);
  return validRemoteCommit(stdout.trim());
}

export async function hasCommit(mirror: string, commit: string, signal?: AbortSignal): Promise<boolean> {
  validRemoteCommit(commit);
  try { await boundedGit(mirror, ["cat-file", "-e", `${commit}^{commit}`], { signal }); return true; }
  catch (error) { if (error instanceof CodingError && PASS_THROUGH.has(error.code)) throw error; return false; }
}

function treePath(path: string): string {
  try { return safeRelative(path); } catch { return rejected("مسار المجلد داخل المستودع غير صالح."); }
}
function records(stdout: Uint8Array): Uint8Array[] {
  const found: Uint8Array[] = []; let start = 0;
  for (let index = 0; index < stdout.length; index++) if (stdout[index] === 0) { found.push(stdout.subarray(start, index)); start = index + 1; }
  if (start < stdout.length) found.push(stdout.subarray(start));
  return found;
}
async function listTree(mirror: string, commit: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<RemoteTreeEntry[]> {
  const args = ["ls-tree", "-z", ...(recursive ? ["-r", "-l"] : []), validRemoteCommit(commit), "--", `${treePath(path)}/`];
  const { stdout } = await boundedGit(mirror, args, { signal, output: "bytes", maxBytes: LISTING_LIMIT }).catch((error: unknown) => {
    if (error instanceof CodingError && error.code === "GIT_OUTPUT_OVERFLOW") throw new CodingError("GIT_REMOTE_TOO_LARGE", "قائمة المستودع أكبر من المسموح.");
    return mapped(error);
  });
  const found = records(stdout);
  if (found.length > MAX_RECORDS) throw new CodingError("GIT_REMOTE_TOO_LARGE", "يحتوي المستودع ملفات أكثر من المسموح.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return found.map((record) => {
    let text: string;
    try { text = decoder.decode(record); } catch { throw new CodingError("GIT_REMOTE_REJECTED", "اسم ملف في المستودع ليس UTF-8 صالحاً."); }
    const match = (recursive ? ENTRY : CHILD).exec(text);
    if (!match) throw unreachable();
    const [, mode, type, objectId, sizeOrPath, maybePath] = match;
    const size = recursive ? sizeOrPath : "-", entryPath = recursive ? maybePath : sizeOrPath;
    return { mode, type: type as RemoteTreeEntry["type"], objectId, size: size === "-" ? null : Number(size), path: entryPath };
  });
}
/** Direct children of `<path>` in `commit`. A path that is not a tree in that commit is reported, not treated as empty. */
export async function treeChildren(mirror: string, commit: string, path: string, signal?: AbortSignal): Promise<RemoteTreeEntry[]> {
  const children = await listTree(mirror, commit, path, false, signal);
  if (children.length) return children;
  const { stdout } = await boundedGit(mirror, ["ls-tree", "-d", "-z", validRemoteCommit(commit), "--", treePath(path)], { signal, output: "bytes", maxBytes: LISTING_LIMIT }).catch(mapped);
  if (!records(stdout).length) throw new CodingError("GIT_REMOTE_PATH_MISSING", "مجلد المهارات غير موجود في هذا الفرع.");
  return [];
}
/** Every entry below `<path>` with blob sizes, so callers can refuse oversized files before reading any blob. */
export function treeEntries(mirror: string, commit: string, path: string, signal?: AbortSignal): Promise<RemoteTreeEntry[]> {
  return listTree(mirror, commit, path, true, signal);
}
/** Raw blob bytes, bounded before and during the read; the caller decodes with a fatal UTF-8 decoder. */
export async function blobBytes(mirror: string, objectId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!OBJECT_ID.test(objectId)) rejected("معرّف الملف غير صالح.");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BLOB) rejected("حد حجم الملف غير صالح.");
  const { stdout } = await boundedGit(mirror, ["cat-file", "blob", objectId], { signal, output: "bytes", maxBytes }).catch((error: unknown) => {
    if (error instanceof CodingError && error.code === "GIT_OUTPUT_OVERFLOW") throw new CodingError("GIT_REMOTE_TOO_LARGE", "الملف أكبر من الحد المسموح للمهارة.");
    return mapped(error);
  });
  return stdout;
}
