"use client";

import { useEffect, useId, useState } from "react";
import { MonitorCardSchema, MonitorManagementResultSchema, MonitorV2ControlSchema, monitorV2Targets,
  type MonitorCard, type MonitorManagementCard, type MonitorSpec, type MonitorV2Target } from "@mohassan/contracts";
import { changeMonitor, publishMonitorUpdate } from "./monitors-client";
import { chatHttpErrorMessage, sessionFetch } from "./chat-request";
import styles from "./smart-monitors.module.css";

const endpoint = "/api/chat/monitors";
type Language = MonitorSpec["language"];

const copy = {
  ar: {
    confirm: "تأكيد", cancel: "إلغاء", other: "غير ذلك", apply: "تأكيد تغيير المراقبة", saved: "حُفظ التغيير.",
    otherText: "اذكر القيمة أو اسم العنصر الذي تقصده في رسالة جديدة.", failure: "تعذّر تحديث المراقبة. حاول مجددًا.",
    saveFailed: "تعذّر حفظ إعداد عروض المراقبة.", loading: "جارٍ تحميل إعداد عروض المراقبة…",
    offers: "اقتراح المراقبة عند وجود حالة منتظرة", plan: "خطة المراقبة", offer: "عرض مراقبة", current: "القيمة الحالية",
    start: "بدء المراقبة", notNow: "ليس الآن", all: "يجب أن تتحقق كل الشروط.", any: "يكفي أن يتحقق أحد الشروط.",
    each: "تنبيه لكل عنصر جديد ضمن حدود الإشعارات.", daily: "ملخص يومي ضمن حدود الإشعارات.",
  },
  en: {
    confirm: "Confirm", cancel: "Cancel", other: "Other", apply: "Confirm monitor change", saved: "Change saved.",
    otherText: "Describe the value or item you want in a new message.", failure: "Could not update the monitor. Try again.",
    saveFailed: "Could not save your monitor offer setting.", loading: "Loading your monitor offer setting…",
    offers: "Suggest monitoring when a status is pending", plan: "Monitoring plan", offer: "Monitoring offer", current: "Current value",
    start: "Start monitoring", notNow: "Not now", all: "All conditions must be met.", any: "Any one condition can trigger an alert.",
    each: "An alert for each new item, within notification limits.", daily: "A daily digest, within notification limits.",
  },
};

