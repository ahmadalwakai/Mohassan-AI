"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Chrome, CircleHelp, Link2, Square, Unplug } from "lucide-react";
import type { ChromeExtensionStatus, ChromeJob } from "@mohassan/contracts";
import styles from "./chrome-extension-panel.module.css";

const JOB_LABELS: Record<ChromeJob["status"], string> = {
  queued: "سجل سابق: مهمة معلقة",
  running: "سجل سابق: تنفيذ غير محسوم",
  awaiting_review: "سجل سابق: وصل إلى المراجعة",
  needs_attention: "سجل سابق: يحتاج مراجعتك",
  stopped: "سجل سابق: توقفت المهمة",
};

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/chrome-extension${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message ?? "تعذر الاتصال بإضافة Chrome. حاول التحديث.");
  return value as T;
}

/** Connection metadata and historical extension reports do not prove saved Google Ads state. */
/**
 * `relevant`: the open conversation is about Google Ads. Elsewhere the bar stays hidden unless a Chrome job is
 * running or needs the owner, so a general chat is not crowded by a campaign tool.
 */
export function ChromeExtensionPanel({ relevant = true }: { relevant?: boolean } = {}) {
  const [status, setStatus] = useState<ChromeExtensionStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const contentId = useId();
  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const mutating = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (pending.current || mutating.current) return;
    pending.current = true;
    const version = ++requestVersion.current;
    try {
      const next = await request<ChromeExtensionStatus>("/status", undefined, signal);
      if (mounted.current && version === requestVersion.current) { setStatus(next); setError(""); }
    } catch (problem) {
      if (mounted.current && !signal?.aborted && version === requestVersion.current) setError(problem instanceof Error ? problem.message : "تعذر قراءة حالة Chrome.");
    } finally { pending.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const poll = () => { if (!document.hidden) void refresh(controller.signal); };
    const timer = window.setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => { mounted.current = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [refresh]);

  async function change(path: string, body: unknown) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError("");
    // A pre-change polling response must not overwrite the newer server state.
    ++requestVersion.current;
    try {
      await request(path, body);
      const next = await request<ChromeExtensionStatus>("/status");
      if (mounted.current) setStatus(next);
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : "تعذر إتمام التغيير.");
    } finally { mutating.current = false; if (mounted.current) setBusy(false); }
  }

  const job = status?.latestJob;
  const active = job?.status === "queued" || job?.status === "running";
  const chromeChosen = status?.preferredTransport === "chrome";
  const connectionLabel = status ? status.connected ? "متصل" : chromeChosen ? "بانتظار الربط" : "غير متصل" : error ? "تعذر الاتصال" : "جارٍ التحقق";

  if (!relevant && !(active || job?.status === "needs_attention")) return null;

  return <section className={styles.panel} aria-label="إضافة Chrome" onKeyDown={event => { if (event.key === "Escape") setExpanded(false); }}>
    <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <Chrome size={17} aria-hidden="true" />
      <strong>Chrome</strong>
      <span className={status?.connected ? styles.connected : styles.muted}>{connectionLabel}</span>
      {job ? <span className={styles.jobSummary}>{JOB_LABELS[job.status]}</span> : <span className={styles.jobSummary}>حالة ربط التبويب فقط</span>}
      <ChevronDown className={expanded ? styles.up : undefined} size={16} aria-hidden="true" />
    </button>
    <div className={styles.body} id={contentId} hidden={!expanded}>
      <div className={styles.mode} role="group" aria-label="مسار الحملات المتاح">
        <button type="button" aria-pressed={Boolean(status && !chromeChosen)} disabled={busy || !status || active} onClick={() => void change("/preference", { transport: "api" })}>استخدام الربط الرسمي</button>
      </div>
      <p className={styles.hint}>تعبئة حملات Google Ads واستئنافها عبر الإضافة غير مدعومين. اطلب الحملة في المحادثة عبر الربط الرسمي أو افتح قسم Google Ads؛ الإنشاء المتوقف والتحقق من الحساب يتمان عبر API.</p>
      {status?.binding ? <p className={styles.account}><Link2 size={15} aria-hidden="true" />بيانات الربط المدخلة: <bdi>{status.binding.customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}</bdi><span>·</span><bdi>{status.binding.currency}</bdi>{!status.connected ? <span>· الاتصال متوقف</span> : null}</p> : null}
      {job ? <div className={styles.job}>
        <p className={styles.jobTitle} role="status" aria-live="polite">{JOB_LABELS[job.status]}</p>
        <p dir="auto">رسالة الإضافة المحفوظة: {job.message}</p>
        <p className={styles.hint}>هذا سجل سابق من الإضافة؛ لا يثبت حفظ حملة أو إعداداتها في حساب Google Ads.</p>
        <p className={styles.hint}>الحملة: <bdi>{job.campaign.campaignName}</bdi> · الحساب: <bdi>{job.customerId}</bdi></p>
        {job.steps.length ? <details><summary>سجل خطوات الإضافة ({job.steps.length})</summary><ol>{job.steps.map((step, index) => <li key={`${index}-${step.stage}`}><span dir="auto">{step.message}</span>{step.fields.length ? <small dir="auto">{step.fields.join(" · ")}</small> : null}</li>)}</ol></details> : null}
        {active ? <button type="button" className={styles.stop} disabled={busy} onClick={() => void change(`/jobs/${job.id}/cancel`, {})}><Square size={13} aria-hidden="true" />إيقاف المهمة السابقة</button> : null}
        {job.status === "needs_attention" ? <>
          <p className={styles.hint}>راجع أثر المهمة السابقة في حساب Google Ads قبل طلب جديد. استئناف التعبئة عبر الإضافة غير متاح.</p>
        </> : null}
      </div> : null}
      <details className={styles.instructions} open={!status?.binding}>
        <summary><CircleHelp size={15} aria-hidden="true" />تثبيت الإضافة وربطها</summary>
        <ol>
          <li>افتح Chrome العادي على جهازك، ثم <code dir="ltr">chrome://extensions</code>.</li>
          <li>فعّل «وضع المطوّر»، واختر «تحميل إضافة غير مضغوطة»، ثم مجلد <code dir="ltr">packages/chrome-extension</code> من مشروع موحسن.</li>
          <li>افتح موحسن وسجّل الدخول في Chrome، ثم افتح الإضافة واضغط «استخدم هذا التبويب لموحسن».</li>
          <li>لربط بيانات تبويب Google Ads، سجّل الدخول بنفسك واختر الحساب. القيم التي تدخلها في الإضافة بيانات ربط فقط، وليست قراءة موثقة من الحساب.</li>
          <li>أبقِ التبويبين مفتوحين، وعد إلى موحسن. ستظهر حالة الاتصال هنا.</li>
        </ol>
        <p className={styles.hint}>الاتصال أو حفظ بيانات الربط لا يمنح الإضافة صلاحية تعبئة حملة أو استئنافها. اربط Google Ads رسميًا لتنفيذ العمليات المدعومة والتحقق منها.</p>
      </details>
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => void refresh()}>تحديث الحالة</button>
        {status?.binding ? <button type="button" disabled={busy || active} onClick={() => void change("/disconnect", { clientId: status.binding!.clientId })}><Unplug size={14} aria-hidden="true" />فصل الربط</button> : null}
      </div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}
