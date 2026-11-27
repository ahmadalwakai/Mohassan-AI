import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import ts from "typescript";
import { limits, type SnapshotFile } from "./security.ts";

export interface RepairFile extends SnapshotFile { editable: boolean }

const projectRoot = "/project";
const libraryRoot = "/typescript-lib";
const libraryDirectory = dirname(ts.getDefaultLibFilePath({}));
const libraryNames = new Set(readdirSync(libraryDirectory).filter((name) => /^lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(name)));
const libraries = new Map<string, string>();
const sourceExtension = /\.(?:tsx?|[cm]?js)$/i;
const supportedDiagnostics = new Set(ts.getSupportedCodeFixes().map(Number));
// Other compiler actions can silence diagnostics or insert inferred implementations.
const provenFixes = new Set(["import", "spelling"]);

function absolutePath(path: string): string {
  return posix.resolve(projectRoot, path.replaceAll("\\", "/"));
}

function readLibrary(path: string): string | undefined {
  if (posix.dirname(path) !== libraryRoot) return;
  const name = posix.basename(path);
  if (!libraryNames.has(name)) return;
  let content = libraries.get(name);
  if (content === undefined) {
    content = readFileSync(join(libraryDirectory, name), "utf8");
    libraries.set(name, content);
  }
  return content;
}

function matches(path: string, glob: string, root: string): boolean {
  const pattern = posix.resolve(root, glob);
  if (pattern.includes("*") || pattern.includes("?")) return posix.matchesGlob(path, pattern);
  return path === pattern || path.startsWith(`${pattern}/`);
}

function createSnapshot(files: readonly SnapshotFile[], formatting = false, signal?: AbortSignal, project?: string) {
  const contents = new Map(files.map((file) => [absolutePath(file.path), file.content]));
  const paths = new Map(files.map((file) => [absolutePath(file.path), file.path]));
  const directories = new Set([projectRoot, libraryRoot]);
  for (const file of contents.keys()) {
    for (let directory = posix.dirname(file); directory !== "/"; directory = posix.dirname(directory)) directories.add(directory);
  }
  const fs: ts.ModuleResolutionHost = {
    getCurrentDirectory: () => projectRoot,
    useCaseSensitiveFileNames: true,
    directoryExists: (path) => directories.has(absolutePath(path)),
    getDirectories: (path) => [...directories].filter((directory) => posix.dirname(directory) === absolutePath(path)).map((directory) => posix.basename(directory)),
    fileExists: (path) => {
      const file = absolutePath(path);
      return contents.has(file) || (posix.dirname(file) === libraryRoot && libraryNames.has(posix.basename(file)));
    },
    readFile: (path) => contents.get(absolutePath(path)) ?? readLibrary(absolutePath(path)),
  };
  const readDirectory: NonNullable<ts.LanguageServiceHost["readDirectory"]> = (path, extensions, excludes, includes, depth) => {
    const root = absolutePath(path);
    const prefix = root === "/" ? "/" : `${root}/`;
    return [...contents.keys()].filter((file) => file.startsWith(prefix)
      && (depth === undefined || file.slice(prefix.length).split("/").length - 1 <= depth)
      && (!extensions || extensions.some((extension) => file.endsWith(extension)))
      && (!excludes || !excludes.some((glob) => matches(file, glob, root)))
      && (!includes?.length || includes.some((glob) => matches(file, glob, root))));
  };
  const config = project ? absolutePath(project) : ["tsconfig.json", "jsconfig.json"].map(absolutePath).find(fs.fileExists);
  const defaults: ts.CompilerOptions = { allowJs: true, checkJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, types: [] };
  let options = defaults;
  let rootNames = [...contents.keys()].filter((file) => sourceExtension.test(file) || (formatting && /\.json$/i.test(file)));
  let configValid = !config || fs.fileExists(config);
  let projectReferences: readonly ts.ProjectReference[] | undefined;
  if (config && configValid && !formatting) {
    const parsed = ts.parseJsonSourceFileConfigFileContent(ts.parseJsonText(config, fs.readFile(config)!), {
      useCaseSensitiveFileNames: true, readDirectory, fileExists: fs.fileExists, readFile: fs.readFile,
    }, posix.dirname(config), defaults, config);
    configValid = parsed.errors.length === 0;
    rootNames = parsed.fileNames.filter((file) => contents.has(absolutePath(file)));
    options = parsed.options;
    projectReferences = parsed.projectReferences;
  }
  const resolution = options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext;
  let defaultModule = ts.ModuleKind.ESNext;
  if (resolution === ts.ModuleResolutionKind.Node16) defaultModule = ts.ModuleKind.Node16;
  if (resolution === ts.ModuleResolutionKind.NodeNext) defaultModule = ts.ModuleKind.NodeNext;
  options = {
    ...options, plugins: undefined, noEmit: true, resolveJsonModule: options.resolveJsonModule ?? true,
    allowImportingTsExtensions: options.allowImportingTsExtensions ?? true, module: options.module ?? defaultModule,
  };
  if (options.moduleResolution === undefined && options.module === ts.ModuleKind.ESNext) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
  let version = 0;
  const versions = new Map<string, number>();
  const service = ts.createLanguageService({
    fileExists: fs.fileExists,
    readFile: fs.readFile,
    directoryExists: fs.directoryExists,
    getDirectories: fs.getDirectories,
    readDirectory,
    useCaseSensitiveFileNames: () => true,
    getCurrentDirectory: () => projectRoot,
    getCompilationSettings: () => options,
    getProjectReferences: () => projectReferences,
    getProjectVersion: () => String(version),
    getScriptFileNames: () => rootNames,
    getScriptVersion: (file) => String(versions.get(absolutePath(file)) ?? 0),
    getScriptSnapshot: (file) => {
      const content = fs.readFile(file);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getDefaultLibFileName: (settings) => `${libraryRoot}/${ts.getDefaultLibFileName(settings)}`,
    getCancellationToken: () => ({ isCancellationRequested: () => signal?.aborted ?? false }),
  });
  const resolvedModules = ts.createModuleResolutionCache(projectRoot, (file) => file, options);

  function diagnostics(): (ts.Diagnostic & { file: ts.SourceFile })[] {
    if (!configValid || !rootNames.length) return [];
    const program = service.getProgram();
    if (!program) return [];
    return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
      .filter((diagnostic): diagnostic is ts.Diagnostic & { file: ts.SourceFile } => Boolean(diagnostic.file && paths.has(absolutePath(diagnostic.file.fileName))));
  }

  function update(changes: ReadonlyMap<string, string>) {
    version += 1;
    for (const [file, content] of changes) {
      contents.set(file, content);
      versions.set(file, version);
    }
  }

  function imports(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [file, content] of contents) {
      if (!sourceExtension.test(file)) continue;
      const edges = new Set<string>();
      const preprocessed = ts.preProcessFile(content, true, /\.[cm]?js$/i.test(file));
      const mode = ts.getImpliedNodeFormatForFile(file, undefined, fs, options);
      for (const imported of preprocessed.importedFiles) {
        const resolved = ts.resolveModuleName(imported.fileName, file, options, fs, resolvedModules, undefined, mode).resolvedModule;
        const path = resolved && paths.get(absolutePath(resolved.resolvedFileName));
        if (path) edges.add(path);
      }
      for (const reference of preprocessed.referencedFiles) {
        const path = paths.get(posix.resolve(posix.dirname(file), reference.fileName));
        if (path) edges.add(path);
      }
      result.set(paths.get(file)!, edges);
    }
    return result;
  }

  return { contents, paths, service, diagnostics, update, imports };
}

