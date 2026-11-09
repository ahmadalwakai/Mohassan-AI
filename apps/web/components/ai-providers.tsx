"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { Activity, ArrowDown, ArrowUp, Gauge, Plus, RefreshCw, Save, ShieldCheck, Trash2, Zap } from "lucide-react";
import { AIProvidersStatusSchema, type AIProviderSettingsInput, type AIProvidersStatus } from "@mohassan/contracts";
import styles from "./ai-providers.module.css";

const ROUTER_OPTIONS = ["auto", "auto:fast", "auto:smart", "auto:reliable", "auto:balanced"];
const number = new Intl.NumberFormat("ar");
const time = (value: string) => new Intl.DateTimeFormat("ar", { timeStyle: "short", dateStyle: "short" }).format(new Date(value));
const eventLabels: Record<AIProvidersStatus["usage"]["events"][number]["kind"], string> = {
  success: "نجاح", rate_limited: "حد الطلبات", quota_exhausted: "نفاد الحصة", failure: "فشل", fallback: "تبديل إلى بديل",
  paid_fallback_blocked: "مُنع التبديل إلى نموذج مدفوع", non_free_route: "توجيه عبر مزود غير مؤكد المجانية", retry: "إعادة محاولة",
};
const healthLabels = { unknown: "لم يُفحص", reachable: "متصل", error: "غير متاح" } as const;

function errorMessage(body: unknown, fallback: string) {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string") return body.error.message;
  return fallback;
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const id = useId();
  return <div className={styles.toggleRow}>
    <div><label htmlFor={id}>{label}</label><p id={`${id}-hint`}>{hint}</p></div>
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={`${id}-hint`} disabled={disabled} className={styles.switch} onClick={() => onChange(!checked)}><span /></button>
  </div>;
}

