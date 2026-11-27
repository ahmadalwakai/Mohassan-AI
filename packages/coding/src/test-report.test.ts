import { describe, expect, it } from "vitest";
import { explainCheckRun, projectPathOf, relativeOutput } from "./test-report.ts";

// Real output of the repair demo's tests in the Windows AppContainer sandbox (Node 24, spec reporter), 2026-11-27.
// Only the user folder in the sandbox's temporary path was renamed.
const work = "file:///C:/Users/runner/AppData/Local/Temp/mohassan-sandbox-c1C0rp/work";
const referenceError = `

✖ adds positive values (0.6578ms)
✖ adds negative values (0.1019ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 54.9709

✖ failing tests:

test at test\\sum.test.mjs:5:1
✖ adds positive values (0.6578ms)
  ReferenceError: rightHandVaule is not defined
      at sum (${work}/src/sum.ts:2:26)
      at TestContext.<anonymous> (${work}/test/sum.test.mjs:5:49)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)

test at test\\sum.test.mjs:6:1
✖ adds negative values (0.1019ms)
  ReferenceError: rightHandVaule is not defined
      at sum (${work}/src/sum.ts:2:26)
      at TestContext.<anonymous> (${work}/test/sum.test.mjs:6:49)
      at Test.runInAsyncScope (node:async_hooks:227:14)
`;
// The original demo (sum returns a - b) in the same sandbox: a failed strict assertion.
const assertion = `
✖ adds positive values (1.2367ms)
ℹ tests 2
ℹ pass 0
ℹ fail 2

✖ failing tests:

test at test\\sum.test.mjs:5:1
✖ adds positive values (1.2367ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -1 !== 5

      at TestContext.<anonymous> (${work}/test/sum.test.mjs:5:43)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: -1,
    expected: 5,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test\\sum.test.mjs:6:1
✖ adds negative values (0.2038ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -4 !== -2

      at TestContext.<anonymous> (${work}/test/sum.test.mjs:6:43) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: -4,
    expected: -2,
    operator: 'strictEqual',
    diff: 'simple'
  }
`;
const paths = ["README.md", "package.json", "src/sum.ts", "test/sum.test.mjs"];
const run = (stdout: string, exitCode: number | null = 1, timedOut = false, stderr = "") => explainCheckRun({ stdout, stderr, exitCode, timedOut }, paths);

