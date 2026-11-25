import { describe, expect, it } from "vitest";
import { formatSourceFiles, inspectTypeScript, repairTypeScript, type RepairFile } from "./typescript-repair.ts";

const signal = new AbortController().signal;
const file = (path: string, content: string, editable = true): RepairFile => ({ path, content, editable });

describe("snapshot TypeScript tools", () => {
  it("resolves configured aliases with snapshot files and omits diagnostics outside the config", () => {
    const files = [
      file("tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }', false),
      file("src/math.ts", "export const offset = 2;"),
      file("src/answer.ts", 'import { offset } from "@/math";\nexport const answer = ofsfet + 40;'),
      file("test/unrelated.test.ts", "export const broken = notDeclared;", false),
    ];

    const analysis = inspectTypeScript(files);
    expect(analysis.diagnosticPaths).toEqual(["src/answer.ts"]);
    expect(analysis.imports.get("src/answer.ts")).toEqual(new Set(["src/math.ts"]));
  });

  it("uses the typecheck script's nested config in preference to the root config", () => {
    const files = [
      file("tsconfig.json", '{"include":["other"]}', false),
      file("config/typecheck.json", '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}},"files":["../src/answer.ts"]}', false),
      file("src/math.ts", "export const offset = 2;", false),
      file("src/answer.ts", 'import { offset } from "@/math";\nexport const answer = ofsfet + 40;'),
    ];
    const analysis = inspectTypeScript(files, signal, "config/typecheck.json");
    expect(analysis.diagnosticPaths).toEqual(["src/answer.ts"]);
    expect(analysis.imports.get("src/answer.ts")).toEqual(new Set(["src/math.ts"]));
    expect(repairTypeScript(files, signal, "config/typecheck.json").get("src/answer.ts")).toContain("offset + 40");
  });

  it("does not read extended configs from the host", () => {
    const files = [
      file("tsconfig.json", JSON.stringify({ extends: `${process.cwd()}/tsconfig.json` }), false),
      file("src/answer.ts", "export const answerValue = 42;\nexport const answer = answerVaule;"),
    ];

    expect(repairTypeScript(files, signal).size).toBe(0);
  });

  it("refuses a missing callee for which the compiler offers an import and a generated function", () => {
    const files = [
      file("src/answer.ts", "export const answer = readValue();"),
      file("src/values.mjs", "export function readValue() { return 42; }", false),
    ];

    expect(repairTypeScript(files, signal).size).toBe(0);
  });

  it("adds a uniquely offered import with its native Node TypeScript extension", () => {
    const files = [
      file("src/answer.ts", "export const answer = answerValue;"),
      file("src/values.ts", "export const answerValue = 42;", false),
    ];

    expect(repairTypeScript(files, signal)).toEqual(new Map([
      ["src/answer.ts", 'import { answerValue } from "./values.ts";\n\nexport const answer = answerValue;'],
    ]));
  });

  it("refuses a single proposed action when it introduces a new diagnostic despite reducing the total", () => {
    const files = [
      file("src/answer.ts", "export const answer: number = answerValue + answerValue;"),
      file("src/values.mjs", 'export const answerValue = "42";', false),
    ];

    expect(inspectTypeScript(files).diagnosticPaths).toEqual(["src/answer.ts"]);
    expect(repairTypeScript(files, signal).size).toBe(0);
  });

  it("leaves read-only diagnostics and JavaScript suppression suggestions alone", () => {
    const files = [
      file("src/read-only.ts", "const answerValue = 42;\nexport const answer = answerVaule;", false),
      file("src/answer.mjs", "// @ts-check\nconst answerValue = 42;\nexport const answer = answerVaule;"),
    ];

    expect(new Set(inspectTypeScript(files).diagnosticPaths)).toEqual(new Set(["src/read-only.ts", "src/answer.mjs"]));
    expect(repairTypeScript(files, signal).size).toBe(0);
  });

  it("formats editable JSX and JSON while preserving JSON number spelling and duplicate properties", () => {
    const json = '{"x":1.0e+4,"x":2,"y":[1,2]}';
    const files = [
      file("src/data.json", json),
      file("src/view.tsx", "export const view=()=> <p>x</p>;"),
      file("test/read-only.json", json, false),
    ];

    expect(formatSourceFiles(files, signal)).toEqual(new Map([
      ["src/data.json", '{ "x": 1.0e+4, "x": 2, "y": [1, 2] }'],
      ["src/view.tsx", "export const view = () => <p>x</p>;"],
    ]));
  });
});
