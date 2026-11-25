import type { ChatConversation, ChatRunView, EvidenceKind, PlanStepState, RunPhase, StepAuthorization } from "@mohassan/contracts";

/**
 * Words for the run the server's runtime committed (docs/architecture/agent-execution.md). Everything shown comes from
 * `conversation.run`; the client never infers a phase, a verdict or a check of its own.
 */

/** Short stage labels for each phase the runtime records. */
export const STAGE_LABELS: Record<RunPhase, string> = {
  received: "استُلم الطلب", understanding: "فهم الطلب", selecting: "اختيار الأداة", planning: "وضع الخطة", answering: "صياغة الجواب",
  awaiting_input: "بانتظار ردك", awaiting_approval: "بانتظار موافقتك", executing: "التنفيذ", verifying: "التحقق من النتيجة",
  repairing: "تصحيح بعد فحص لم ينجح", completed: "اكتمل", partial: "اكتمل جزئيًا", blocked: "تعذّر الإكمال", cancelled: "أُلغي",
};

export type VerdictTone = "done" | "partial" | "blocked" | "cancelled";
/** The badge under a finished reply: the server's verdict, never a check mark of the client's own. */
export function verdictBadge(run: ChatRunView | null | undefined): { tone: VerdictTone; label: string; reason: string } | null {
  const verdict = run?.verdict;
  if (!verdict) return null;
  const tone: VerdictTone = verdict.status === "completed" ? "done" : verdict.status;
  return { tone, label: STAGE_LABELS[verdict.status], reason: VERDICT_REASONS[verdict.reason] ?? "" };
}

const VERDICT_REASONS: Record<string, string> = {
  answered: "أُجيب مباشرة دون أدوات خارجية.",
  criteria_met: "تحققت شروط الخطوات المطلوبة.",
  partial_result: "أُنجز جزء من المطلوب فقط.",
  not_possible: "لم يمكن إنجاز المطلوب بالقدرات المتاحة الآن.",
  step_failed: "فشلت خطوة مطلوبة.",
  step_unverified: "لم تُحسم نتيجة خطوة مطلوبة.",
  steps_outstanding: "بقيت خطوات مطلوبة لم تُنفَّذ.",
  criteria_unmet: "لم تتحقق شروط المهمة المعلنة.",
  owner_refused: "رفضتَ إجراءً مطلوبًا فلم يُنفَّذ.",
  owner_cancelled: "أوقفتَ المهمة.",
  superseded: "صحّحتَ الطلب أثناء العمل، فاستُبدلت المهمة.",
  error: "توقف العمل بخطأ.",
  interrupted: "انقطع العمل قبل إكماله.",
  recorded: "",
  unknown_status: "",
};

/** Whether a language model took part: only the server's count of model calls that returned a valid result decides it. */
export function engineLabel(run: ChatRunView): string {
  return run.engine.kind === "model"
    ? `شارك نموذج لغوي (${run.engine.modelCalls} ${run.engine.modelCalls === 1 ? "استدعاء ناجح" : "استدعاءات ناجحة"}).`
    : "دون نموذج لغوي: خطوات هذا الطلب قررتها قواعد محددة في الخادم.";
}

export const STEP_STATE_LABELS: Record<PlanStepState, string> = {
  pending: "لم تبدأ", running: "تعمل الآن", awaiting_approval: "بانتظار موافقتك", verified: "تحققت", failed: "لم تنجح",
  unknown: "نتيجتها غير محسومة", skipped: "لم تُنفَّذ", invalidated: "أُلغيت",
};
export const AUTHORIZATION_LABELS: Record<StepAuthorization, string> = {
  not_needed: "", required: "تحتاج موافقتك", granted: "وافقتَ عليها", refused: "رفضتَها", invalidated: "سقطت موافقتها",
};
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  observation: "رصد مباشر", computation: "حساب", readback: "قراءة راجعة", source: "مصدر مقروء",
  user_statement: "قولك", adapter_report: "تقرير الأداة", model_output: "نص النموذج",
};
export const PERMISSION_LABELS: Record<ChatRunView["permissions"][number]["decision"], string> = {
  asked: "طُلبت موافقتك", granted: "وافقتَ", refused: "رفضتَ", consumed: "نُفّذ مرة واحدة", invalidated: "سقطت", expired: "انتهت صلاحيتها",
};

/** Only an http(s) reference becomes a link; anything else (a receipt, a file id) is shown as text. */
export const linkable = (reference: string | null): reference is string => Boolean(reference && /^https?:\/\//iu.test(reference));

/**
 * Whether a snapshot from the server may replace the one shown. A slow poll answered after a newer action result must
 * not move the view back: for the same conversation, a snapshot older than the current one is ignored.
 */
export function isNewerSnapshot(current: ChatConversation | null, next: ChatConversation): boolean {
  if (!current || current.id !== next.id) return true;
  const currentRun = current.run, nextRun = next.run;
  if (currentRun && nextRun && currentRun.id === nextRun.id && nextRun.sequence < currentRun.sequence) return false;
  if (currentRun && nextRun && currentRun.id !== nextRun.id && Date.parse(nextRun.updatedAt) < Date.parse(currentRun.updatedAt)) return false;
  if (currentRun && !nextRun) return false;
  return Date.parse(next.updatedAt) >= Date.parse(current.updatedAt) || Boolean(nextRun && currentRun && nextRun.id === currentRun.id && nextRun.sequence > currentRun.sequence);
}

/**
 * A message sent while a task works, or waits for approval or for the owner's hands on a page, corrects that task on the
 * server. A sign-in or code card is never steered from the composer: its values belong in its own fields.
 */
export const steerable = (status: ChatConversation["status"] | undefined, secureKind?: string | null) =>
  status === "running" || status === "waiting_approval" || status === "waiting_input" && secureKind === "hands_on";

/** A disconnected progress reader retries reads only; it never replays a submission. */
export function progressRetryDelay(failures: number, hidden: boolean): number {
  return hidden ? 15_000 : Math.min(8_000, 450 * 2 ** Math.min(5, Math.max(0, failures)));
}

/** Required steps still need evidence unless the server explicitly marked them verified. */
export function runStepSummary(run: ChatRunView) {
  const required = run.plan?.steps.filter(step => step.required) ?? [];
  return { verified: required.filter(step => step.state === "verified"), remaining: required.filter(step => step.state !== "verified") };
}

/** Invalid dates stay visibly unavailable instead of appearing to be fresh evidence. */
export function observedTime(value: string): string {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" }) : "وقت الرصد غير متاح";
}
