"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Chrome, CircleHelp, Link2, Square, Unplug } from "lucide-react";
import type { ChromeExtensionStatus, ChromeJob } from "@mohassan/contracts";
import styles from "./chrome-extension-panel.module.css";

const JOB_LABELS: Record<ChromeJob["status"], string> = {
  queued: "بانتظار الإضافة",
  running: "يملأ الحملة في Chrome",
  awaiting_review: "وصل إلى المراجعة — لم ينشر",
  needs_attention: "يحتاج مراجعتك",
  stopped: "توقفت المهمة",
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

/** The queue reports execution separately from the chat's preparation of campaign text. */
export function ChromeExtensionPanel() {
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
  const canResume = Boolean(job?.status === "needs_attention" && chromeChosen && status?.connected && status.binding
    && status.binding.clientId === job.clientId && status.binding.tabId === job.tabId
    && status.binding.customerId === job.customerId && status.binding.currency === job.currency);
  const connectionLabel = status ? status.connected ? "متصل" : chromeChosen ? "بانتظار الربط" : "غير متصل" : error ? "تعذر الاتصال" : "جارٍ التحقق";

  return <section className={styles.panel} aria-label="إضافة Chrome" onKeyDown={event => { if (event.key === "Escape") setExpanded(false); }}>
    <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      <Chrome size={17} aria-hidden="true" />
      <strong>Chrome</strong>
      <span className={status?.connected ? styles.connected : styles.muted}>{connectionLabel}</span>
      {job ? <span className={styles.jobSummary}>{JOB_LABELS[job.status]}</span> : <span className={styles.jobSummary}>إكمال حملة البحث في متصفحك</span>}
      <ChevronDown className={expanded ? styles.up : undefined} size={16} aria-hidden="true" />
    </button>
    <div className={styles.body} id={contentId} hidden={!expanded}>
      <div className={styles.mode} role="group" aria-label="طريقة إنشاء الحملات">
        <button type="button" aria-pressed={chromeChosen} disabled={busy || !status || active} onClick={() => void change("/preference", { transport: "chrome" })}><Chrome size={15} aria-hidden="true" />إضافة Chrome</button>
        <button type="button" aria-pressed={Boolean(status && !chromeChosen)} disabled={busy || !status || active} onClick={() => void change("/preference", { transport: "api" })}>الربط الرسمي</button>
      </div>
      <p className={styles.hint}>{chromeChosen ? "بعد إجاباتك في بطاقة الحملة، يرسل موحسن البيانات إلى التبويب المرتبط. تبقى خطوة النشر لك." : "اختر إضافة Chrome لتعبئة الحملة في متصفحك بعد الإجابة عن البطاقة."}</p>
      {status?.binding ? <p className={styles.account}><Link2 size={15} aria-hidden="true" />الحساب <bdi>{status.binding.customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}</bdi><span>·</span><bdi>{status.binding.currency}</bdi>{!status.connected ? <span>· الاتصال متوقف</span> : null}</p> : null}
      {job ? <div className={styles.job}>
        <p className={styles.jobTitle} role="status" aria-live="polite">{JOB_LABELS[job.status]}</p>
        <p dir="auto">{job.message}</p>
        <p className={styles.hint}>الحملة: <bdi>{job.campaign.campaignName}</bdi> · الحساب: <bdi>{job.customerId}</bdi></p>
        {job.steps.length ? <details><summary>الخطوات المنفذة ({job.steps.length})</summary><ol>{job.steps.map((step, index) => <li key={`${index}-${step.stage}`}><span dir="auto">{step.message}</span>{step.fields.length ? <small dir="auto">{step.fields.join(" · ")}</small> : null}</li>)}</ol></details> : null}
        {active ? <button type="button" className={styles.stop} disabled={busy} onClick={() => void change(`/jobs/${job.id}/cancel`, {})}><Square size={13} aria-hidden="true" />إيقاف التعبئة</button> : null}
        {job.status === "needs_attention" ? <>
          <p className={styles.hint}>راجع الصفحة الحالية في تبويب Google Ads أولاً؛ قد تكون بعض الحقول عُبئت قبل التوقف. أكمل الخطوة التي تحتاجك، ثم استأنف التعبئة من هنا.</p>
          {canResume ? <button type="button" className={styles.resume} disabled={busy} onClick={() => void change(`/jobs/${job.id}/resume`, { clientId: job.clientId })}>راجعت الخطوة، أكمل التعبئة</button> : <p className={styles.hint}>يلزم اتصال الإضافة بالتبويب والحساب المرتبطين بهذه المهمة حتى يمكن استئنافها.</p>}
        </> : null}
      </div> : null}
      <details className={styles.instructions} open={!status?.binding}>
        <summary><CircleHelp size={15} aria-hidden="true" />تثبيت الإضافة وربطها</summary>
        <ol>
          <li>افتح Chrome العادي على جهازك، ثم <code dir="ltr">chrome://extensions</code>.</li>
          <li>فعّل «وضع المطوّر»، واختر «تحميل إضافة غير مضغوطة»، ثم مجلد <code dir="ltr">packages/chrome-extension</code> من مشروع موحسن.</li>
          <li>افتح موحسن وسجّل الدخول في Chrome، ثم افتح الإضافة واضغط «استخدم هذا التبويب لموحسن».</li>
          <li>افتح Google Ads في تبويب آخر وسجّل الدخول بنفسك. اختر الحساب وافتح معالج حملة بحث جديدة. في الإضافة، أدخل رقم الحساب وعملته ثم اضغط «اربط هذا التبويب وابدأ الانتظار».</li>
          <li>أبقِ التبويبين مفتوحين، وعد إلى موحسن. ستظهر حالة الاتصال هنا.</li>
        </ol>
        <p className={styles.hint}>تتوقف الإضافة عند تسجيل الدخول أو النشر أو الفوترة أو خطوة غير معروفة. اكتمال التعبئة لا يعني أن الحملة نُشرت أو حُفظت في الحساب.</p>
      </details>
      <div className={styles.actions}>
        <button type="button" disabled={busy} onClick={() => void refresh()}>تحديث الحالة</button>
        {status?.binding ? <button type="button" disabled={busy || active} onClick={() => void change("/disconnect", { clientId: status.binding!.clientId })}><Unplug size={14} aria-hidden="true" />فصل الربط</button> : null}
      </div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}