export function inspectTypeScript(files: readonly SnapshotFile[], signal?: AbortSignal, project?: string): { diagnosticPaths: string[]; imports: Map<string, Set<string>> } {
  signal?.throwIfAborted();
  const snapshot = createSnapshot(files, false, signal, project);
  try {
    return {
      diagnosticPaths: [...new Set(snapshot.diagnostics().map((diagnostic) => snapshot.paths.get(absolutePath(diagnostic.file.fileName))!))],
      imports: snapshot.imports(),
    };
  } finally { snapshot.service.dispose(); }
}

export interface TypeScriptDiagnostic { path: string; line: number; column: number; code: string; message: string }

/** The compiler's own diagnostics for the tracked files, computed in memory: nothing runs and nothing is written. */
export function typeScriptDiagnostics(files: readonly SnapshotFile[], signal?: AbortSignal, project?: string): TypeScriptDiagnostic[] {
  signal?.throwIfAborted();
  const snapshot = createSnapshot(files, false, signal, project);
  try {
    return snapshot.diagnostics().map((diagnostic) => {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      return { path: snapshot.paths.get(absolutePath(diagnostic.file.fileName))!, line: line + 1, column: character + 1,
        code: `TS${diagnostic.code}`, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 300) };
    });
  } finally { snapshot.service.dispose(); }
}

function applyTextChanges(content: string, changes: readonly ts.TextChange[]): string | undefined {
  let end = content.length;
  let result = content;
  for (const { span, newText } of [...changes].sort((a, b) => a.span.start - b.span.start).reverse()) {
    if (span.start < 0 || span.length < 0 || span.start + span.length > end) return;
    result = result.slice(0, span.start) + newText + result.slice(span.start + span.length);
    end = span.start;
  }
  return result;
}

