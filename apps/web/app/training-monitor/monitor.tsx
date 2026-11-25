"use client";

import { TRAINING_SPEED_GUARD_RATIO, TRAINING_SPEED_GUARD_SECONDS, type TrainingMonitorSnapshot, type TrainingRun } from "@mohassan/contracts";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import styles from "./monitor.module.css";

const unavailable = "غير متاح";
const pollMs = 15_000;
const locale = "ar-u-nu-arab";
const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const signedNumberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
const validationFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
const guardLabel = `حد الحماية (${percentFormat.format(TRAINING_SPEED_GUARD_RATIO)} من سرعة الدقيقة الأولى)`;
const averageLabel = "متوسط آخر ٣٠ دقيقة تدريب";

const statusText: Record<TrainingRun["status"] | "crashed" | "unknown", string> = {
  running: "جارٍ التدريب",
  completed: "مكتمل",
  early_stopped: "توقف مبكرًا",
  failed: "فشل",
  paused_by_stop_file: "متوقف مؤقتًا",
  paused_time_limit: "انتهت مدة المحاولة",
  interrupted: "انقطع",
  crashed: "انقطع",
  unknown: "الحالة غير معروفة",
};

type Alert = { tone: "warning" | "danger" | "success"; text: string };
const runAlerts: Partial<Record<TrainingRun["status"], Alert>> = {
  completed: { tone: "success", text: "اكتمل التدريب." },
  early_stopped: { tone: "warning", text: "توقف التدريب مبكرًا." },
  failed: { tone: "danger", text: "فشل التدريب." },
  paused_by_stop_file: { tone: "warning", text: "توقف التدريب مؤقتًا بطلب من ملف الإيقاف." },
  paused_time_limit: { tone: "warning", text: "توقف التدريب عند انتهاء مدة المحاولة." },
  interrupted: { tone: "danger", text: "انقطع التدريب." },
};

function alertsFor(run: TrainingRun, temperatureC: number | null) {
  const alerts: Alert[] = [];
  const runAlert = runAlerts[run.status];
  if (runAlert) alerts.push(runAlert);
  if (run.status === "running") {
    if (run.stopRequested) alerts.push({ tone: "warning", text: "طُلب إيقاف التدريب مؤقتًا." });
    const speed = run.speed;
    if (speed && speed.guardLine !== null && speed.current <= speed.guardLine * 1.1) {
      alerts.push(speed.current < speed.guardLine
        ? { tone: "danger", text: "سرعة التدريب أقل من حد الحماية." }
        : { tone: "warning", text: "سرعة التدريب قريبة من حد الحماية." });
    }
  }
  if (temperatureC !== null && temperatureC >= 80) {
    alerts.push({ tone: "danger", text: "حرارة بطاقة الرسومات بلغت ٨٠ درجة مئوية أو أكثر." });
  }
  return alerts;
}

function metric(value: number | null | undefined, unit = "") {
  return value == null ? unavailable : numberFormat.format(value) + unit;
}

function MonitorTime({ value, utc = false }: { value: string | null | undefined; utc?: boolean }) {
  if (!value) return unavailable;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return unavailable;
  const label = new Intl.DateTimeFormat(locale, {
    calendar: "gregory", dateStyle: "medium", timeStyle: "short", timeZone: utc ? "UTC" : undefined,
  }).format(date);
  return <time dateTime={value}>{label}</time>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.field}><dt>{label}</dt><dd>{children}</dd></div>;
}

