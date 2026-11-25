"use client";

import { Activity, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MonitorCard, MonitorSpec } from "@mohassan/contracts";
import { changeMonitor, followMonitorChanges, listMonitors, mergeMonitors, type MonitorAction } from "./monitors-client";
import styles from "./smart-monitors.module.css";
import { MonitorCardAlertFeedback } from "../lib/monitor-feedback/alert-feedback";

const copy = {
  ar: {
    proposed: "بانتظار الموافقة", active: "نشطة", paused: "متوقفة مؤقتًا", stopped: "متوقفة",
    completed: "تحقّق الشرط", expired: "انتهت المدة", explicit: "خطة المراقبة", implicit: "عرض مراقبة",
    "agent-initiated": "عرض مراقبة لمتابعة المهمة", current: "القيمة الحالية", unavailable: "القراءة غير متاحة",
    last: "آخر فحص", next: "الفحص التالي", interval: "الفاصل الأول", duration: "المدة",
    deadline: "الموعد النهائي", approve: "بدء المراقبة", decline: "ليس الآن", pause: "إيقاف مؤقت",
    resume: "استئناف", stop: "إيقاف المراقبة", present: "موجود", absent: "غير موجود",
    backgroundRun: "مهمة في الخلفية", open: "فتح المحادثة", saving: "جارٍ الحفظ…",
    failure: "تعذّر تحديث المراقبة. حاول مجددًا.", listFailure: "تعذّر تحميل المراقبات. حاول مجددًا.",
  },
  en: {
    proposed: "Awaiting approval", active: "Active", paused: "Paused", stopped: "Stopped",
    completed: "Condition met", expired: "Expired", explicit: "Monitoring plan", implicit: "Monitoring offer",
    "agent-initiated": "Monitoring offer to follow up on your task", current: "Current value", unavailable: "Reading unavailable",
    last: "Last check", next: "Next check", interval: "Initial interval", duration: "Duration",
    deadline: "Deadline", approve: "Start monitoring", decline: "Not now", pause: "Pause",
    resume: "Resume", stop: "Stop monitoring", present: "Present", absent: "Absent",
    backgroundRun: "Background run", open: "Open conversation", saving: "Saving…",
    failure: "Could not update the monitor. Try again.", listFailure: "Could not load the monitors. Try again.",
  },
};

type Language = keyof typeof copy;

function Time({ value, language }: { value: string | null; language: Language }) {
  return value ? <time dateTime={value}>{new Intl.DateTimeFormat(language, {
    dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value))}</time> : <>—</>;
}

function intervalLabel(ms: number, language: Language): string {
  const minutes = ms / 60_000;
  const unit = minutes < 60 ? "minute" : minutes < 1_440 ? "hour" : "day";
  const divisor = unit === "day" ? 1_440 : unit === "hour" ? 60 : 1;
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(minutes / divisor);
}

function sourceLabel(source: MonitorSpec["source"], language: Language): string {
  switch (source.kind) {
    case "page": return source.anchor ? `${source.url} · ${source.anchor}` : source.url;
    case "currency": return `${source.base}/${source.quote}`;
    case "weather": return source.location;
    case "search": return source.query;
    case "run": return copy[language].backgroundRun;
  }
}

function conditionLabel({ condition, language, read, source, title }: MonitorSpec): string {
  const ar = language === "ar";
  switch (condition.kind) {
    case "change": return ar ? "سأنبّهك عند تغيّر القراءة." : "I’ll notify you when the reading changes.";
    case "equals": return ar ? `سأنبّهك عندما تصبح القراءة «${condition.value}».` : `I’ll notify you when the reading is “${condition.value}”.`;
    case "contains": return ar ? `سأنبّهك عندما تتضمّن القراءة «${condition.value}».` : `I’ll notify you when the reading includes “${condition.value}”.`;
    case "appears":
    case "disappears": {
      const target = read.kind === "phrase" ? read.phrase : title;
      const appears = condition.kind === "appears";
      return ar ? `سأنبّهك عند ${appears ? "ظهور" : "اختفاء"} «${target}».` : `I’ll notify you when “${target}” ${appears ? "appears" : "disappears"}.`;
    }
    case "threshold":
    case "crossing": {
      const below = condition.direction === "below";
      const crosses = condition.kind === "crossing";
      const number = source.kind === "currency" && Number(condition.value.toFixed(2)) === condition.value
        ? condition.value.toFixed(2) : String(condition.value);
      if (ar) return `سأنبّهك عندما ${crosses ? "تنتقل" : "تصبح"} القراءة ${below ? "دون" : "فوق"} ${number}.`;
      return `I’ll notify you when the reading ${crosses ? "crosses" : "is"} ${below ? "below" : "above"} ${number}.`;
    }
    case "percent": {
      const direction = condition.direction;
      if (ar) return `سأنبّهك عندما ${direction === "above" ? "ترتفع" : direction === "below" ? "تنخفض" : "تتغيّر"} القراءة بنسبة ${condition.value}٪ على الأقل.`;
      return `I’ll notify you when the reading ${direction === "above" ? "rises" : direction === "below" ? "falls" : "changes"} by at least ${condition.value}%.`;
    }
    case "new-item": return ar ? "سأنبّهك عند ظهور عنصر جديد." : "I’ll notify you when a new item appears.";
  }
}

