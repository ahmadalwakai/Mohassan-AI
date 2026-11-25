import { describe, expect, it } from "vitest";
import { limits } from "./security.ts";
import { sandboxDiagnosticPaths, selectContextFiles } from "./selection.ts";

const source = (path: string, editable = false, content = "export {};\n") => ({ path, editable, content });

describe("selective coding context", () => {
  it("prioritizes editable files, diagnostics, goal paths and graph neighbors under the file cap", () => {
    const files = [
      source("zz/edit.ts", true), source("zz/check.test.ts"), source("zz/named.tsx"),
      source("zz/dependency.mjs"), source("zz/consumer.cjs"), source("zz/transitive.json"),
      ...Array.from({ length: limits.contextFiles }, (_, index) => source(`aa/unrelated-${index}.ts`)),
    ];
    const imports = new Map([
      ["zz/check.test.ts", new Set(["zz/dependency.mjs", "untracked.ts"])],
      ["zz/consumer.cjs", new Set(["zz/named.tsx"])],
      ["zz/dependency.mjs", new Set(["zz/transitive.json"])],
    ]);
    const selection = selectContextFiles(files, "أصلح zz/named.tsx.", ["zz/check.test.ts", "untracked.ts"], imports);
    expect(selection).toHaveLength(limits.contextFiles);
    expect(selection.slice(0, 6).map(({ path }) => path)).toEqual([
      "zz/edit.ts", "zz/check.test.ts", "zz/named.tsx", "zz/consumer.cjs", "zz/dependency.mjs", "zz/transitive.json",
    ]);
    expect(selectContextFiles([...files].reverse(), "أصلح zz/named.tsx.", ["zz/check.test.ts"], imports)).toEqual(selection);
  });

  it("retains editable snapshots under the byte limit", () => {
    const files = [source("src/a.ts", true, "x".repeat(limits.fileBytes)), source("src/b.ts", true, "y".repeat(limits.fileBytes)), source("tsconfig.json")];
    expect(selectContextFiles(files, "", [], new Map())).toEqual(files.slice(0, 2));
  });

  it("uses goal identifiers when paths do not name the requested code", () => {
    const files = [source("alpha.ts"), source("beta.ts", false, "export function invoiceTotal() { return 0; }")];
    expect(selectContextFiles(files, "أصلح invoiceTotal", [], new Map()).map(({ path }) => path)).toEqual(["beta.ts", "alpha.ts"]);
  });

  it("ranks only tracked locations printed in TypeScript and Node diagnostic formats", () => {
    const files = [source("src/check.ts"), source("check.ts"), source("test/أسماء.mjs"), source("irrelevant.ts")];
    const stdout = "src\\check.ts(8,2): error TS2304: Cannot find referenced name.\nexternal.ts(1,1): unsupported location";
    const stderr = "at test (file:///C:/sandbox/test/%D8%A3%D8%B3%D9%85%D8%A7%D8%A1.mjs:9:1)\nmention irrelevant.ts without a location";
    expect(sandboxDiagnosticPaths(files, { stdout, stderr })).toEqual(["src/check.ts", "test/أسماء.mjs"]);
  });
});
