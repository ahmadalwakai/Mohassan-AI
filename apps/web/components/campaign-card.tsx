"use client";

import { useMemo, useState } from "react";
import { Badge, Spinner } from "@chakra-ui/react";
import { AlertTriangle, Ban, Check, ChevronDown, CircleDashed, CircleHelp, ShieldCheck, X } from "lucide-react";
import { reduceCampaignEvents, type CampaignEventStream, type CampaignProgress, type CampaignStepId, type CampaignStepStatus } from "@mohassan/contracts";
import styles from "./campaign-card.module.css";

const STEP_LABEL: Record<CampaignStepId, string> = {
  intent: "تحليل الطلب", draft: "إعداد مسودة الحملة", local_validation: "فحص النص محليًا", correction: "تصحيح ما فشل", landing_page: "فحص صفحة الهبوط",
  remote_validation: "فحص Google (دون إنشاء)", approval: "شروط الإنشاء", paused_creation: "إنشاء الحملة متوقفة", readback: "قراءة الحساب للتأكد", outcome: "النتيجة",
};
const STATUS_LABEL: Record<CampaignStepStatus, string> = { pending: "بانتظار", running: "قيد التنفيذ", passed: "تم", failed: "فشل", corrected: "صُحّح", waiting: "ينتظر", skipped: "لم يُنفذ", unknown: "غير محسوم", cancelled: "أُلغي" };
const OUTCOME: Record<CampaignProgress["status"], { text: string; tone: "ok" | "warn" | "bad" | "idle" | "live" }> = {
  running: { text: "قيد العمل", tone: "live" }, completed: { text: "اكتمل: حملة متوقفة مؤكدة من الحساب", tone: "ok" }, partial: { text: "نجاح جزئي: النص فُحص ولم يُكتب شيء في الحساب", tone: "warn" },
  failed: { text: "فشل", tone: "bad" }, cancelled: { text: "أُلغي", tone: "idle" }, reconciliation_required: { text: "يلزم تأكيد النتيجة من الحساب", tone: "warn" },
};
const AUTHORITY = { local: "فحص محلي", google_ads_api: "من Google Ads" } as const;
const SCOPE = { local_text: "نص الإعلان", landing_page: "صفحة الهبوط", draft_integrity: "سلامة العمليات", account: "الحساب", conversion_tracking: "تتبع التحويلات", google_validate_only: "فحص Google دون إنشاء", readback: "قراءة الحساب بعد الإنشاء" } as const;

function StepIcon({ status }: { status: CampaignStepStatus }) {
  if (status === "running") return <Spinner size="xs" aria-hidden="true" />;
  if (status === "passed" || status === "corrected") return <Check size={14} aria-hidden="true" />;
  if (status === "failed") return <X size={14} aria-hidden="true" />;
  if (status === "unknown") return <CircleHelp size={14} aria-hidden="true" />;
  if (status === "cancelled") return <Ban size={14} aria-hidden="true" />;
  return <CircleDashed size={14} aria-hidden="true" />;
}

/**
 * Draws a campaign task from its structured events only. Nothing here is
 * animated text or an estimate; a step appears when the server reported it.
 * Local checks and answers from Google Ads carry different labels on purpose.
 */
