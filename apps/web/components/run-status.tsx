import { useId, useState } from "react";
import { Ban, CircleAlert, CircleCheck, CircleDashed, ChevronDown, ExternalLink } from "lucide-react";
import type { ChatRunView } from "@mohassan/contracts";
import { AUTHORIZATION_LABELS, EVIDENCE_LABELS, PERMISSION_LABELS, STAGE_LABELS, STEP_STATE_LABELS, engineLabel, linkable, verdictBadge, type VerdictTone } from "./run-view";
import styles from "./run-status.module.css";

const TONE_ICON: Record<VerdictTone, typeof CircleCheck> = { done: CircleCheck, partial: CircleDashed, blocked: CircleAlert, cancelled: Ban };

/** The server's verdict on the finished run, in place of a check mark the client would otherwise draw for every run. */
export function RunVerdict({ run }: { run: ChatRunView | null | undefined }) {
  const badge = verdictBadge(run);
  if (!badge) return null;
  const Icon = TONE_ICON[badge.tone];
  return <span className={`${styles.verdict} ${styles[badge.tone]}`} title={badge.reason || undefined} data-testid="run-verdict" data-verdict={run?.verdict?.status}>
    <Icon size={14} aria-hidden="true" /><span>{badge.label}</span>
  </span>;
}

/**
 * What the runtime recorded for this run, on request: the stage, who decided the steps (rules or a model), the
 * understood objective and corrections, the plan with each step's check, the evidence and the permission decisions.
 * Never the model's private reasoning; nothing here is inferred by the client.
 */
export function RunDetails({ run }: { run: ChatRunView }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const badge = verdictBadge(run);
  return <div className={styles.details}>
    <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)} data-testid="run-details-toggle">
      <span>تفاصيل التنفيذ</span><ChevronDown size={14} className={open ? styles.flipped : ""} aria-hidden="true" />
    </button>
    {open ? <div id={panel} className={styles.panel} data-testid="run-details">
      <p className={styles.line}><strong>المرحلة:</strong> {STAGE_LABELS[run.phase]}{badge?.reason ? ` — ${badge.reason}` : ""}</p>
      <p className={styles.line} data-testid="run-engine">{engineLabel(run)}</p>
      {run.path ? <p className={styles.line}><strong>المسار:</strong> {run.path === "direct" ? "جواب مباشر دون أدوات خارجية" : "بحث أو تنفيذ بأدوات"}</p> : null}
      {run.context?.corrections.length ? <p className={styles.line}><strong>صحّحتَ:</strong> <bdi>{run.context.corrections.join("، ")}</bdi></p> : null}
      {run.context?.constraints.length ? <p className={styles.line}><strong>ممنوع في طلبك:</strong> <bdi dir="ltr">{run.context.constraints.join(", ")}</bdi></p> : null}
      {run.plan ? <section aria-label="الخطة">
        <h3 className={styles.heading}>الخطة</h3>
        <ol className={styles.list}>
          {run.plan.steps.map(step => <li key={step.id} className={styles.item}>
            <span className={`${styles.state} ${styles[step.state]}`}>{STEP_STATE_LABELS[step.state]}</span>
            <span dir="auto" className={styles.outcome}>{step.outcome}{step.required ? "" : " (للاطلاع)"}</span>
            {AUTHORIZATION_LABELS[step.authorization] ? <span className={styles.note}>{AUTHORIZATION_LABELS[step.authorization]}</span> : null}
            {step.verification === "adapter_report" ? <span className={styles.note}>التحقق: تقرير الأداة نفسها، دون فحص مستقل</span> : null}
          </li>)}
        </ol>
      </section> : null}
      {run.evidence.length ? <section aria-label="الأدلة">
        <h3 className={styles.heading}>الأدلة</h3>
        <ul className={styles.list}>
          {run.evidence.map(item => <li key={item.id} className={styles.item}>
            <span className={`${styles.kind} ${item.independent ? styles.independent : ""}`}>{EVIDENCE_LABELS[item.kind]}{item.independent ? "" : " · غير مستقل"}</span>
            {linkable(item.reference)
              ? <a dir="auto" className={styles.outcome} href={item.reference} target="_blank" rel="noopener noreferrer">{item.label}<ExternalLink size={12} aria-hidden="true" /></a>
              : <span dir="auto" className={styles.outcome}>{item.label}</span>}
          </li>)}
        </ul>
      </section> : <p className={styles.line}>لا أدلة مسجلة لهذا الطلب.</p>}
      {run.verification?.criteria.length ? <section aria-label="الشروط">
        <h3 className={styles.heading}>الشروط</h3>
        <ul className={styles.list}>
          {run.verification.criteria.map(item => <li key={item.id} className={styles.item}>
            <span className={`${styles.state} ${styles[item.status === "verified" ? "verified" : item.status === "failed" ? "failed" : "unknown"]}`}>{item.status === "verified" ? "تحقق" : item.status === "failed" ? "لم يتحقق" : item.status === "expired" ? "انتهت صلاحيته" : "غير مثبت"}</span>
            <span dir="auto" className={styles.outcome}>{item.label}{item.required ? "" : " (اختياري)"}</span>
          </li>)}
        </ul>
      </section> : null}
      {run.permissions.length ? <section aria-label="الموافقات">
        <h3 className={styles.heading}>الموافقات</h3>
        <ul className={styles.list}>
          {run.permissions.map(item => <li key={item.id} className={styles.item}>
            <span className={styles.kind}>{PERMISSION_LABELS[item.decision]}</span>
            <span dir="auto" className={styles.outcome}>{item.action} — <bdi>{item.target}</bdi></span>
          </li>)}
        </ul>
      </section> : null}
      {run.repairs.used ? <p className={styles.line}>تصحيحات: {run.repairs.used} من {run.repairs.limit}</p> : null}
    </div> : null}
  </div>;
}
