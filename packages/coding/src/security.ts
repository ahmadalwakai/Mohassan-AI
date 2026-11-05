import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class CodingError extends Error {
  usage?: { inputTokens: number; outputTokens: number };
  model?: string;
  readonly retryable = false;
  constructor(public readonly code: string, message: string) { super(message); this.name = "CodingError"; }
}

export const limits = { files: 40, fileBytes: 64_000, totalBytes: 128_000, editsBytes: 64_000, diffBytes: 131_072 } as const;
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const normalized = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function containsPath(root: string, target: string): boolean {
  const path = relative(normalized(root), normalized(target));
  return path === "" || (!path.startsWith(".." + sep) && path !== ".." && !isAbsolute(path));
}

export function safeRelative(path: string): string {
  if (typeof path !== "string" || path.length > 180 || !/^[\p{L}\p{N}._/-]+$/u.test(path)
    || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".."
      || part.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new CodingError("UNSAFE_PATH", "مسار الملف غير صالح أو يتجاوز نطاق المشروع.");
  }
  return path;
}

export function sensitivePath(path: string): boolean {
  return path.split("/").some((part) => /^\.env/i.test(part)
    || /^(?:secrets?|credentials)(?:\.|$)/i.test(part)
    || /^(\.git|node_modules|\.npmrc|\.pypirc|\.ssh|credentials|id_rsa|id_ed25519)$/i.test(part)
    || /\.(pem|key|pfx|p12)$/i.test(part));
}

export function editablePath(path: string): boolean {
  safeRelative(path);
  return !sensitivePath(path) && /\.(?:[cm]?js|ts)$/i.test(path)
    && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path)
    && !/\.(?:test|spec)\./i.test(path)
    && !/(?:^|\/)(?:[^/]*\.config\.[^/]+|config\.[^/]+)$/i.test(path);
}

export function credentialLike(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gsk_|sk-(?:proj-)?|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|\bnpg_[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(content)
    || /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/i.test(content)
    || /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|database_url|connection[_-]?string|secret)\b["']?\s*[:=]\s*["'`][^\r\n"'`]{8,}["'`]/i.test(content);
}

/** Checks each component, including Windows junctions, before reading or writing. */
export async function assertNoLinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const components: string[] = [];
  let current = absolute;
  while (true) {
    components.unshift(current);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  for (const component of components) {
    try {
      const info = await lstat(component);
      if (info.isSymbolicLink()) throw new CodingError("SYMLINK_REJECTED", "الروابط الرمزية وjunctions غير مدعومة في هذه الشريحة.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function canonicalDirectory(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path) || /^(?:[a-z]+:\/\/|\\\\)/i.test(path) || !roots.length) {
    throw new CodingError("LOCAL_PROJECT_REQUIRED", "يلزم مجلد Git محلي داخل الجذور المصرح بها.");
  }
  await assertNoLinks(path);
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) throw new CodingError("PROJECT_NOT_DIRECTORY", "مسار المشروع ليس مجلدًا.");
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    await assertNoLinks(root);
    if (containsPath(await realpath(root), canonical)) return canonical;
  }
  throw new CodingError("PROJECT_OUTSIDE_ROOTS", "المشروع خارج الجذور المصرح بها.");
}

export async function boundedText(path: string, maxBytes: number = limits.fileBytes): Promise<string> {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new CodingError("UNSUPPORTED_FILE", "الملف ليس نصًا عاديًا محدود الحجم أو يملك hard links.");
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes || bytes.includes(0)) throw new CodingError("UNSUPPORTED_FILE", "تجاوز الملف حدود النص المسموحة.");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CodingError("UNSUPPORTED_ENCODING", "يلزم ترميز UTF-8 للملفات الحالية."); }
  if (credentialLike(content)) throw new CodingError("SENSITIVE_SOURCE_REJECTED", "يحتوي ملف مصدر على صيغة اعتماد حساسة؛ لم يُرسل إلى النموذج.");
  return content;
}

export async function sourcePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  let entries = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" && prefix === "") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(path);
      if (sensitivePath(path)) throw new CodingError("SENSITIVE_PROJECT_PATH", "المشروع يحتوي مسارًا حساسًا أو تبعيات محلية غير مدعومة؛ لم يُقرأ محتواه.");
      const absolute = join(root, ...path.split("/"));
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new CodingError("SYMLINK_REJECTED", "المشروع يحتوي رابطًا أو نوع ملف غير مدعوم.");
      if (++entries > 200) throw new CodingError("PROJECT_TOO_LARGE", "تجاوز المشروع حدود الشريحة الحالية.");
      if (info.isDirectory()) await walk(absolute, path);
      else paths.push(path);
      if (paths.length > limits.files) throw new CodingError("PROJECT_TOO_LARGE", "تجاوز المشروع عدد الملفات المدعوم.");
    }
  }
  await walk(root, "");
  return paths.sort();
}

export interface SnapshotFile { path: string; content: string }
export function snapshotHash(files: readonly SnapshotFile[]): string {
  return sha256(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, "en")).map(({ path, content }) => ({ path, content }))));
}
