/**
 * Explains one sandbox check run from its own output, without a model: which tests failed, where they are declared,
 * the error, the first stack frame inside the project, and a failed assertion's expected and actual values. Nothing is
 * inferred beyond what the output states. Every location is mapped to a tracked project path, so the sandbox's
 * temporary folder never reaches a reply.
 *
 * Formats: Node's spec reporter (Node 23 and later use it even when the output is not a terminal) and TAP (earlier
 * versions, when the output is not a terminal); `tsc --pretty false` errors; `node --check` syntax errors.
 */
import { credentialLike } from "./security.ts";

export interface SourceLocation { path: string; line: number; column: number | null }
export interface CheckFailure {
  test: string;
  /** Where the test is declared. */
  location: SourceLocation | null;
  /** The error's first line, e.g. "ReferenceError: x is not defined". */
  error: string;
  /** A failed assertion's own comparison, e.g. "-1 !== 5". */
  comparison: string | null;
  expected: string | null;
  actual: string | null;
  operator: string | null;
  /** The first stack frame inside a tracked project file. */
  origin: SourceLocation | null;
}
export interface CheckCounts { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number }
export interface TypecheckError extends SourceLocation { code: string; message: string }
export interface SyntaxFailure { location: SourceLocation | null; message: string }
export interface CheckReport {
  status: "passed" | "failed" | "timed_out";
  counts: CheckCounts | null;
  failures: CheckFailure[];
  /** Failures the report left out beyond its limit. */
  omittedFailures: number;
  typecheck: TypecheckError[];
  syntax: SyntaxFailure[];
  /** The output's last lines, only when a failed run gave nothing parseable; absolute paths become project paths. */
  unparsed: string | null;
}

const MAX_FAILURES = 10;
const MAX_TYPECHECK = 10;
const MAX_SYNTAX = 5;
const bounded = (text: string, size: number) => text.length > size ? `${text.slice(0, size - 1)}…` : text;

