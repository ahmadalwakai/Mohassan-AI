import { posix } from "node:path";
import ts from "typescript";
import { CodingError, credentialLike, sensitivePath, type SnapshotFile } from "./security.ts";

/**
 * Read-only views of a registered project's committed files, without a model and without running anything: a literal
 * search, and which files import which. Callers pass the files inspectProject read, so only tracked, committed, bounded
 * text inside the allowed roots is ever seen. Sensitive files are skipped and credential-like lines are never quoted.
 */
export interface SearchMatch { path: string; line: number; text: string }
export interface ProjectSearchResult {
  query: string;
  /** An identifier-like query matches whole words only, so «sum» does not match «summary». */
  wholeWord: boolean;
  matches: SearchMatch[];
  /** Matching lines in total, including those beyond the shown limit and the masked ones. */
  total: number;
  files: number;
  /** Matching lines that look like credentials: counted, never quoted. */
  masked: number;
  /** Tracked paths that contain the query, so a file can be found by its name (at most 10). */
  pathMatches: string[];
}
export interface ImportEdge { specifier: string; path: string | null }
export interface ImportRelations {
  target: string;
  /** What the target imports; `path` is the tracked file a relative specifier resolves to, null for packages and built-ins. */
  imports: ImportEdge[];
  importedBy: { path: string; specifier: string }[];
}
export type ProjectReference = { kind: "file"; path: string } | { kind: "ambiguous"; paths: string[] } | { kind: "none" };

const MAX_MATCHES = 30;
const MAX_LINE = 160;
const SOURCE = /\.(?:tsx?|[cm]?[jt]s|jsx)$/i;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];

function snippet(line: string, index: number): string {
  const text = line.trim();
  if (text.length <= MAX_LINE) return text;
  const offset = Math.max(0, index - (line.length - line.trimStart().length) - 40);
  const window = text.slice(offset, offset + MAX_LINE - 2);
  return `${offset > 0 ? "…" : ""}${window}${offset + MAX_LINE - 2 < text.length ? "…" : ""}`;
}

export function searchProjectFiles(files: readonly SnapshotFile[], query: string): ProjectSearchResult {
  const needle = query.trim();
  if (!needle || needle.length > 200 || /[\r\n]/.test(needle)) throw new CodingError("INVALID_SEARCH", "عبارة البحث يجب أن تكون سطرًا واحدًا بين حرف و200 حرف.");
  const wholeWord = /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])` : escaped, "iu");
  const matches: SearchMatch[] = [];
  const touched = new Set<string>();
  let total = 0, masked = 0;
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (sensitivePath(file.path)) continue;
    file.content.split(/\r?\n/).forEach((line, index) => {
      const found = pattern.exec(line);
      if (!found) return;
      total += 1;
      touched.add(file.path);
      if (credentialLike(line)) { masked += 1; return; }
      if (matches.length < MAX_MATCHES) matches.push({ path: file.path, line: index + 1, text: snippet(line, found.index) });
    });
  }
  const lowered = needle.toLowerCase();
  const pathMatches = files.map((file) => file.path).filter((path) => !sensitivePath(path) && path.toLowerCase().includes(lowered)).sort().slice(0, 10);
  return { query: needle, wholeWord, matches, total, files: touched.size, masked, pathMatches };
}

/** The tracked file a relative specifier names, trying the extensions Node and TypeScript resolve; null outside the project. */
function resolveSpecifier(from: string, specifier: string, paths: ReadonlySet<string>, lower: ReadonlyMap<string, string>): string | null {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (base === ".." || base.startsWith("../")) return null;
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/i, "");
  const candidates = [base, ...EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"].map((name) => posix.join(base, name))];
  for (const candidate of candidates) {
    if (paths.has(candidate)) return candidate;
    const folded = lower.get(candidate.toLowerCase());
    if (folded) return folded;
  }
  return null;
}

export function fileImports(file: SnapshotFile, paths: ReadonlySet<string>): ImportEdge[] {
  if (!SOURCE.test(file.path)) return [];
  const lower = new Map([...paths].map((path) => [path.toLowerCase(), path]));
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];
  for (const { fileName } of ts.preProcessFile(file.content, true, true).importedFiles) {
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    edges.push({ specifier: fileName, path: resolveSpecifier(file.path, fileName, paths, lower) });
  }
  return edges;
}

/** A file the owner named: an exact path, else a unique file name, else a unique name without its extension. */
export function resolveProjectReference(reference: string, paths: readonly string[]): ProjectReference {
  // A sentence mark may follow the closing quote («src/a.ts»؟), and a path never ends in one (safeRelative).
  const wanted = reference.trim().replace(/[؟?!.,،:;]+$/u, "").replace(/^[`'"«]+|[`'"»]+$/g, "").replace(/[؟?!.,،:;]+$/u, "")
    .replace(/\\/g, "/").replace(/^\.\//, "");
  if (!wanted) return { kind: "none" };
  const lowered = wanted.toLowerCase();
  const exact = paths.filter((path) => path.toLowerCase() === lowered);
  if (exact.length === 1) return { kind: "file", path: exact[0]! };
  const tail = paths.filter((path) => path.toLowerCase().endsWith(`/${lowered}`));
  if (tail.length === 1) return { kind: "file", path: tail[0]! };
  if (tail.length > 1) return { kind: "ambiguous", paths: tail.slice(0, 8) };
  const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "").toLowerCase();
  const stems = paths.filter((path) => !wanted.includes("/") && stem(path) === lowered.replace(/\.[^.]+$/, ""));
  if (stems.length === 1) return { kind: "file", path: stems[0]! };
  if (stems.length > 1) return { kind: "ambiguous", paths: stems.slice(0, 8) };
  return { kind: "none" };
}

export type ImportsLookup = { kind: "file"; relations: ImportRelations } | Exclude<ProjectReference, { kind: "file" }>;

/** The import relations of the file the owner named, or why no single file was found. */
export function lookupImports(files: readonly SnapshotFile[], reference: string): ImportsLookup {
  const target = resolveProjectReference(reference, files.map((file) => file.path));
  return target.kind === "file" ? { kind: "file", relations: importRelations(files, target.path) } : target;
}

export function importRelations(files: readonly SnapshotFile[], target: string): ImportRelations {
  const paths = new Set(files.map((file) => file.path));
  const file = files.find((item) => item.path === target);
  if (!file) throw new CodingError("UNKNOWN_FILE", "الملف غير موجود بين ملفات المشروع المحفوظة.");
  const importedBy = files.filter((item) => item.path !== target && !sensitivePath(item.path))
    .flatMap((item) => fileImports(item, paths).filter((edge) => edge.path === target).map((edge) => ({ path: item.path, specifier: edge.specifier })))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { target, imports: sensitivePath(target) ? [] : fileImports(file, paths), importedBy };
}