export function AiProviders({ offline }: { offline: boolean }) {
  const [status, setStatus] = useState<AIProvidersStatus | null>(null);
  const [draft, setDraft] = useState<AIProviderSettingsInput | null>(null);
  const [adding, setAdding] = useState("auto:fast");
  const [busy, setBusy] = useState<"" | "save" | "check">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = useRef(false);
  const active = useRef<AbortController | null>(null);

  const apply = useCallback((body: unknown) => {
    const parsed = AIProvidersStatusSchema.safeParse(body);
    if (!parsed.success) throw new Error("وصل رد غير صالح من خدمة المزودين.");
    setStatus(parsed.data);
    if (!dirty.current) setDraft(parsed.data.freellmapi.settings);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/ai/providers", { cache: "no-store", credentials: "same-origin", signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(body, "تعذر تحميل حالة المزودين."));
    apply(body);
  }, [apply]);

  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    const refresh = () => load(controller.signal).then(() => setError("")).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error && !(caught instanceof TypeError) ? caught.message : "تعذر الاتصال بالخدمة."); });
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load, offline]);
  useEffect(() => () => active.current?.abort(), []);

  async function post(path: string, body: unknown, kind: "save" | "check") {
    if (busy || offline) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(kind); setError(""); setNotice("");
    try {
      const response = await fetch(path, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, kind === "save" ? "تعذر حفظ الإعدادات." : "تعذر فحص FreeLLMAPI."));
      if (kind === "save") dirty.current = false;
      apply(result);
      setNotice(kind === "save" ? "حُفظت الإعدادات وتسري على الطلب التالي للمساعد." : "اكتمل الفحص. لم يُرسل أي طلب نموذج.");
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error && !(caught instanceof TypeError) ? caught.message : "تعذر الاتصال بالخدمة.");
    } finally {
      if (active.current === controller) { active.current = null; setBusy(""); }
    }
  }

  function edit(change: Partial<AIProviderSettingsInput>) {
    if (!draft) return;
    dirty.current = true;
    setDraft({ ...draft, ...change });
  }
  function move(index: number, by: number) {
    if (!draft) return;
    const models = [...draft.models];
    const target = index + by;
    if (target < 0 || target >= models.length) return;
    [models[index], models[target]] = [models[target]!, models[index]!];
    edit({ models });
  }

  if (!status || !draft) return <section className={styles.panel} aria-busy="true"><div className={styles.loading}><Spinner size="sm" /><p>جارٍ تحميل إعدادات المزودين…</p></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}</section>;

  const free = status.freellmapi;
  const usage = status.usage;
  const selectable = [...new Set([...ROUTER_OPTIONS, ...free.models.filter(model => model.router || model.executionStatus === "ready").map(model => model.id)])].filter(id => !draft.models.includes(id));
  const describe = (id: string) => {
    const model = free.models.find(entry => entry.id === id);
    if (!model) return id.startsWith("auto") ? "توجيه تلقائي داخل FreeLLMAPI" : "غير موجود في آخر فحص";
    if (model.router) return "توجيه تلقائي داخل FreeLLMAPI";
    return [model.executionStatus === "ready" ? "جاهز" : model.executionStatus === "exhausted" ? "مستنفد مؤقتًا" : "يحتاج مفتاحًا", model.supportsStructuredOutput ? "مخرجات منظمة" : "بدون مخرجات منظمة", model.supportsTools ? "أدوات" : null].filter(Boolean).join(" · ");
  };

  return <section className={styles.panel} aria-labelledby="providers-title">
    <header className={styles.header}>
      <span className="tool-icon tool-active"><Zap size={22} /></span>
      <div><h2 id="providers-title">مزودو النماذج و FreeLLMAPI</h2><p>{free.health.message}</p></div>
      <span className={`${styles.badge} ${free.health.status === "reachable" ? styles.good : free.health.status === "error" ? styles.bad : ""}`} aria-live="polite">{healthLabels[free.health.status]}</span>
    </header>

    <div className={styles.meta}>
      {free.baseUrl ? <span>العنوان <code dir="ltr">{free.baseUrl}</code></span> : null}
      {free.health.checkedAt ? <span>آخر فحص: <time dateTime={free.health.checkedAt}>{time(free.health.checkedAt)}</time></span> : null}
      <span>Groq: {status.groq.configured ? "مهيأ" : "غير مهيأ"}</span>
    </div>

    <div className={styles.grid}>
      <div className={styles.card}>
        <h3>الإعدادات</h3>
        <Toggle label="تفعيل FreeLLMAPI للمساعد" hint={free.configured ? "يجرب المساعد النماذج المجانية أولًا. التخطيط والبرمجة والاستوديو تبقى على Groq." : "أضف FREELLMAPI_API_KEY إلى ملف .env على الخادم أولًا."} checked={draft.enabled} disabled={!free.configured || offline} onChange={value => edit({ enabled: value })} />
        <Toggle label="التبديل التلقائي" hint="عند حد الطلبات أو تعطل نموذج ينتقل الطلب إلى المرشح التالي، مع عدد محاولات محدود." checked={draft.automaticFallback} disabled={offline} onChange={value => edit({ automaticFallback: value })} />
        <Toggle label="المجاني فقط" hint={free.allowPaidFallback ? "عند إيقافه قد يكمل الطلب على Groq المدفوع بعد فشل النماذج المجانية (مسموح من الخادم)." : "عند إيقافه يبقى الانتقال من نموذج مجاني إلى Groq المدفوع ممنوعًا ما لم يُفعَّل AI_ALLOW_PAID_FALLBACK على الخادم."} checked={draft.freeOnly} disabled={offline} onChange={value => edit({ freeOnly: value })} />

        <fieldset className={styles.models}>
          <legend>أولوية النماذج</legend>
          <ol>
            {draft.models.map((id, index) => <li key={id}>
              <div><code dir="ltr">{id}</code><small>{describe(id)}</small></div>
              <div className={styles.rowActions}>
                <button type="button" aria-label={`رفع ${id}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
                <button type="button" aria-label={`خفض ${id}`} disabled={index === draft.models.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
                <button type="button" aria-label={`إزالة ${id}`} disabled={draft.models.length === 1} onClick={() => edit({ models: draft.models.filter(item => item !== id) })}><Trash2 size={15} /></button>
              </div>
            </li>)}
          </ol>
          {draft.models.length < 8 && selectable.length ? <div className={styles.addRow}>
            <label htmlFor="provider-model-add" className={styles.srOnly}>إضافة نموذج</label>
            <select id="provider-model-add" dir="ltr" value={selectable.includes(adding) ? adding : selectable[0]} onChange={event => setAdding(event.target.value)}>
              {selectable.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            <Button size="sm" variant="outline" onClick={() => { const id = selectable.includes(adding) ? adding : selectable[0]!; edit({ models: [...draft.models, id] }); }}><Plus size={14} />إضافة</Button>
          </div> : null}
          {free.modelsTruncated ? <p className={styles.hint}>تعرض القائمة أول 400 نموذج من الكتالوج.</p> : null}
        </fieldset>

        <div className={styles.actions}>
          <Button className="primary-button" disabled={offline || busy !== ""} loading={busy === "save"} onClick={() => { void post("/api/ai/providers/freellmapi/settings", draft, "save"); }}><Save size={15} />حفظ الإعدادات</Button>
          <Button variant="outline" disabled={offline || busy !== "" || !free.configured} loading={busy === "check"} onClick={() => { void post("/api/ai/providers/freellmapi/check", {}, "check"); }}><RefreshCw size={15} />فحص الاتصال والنماذج</Button>
        </div>
        <p className={styles.hint}><ShieldCheck size={14} />الفحص يقرأ قائمة النماذج وسجل الاستخدام فقط ولا يستهلك حصة. المفتاح يبقى على الخادم ولا يظهر هنا.</p>
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </div>

      <div className={styles.card}>
        <h3><Gauge size={16} />الاستخدام اليوم</h3>
        <dl className={styles.stats}>
          <div><dt>المزود النشط</dt><dd>{usage.active ? <><span>{usage.active.provider}</span><code dir="ltr">{usage.active.model}</code></> : "لا طلبات بعد"}</dd></div>
          <div><dt>توكنات الإدخال</dt><dd>{number.format(usage.totals.inputTokens)}</dd></div>
          <div><dt>توكنات الإخراج</dt><dd>{number.format(usage.totals.outputTokens)}</dd></div>
          <div><dt>الإجمالي</dt><dd>{number.format(usage.totals.totalTokens)}</dd></div>
          <div><dt>طلبات آخر دقيقة</dt><dd>{number.format(usage.requestsLastMinute)}</dd></div>
          <div><dt>التكلفة التقديرية</dt><dd>{usage.totals.estimatedCostUsd === null ? "غير معروفة (لا سعر مضبوط لـ Groq)" : `$${usage.totals.estimatedCostUsd.toFixed(4)} (تقدير)`}</dd></div>
        </dl>
        <p className={styles.hint}>أرقام هذا القسم من هذه العملية منذ <time dateTime={usage.since}>{time(usage.since)}</time>، وتشمل طلبات المساعد عبر الموجّه.</p>

        {usage.recorded.length ? <div className={styles.tableWrap}><table>
          <caption>قرارات المساعد المسجلة اليوم (UTC)</caption>
          <thead><tr><th scope="col">النموذج</th><th scope="col">طلبات</th><th scope="col">فشل</th><th scope="col">إدخال</th><th scope="col">إخراج</th></tr></thead>
          <tbody>{usage.recorded.map(row => <tr key={row.model}><td><code dir="ltr">{row.model}</code></td><td>{number.format(row.requests)}</td><td>{number.format(row.failures)}</td><td>{number.format(row.inputTokens)}</td><td>{number.format(row.outputTokens)}</td></tr>)}</tbody>
        </table></div> : null}

        <h3><Activity size={16} />الحصص المعروفة</h3>
        {free.gatewayUsage ? <p className={styles.verified}><strong>موثّق من FreeLLMAPI</strong> استهلاك شهر {free.gatewayUsage.month}: {number.format(free.gatewayUsage.requests)} طلبًا و{number.format(free.gatewayUsage.tokens)} توكنًا{free.gatewayUsage.resetsAt ? `، يُصفّر ${time(free.gatewayUsage.resetsAt)}` : ""}.</p> : null}
        {usage.quotas.filter(quota => quota.provider !== "freellmapi").length ? <ul className={styles.quotas}>{usage.quotas.filter(quota => quota.provider !== "freellmapi").map(quota => <li key={`${quota.provider}-${quota.model}-${quota.metric}`}><span className={quota.source === "verified" ? styles.good : ""}>{quota.source === "verified" ? "موثّق" : "تقدير"}</span><code dir="ltr">{quota.provider}/{quota.model}</code> متبقٍ {quota.remaining === null ? "غير معروف" : number.format(quota.remaining)} {quota.metric === "tokens" ? "توكن" : "طلب"}{quota.resetAt ? ` حتى ${time(quota.resetAt)}` : ""}</li>)}</ul> : null}
        <p className={styles.hint}>لا تعرض FreeLLMAPI حدًا شخصيًا موحدًا لكل المزودين. السعة الإجمالية المعلنة للمشروع ليست حصة مضمونة لحسابك؛ حدود كل مزود تُدار داخل البوابة.</p>

        <h3>سجل التبديل والأعطال</h3>
        {usage.events.filter(event => event.kind !== "success").length ? <ol className={styles.events}>
          {usage.events.filter(event => event.kind !== "success").slice(0, 15).map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{time(event.at)}</time><strong>{eventLabels[event.kind]}</strong><code dir="ltr">{event.provider}/{event.model}{event.to ? ` → ${event.to}` : ""}</code>{event.code ? <small dir="ltr">{event.code}</small> : null}</li>)}
        </ol> : <p className={styles.hint}>لا أحداث حد طلبات أو أعطال منذ بدء الخدمة.</p>}
      </div>
    </div>
  </section>;
}
