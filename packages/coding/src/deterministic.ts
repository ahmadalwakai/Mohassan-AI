import type { CodingContextFile, EditGenerator } from "./edit-generator.ts";
import { credentialLike, limits, sha256 } from "./security.ts";
import { formatSourceFiles } from "./typescript-repair.ts";

const noProvenFix = "لم تجد الأدوات إصلاحًا يمكن إثباته ضمن الملفات المسموح بها. تحتاج أخطاء المنطق غير المشخّصة إلى تعديل يدوي.";
export const deterministicCodingMessage = "محرك البرمجة يعمل دون نموذج. يصلح تشخيصات TypeScript ذات الإصلاح المؤكد ومشكلات ESLint القابلة للإصلاح، وينسّق الملفات عند الطلب. يرفض تغييرات المنطق التي لا تستطيع الأدوات إثباتها.";

function requestsFormatting(goal: string): boolean {
  const normalized = goal.normalize("NFKC").replace(/\p{M}/gu, "");
  const englishExclusion = /\b(?:no|without|avoid|never|skip|do not|don't)\s+(?:(?:change|touch|any)\s+)?(?:re)?format(?:ting)?\b/i;
  const arabicExclusion = /(?:دون|بدون|بلا|لا)\s+(?:(?:تغيير|تعديل|أريد)\s+)?(?:تنسيق|تنسق)/u;
  if (englishExclusion.test(normalized) || arabicExclusion.test(normalized)) return false;
  const englishRequest = /(?:^|[.!?;]\s+|\n|\b(?:and|also|please)\s+)\s*(?:please\s+)?(?:reformat|format|fix\s+(?:the\s+)?formatting)(?=\s|[.!?]?$)/i;
  const arabicRequest = /(?:^|[.!؟؛]\s+|\n|\sو|رجاء\s+)\s*(?:نسق|[أا]عد\s+تنسيق|[أا]صلح\s+التنسيق)(?=\s|[.!؟]?$)|^\s*تنسيق(?=\s|$)/u;
  return englishRequest.test(normalized) || arabicRequest.test(normalized);
}

function formattingTargets(files: CodingContextFile[], goal: string): CodingContextFile[] {
  const paths = goal.match(/[\p{L}\p{N}._/-]+\.(?:tsx?|[cm]?js|json)(?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}])/giu) ?? [];
  const mentioned = new Set(paths.map((path) => path.replace(/^\.\//, "")));
  if (!mentioned.size) return files;
  return files.map((file) => ({
    ...file,
    editable: file.editable && (mentioned.has(file.path) || mentioned.has(file.path.split("/").at(-1)!)),
  }));
}

export const generateDeterministicEdits: EditGenerator = Object.assign(async (context: Parameters<EditGenerator>[0]) => {
  const { files, goal, signal, tools } = context;
  signal.throwIfAborted();
  const formatting = requestsFormatting(goal);
  const formattingFiles = formatting ? formattingTargets(files, goal) : files;
  const proposed = tools?.repairTypeScript() ?? new Map<string, string>();
  const used: string[] = [];
  if (proposed.size) used.push("TypeScript");
  if (formatting) {
    const current = formattingFiles.map((file) => ({ ...file, content: proposed.get(file.path) ?? file.content }));
    const formatted = formatSourceFiles(current, signal);
    if (formatted.size) used.push("التنسيق المطلوب");
    for (const [path, content] of formatted) proposed.set(path, content);
  }
  if (tools?.fixESLint) {
    const paths = formattingFiles.filter((file) => file.editable && /\.[cm]?js$/i.test(file.path)).map((file) => file.path);
    if (paths.length) {
      const fixes = await tools.fixESLint(paths, proposed, formatting);
      if (fixes.length) used.push("ESLint");
      for (const fix of fixes) proposed.set(fix.path, fix.content);
    }
  }
  const edits = files.flatMap((file) => {
    const content = proposed.get(file.path);
    return file.editable && content !== undefined && sha256(content) !== file.hash
      ? [{ path: file.path, expectedHash: file.hash, content }] : [];
  });
  if (!edits.length || edits.some(({ content }) => content.includes("\0") || credentialLike(content))
    || edits.reduce((bytes, edit) => bytes + Buffer.byteLength(edit.content), 0) > limits.editsBytes) {
    return { kind: "refused" as const, code: "NO_PROVEN_FIX" as const, reason: noProvenFix };
  }
  return { summary: `اقتُرح تعديل مثبت بالأدوات التالية: ${used.join("، ")}.`, edits };
}, { mode: "deterministic" as const });