function currentValue(current: MonitorCard["current"], language: Language): string {
  const text = copy[language];
  if (!current) return text.unavailable;
  const { value } = current;
  if (typeof value === "boolean") return value ? text.present : text.absent;
  const reading = Array.isArray(value)
    ? value.length ? new Intl.ListFormat(language).format(value.slice(0, 3)) : text.absent
    : String(value);
  return compactText(reading, Array.isArray(value) && value.length > 3);
}

function compactText(value: string, hasMore = false): string {
  const limit = 240;
  return value.length > limit || hasMore ? `${value.slice(0, limit).trimEnd()}…` : value;
}

export function SmartMonitorCard({ monitor, onOpenConversation, onStopped }: {
  monitor: MonitorCard;
  onOpenConversation?: (id: string) => void;
  onStopped?: () => void;
}) {
  const title = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { language, source, timing } = monitor.spec;
  const text = copy[language];
  const proposed = monitor.status === "proposed";
  const canManage = monitor.status === "active" || monitor.status === "paused";
  const value = currentValue(monitor.current, language);
  const sourceText = sourceLabel(source, language);
  const heading = proposed ? text[monitor.offer ?? "explicit"] : monitor.spec.title;

  async function run(action: MonitorAction) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const updated = await changeMonitor(monitor.id, action, text.failure);
      if (updated.status === "stopped") onStopped?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : text.failure);
    } finally {
      setPending(false);
    }
  }

  return <section className={styles.card} aria-labelledby={title} aria-busy={pending} data-testid={proposed ? "monitor-approval" : "monitor-card"} lang={language} dir={language === "ar" ? "rtl" : "ltr"}>
    <div className={styles.heading}>
      <strong id={title} dir="auto">{heading}</strong>
      <span className={styles.status}>{text[monitor.status]}</span>
    </div>
    {proposed ? <p dir="auto">{monitor.spec.title}</p> : null}
    {sourceText !== monitor.spec.title ? <p className={styles.source} dir="auto">{sourceText}</p> : null}
    {proposed ? <p className={styles.detail} dir="auto">{conditionLabel(monitor.spec)}</p> : null}
    {monitor.status === "paused" && monitor.note ? <p className={styles.detail} dir="auto">{monitor.note}</p> : null}
    <dl className={styles.readings}>
      <div><dt>{text.current}</dt><dd dir="auto">{value}</dd></div>
      {proposed ? <>
        <div><dt>{text.interval}</dt><dd>{intervalLabel(timing.initialIntervalMs, language)}</dd></div>
        <div><dt>{text.duration}</dt><dd>{intervalLabel(timing.lifetimeMs, language)}</dd></div>
        {timing.deadline ? <div><dt>{text.deadline}</dt><dd><Time value={timing.deadline} language={language} /></dd></div> : null}
      </> : <>
        <div><dt>{text.last}</dt><dd><Time value={monitor.lastCheckedAt} language={language} /></dd></div>
        <div><dt>{text.next}</dt><dd><Time value={monitor.nextCheckAt} language={language} /></dd></div>
      </>}
    </dl>
    {proposed && monitor.current?.excerpt && monitor.current.excerpt !== monitor.current.value ? <p className={styles.excerpt} dir="auto">{compactText(monitor.current.excerpt)}</p> : null}
    {proposed || canManage || onOpenConversation ? <div className={styles.actions}>
      {proposed ? <>
        <button type="button" className={styles.primary} disabled={pending} onClick={() => void run("approve")}>{text.approve}</button>
        <button type="button" disabled={pending} onClick={() => void run("stop")}>{text.decline}</button>
      </> : null}
      {canManage ? <>
        <button type="button" disabled={pending} onClick={() => void run(monitor.status === "active" ? "pause" : "resume")}>{monitor.status === "active" ? text.pause : text.resume}</button>
        <button type="button" disabled={pending} onClick={() => void run("stop")}>{text.stop}</button>
      </> : null}
      {onOpenConversation ? <button type="button" onClick={() => onOpenConversation(monitor.conversationId)}>{text.open}</button> : null}
    </div> : null}
    <MonitorCardAlertFeedback alerts={monitor.alerts} />
    {pending ? <p className={styles.detail} role="status">{text.saving}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </section>;
}