describe("check run explanation", () => {
  it("names each failing test, where it is declared, its error and the project frame that raised it", () => {
    const report = run(referenceError);
    expect(report.status).toBe("failed");
    expect(report.counts).toEqual({ tests: 2, pass: 0, fail: 2, cancelled: 0, skipped: 0, todo: 0 });
    expect(report.failures).toEqual([
      { test: "adds positive values", location: { path: "test/sum.test.mjs", line: 5, column: 1 }, error: "ReferenceError: rightHandVaule is not defined",
        comparison: null, expected: null, actual: null, operator: null, origin: { path: "src/sum.ts", line: 2, column: 26 } },
      { test: "adds negative values", location: { path: "test/sum.test.mjs", line: 6, column: 1 }, error: "ReferenceError: rightHandVaule is not defined",
        comparison: null, expected: null, actual: null, operator: null, origin: { path: "src/sum.ts", line: 2, column: 26 } },
    ]);
    expect(report.unparsed).toBeNull();
    expect(JSON.stringify(report)).not.toContain("mohassan-sandbox");
  });

  it("reports the failing test inside a suite, not the suite that failed because of it", () => {
    const nested = [
      "✖ failing tests:", "",
      "test at test\\cart.test.mjs:4:3", "✖ adds an item (0.4ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "  0 !== 1", "",
      `      at TestContext.<anonymous> (${work}/test/cart.test.mjs:5:12)`, "",
      "test at test\\cart.test.mjs:3:1", "✖ cart (1.1ms)", "  '1 subtest failed'", "",
    ].join("\n");
    const report = explainCheckRun({ stdout: nested, stderr: "", exitCode: 1, timedOut: false }, ["test/cart.test.mjs"]);
    expect(report.failures.map((failure) => `${failure.test}: ${failure.comparison}`)).toEqual(["adds an item: 0 !== 1"]);
  });

  it("reads a failed assertion's expected and actual values as the output printed them", () => {
    const [first, second] = run(assertion).failures;
    expect(first).toMatchObject({ error: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", comparison: "-1 !== 5",
      expected: "5", actual: "-1", operator: "strictEqual", origin: { path: "test/sum.test.mjs", line: 5, column: 43 } });
    expect(second).toMatchObject({ comparison: "-4 !== -2", expected: "-2", actual: "-4" });
  });

  it("passes only on exit 0 with no failure, and never calls a timed-out run passed", () => {
    const passing = "✔ adds positive values (0.5ms)\n✔ adds negative values (0.1ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n";
    expect(run(passing, 0)).toMatchObject({ status: "passed", counts: { tests: 2, pass: 2, fail: 0 }, failures: [] });
    expect(run(passing, 0, true).status).toBe("timed_out");
    expect(run(referenceError, 0).status).toBe("failed");
    expect(run("", null).status).toBe("failed");
  });

  it("reads TAP, the reporter of Node versions before 23 when the output is not a terminal", () => {
    const tap = [
      "TAP version 13",
      "# Subtest: adds positive values",
      "not ok 1 - adds positive values",
      "  ---",
      "  duration_ms: 0.61",
      "  location: 'C:\\\\Temp\\\\mohassan-sandbox-x\\\\work\\\\test\\\\sum.test.mjs:5:1'",
      "  failureType: 'testCodeFailure'",
      "  error: |-",
      "    Expected values to be strictly equal:",
      "    ",
      "    -1 !== 5",
      "    ",
      "  code: 'ERR_ASSERTION'",
      "  name: 'AssertionError'",
      "  expected: 5",
      "  actual: -1",
      "  operator: 'strictEqual'",
      "  stack: |-",
      `    TestContext.<anonymous> (${work}/test/sum.test.mjs:5:43)`,
      "    Test.runInAsyncScope (node:async_hooks:227:14)",
      "  ...",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1",
    ].join("\n");
    const report = run(tap);
    expect(report.counts).toMatchObject({ tests: 1, pass: 0, fail: 1 });
    expect(report.failures).toEqual([{ test: "adds positive values", location: { path: "test/sum.test.mjs", line: 5, column: 1 },
      error: "AssertionError: Expected values to be strictly equal:", comparison: "-1 !== 5", expected: "5", actual: "-1", operator: "strictEqual",
      origin: { path: "test/sum.test.mjs", line: 5, column: 43 } }]);
  });

  it("maps type check and syntax errors to project files, and shows the raw tail only when nothing could be read", () => {
    const tsc = "C:/Users/runner/AppData/Local/Temp/mohassan-sandbox-y/work/src/sum.ts(2,26): error TS2552: Cannot find name 'rightHandVaule'. Did you mean 'rightHandValue'?";
    expect(run(tsc).typecheck).toEqual([{ path: "src/sum.ts", line: 2, column: 26, code: "TS2552", message: "Cannot find name 'rightHandVaule'. Did you mean 'rightHandValue'?" }]);
    const syntax = `${work}/src/sum.ts:2\n  return a +;\n            ^\n\nSyntaxError: Unexpected token ';'\n    at compileSourceTextModule (node:internal/modules/esm/utils:340:16)`;
    expect(run("", 1, false, syntax).syntax).toEqual([{ location: { path: "src/sum.ts", line: 2, column: null }, message: "SyntaxError: Unexpected token ';'" }]);
    const unknown = run("Error: spawn failed in C:\\Users\\runner\\AppData\\Local\\Temp\\mohassan-sandbox-z\\work\\src\\sum.ts\nexit 9");
    expect(unknown.unparsed).toBe("Error: spawn failed in src/sum.ts\nexit 9");
    expect(run(referenceError).unparsed).toBeNull();
  });

  it("maps a location to the longest tracked path it ends with and hides other absolute paths", () => {
    expect(projectPathOf(`${work}/src/sum.ts`, ["sum.ts", "src/sum.ts"])).toBe("src/sum.ts");
    expect(projectPathOf("C:\\a\\work\\SRC\\Sum.ts", paths)).toBe("src/sum.ts");
    expect(projectPathOf("/elsewhere/other.ts", paths)).toBeNull();
    expect(relativeOutput("Cannot find module C:\\Users\\runner\\secret\\x.mjs imported from /tmp/work/test/sum.test.mjs", paths))
      .toBe("Cannot find module <path> imported from test/sum.test.mjs");
  });

  it("never repeats a credential a test printed", () => {
    const leaked = run(`${referenceError.replace("ReferenceError: rightHandVaule is not defined", "Error: api_key = \"sk-live-abcdefghijklmnopqrstuv\" rejected")}`);
    expect(leaked.failures[0]!.error).toBe("[hidden: looks like a password or key]");
    expect(JSON.stringify(leaked)).not.toContain("abcdefghijklmnop");
    const tail = run("connecting with password: \"hunter2hunter2\"\nexit 1");
    expect(tail.unparsed).toBe("[hidden: looks like a password or key]\nexit 1");
  });
});
