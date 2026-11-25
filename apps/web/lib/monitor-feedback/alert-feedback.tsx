"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  MonitorAlertFeedbackStateSchema, type MonitorAlert, type MonitorAlertFeedback, type MonitorAlertFeedbackState,
} from "@mohassan/contracts";
import styles from "./alert-feedback.module.css";

const feedbackChanged = new EventTarget();
const reasons = {
  no_meaningful_change: "لم يتغير شيء مهم",
  late: "تأخر التنبيه",
  wrong_value: "قيمة خاطئة",
} satisfies Record<NonNullable<MonitorAlertFeedback["reason"]>, string>;

function AlertFeedback({ alert }: { alert: MonitorAlert }) {
  const [local, setLocal] = useState<MonitorAlertFeedbackState>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const saved = !local || (alert.feedback && alert.feedback.updatedAt > local.updatedAt) ? alert.feedback : local;

  useEffect(() => {
    const sync = (event: Event) => {
      const { id, feedback } = (event as CustomEvent<{ id: string; feedback: MonitorAlertFeedbackState }>).detail;
      if (id === alert.id) setLocal(current => current && current.updatedAt > feedback.updatedAt ? current : feedback);
    };
    feedbackChanged.addEventListener("saved", sync);
    return () => feedbackChanged.removeEventListener("saved", sync);
  }, [alert.id]);

  async function save(input: MonitorAlertFeedback) {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const response = await fetch(`/api/chat/monitors/alerts/${encodeURIComponent(alert.id)}/feedback`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Could not save monitor feedback");
      const feedback = MonitorAlertFeedbackStateSchema.parse(await response.json());
      feedbackChanged.dispatchEvent(new CustomEvent("saved", { detail: { id: alert.id, feedback } }));
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return <div className={styles.feedback} lang="ar" dir="rtl" role="group" aria-label="تقييم تنبيه المراقبة" aria-busy={pending}>
    <button type="button" aria-pressed={saved?.rating === "helpful"} disabled={pending}
      onClick={() => void save({ rating: "helpful" })}>مفيد</button>
    <button type="button" aria-pressed={saved?.rating === "not_helpful"} disabled={pending}
      onClick={() => void save({ rating: "not_helpful", reason: saved?.reason })}>غير مفيد</button>
    {saved?.rating === "not_helpful" ? <label>
      السبب (اختياري)
      <select value={saved.reason ?? ""} disabled={pending} onChange={event =>
        void save({ rating: "not_helpful", reason: (event.target.value || undefined) as MonitorAlertFeedback["reason"] })}>
        <option value="">بلا سبب</option>
        {Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label> : null}
    {error ? <span role="alert">تعذّر حفظ التقييم. حاول مجددًا.</span> : null}
  </div>;
}

export function ConversationMessageFeedback({ alerts, messageId, fallback }: {
  alerts?: MonitorAlert[];
  messageId: string;
  fallback: ReactNode;
}) {
  const alert = alerts?.find(alert => alert.id === messageId);
  return alert ? <AlertFeedback key={alert.id} alert={alert} /> : fallback;
}

export function MonitorCardAlertFeedback({ alerts }: { alerts?: MonitorAlert[] }) {
  if (!alerts?.length) return null;
  return <ul className={styles.alerts}>
    {alerts.map(alert => <li key={alert.id}>
      {alerts.length > 1 ? <time dateTime={alert.happenedAt} lang="ar">{new Intl.DateTimeFormat("ar", {
        dateStyle: "short", timeStyle: "short",
      }).format(new Date(alert.happenedAt))}</time> : null}
      <AlertFeedback alert={alert} />
    </li>)}
  </ul>;
}
