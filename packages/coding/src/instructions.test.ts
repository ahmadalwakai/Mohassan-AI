import { describe, expect, it } from "vitest";
import { matchesProjectInstructions, parseProjectInstructions } from "./instructions.ts";

describe("saved project instructions", () => {
  it("parses English headings, CRLF lines, and repository-relative globs", () => {
    const instructions = parseProjectInstructions([
      "# Project instructions", "## Do not edit", "- ./src/**/generated?.ts", "- src/[a-c].ts",
      "", "## Notes", "Keep the public API stable.", "", "- Prefer small diffs.",
    ].join("\r\n"));

    expect(instructions).toEqual({
      protectedGlobs: ["src/**/generated?.ts", "src/[a-c].ts"],
      notes: "Keep the public API stable.\n\n- Prefer small diffs.",
      warnings: [],
    });
    expect(matchesProjectInstructions("src/generated1.ts", instructions)).toBe(true);
    expect(matchesProjectInstructions("src/nested/generated2.ts", instructions)).toBe(true);
    expect(matchesProjectInstructions("src/b.ts", instructions)).toBe(true);
    expect(matchesProjectInstructions("src/d.ts", instructions)).toBe(false);
  });

  it("parses Arabic headings and keeps the notes as text", () => {
    const instructions = parseProjectInstructions("## لا تعدّل\n- src/حساب.ts\n## ملاحظات\nأبقِ واجهة الجمع كما هي.\n`node --test`\n");

    expect(instructions).toEqual({
      protectedGlobs: ["src/حساب.ts"],
      notes: "أبقِ واجهة الجمع كما هي.\n`node --test`",
      warnings: [],
    });
    expect(matchesProjectInstructions("src/حساب.ts", instructions)).toBe(true);
  });

  it("parses an empty file as empty instructions", () => {
    expect(parseProjectInstructions("")).toEqual({ protectedGlobs: [], notes: "", warnings: [] });
  });

  it("limits notes to 1500 characters and keeps parsing protection lines", () => {
    const prefix = "ن".repeat(1500);
    const instructions = parseProjectInstructions(`## Notes\n${prefix}text beyond the limit\n## Do not edit\n- src/generated.ts`);

    expect(instructions.notes).toBe(prefix);
    expect(instructions.protectedGlobs).toEqual(["src/generated.ts"]);
    expect(parseProjectInstructions(`## Notes\n${prefix.slice(1)}💡`).notes).toBe(prefix.slice(1));
  });

  it("ignores invalid and unsupported globs and reports a warning", () => {
    const instructions = parseProjectInstructions([
      "## Do not edit", "- ../outside.ts", "- /root.ts", "- src\\bad.ts", "- src/[abc.ts", "- src/[z-a].ts",
      "- src/{a,b}.ts", "- src/[!ab].ts", "- src/[!ab].ts",
    ].join("\n"));

    expect(instructions.protectedGlobs).toEqual(["src/[!ab].ts"]);
    expect(instructions.warnings).toEqual([expect.stringMatching(/\(6\).*السطر 2/)]);
    expect(matchesProjectInstructions("src/c.ts", instructions)).toBe(true);
    expect(matchesProjectInstructions("src/a.ts", instructions)).toBe(false);
  });

  it("bounds separated star groups while counting a recursive wildcard as one group", () => {
    const instructions = parseProjectInstructions("## Do not edit\n- **/src/*/generated*.ts\n- **/src/*/generated*-*.ts");

    expect(instructions.protectedGlobs).toEqual(["**/src/*/generated*.ts"]);
    expect(instructions.warnings).toEqual([expect.stringMatching(/السطر 3/)]);
    expect(matchesProjectInstructions("lib/src/util/generated-files.ts", instructions)).toBe(true);
  });
});
