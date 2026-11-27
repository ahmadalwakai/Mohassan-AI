import { posix } from "node:path";
import { safeRelative } from "./security.ts";

export const PROJECT_INSTRUCTIONS_PATH = ".mohassan/instructions.md";
const MAX_NOTES_LENGTH = 1_500;
const MAX_STAR_GROUPS = 3;

export interface ProjectInstructions {
  protectedGlobs: string[];
  notes: string;
  warnings: string[];
}

const headings = new Map<string, "globs" | "notes">([
  ["## Do not edit", "globs"], ["## لا تعدّل", "globs"],
  ["## Notes", "notes"], ["## ملاحظات", "notes"],
]);

function validGlob(pattern: string): boolean {
  // Separated runs of stars can multiply the glob matcher's backtracking.
  if ((pattern.match(/\*+/g)?.length ?? 0) > MAX_STAR_GROUPS) return false;
  // Validate repository-relative paths without treating glob operators as path characters.
  const path = pattern.replace(/\[[!^]?[\p{L}\p{N}._-]+\]/gu, (characterClass) => {
    try { new RegExp(characterClass.replace(/^\[!/, "[^"), "u"); }
    catch { return characterClass; }
    return "x".repeat(characterClass.length);
  }).replace(/[*?]/g, "x");
  try { safeRelative(path); }
  catch { return false; }
  return true;
}

/** Parses text from the inspected, size-limited Git snapshot. */
export function parseProjectInstructions(content: string): ProjectInstructions {
  const protectedGlobs = new Set<string>();
  const notes: string[] = [];
  let section: "globs" | "notes" | undefined;
  let invalidGlobs = 0;
  let firstInvalidLine: number | undefined;

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/^##(?:[ \t]|$)/.test(line)) {
      section = headings.get(line.trimEnd());
    } else if (section === "notes") {
      notes.push(line);
    } else if (section === "globs") {
      const bullet = /^\s*-[ \t]+(.*)$/.exec(line);
      if (!bullet) continue;
      const pattern = bullet[1]!.trim().replace(/^\.\//, "");
      if (validGlob(pattern)) protectedGlobs.add(pattern);
      else {
        invalidGlobs++;
        firstInvalidLine ??= index + 1;
      }
    }
  }

  return {
    protectedGlobs: [...protectedGlobs],
    notes: notes.join("\n").trim().slice(0, MAX_NOTES_LENGTH).replace(/[\uD800-\uDBFF]$/, ""),
    warnings: firstInvalidLine === undefined ? [] : [
      `تم تجاهل أنماط حماية غير صالحة (${invalidGlobs}). أولها في السطر ${firstInvalidLine}.`,
    ],
  };
}

export function matchesProjectInstructions(path: string, instructions: ProjectInstructions): boolean {
  return instructions.protectedGlobs.some((pattern) => posix.matchesGlob(path, pattern));
}