/** The tracked path a location names: the longest project path it ends with, as whole path segments. */
export function projectPathOf(raw: string, paths: readonly string[]): string | null {
  let value = raw.trim().replace(/^['"]|['"]$/g, "");
  try { value = decodeURIComponent(value); } catch { /* A malformed escape stays as written. */ }
  value = value.replace(/\\\\/g, "/").replace(/\\/g, "/").replace(/^file:\/\/\/?/i, "");
  const lower = value.toLowerCase();
  let best: string | null = null;
  for (const path of paths) {
    const candidate = path.toLowerCase();
    if ((lower === candidate || lower.endsWith(`/${candidate}`)) && (!best || path.length > best.length)) best = path;
  }
  return best;
}

function located(raw: string, line: string, column: string | undefined, paths: readonly string[]): SourceLocation | null {
  const path = projectPathOf(raw, paths);
  return path ? { path, line: Number(line), column: column === undefined ? null : Number(column) } : null;
}

/**
 * Absolute paths inside a message become project paths, or `<path>` when they name no tracked file; a line that looks
 * like a credential (a test may print one) is replaced whole.
 */
export function relativeOutput(text: string, paths: readonly string[]): string {
  return text.split("\n").map((line) => credentialLike(line) ? "[hidden: looks like a password or key]" : line).join("\n")
    .replace(/(?:file:\/\/\/?)?(?:[A-Za-z]:)?(?:[\\/]{1,2}[^\s'"()<>|*?\\/:]+)+(?=[\s'"():,]|$)/g, (match) => {
      if (!/^(?:file:|[A-Za-z]:|[\\/])/i.test(match) || !/[\\/]/.test(match)) return match;
      return projectPathOf(match, paths) ?? "<path>";
    });
}

const FRAME = /^\s*at (?:.*? \()?((?:file:\/\/\/?)?.+?):(\d+):(\d+)\)?(?:\s*\{)?\s*$/;

function originOf(lines: readonly string[], paths: readonly string[]): SourceLocation | null {
  for (const line of lines) {
    const frame = FRAME.exec(line) ?? /^\s+((?:file:\/\/\/?)?[^\s(]+?):(\d+):(\d+)\)?\s*$/.exec(line) ?? /\(((?:file:\/\/\/?)?.+?):(\d+):(\d+)\)\s*$/.exec(line);
    if (!frame || frame[1]!.startsWith("node:")) continue;
    const location = located(frame[1]!, frame[2]!, frame[3], paths);
    if (location) return location;
  }
  return null;
}

function field(lines: readonly string[], key: string): string | null {
  for (const line of lines) {
    const match = new RegExp(`^\\s*${key}: (.+?),?\\s*$`).exec(line);
    if (match) return credentialLike(match[1]!) ? "[hidden]" : bounded(match[1]!.replace(/^'(.*)'$/, "$1"), 200);
  }
  return null;
}

/** Node's spec reporter: the «failing tests» section repeats each failure under «test at <file>:<line>:<column>». */
function specFailures(output: string, paths: readonly string[]): CheckFailure[] {
  const start = output.search(/^✖ failing tests:\s*$/m);
  if (start < 0) return [];
  const failures: CheckFailure[] = [];
  let block: string[] | null = null;
  const blocks: string[][] = [];
  for (const line of output.slice(start).split("\n").slice(1)) {
    if (/^test at .+:\d+:\d+\s*$/.test(line)) { block = [line]; blocks.push(block); continue; }
    block?.push(line);
  }
  for (const lines of blocks) {
    const declared = /^test at (.+):(\d+):(\d+)\s*$/.exec(lines[0]!)!;
    const name = /^✖ (.+?)(?: \([\d.]+m?s\))?\s*$/.exec(lines[1] ?? "");
    if (!name) continue;
    const body = lines.slice(2);
    const firstFrame = body.findIndex(line => FRAME.test(line));
    const message = body.slice(0, firstFrame < 0 ? body.length : firstFrame).map(line => line.trim());
    const errorIndex = message.findIndex(Boolean);
    // A suite fails because a test inside it failed; that test's own entry carries the cause.
    if (/^'?\d+ subtests? failed'?$/.test(message[errorIndex] ?? "")) continue;
    const comparison = message.slice(errorIndex + 1).filter(Boolean).slice(0, 6).join("\n");
    failures.push({
      test: bounded(name[1]!, 200),
      location: located(declared[1]!, declared[2]!, declared[3], paths),
      error: bounded(relativeOutput(errorIndex < 0 ? "Test failed without an error message." : message[errorIndex]!, paths), 300),
      comparison: comparison ? bounded(relativeOutput(comparison, paths), 300) : null,
      expected: field(body, "expected"), actual: field(body, "actual"), operator: field(body, "operator"),
      origin: originOf(body, paths),
    });
  }
  return failures;
}

/** TAP: «not ok N - name» with a YAML block holding location, error, expected, actual, operator and stack. */
function tapFailures(output: string, paths: readonly string[]): CheckFailure[] {
  const lines = output.split("\n");
  const failures: CheckFailure[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = /^( *)not ok \d+ - (.+?)\s*$/.exec(lines[index]!);
    if (!header || /# (?:SKIP|TODO)\b/i.test(header[2]!)) continue;
    const indent = header[1]!.length;
    if (lines[index + 1]?.trim() !== "---") continue;
    const yaml: string[] = [];
    for (index += 2; index < lines.length && lines[index]!.trim() !== "..."; index++) yaml.push(lines[index]!);
    const text = (key: string) => {
      const at = yaml.findIndex(line => new RegExp(`^\\s{${indent + 2}}${key}:`).test(line));
      if (at < 0) return null;
      const inline = yaml[at]!.replace(new RegExp(`^\\s*${key}:\\s*`), "");
      if (!/^\|-?$/.test(inline)) return inline.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
      const continuation: string[] = [];
      for (const line of yaml.slice(at + 1)) {
        if (line.length - line.trimStart().length <= indent + 2 && line.trim()) break;
        continuation.push(line.trim());
      }
      return continuation.join("\n").trim();
    };
    // A parent test fails because a subtest failed; the subtest itself carries the cause.
    if (text("failureType") === "subtestsFailed") continue;
    const location = /^(.+):(\d+):(\d+)$/.exec(text("location") ?? "");
    const name = text("name"), error = text("error") ?? "Test failed without an error message.";
    const [first, ...rest] = error.split("\n");
    const comparison = rest.filter(Boolean).slice(0, 6).join("\n");
    failures.push({
      test: bounded(header[2]!, 200),
      location: location ? located(location[1]!, location[2]!, location[3], paths) : null,
      error: bounded(relativeOutput(name && !first!.startsWith(name) ? `${name}: ${first}` : first!, paths), 300),
      comparison: comparison ? bounded(relativeOutput(comparison, paths), 300) : null,
      expected: text("expected") && bounded(text("expected")!, 200), actual: text("actual") && bounded(text("actual")!, 200),
      operator: text("operator") && bounded(text("operator")!, 200),
      origin: originOf((text("stack") ?? "").split("\n").map(line => `    at ${line}`), paths),
    });
  }
  return failures;
}

function counts(output: string): CheckCounts | null {
  const found = new Map<string, number>();
  for (const match of output.matchAll(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gmu)) found.set(match[1]!, Number(match[2]));
  if (!found.has("tests")) return null;
  const value = (key: string) => found.get(key) ?? 0;
  return { tests: value("tests"), pass: value("pass"), fail: value("fail"), cancelled: value("cancelled"), skipped: value("skipped"), todo: value("todo") };
}

function typecheckErrors(output: string, paths: readonly string[]): TypecheckError[] {
  const errors: TypecheckError[] = [];
  for (const match of output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    const location = located(match[1]!, match[2]!, match[3], paths);
    if (location) errors.push({ ...location, code: match[4]!, message: bounded(relativeOutput(match[5]!.trim(), paths), 300) });
  }
  return errors;
}

function syntaxFailures(output: string, paths: readonly string[], inTests: ReadonlySet<string>): SyntaxFailure[] {
  const lines = output.split("\n");
  const failures: SyntaxFailure[] = [];
  lines.forEach((line, index) => {
    const syntax = /^(SyntaxError: .+)$/.exec(line.trim());
    if (!syntax || inTests.has(syntax[1]!)) return;
    let location: SourceLocation | null = null;
    for (const before of lines.slice(Math.max(0, index - 6), index).reverse()) {
      const at = /^((?:file:\/\/\/?)?.+?):(\d+)\s*$/.exec(before.trim());
      if (at && (location = located(at[1]!, at[2]!, undefined, paths))) break;
    }
    failures.push({ location, message: bounded(relativeOutput(syntax[1]!, paths), 300) });
  });
  return failures;
}

export function explainCheckRun(receipt: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }, paths: readonly string[]): CheckReport {
  const output = `${receipt.stdout}\n${receipt.stderr}`.replace(/\r\n?/g, "\n");
  const failures = specFailures(output, paths);
  const all = failures.length ? failures : tapFailures(output, paths);
  const tally = counts(output);
  const typecheck = typecheckErrors(output, paths).slice(0, MAX_TYPECHECK);
  const syntax = syntaxFailures(output, paths, new Set(all.map(failure => failure.error))).slice(0, MAX_SYNTAX);
  const status = receipt.timedOut ? "timed_out" : receipt.exitCode === 0 && !(tally?.fail) && !all.length ? "passed" : "failed";
  const unparsed = status === "failed" && !all.length && !typecheck.length && !syntax.length
    ? bounded(relativeOutput(output.trim().split("\n").slice(-12).join("\n"), paths), 900) || null : null;
  return { status, counts: tally, failures: all.slice(0, MAX_FAILURES), omittedFailures: Math.max(0, all.length - MAX_FAILURES), typecheck, syntax, unparsed };
}