async function monitorRequest(path: string, fallback: string, options: { body?: object; signal?: AbortSignal } = {}) {
  const response = await sessionFetch(`${endpoint}${path}`, { credentials: "same-origin", cache: "no-store", signal: options.signal,
    ...(options.body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(chatHttpErrorMessage(response.status, data?.error, fallback));
  return data;
}

function ChoiceButtons({ choices, pending, other, onChoose, onOther }: {
  choices: readonly { id: string; label: string }[];
  pending: boolean;
  other: string;
  onChoose: (id: string) => void;
  onOther: () => void;
}) {
  return <div className={styles.actions}>
    {choices.map(choice => <button key={choice.id} type="button" disabled={pending} onClick={() => onChoose(choice.id)} dir="auto">{choice.label}</button>)}
    <button type="button" disabled={pending} onClick={onOther}>{other}</button>
  </div>;
}

function valueLabel(value: NonNullable<MonitorCard["current"]>["value"], language: Language) {
  if (Array.isArray(value)) return new Intl.ListFormat(language).format(value.slice(0, 3));
  if (typeof value === "number") return new Intl.NumberFormat(language, { maximumFractionDigits: 12 }).format(value);
  if (typeof value === "boolean") return value ? language === "ar" ? "موجود" : "Present" : language === "ar" ? "غير موجود" : "Absent";
  return value;
}

function durationLabel(ms: number, language: Language) {
  const minute = 60_000;
  const hour = 60 * minute;
  const unit = ms % hour === 0 ? "hour" : "minute";
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long" }).format(ms / (unit === "hour" ? hour : minute));
}

function targetLabel(target: MonitorV2Target, language: Language) {
  const { source } = target;
  switch (source.kind) {
    case "page": case "pdf": case "visual": return source.anchor ? `${source.anchor} · ${source.url}` : source.url;
    case "github": return `${source.owner}/${source.repo}${"number" in source.watch ? ` #${source.watch.number}` : "branch" in source.watch ? ` · ${source.watch.branch}` : ""}`;
    case "currency": return `${source.base}/${source.quote}`;
    case "weather": return source.location;
    case "search": return source.query;
    case "run": return language === "ar" ? "مهمة في الخلفية" : "Background run";
  }
}

function targetCondition(spec: MonitorSpec, target: MonitorV2Target, describeCondition: (spec: MonitorSpec) => string) {
  const { trend } = target;
  const ar = spec.language === "ar";
  if (!trend) return describeCondition({ ...spec, ...target });
  const move = trend.direction === "rise" ? ar ? "ترتفع" : "rises" : ar ? "تنخفض" : "falls";
  if (trend.kind === "consecutive") return ar ? `${move} القراءة في ${trend.checks} فحوص متتالية.` : `The reading ${move} in ${trend.checks} consecutive checks.`;
  const window = durationLabel(trend.windowMs, spec.language);
  const percent = new Intl.NumberFormat(spec.language, { style: "percent" }).format(trend.percent / 100);
  return ar ? `${move} القراءة بنسبة ${percent} خلال ${window}.` : `The reading ${move} by ${percent} within ${window}.`;
}

export function MonitorV2ProposalCard({ monitor, describeCondition }: { monitor: MonitorCard; describeCondition: (spec: MonitorSpec) => string }) {
  const title = useId();
  const [pending, setPending] = useState(false);
  const [other, setOther] = useState(false);
  const [error, setError] = useState("");
  const { language, v2 } = monitor.spec;
  const text = copy[language];
  const ar = language === "ar";

  async function run(action: "approve" | "stop", candidateId?: string) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (candidateId) {
        const response = await monitorRequest("", text.failure, { body: { proposalId: monitor.id, candidateId } });
        publishMonitorUpdate(MonitorCardSchema.parse(response));
        setOther(false);
      } else await changeMonitor(monitor.id, action, text.failure);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : text.failure);
    } finally {
      setPending(false);
    }
  }

  const group = v2?.combine?.kind === "and" ? text.all : v2?.combine?.kind === "or" ? text.any : v2?.combine?.kind === "sequence"
    ? ar ? `يجب أن يتحقق الشرط الثاني خلال ${durationLabel(v2.combine.windowMs, language)} من الأول.`
      : `The second condition must follow the first within ${durationLabel(v2.combine.windowMs, language)}.` : null;
  const choices = monitor.clarification?.choices.map(choice => ({ id: choice.id, label: `${choice.label} · ${valueLabel(choice.value, language)}` }));
  const heading = monitor.clarification?.question ?? (monitor.offer === "explicit" ? text.plan : text.offer);

  return <section className={styles.card} aria-labelledby={title} aria-busy={pending} data-testid={choices ? "monitor-choice" : "monitor-approval"} lang={language} dir={ar ? "rtl" : "ltr"}>
    <strong id={title} dir="auto">{heading}</strong>
    {!choices ? <>
      <p dir="auto">{monitor.spec.title}</p>
      {group ? <p className={styles.detail}>{group}</p> : null}
      {monitorV2Targets(monitor.spec).map((target, index) => <div key={index}>
        <p className={styles.source} dir="auto">{targetLabel(target, language)}</p>
        <p className={styles.detail} dir="auto">{targetCondition(monitor.spec, target, describeCondition)}</p>
      </div>)}
      {monitor.current ? <dl className={styles.readings}><div><dt>{text.current}</dt><dd dir="auto">{valueLabel(monitor.current.value, language)}</dd></div></dl> : null}
      {monitor.current?.excerpt ? <p className={styles.excerpt} dir="auto">{monitor.current.excerpt}</p> : null}
      {v2?.delivery === "each" || v2?.delivery === "daily" ? <p className={styles.detail}>{text[v2.delivery]}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={pending} onClick={() => void run("approve")}>{text.start}</button>
        <button type="button" disabled={pending} onClick={() => void run("stop")}>{text.notNow}</button>
      </div>
    </> : <ChoiceButtons choices={choices} pending={pending} other={text.other} onChoose={id => void run("approve", id)} onOther={() => setOther(true)} />}
    {other ? <p role="status" className={styles.detail}>{text.otherText}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </section>;
}

export function MonitorConversationControls({ conversationId, revision }: { conversationId: string; revision?: string }) {
  const title = useId();
  const [action, setAction] = useState<MonitorManagementCard>();
  const [pending, setPending] = useState(false);
  const [other, setOther] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Language>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ control: "v2", conversationId });
    void monitorRequest(`?${query}`, copy.ar.failure, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setAction(MonitorV2ControlSchema.parse(data).action);
    }).catch(() => {});
    return () => controller.abort();
  }, [conversationId, revision]);

  async function answer(approved: boolean, targetId?: string) {
    if (!action || pending) return;
    const { language, id } = action;
    setError("");
    setPending(true);
    try {
      const response = await monitorRequest("", copy[language].failure, { body: { actionId: id, approved, ...(targetId && { targetId }) } });
      const result = MonitorManagementResultSchema.parse(response);
      setAction(result.action);
      if (result.monitor) publishMonitorUpdate(result.monitor);
      if (approved && !result.action) setSaved(language);
      setOther(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy[language].failure);
    } finally {
      setPending(false);
    }
  }

  if (!action) return saved ? <p className={styles.detail} role="status" lang={saved}>{copy[saved].saved}</p> : null;
  const { language, question, choices } = action;
  const text = copy[language];
  return <section className={styles.card} aria-labelledby={title} aria-busy={pending} data-testid="monitor-management" lang={language} dir={language === "ar" ? "rtl" : "ltr"}>
    <strong id={title}>{question}</strong>
    {choices ? <ChoiceButtons choices={choices} pending={pending} other={text.other} onChoose={id => void answer(true, id)} onOther={() => setOther(true)} />
      : <div className={styles.actions}>
        <button type="button" className={styles.primary} aria-label={text.apply} disabled={pending} onClick={() => void answer(true)}>{text.confirm}</button>
        <button type="button" disabled={pending} onClick={() => void answer(false)}>{text.cancel}</button>
      </div>}
    {other ? <p role="status" className={styles.detail}>{text.otherText}</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </section>;
}

export function MonitorOfferSettings() {
  const [enabled, setEnabled] = useState<boolean>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const text = copy.ar;

  useEffect(() => {
    const controller = new AbortController();
    void monitorRequest("?control=v2", text.saveFailed, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setEnabled(MonitorV2ControlSchema.parse(data).proactiveOffers);
    }).catch(() => { if (!controller.signal.aborted) setError(text.saveFailed); });
    return () => controller.abort();
  }, [text.saveFailed]);

  async function update(checked: boolean) {
    setError("");
    setPending(true);
    try {
      const response = await monitorRequest("", text.saveFailed, { body: { proactiveOffers: checked } });
      setEnabled(MonitorV2ControlSchema.parse(response).proactiveOffers);
    } catch {
      setError(text.saveFailed);
    } finally {
      setPending(false);
    }
  }

  return <div className={styles.dialogBody} aria-busy={enabled === undefined && !error || pending}>
    {enabled === undefined && !error ? <p className={styles.detail} role="status">{text.loading}</p> : null}
    {enabled === undefined ? null : <label><input type="checkbox" checked={enabled} disabled={pending} onChange={event => void update(event.target.checked)} /> {text.offers}</label>}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div>;
}