function useMonitorUpdates(conversationId?: string) {
  const [updates, setUpdates] = useState<MonitorCard[]>([]);
  const changes = useRef(0);
  const changedAt = useRef(new Map<string, number>());
  useEffect(() => followMonitorChanges((monitor) => {
    if (conversationId && monitor.conversationId !== conversationId) return;
    changes.current += 1;
    changedAt.current.set(monitor.id, changes.current);
    setUpdates((current) => mergeMonitors(current, [monitor]));
  }), [conversationId]);

  const refresh = useCallback(async (signal: AbortSignal, fallback: string) => {
    const version = changes.current;
    const cards = await listMonitors(signal, fallback, conversationId);
    if (!signal.aborted) setUpdates((current) => mergeMonitors(cards, current.filter((monitor) => (changedAt.current.get(monitor.id) ?? 0) > version)));
  }, [conversationId]);
  return { updates, refresh };
}

const REFRESH_MS = 30_000; // Matches the existing conversation reminder poll and only starts at a due check.

export function ConversationMonitors({ conversationId, monitors = [], proposal }: {
  conversationId: string;
  monitors?: MonitorCard[];
  proposal?: MonitorCard;
}) {
  const { updates, refresh } = useMonitorUpdates(conversationId);
  const [error, setError] = useState("");
  const cards = mergeMonitors(monitors, proposal ? [proposal] : [], updates);
  const active = cards.filter((monitor) => monitor.status === "active");
  const next = active.map((monitor) => monitor.nextCheckAt).filter((time) => time !== null).sort()[0];
  const fallback = copy[active[0]?.spec.language ?? "ar"].listFailure;

  useEffect(() => {
    if (!next) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    function schedule(delay: number) {
      clearTimeout(timer);
      if (!signal.aborted && !document.hidden) timer = setTimeout(poll, delay);
    }
    async function poll() {
      if (loading || signal.aborted || document.hidden) return;
      loading = true;
      try {
        await refresh(signal, fallback);
        if (!signal.aborted) setError("");
      } catch {
        if (!signal.aborted) setError(fallback);
      } finally {
        loading = false;
        schedule(REFRESH_MS);
      }
    }
    const shown = () => schedule(0);
    schedule(Math.max(REFRESH_MS, Date.parse(next) - Date.now()));
    document.addEventListener("visibilitychange", shown);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [fallback, next, refresh]);

  return <>
    {cards.filter((monitor) => monitor.status !== "proposed" || monitor.id === proposal?.id)
      .map((monitor) => <SmartMonitorCard key={monitor.id} monitor={monitor} />)}
    {next && error ? <p className={styles.error} role="alert">{error}</p> : null}
  </>;
}

export function MonitorSettings({ onOpenConversation }: { onOpenConversation: (id: string) => void }) {
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { updates, refresh } = useMonitorUpdates();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const { signal } = controller;
    void refresh(signal, copy.ar.listFailure).catch(() => {
      if (!signal.aborted) setError(copy.ar.listFailure);
    }).finally(() => {
      if (!signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, revision, refresh]);

  function reload() {
    setError("");
    setLoading(true);
    setRevision((value) => value + 1);
  }

  const visible = updates.filter((monitor) => monitor.status === "active" || monitor.status === "paused");

  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => {
      reload();
      dialog.current?.showModal();
      setOpen(true);
    }}><Activity size={15} aria-hidden="true" />المراقبات</button>
    <dialog ref={dialog} className={styles.dialog} dir="rtl" lang="ar" aria-labelledby={title} onClose={() => setOpen(false)}>
      <header className={styles.dialogHeader}>
        <h2 id={title}>المراقبات</h2>
        <button ref={closeButton} type="button" autoFocus aria-label="إغلاق المراقبات" onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button>
      </header>
      {open ? <div className={styles.dialogBody} aria-busy={loading}>
        {error ? <>
          <p className={styles.error} role="alert">{error}</p>
          <div className={styles.actions}><button type="button" onClick={reload}>إعادة المحاولة</button></div>
        </> : null}
        {loading ? <p className={styles.detail} role="status">جارٍ تحميل المراقبات…</p> : null}
        {!loading && !error && !visible.length ? <p className={styles.detail}>لا توجد مراقبات نشطة أو متوقفة مؤقتًا.</p> : null}
        {!loading ? visible.map((monitor) => <SmartMonitorCard key={monitor.id} monitor={monitor} onStopped={() => closeButton.current?.focus()} onOpenConversation={(id) => {
          dialog.current?.close();
          onOpenConversation(id);
        }} />) : null}
      </div> : null}
    </dialog>
  </>;
}
