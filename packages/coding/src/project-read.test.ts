import { describe, expect, it } from "vitest";
import { fileImports, importRelations, lookupImports, resolveProjectReference, searchProjectFiles } from "./project-read.ts";

const demo = [
  { path: "package.json", content: "{\n  \"name\": \"mohassan-coding-demo\",\n  \"type\": \"module\"\n}\n" },
  { path: "src/sum.ts", content: "export function sum(leftHandValue: number, rightHandValue: number) {\n  return leftHandValue + rightHandVaule;\n}\n" },
  { path: "test/sum.test.mjs", content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.ts';\n\ntest('adds positive values', () => assert.equal(sum(2, 3), 5));\ntest('adds negative values', () => assert.equal(sum(-3, 1), -2));\n" },
  { path: "README.md", content: "# Demo\n\nA summary: src/sum.ts has a misspelled identifier.\n" },
];

describe("project search", () => {
  it("finds an identifier as a whole word, case-insensitively, with its line", () => {
    const found = searchProjectFiles(demo, "sum");
    expect(found.wholeWord).toBe(true);
    expect(found.matches.map(({ path, line }) => `${path}:${line}`)).toEqual(["README.md:3", "src/sum.ts:1", "test/sum.test.mjs:3", "test/sum.test.mjs:5", "test/sum.test.mjs:6"]);
    expect(found.matches.some(({ text }) => text.includes("summary") && !/\bsum\b/.test(text))).toBe(false);
    expect(found.pathMatches).toEqual(["src/sum.ts", "test/sum.test.mjs"]);
    expect(searchProjectFiles(demo, "RIGHTHANDVAULE").matches).toEqual([{ path: "src/sum.ts", line: 2, text: "return leftHandValue + rightHandVaule;" }]);
    expect(searchProjectFiles(demo, "../src").matches).toEqual([{ path: "test/sum.test.mjs", line: 3, text: "import { sum } from '../src/sum.ts';" }]);
  });

  it("never quotes a credential-like line or reads a sensitive file, and caps what it shows", () => {
    const files = [
      { path: "src/config.ts", content: "export const token = 1;\nconst api_key = \"abcdefghijklmnop\";\n" },
      { path: ".env", content: "TOKEN=abcdefghijklmnop\n" },
      { path: "src/many.ts", content: Array.from({ length: 40 }, (_, index) => `const token${index} = token;`).join("\n") },
    ];
    expect(searchProjectFiles(files, "api_key")).toMatchObject({ total: 1, masked: 1, matches: [] });
    expect(searchProjectFiles(files, "TOKEN=").total).toBe(0);
    const many = searchProjectFiles(files, "token");
    expect(many.total).toBe(41);
    expect(many.matches).toHaveLength(30);
    expect(() => searchProjectFiles(demo, "  ")).toThrow(/عبارة البحث/);
    expect(() => searchProjectFiles(demo, "a\nb")).toThrow(/عبارة البحث/);
  });
});

describe("project imports", () => {
  it("lists what a file imports, resolving relative specifiers to tracked files", () => {
    const paths = new Set(demo.map(({ path }) => path));
    expect(fileImports(demo[2]!, paths)).toEqual([
      { specifier: "node:test", path: null }, { specifier: "node:assert/strict", path: null }, { specifier: "../src/sum.ts", path: "src/sum.ts" },
    ]);
    expect(importRelations(demo, "src/sum.ts")).toEqual({ target: "src/sum.ts", imports: [], importedBy: [{ path: "test/sum.test.mjs", specifier: "../src/sum.ts" }] });
  });

  it("resolves the specifiers Node and TypeScript accept, and never a path outside the project", () => {
    const files = [
      { path: "src/a.ts", content: "import { b } from './b.js';\nimport './lib';\nexport * from '../../outside';\nconst c = require('./c.cjs');\n" },
      { path: "src/b.ts", content: "export const b = 1;\n" },
      { path: "src/lib/index.ts", content: "export {};\n" },
      { path: "src/c.cjs", content: "module.exports = 1;\n" },
    ];
    expect(fileImports(files[0]!, new Set(files.map(({ path }) => path)))).toEqual([
      { specifier: "./b.js", path: "src/b.ts" }, { specifier: "./lib", path: "src/lib/index.ts" },
      { specifier: "../../outside", path: null }, { specifier: "./c.cjs", path: "src/c.cjs" },
    ]);
  });

  it("finds the file the owner named, or says it is unclear", () => {
    const paths = ["src/sum.ts", "test/sum.test.mjs", "lib/sum.ts", "README.md"];
    expect(resolveProjectReference("«src/sum.ts»؟", paths)).toEqual({ kind: "file", path: "src/sum.ts" });
    expect(resolveProjectReference("./test/sum.test.mjs", paths)).toEqual({ kind: "file", path: "test/sum.test.mjs" });
    expect(resolveProjectReference("sum.ts", paths)).toEqual({ kind: "ambiguous", paths: ["src/sum.ts", "lib/sum.ts"] });
    expect(resolveProjectReference("readme", paths)).toEqual({ kind: "file", path: "README.md" });
    expect(resolveProjectReference("missing.ts", paths)).toEqual({ kind: "none" });
    expect(lookupImports(demo, "sum.ts")).toMatchObject({ kind: "file", relations: { target: "src/sum.ts" } });
  });
});
