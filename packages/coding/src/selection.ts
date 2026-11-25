import { posix } from "node:path";
import { limits, projectSettingsPath, repairSourcePath, type SnapshotFile } from "./security.ts";

type ImportGraph = ReadonlyMap<string, ReadonlySet<string>>;

function importDistances(paths: ReadonlySet<string>, imports: ImportGraph, seeds: string[]): Map<string, number> {
  const neighbors = new Map([...paths].map((path) => [path, new Set<string>()]));
  for (const [path, targets] of imports) {
    for (const target of targets) {
      if (!paths.has(path) || !paths.has(target)) continue;
      neighbors.get(path)!.add(target);
      neighbors.get(target)!.add(path);
    }
  }
  const distance = new Map(seeds.map((path) => [path, 0]));
  const queue = [...distance.keys()];
  for (const path of queue) {
    for (const neighbor of neighbors.get(path)!) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, distance.get(path)! + 1);
      queue.push(neighbor);
    }
  }
  return distance;
}

/** Only tracked paths can contribute locations, and output affects ranking alone. */
export function sandboxDiagnosticPaths(files: readonly SnapshotFile[], receipt: { stdout: string; stderr: string }): string[] {
  const paths = files.map(({ path }) => path).sort((a, b) => b.length - a.length);
  const diagnostics = new Set<string>();
  const output = `${receipt.stdout}\n${receipt.stderr}`.replace(/\\/g, "/");
  const location = /(?:^|[\s(:])([/\p{L}\p{N}._%-]{1,600})(?=\(\d+,\s*\d+\)\s*:|:\d+(?::\d+)?(?:[:)\s]|$))/gmu;
  for (const match of output.matchAll(location)) {
    let hint = match[1]!;
    try { hint = decodeURIComponent(hint); } catch { continue; }
    const name = hint.toLowerCase();
    const path = paths.find((candidate) => name === candidate.toLowerCase() || name.endsWith(`/${candidate.toLowerCase()}`));
    if (path) diagnostics.add(path);
  }
  return [...diagnostics];
}

function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

export function selectContextFiles<T extends SnapshotFile & { editable: boolean }>(
  files: readonly T[], goal: string, diagnosticPaths: readonly string[], imports: ImportGraph,
): T[] {
  const goalWords = new Set(words(goal));
  const goalPaths = new Set((goal.toLowerCase().match(/[\p{L}\p{N}._/-]+/gu) ?? []).map((token) => token.replace(/^\.\//, "").replace(/\.$/, "")));
  const diagnostics = new Set(diagnosticPaths);
  const paths = new Set(files.map(({ path }) => path));
  const candidates = files.map((file) => {
    const path = file.path.toLowerCase();
    const named = goalPaths.has(path) || goalPaths.has(posix.basename(path));
    const pathStem = file.path.slice(0, file.path.length - posix.extname(file.path).length);
    const nameWords = new Set(words(pathStem));
    const matchedWords = [...nameWords].filter((word) => goalWords.has(word)).length;
    const contentMatches = new Set(repairSourcePath(path) ? words(file.content).filter((word) => word.length > 2 && goalWords.has(word)) : []);
    return { file, named, matchedWords, contentMatches: contentMatches.size, diagnostic: diagnostics.has(file.path) };
  });
  const seeds = candidates.filter(({ file, named, matchedWords, contentMatches, diagnostic }) => file.editable || named || matchedWords > 0 || contentMatches > 0 || diagnostic);
  const distances = importDistances(paths, imports, seeds.map(({ file }) => file.path));
  const ranked = candidates.map(({ file, named, matchedWords, contentMatches, diagnostic }) => {
    const distance = distances.get(file.path);
    const settings = projectSettingsPath(file.path);
    const related = distance !== undefined && distance > 0;
    const relevance = (file.editable ? 1000 : 0) + (diagnostic ? 500 : 0) + (named ? 250 : 0)
      + Math.min(matchedWords * 30, 120) + (settings ? 140 : 0) + (related ? 125 / distance : 0)
      + Math.min(contentMatches * 12, 48);
    return { file, relevance, include: relevance > 0 || repairSourcePath(file.path) };
  }).filter(({ include }) => include).sort((a, b) => b.relevance - a.relevance || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  const selected: T[] = [];
  let bytes = 0;
  for (const { file } of ranked) {
    if (selected.length === limits.contextFiles) break;
    const size = Buffer.byteLength(file.content);
    if (size > limits.fileBytes || bytes + size > limits.totalBytes) continue;
    bytes += size;
    selected.push(file);
  }
  return selected;
}