function RunDetails({ run, gpu, gpuLock }: { run: TrainingRun } & Pick<TrainingMonitorSnapshot, "gpu" | "gpuLock">) {
  const { speed } = run;
  const averageWindow = speed?.averageWindowSeconds;
  const partialAverage = averageWindow != null && averageWindow < 1800;
  const progress = run.percentDone;
  const progressLabel = progress === null ? unavailable : percentFormat.format(progress / 100);
  const alerts = alertsFor(run, gpu?.temperatureC ?? null);
  const languages = new Set([...Object.keys(run.lastValidation), ...Object.keys(run.bestValidation)]);
  const finished = run.status === "completed" || run.status === "early_stopped";
  const finishTime = finished
    ? run.attempts.find((attempt) => attempt.id === run.currentAttempt)?.endedAt ?? run.updatedAt
    : run.etaAt;

  return <>
    <section className={styles.progressPanel} aria-labelledby="training-progress">
      <div className={styles.progressHeadline}>
        <div>
          <h2 id="training-progress">تقدّم التدريب</h2>
          <p className={styles.runName}><bdi>{run.run} / {run.shape}</bdi></p>
        </div>
        <div className={styles.progressValue}><strong>{progressLabel}</strong><span>{statusText[run.status]}</span></div>
      </div>
      {progress !== null ? <progress aria-label="نسبة تقدّم التدريب" value={progress} max={100}>{progressLabel}</progress> : null}
      <p className={styles.tokenCount}>الرموز المعالجة <bdi>{metric(run.processedTokens)}</bdi> من <bdi>{metric(run.totalTokens)}</bdi></p>
      <p className={styles.updated}>آخر تحديث للتدريب <MonitorTime value={run.updatedAt} /></p>
    </section>

    <div role="status" aria-live="polite">
      {alerts.length ? <ul className={styles.alerts} aria-label="تنبيهات التدريب">
        {alerts.map(({ tone, text }) => <li className={styles[tone]} key={text}>{text}</li>)}
      </ul> : null}
    </div>

    <div className={styles.grid}>
      <section className={styles.panel} aria-labelledby="training-speed">
        <h2 id="training-speed">سرعة التدريب</h2>
        <dl className={styles.fields}>
          <Field label="السرعة الحالية">{metric(speed?.current, " رمز/ثانية")}</Field>
          <Field label={averageWindow === null || partialAverage ? "متوسط السرعة المتاح" : averageLabel}>{metric(speed?.average30Minutes, " رمز/ثانية")}</Field>
          {partialAverage && averageWindow > 0
            ? <Field label="مدة قياس المتوسط">{metric(averageWindow, " ثانية")}</Field> : null}
          <Field label={guardLabel}>{metric(speed?.guardLine, " رمز/ثانية")}</Field>
          <Field label="فارق السرعة عن الحد">
            {speed?.distanceFromGuardLine != null ? <><bdi>{signedNumberFormat.format(speed.distanceFromGuardLine)}</bdi> رمز/ثانية</> : unavailable}
          </Field>
          <Field label="مدة البطء المتواصل">{speed?.consecutiveSlowSeconds != null
            ? `${metric(speed.consecutiveSlowSeconds)} من ${metric(TRAINING_SPEED_GUARD_SECONDS)} ثانية` : unavailable}</Field>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="training-estimated-finish">
        <h2 id="training-estimated-finish">{finished ? "وقت انتهاء التدريب" : "وقت الانتهاء المتوقع"}</h2>
        <dl className={styles.fields}>
          <Field label="توقيت جهازك"><MonitorTime value={finishTime} /></Field>
          <Field label="التوقيت العالمي (UTC)"><MonitorTime value={finishTime} utc /></Field>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="training-gpu">
        <h2 id="training-gpu">بطاقة الرسومات</h2>
        <dl className={styles.fields}>
          <Field label="درجة الحرارة">{metric(gpu?.temperatureC, " °م")}</Field>
          <Field label="نسبة الاستخدام">{gpu ? percentFormat.format(gpu.utilizationPercent / 100) : unavailable}</Field>
          <Field label="الذاكرة المستخدمة">{metric(gpu?.memoryUsedMiB, " ميبيبايت")}</Field>
          {gpuLock?.owner ? <Field label="صاحب حجز البطاقة"><bdi>{gpuLock.owner}</bdi></Field> : null}
          {gpuLock?.purpose ? <Field label="الغرض"><bdi>{gpuLock.purpose}</bdi></Field> : null}
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="training-checkpoints">
        <h2 id="training-checkpoints">نقاط الحفظ</h2>
        <dl className={styles.fields}>
          <Field label="آخر نقطة حفظ">{metric(run.lastCheckpoint?.tokens, " رمز")}</Field>
          <Field label="وقت الحفظ"><MonitorTime value={run.lastCheckpoint?.savedAt} /></Field>
          <Field label="نقطة الحفظ القادمة">{metric(run.nextCheckpoint?.tokens, " رمز")}</Field>
          <Field label="وقت الحفظ المتوقع"><MonitorTime value={run.nextCheckpoint?.etaAt} /></Field>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="training-validation">
        <h2 id="training-validation">خسارة التحقق</h2>
        {languages.size ? <table className={styles.table}>
          <thead><tr><th scope="col">اللغة</th><th scope="col">آخر قيمة</th><th scope="col">أفضل قيمة</th></tr></thead>
          <tbody>{[...languages].map((language) => <tr key={language}>
            <th scope="row"><bdi>{language === "ar" ? "العربية" : language === "en" ? "الإنجليزية" : language}</bdi></th>
            <td>{run.lastValidation[language] == null ? unavailable : validationFormat.format(run.lastValidation[language])}</td>
            <td>{run.bestValidation[language] == null ? unavailable : validationFormat.format(run.bestValidation[language])}</td>
          </tr>)}</tbody>
        </table> : <p className={styles.empty}>لا توجد نتائج تحقق مسجّلة.</p>}
      </section>

      <section className={styles.panel} aria-labelledby="training-attempts">
        <h2 id="training-attempts">سجلّ المحاولات</h2>
        {run.attempts.length ? <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="جدول محاولات التدريب">
          <table className={styles.table}>
            <thead><tr><th scope="col">المحاولة</th><th scope="col">الحالة</th><th scope="col">البداية</th><th scope="col">النهاية</th></tr></thead>
            <tbody>{run.attempts.map((attempt, index) => <tr key={attempt.id}>
              <th scope="row"><bdi>{attempt.id}</bdi>{attempt.resumed ? <small>استئناف</small> : index > 0 ? <small>إعادة تشغيل</small> : null}</th>
              <td>{statusText[attempt.status]}</td>
              <td><MonitorTime value={attempt.startedAt} /></td>
              <td>{attempt.endedAt ? <MonitorTime value={attempt.endedAt} /> : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className={styles.empty}>لا توجد محاولات مسجّلة.</p>}
      </section>
    </div>
  </>;
}

const runKey = ({ run, shape }: TrainingRun) => JSON.stringify([run, shape]);

function TrainingMonitorData({ snapshot }: { snapshot: TrainingMonitorSnapshot }) {
  const [chosenRun, setChosenRun] = useState("");
  const { active, recent } = snapshot;
  const runs = active ? [active, ...recent.filter((run) => runKey(run) !== runKey(active))] : recent;
  const current = runs.find((run) => runKey(run) === chosenRun) ?? runs[0];
  if (!current) return <p className={styles.message} role="status">لا توجد سجلات تدريب محلية لعرضها.</p>;
  return <>
    <div className={styles.toolbar}>
      {runs.length > 1 ? <label className={styles.runPicker}>
        التشغيل المعروض
        <select value={runKey(current)} onChange={(event) => setChosenRun(event.currentTarget.value)}>
          {runs.map((run) => <option value={runKey(run)} key={runKey(run)}>{run.run} / {run.shape}</option>)}
        </select>
      </label> : null}
      <p className={styles.updated}>آخر قراءة <MonitorTime value={snapshot.sampledAt} /></p>
    </div>
    <RunDetails run={current} gpu={snapshot.gpu} gpuLock={snapshot.gpuLock} />
  </>;
}

type MonitorState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: TrainingMonitorSnapshot };

export function TrainingMonitor() {
  const [state, setState] = useState<MonitorState>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let request: AbortController | undefined;
    let stopped = false;
    let disposed = false;

    async function load() {
      if (stopped || request || document.hidden) return;
      request = new AbortController();
      try {
        const response = await fetch("/api/training-monitor", {
          credentials: "same-origin", cache: "no-store", signal: request.signal,
        });
        const body = await response.json().catch(() => null);
        if (disposed) return;
        if (response.ok && body) {
          setState({ status: "ready", snapshot: body as TrainingMonitorSnapshot });
        } else {
          stopped = [401, 403, 404].includes(response.status) || body?.error?.code === "TRAINING_MONITOR_UNAVAILABLE";
          setState({ status: "error", message: body?.error?.message ?? "تعذّر تحميل حالة التدريب." });
        }
      } catch {
        if (!disposed) setState({ status: "error", message: "تعذّر الاتصال بخادم موحسن المحلي." });
      } finally {
        request = undefined;
      }
    }

    void load();
    const timer = window.setInterval(load, pollMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh]);

  return <main className={styles.page} dir="rtl">
    <header className={styles.header}>
      <Link className={styles.back} href="/" prefetch={false}><ArrowRight size={16} aria-hidden="true" />العودة إلى موحسن</Link>
      <h1>مراقبة التدريب</h1>
    </header>
    {state.status === "loading" ? <p className={styles.message} role="status">جارٍ قراءة حالة التدريب…</p> : null}
    {state.status === "error" ? <div className={styles.message}>
      <p role="alert">{state.message}</p>
      <button className={styles.retry} type="button" onClick={() => {
        setState({ status: "loading" });
        setRefresh((previous) => previous + 1);
      }}>إعادة المحاولة</button>
    </div> : null}
    {state.status === "ready" ? <TrainingMonitorData snapshot={state.snapshot} /> : null}
  </main>;
}