export function CampaignCard({ stream, running }: { stream: CampaignEventStream | null | undefined; running: boolean }) {
  const progress = useMemo(() => (stream?.events.length ? reduceCampaignEvents(stream.events) : null), [stream]);
  const [open, setOpen] = useState<string | null>(null);
  if (!progress) return running ? <section className={styles.card} aria-label="تقدم الحملة"><p className={styles.muted}><Spinner size="xs" aria-hidden="true" /> بانتظار أول خطوة من الحملة…</p></section> : null;
  const outcome = OUTCOME[progress.status];
  const toggle = (key: string) => setOpen(current => (current === key ? null : key));
  return <section className={styles.card} aria-label="تقدم الحملة" aria-busy={progress.status === "running"}>
    <header className={styles.head}>
      <h3>حملة Google Ads</h3>
      <Badge className={`${styles.badge} ${styles[outcome.tone]}`}>{outcome.text}</Badge>
    </header>
    <p className={styles.sr} role="status" aria-live="polite">{outcome.text}</p>
    <ol className={styles.steps}>
      {progress.steps.map(step => <li key={step.id} className={`${styles.step} ${styles[`s_${step.status}`]}`}>
        <span className={styles.icon}><StepIcon status={step.status} /></span>
        <span>{STEP_LABEL[step.id]}</span><span className={styles.state}>{STATUS_LABEL[step.status]}</span>
      </li>)}
    </ol>

    {progress.fields.length ? <details className={styles.block} open={progress.status === "running" || progress.issues.length > 0 || progress.fields.some(field => field.status === "invalid")}>
      <summary>العناوين والأوصاف ({progress.fields.length})</summary>
      <ul className={styles.fields}>
        {progress.fields.map(field => <li key={`${field.kind}${field.index}`} className={styles[`f_${field.status}`]}>
          <span dir="auto" className={styles.text}>{field.text}</span>
          <span className={styles.count} aria-label={`${field.length} من ${field.limit} حرفًا`}>{field.length}/{field.limit}</span>
          <span className={styles.fieldState}>{field.status === "valid" ? "سليم" : field.status === "corrected" ? "صُحّح" : "مخالف"}</span>
        </li>)}
      </ul>
      <p className={styles.muted}>{progress.keywords} كلمة مفتاحية و{progress.negativeKeywords} كلمة سلبية.</p>
    </details> : null}

    {progress.corrections.length ? <div className={styles.block}>
      <h4>التصحيحات</h4>
      {progress.corrections.map((change, index) => {
        const key = `c${index}`;
        return <div key={key} className={styles.item}>
          <button type="button" aria-expanded={open === key} onClick={() => toggle(key)}><span>{change.field}: {change.after === null ? "حُذف" : "صُحّح"}</span><ChevronDown size={14} aria-hidden="true" /></button>
          {open === key ? <dl className={styles.detail}>
            <dt>سبب الفشل (من الفاحص)</dt><dd dir="auto">{change.reason}</dd>
            <dt>قبل</dt><dd dir="auto">{change.before}</dd>
            <dt>بعد</dt><dd dir="auto">{change.after ?? "—"}</dd>
            <dt>من أجرى التصحيح</dt><dd>{change.basis === "model" ? "نموذج، ثم أعاد الفاحص فحصه" : "البرنامج"}</dd>
            <dt>التحقق</dt><dd>{change.verified ? "أقرّه الفاحص المستقل" : "لم يُقرّه الفاحص"}</dd>
          </dl> : null}
        </div>;
      })}
      {progress.correctionFailure ? <p className={styles.warn}>تعذر ردّ النموذج في إحدى المحاولات ({progress.correctionFailure}).</p> : null}
    </div> : null}

    {progress.issues.length ? <div className={styles.block} role="alert"><h4><AlertTriangle size={14} aria-hidden="true" /> ما زال مخالفًا</h4>
      <ul>{progress.issues.map((issue, index) => <li key={index} dir="auto">{AUTHORITY[issue.authority]}: {issue.message}</li>)}</ul></div> : null}

    {progress.verifications.length ? <div className={styles.block}>
      <h4><ShieldCheck size={14} aria-hidden="true" /> نتائج الفحص</h4>
      {progress.verifications.map(item => {
        const key = `v${item.scope}`;
        return <div key={key} className={styles.item}>
          <button type="button" aria-expanded={open === key} onClick={() => toggle(key)}>
            <span>{SCOPE[item.scope]} · <em>{AUTHORITY[item.authority]}</em> · {item.passed ? "نجح" : "فشل"}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          {open === key ? <ul className={styles.detail}>{item.checks.map(check => <li key={check.id} className={check.passed ? styles.pass : styles.fail}><strong>{check.passed ? "✓" : "✗"}</strong> <span dir="auto">{check.detail}</span></li>)}</ul> : null}
        </div>;
      })}
    </div> : null}

    {progress.approval ? <p className={progress.approval.satisfied ? styles.muted : styles.warn}>{progress.approval.satisfied ? "شروط الإنشاء مفتوحة." : "شروط الإنشاء مغلقة"}{progress.approval.gates.filter(gate => !gate.passed).map(gate => ` — ${gate.detail}`).join("")}</p> : null}

    {progress.operations.length ? <ul className={styles.ops}>{progress.operations.map(op => <li key={op.operation}>
      {op.operation === "validate_only" ? "فحص Google دون إنشاء" : op.operation === "create_paused" ? "إنشاء الحملة متوقفة" : "قراءة الحساب"}:{" "}
      {op.state === "started" ? "أُرسل ولم تُحسم نتيجته" : op.state === "confirmed_paused" ? "مؤكد من الحساب (متوقفة)" : op.state === "confirmed_absent" ? "مؤكد أنها لم تُنشأ" : op.state === "rejected" ? "رفضته Google ولم يُطبّق" : op.state === "mismatch" ? "لا يطابق المطلوب" : "يلزم تأكيد النتيجة"}
      {op.campaignResourceName ? <bdi dir="ltr" className={styles.code}> {op.campaignResourceName}</bdi> : null}
    </li>)}</ul> : null}

    {progress.outcome ? <p className={styles.ok}>{progress.outcome.outcome === "draft_checked" ? "فُحص نص الحملة فقط؛ لم يتغير شيء في حساب Google Ads." : "الحملة متوقفة ولا تصرف. التشغيل يحتاج موافقتك المنفصلة."}{progress.outcome.conversionTrackingProven === false ? " تتبع التحويلات لم يثبت بعد." : ""}</p> : null}
    {progress.error ? <div className={styles.block} role="alert"><p className={styles.fail}>{progress.error.message}</p><p>{progress.error.action}</p>{progress.error.retryAfterSeconds ? <p className={styles.muted}>أعد المحاولة بعد {progress.error.retryAfterSeconds} ثانية تقريبًا.</p> : null}</div> : null}
    {progress.cancelled ? <p className={styles.muted}>{progress.cancelled.reconciliationRequired ? "أُوقفت المهمة بعد إرسال طلب كتابة؛ راجع الحساب قبل أي طلب جديد." : "أُوقفت المهمة قبل أي كتابة في الحساب."}</p> : null}
  </section>;
}
