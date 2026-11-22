/**
 * The live line's words come from the server («يقرأ ويكيبيديا…»); the icon beside them follows the
 * kind of work those words name. Rules are tried in order, the first match wins, and anything else
 * is thinking. Nothing here invents a phase: the server reports only what it is doing.
 */
export type ActivityKind = "think" | "wait" | "memory" | "search" | "open" | "read" | "write" | "act";

const RULES: [ActivityKind, RegExp][] = [
  ["think", /يفهم|يفكر|يختار الخطوة|يرتب خطوته|يحسب|^حساب /u],
  ["wait", /مشغول|سأستأنف|ينتظر|انتظار|\bwait/iu],
  ["memory", /الذاكرة|يتذكر|المستندات المحفوظة|\bmemory/iu],
  ["search", /يبحث|بحث|\bsearch/iu],
  ["read", /يقرأ|قراءة|يستخرج|يفحص|فحص|\bread/iu],
  ["open", /يفتح|فتح|\bopen/iu],
  ["write", /يكتب|كتابة|الكتابة|يصوغ|يراجع|يحفظ|حفظ|ينشئ|إنشاء|يعدّ|إعداد|\b(?:writ|draft|sav)/iu],
  ["act", /ينقر|النقر|يضغط|الضغط|يمرّر|التمرير|ينفذ|تنفيذ|يرسل|إرسال|يسجّل الدخول|تسجيل الدخول|يدخل|إدخال|يختار|اختيار|يرجع|الرجوع|يحمّل|تحميل|يغيّر|تغيير|يبدأ|بدء|\b(?:click|press|type)/iu],
];

export function activityKind(text: string | null | undefined): ActivityKind {
  const value = (text ?? "").trim();
  for (const [kind, pattern] of RULES) if (pattern.test(value)) return kind;
  return "think";
}

/** Time since the request, shown only once it has lasted five seconds, so a quick answer never flashes a counter. */
export function elapsedLabel(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 5000) return null;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} ث` : `${Math.floor(seconds / 60)} د ${seconds % 60} ث`;
}