function diagnosticKey(diagnostic: ts.Diagnostic): string {
  return JSON.stringify([diagnostic.file?.fileName, diagnostic.code, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")]);
}

function diagnosticCounts(diagnostics: readonly ts.Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of diagnostics) {
    const key = diagnosticKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formattingSettings(content: string): ts.FormatCodeSettings {
  return ts.getDefaultFormatCodeSettings(content.includes("\r\n") ? "\r\n" : "\n");
}

export function repairTypeScript(files: readonly RepairFile[], signal: AbortSignal, project?: string): Map<string, string> {
  signal.throwIfAborted();
  const editable = new Set(files.filter((file) => file.editable).map((file) => absolutePath(file.path)));
  if (!editable.size) return new Map();
  const snapshot = createSnapshot(files, false, signal, project);
  try {
    let diagnostics = snapshot.diagnostics();
    const order = new Map([...editable].map((path, index) => [path, index]));
    const proposals = new Map<string, string>();
    let attempts = 0;
    while (attempts < limits.files) {
      let improved = false;
      const counts = diagnosticCounts(diagnostics);
      const editableDiagnostics = diagnostics.filter((item) => editable.has(absolutePath(item.file.fileName)))
        .sort((a, b) => order.get(absolutePath(a.file.fileName))! - order.get(absolutePath(b.file.fileName))!);
      for (const diagnostic of editableDiagnostics) {
        signal.throwIfAborted();
        if (diagnostic.start === undefined || diagnostic.length === undefined || !supportedDiagnostics.has(diagnostic.code)) continue;
        if (attempts++ >= limits.files) break;
        const file = absolutePath(diagnostic.file.fileName);
        const fixes = snapshot.service.getCodeFixesAtPosition(file, diagnostic.start, diagnostic.start + diagnostic.length,
          [diagnostic.code], formattingSettings(snapshot.contents.get(file)!), { importModuleSpecifierPreference: "relative", importModuleSpecifierEnding: "js" });
        const action = fixes[0];
        if (fixes.length !== 1 || !action || !provenFixes.has(action.fixName) || action.commands?.length) continue;
        if (action.changes.length !== 1 || action.changes[0]!.isNewFile || absolutePath(action.changes[0]!.fileName) !== file) continue;
        const before = snapshot.contents.get(file)!;
        const after = applyTextChanges(before, action.changes[0]!.textChanges);
        if (after === undefined || before === after || Buffer.byteLength(after) > limits.fileBytes) continue;
        const path = snapshot.paths.get(file)!;
        const editBytes = [...proposals].reduce((size, [other, content]) => size + (other === path ? 0 : Buffer.byteLength(content)), Buffer.byteLength(after));
        if (editBytes > limits.editsBytes) continue;

        snapshot.update(new Map([[file, after]]));
        const candidate = snapshot.diagnostics();
        const candidateCounts = diagnosticCounts(candidate);
        const key = diagnosticKey(diagnostic);
        if (candidate.length >= diagnostics.length || (candidateCounts.get(key) ?? 0) >= counts.get(key)!
          || [...candidateCounts].some(([key, count]) => count > (counts.get(key) ?? 0))) {
          snapshot.update(new Map([[file, before]]));
          continue;
        }
        diagnostics = candidate;
        proposals.set(path, after);
        improved = true;
        break;
      }
      if (!improved) break;
    }
    return proposals;
  } finally { snapshot.service.dispose(); }
}

export function formatSourceFiles(files: readonly RepairFile[], signal: AbortSignal): Map<string, string> {
  signal.throwIfAborted();
  const snapshot = createSnapshot(files, true, signal);
  try {
    const changed = new Map<string, string>();
    let bytes = 0;
    for (const { path, content, editable } of files) {
      signal.throwIfAborted();
      if (!editable || !/\.(?:tsx?|[cm]?js|json)$/i.test(path)) continue;
      const file = absolutePath(path);
      if (snapshot.service.getSyntacticDiagnostics(file).length) continue;
      const settings = { ...formattingSettings(content), semicolons: ts.SemicolonPreference.Ignore };
      const changes = snapshot.service.getFormattingEditsForDocument(file, settings);
      if (changes.some(({ span, newText }) => /\S/.test(newText) || /\S/.test(content.slice(span.start, span.start + span.length)))) continue;
      const formatted = applyTextChanges(content, changes);
      if (formatted === undefined || formatted === content) continue;
      const size = Buffer.byteLength(formatted);
      if (size > limits.fileBytes || bytes + size > limits.editsBytes) continue;
      bytes += size;
      changed.set(path, formatted);
    }
    return changed;
  } finally { snapshot.service.dispose(); }
}
