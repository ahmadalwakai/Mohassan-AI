"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Brain, Check, Cpu, Database, LoaderCircle, Play, RefreshCw, ShieldAlert, ShieldCheck, Square, X } from "lucide-react";
import styles from "./executor-workspace.module.css";
import { AdsLabPanel } from "./ads-lab-panel";

type Capability = "json.transform.v1:integers-to-strings" | "json.check.v1:inclusive-interval" | "typescript.implement.v1:null-safe-delta";
type Checkpoint = {
  path: string; modelVersion: string; architecture: string; checkpointId: string; tokenizerId: string; configIdentity: string; weightsSha256: string;
  vocabularySize: number; parameters: { layers: number; hidden: number; heads: number; contextLength: number }; initialization: string; trainingStatus: string;
  training: { optimizerSteps: number; processedTokens: number; uniqueDatasetTokens: number; status: string } | null;
  evaluation: { status: string; promotion: string; passed: boolean | null; reportBound: boolean; perFamily: Record<string, { tasks: number; modelSuccess: number }> } | null;
  device: "cpu" | "cuda";
};
type Load = { status: "loaded" | "failed"; checkedAt: string; durationMs: number; capabilities: string[]; error?: string };
type ExecutorState =
  | { state: "disabled"; message: string }
  | { state: "checkpoint_missing"; message: string; path: string | null }
  | { state: "checkpoint_incompatible"; message: string; reason: string; path: string }
  | { state: "runtime_missing"; message: string; python: string }
  | { state: "available"; checkpoint: Checkpoint };
type Status = {
  experiment: { enabled: boolean; mode: string | null; contained: false };
  executor: ExecutorState & { load: Load | null; busy: boolean };
  reasoning: { provider: string; configured: boolean; available: boolean; verified?: boolean; model: string | null; message: string };
  ollama: { status: "unreachable"; origin: string } | { status: "no_models"; origin: string; version: string | null } | { status: "ready"; origin: string; version: string | null; models: string[] };
  sandbox: { available: boolean; provider: string | null; message: string };
};
type Run = {
  runId: string; mode: "direct" | "assisted"; capability: string; status: string; message: string;
  submitted: { capability: string; fields: Record<string, unknown> | null };
  executor: { kind: string; transport: string; contained: false; modelVersion: string | null; checkpointId: string | null; tokenizerId: string | null; device: string; called: boolean };
  external: { provider: string; model: string; purpose: string; inputTokens: number; outputTokens: number; durationMs: number; output: Record<string, unknown> | null }[];
  candidate: { text: string; outputTokens: number; generationMs: number; stopReason: string } | null;
  missingContextKeys?: string[];
  verification: { status: "passed" | "rejected" | "unavailable"; method: string; checks: string[]; reason?: string; sandbox?: { provider: string; network: string; isolationVerified: boolean; exitCode: number | null; timedOut: boolean; durationMs: number } } | null;
  timing: { totalMs: number; executorMs: number | null };
  startedAt: string;
};

const TASKS: { id: Capability; title: string; note: string; family: string }[] = [
  { id: "json.transform.v1:integers-to-strings", title: "تحويل أعداد صحيحة إلى نصوص", note: "حتى 4 أعداد بين ‎-1024 و1024. التقييم المستقل: 12 من 19.", family: "type_transform" },
  { id: "json.check.v1:inclusive-interval", title: "فحص وقوع قيمة داخل مجال", note: "الحد الأدنى بين ‎-100 و99، وعرض المجال حتى 19. التقييم: 12 من 23.", family: "boundary_conditions" },
  { id: "typescript.implement.v1:null-safe-delta", title: "كتابة دالة TypeScript", note: "زيادة بين ‎-9 و9. التقييم المستقل: 0 من 25؛ توقّع الفشل.", family: "typescript_function" },
];
const runLabels: Record<string, string> = {
  candidate: "أنتج النموذج مرشحًا", missing_context: "سياق ناقص", unsupported: "مهمة غير مدعومة", timeout: "انتهت المهلة", cancelled: "أُلغيت",
  process_failure: "فشلت عملية النموذج", checkpoint_missing: "نقطة الحفظ غير موجودة", checkpoint_incompatible: "نقطة حفظ غير متوافقة",
  runtime_missing: "مفسّر Python غير موجود", reasoning_unavailable: "مزود التفكير غير متاح", reasoning_failed: "فشل مزود التفكير", disabled: "التجربة غير مفعّلة",
};
const short = (value: string | null | undefined) => value ? `${value.slice(0, 12)}…` : "—";

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json", ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error?.message ?? (response.status === 429 ? "طلبات كثيرة متتابعة. انتظر قليلًا." : "تعذر إتمام الطلب."), response.status);
  return body as T;
}

function parseInteger(text: string): number | undefined {
  const value = text.trim();
  if (!value) return undefined;
  if (!/^-?\d{1,6}$/.test(value)) throw new Error(`«${value}» ليس عددًا صحيحًا.`);
  return Number(value);
}

export function ExecutorWorkspace({ offline }: { offline: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<"direct" | "assisted">("direct");
  const [capability, setCapability] = useState<Capability>("json.transform.v1:integers-to-strings");
  const [values, setValues] = useState("7, -42, 1024");
  const [interval, setInterval_] = useState({ value: "5", minimum: "3", maximum: "12" });
  const [delta, setDelta] = useState({ name: "addFive", increment: "5" });
  const [requestText, setRequestText] = useState("");
  const [running, setRunning] = useState<{ runId: string; controller: AbortController } | null>(null);
  const [result, setResult] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const runningRef = useRef(running);
  runningRef.current = running;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const value = await api<Status>("/api/executor/status", { signal }); setStatus(value); setLoadError(""); }
    catch (caught) { if (!(caught instanceof DOMException && caught.name === "AbortError")) setLoadError(caught instanceof ApiError ? caught.message : "تعذر الاتصال بالخدمة."); }
  }, []);
  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [offline, refresh]);
  // Leaving the page stops a running experiment instead of leaving the worker behind.
  useEffect(() => () => {
    const current = runningRef.current;
    if (current) { current.controller.abort(); void fetch(`/api/executor/runs/${current.runId}`, { method: "DELETE", credentials: "same-origin" }).catch(() => {}); }
  }, []);

  const executor = status?.executor;
  const available = executor?.state === "available";
  const reasoningReady = status?.reasoning.available === true;
  const task = TASKS.find(item => item.id === capability)!;

  async function checkLoad() {
    if (checking || offline || !available) return;
    setChecking(true); setError("");
    try { await api<Load>("/api/executor/check", { method: "POST", body: "{}" }); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "تعذر فحص التحميل."); }
    finally { setChecking(false); await refresh(); }
  }

  function fields(): Record<string, unknown> {
    if (capability === "json.transform.v1:integers-to-strings") {
      const parts = values.split(/[,،\s]+/).filter(Boolean);
      return { values: parts.map(part => parseInteger(part)!) };
    }
    if (capability === "json.check.v1:inclusive-interval") {
      const output: Record<string, unknown> = {};
      for (const key of ["value", "minimum", "maximum"] as const) { const parsed = parseInteger(interval[key]); if (parsed !== undefined) output[key] = parsed; }
      return output;
    }
    const output: Record<string, unknown> = {};
    if (delta.name.trim()) output.function_name = delta.name.trim();
    const increment = parseInteger(delta.increment);
    if (increment !== undefined) output.increment = increment;
    return output;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running || offline || !available) return;
    let body: Record<string, unknown>;
    try {
      body = mode === "direct" ? { runId: crypto.randomUUID(), mode, capability, fields: fields() } : { runId: crypto.randomUUID(), mode, capability, request: requestText };
    } catch (caught) { setError(caught instanceof Error ? caught.message : "قيم غير صالحة."); return; }
    const controller = new AbortController();
    setRunning({ runId: String(body.runId), controller }); setError(""); setResult(null);
    try { setResult(await api<Run>("/api/executor/runs", { method: "POST", body: JSON.stringify(body), signal: controller.signal })); }
    catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") setError("أُلغيت التجربة.");
      else setError(caught instanceof ApiError ? caught.message : "تعذر تشغيل التجربة.");
    } finally { setRunning(null); void refresh(); }
  }

  async function cancel() {
    const current = running;
    if (!current) return;
    try { await api(`/api/executor/runs/${current.runId}`, { method: "DELETE" }); } catch { /* the fetch abort below still stops it */ }
    current.controller.abort();
  }

  return <section className={styles.workspace} aria-label="المنفّذ المحلي">
    <div className={styles.intro}>
      <div><span>LOCAL EXECUTOR · EXPERIMENTAL</span><h2>نموذجك المبني من الصفر، كما هو.</h2>
        <p>يرسل هذا القسم مهمة محددة الحقول إلى النموذج المحلي مباشرة، ثم يفحص المخرج بفاحص مستقل. لا يستخدم Ollama، ولا يستبدل النموذج بنموذج سحابي. النموذج تجريبي ولم يجتز بوابة الترقية.</p></div>
      <Cpu size={44} strokeWidth={1.2} />
    </div>
    <div className={styles.toolbar}>
      <button type="button" className="secondary-button" disabled={offline || checking} onClick={() => void refresh()}><RefreshCw size={15} />تحديث الحالة</button>
      <button type="button" className="secondary-button" disabled={offline || checking || !available || Boolean(running)} onClick={() => void checkLoad()}>{checking ? <LoaderCircle size={15} className="spin" /> : <Database size={15} />}فحص تحميل نقطة الحفظ</button>
    </div>
    {loadError ? <p className="inline-error" role="alert">{loadError}</p> : null}
    {!status ? <div className={styles.empty}><LoaderCircle size={26} className="spin" /><p>جارٍ قراءة حالة المنفّذ…</p></div> : <>
      <div className={styles.cards}>
        <article className={styles.card}>
          <h3><Cpu size={17} />المنفّذ المخصص</h3>
          {executor?.state === "available" ? <>
            <span className={styles.badgeOk}>نقطة الحفظ متاحة</span>
            <dl>
              <dt>الإصدار</dt><dd dir="ltr">{executor.checkpoint.modelVersion}</dd>
              <dt>نقطة الحفظ</dt><dd dir="ltr" title={executor.checkpoint.checkpointId}>{short(executor.checkpoint.checkpointId)}</dd>
              <dt>المُرمِّز</dt><dd dir="ltr" title={executor.checkpoint.tokenizerId}>{short(executor.checkpoint.tokenizerId)} · {executor.checkpoint.vocabularySize}</dd>
              <dt>المعمارية</dt><dd dir="ltr">{executor.checkpoint.architecture} · {executor.checkpoint.parameters.layers}×{executor.checkpoint.parameters.hidden} · ctx {executor.checkpoint.parameters.contextLength}</dd>
              <dt>التدريب</dt><dd>{executor.checkpoint.training ? `${executor.checkpoint.training.optimizerSteps.toLocaleString("ar")} خطوة · ${(executor.checkpoint.training.processedTokens / 1e6).toFixed(1)} مليون رمز · بدء عشوائي` : "سجل التدريب غير مقروء"}</dd>
              <dt>التقييم</dt><dd>{executor.checkpoint.evaluation ? `${executor.checkpoint.evaluation.passed === false ? "لم يجتز البوابة" : executor.checkpoint.evaluation.status} · ${executor.checkpoint.evaluation.promotion === "unpromoted" ? "غير مُرقّى" : executor.checkpoint.evaluation.promotion}${executor.checkpoint.evaluation.reportBound ? "" : " · التقرير غير مربوط"}` : "لا يوجد تقييم مربوط"}</dd>
              <dt>الجهاز</dt><dd dir="ltr">{executor.checkpoint.device}</dd>
              <dt>التحميل</dt><dd>{executor.load ? executor.load.status === "loaded" ? `حُمّل بالمحمّل الصارم في ${executor.load.durationMs} ms` : `فشل (${executor.load.error})` : "لم يُفحص بعد"}</dd>
            </dl>
          </> : <><span className={styles.badgeWarn}>{executor?.state === "disabled" ? "غير مفعّل" : executor?.state === "checkpoint_missing" ? "لا توجد نقطة حفظ" : executor?.state === "checkpoint_incompatible" ? "نقطة حفظ غير متوافقة" : "مفسّر Python غير موجود"}</span><p className={styles.cardNote}>{executor && "message" in executor ? executor.message : ""}</p></>}
          <p className={styles.warning}><ShieldAlert size={14} />عملية النموذج غير معزولة بنظام التشغيل؛ لا أدوات ولا شبكة ولا كتابة لديها، والكود الناتج يُشغَّل داخل AppContainer فقط.</p>
        </article>
        <article className={styles.card}>
          <h3><Brain size={17} />مزود التفكير</h3>
          <span className={status.reasoning.available && status.reasoning.verified ? styles.badgeOk : styles.badgeWarn}>{status.reasoning.available ? status.reasoning.verified ? "متاح ومُتحقق منه" : "مهيأ، لم يُتحقق منه" : status.reasoning.configured ? "غير متاح الآن" : "غير مهيأ"}</span>
          <dl><dt>المزود</dt><dd dir="ltr">{status.reasoning.provider}</dd><dt>النموذج</dt><dd dir="ltr">{status.reasoning.model ?? "—"}</dd></dl>
          <p className={styles.cardNote}>{status.reasoning.message}</p>
          <p className={styles.cardNote}>منفصل عن المنفّذ: يُستخدم فقط في الوضع المساعد لاستخراج الحقول، ويُسجَّل كل طلب إليه.</p>
        </article>
        <article className={styles.card}>
          <h3><Database size={17} />Ollama</h3>
          <span className={status.ollama.status === "ready" ? styles.badgeOk : styles.badgeWarn}>{status.ollama.status === "ready" ? `${status.ollama.models.length} نموذج` : status.ollama.status === "no_models" ? "يعمل بلا نماذج" : "غير متصل"}</span>
          <p className={styles.cardNote}>{status.ollama.status === "ready" ? status.ollama.models.join("، ") : status.ollama.status === "no_models" ? "لا توجد نماذج مثبتة. لا يُنزَّل أي نموذج تلقائيًا." : "الخدمة لا تستجيب."} المنفّذ المخصص لا يحتاج Ollama.</p>
          <p className={styles.cardNote}>بيئة العزل: {status.sandbox.available ? status.sandbox.provider : "غير متاحة"}</p>
        </article>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <fieldset className={styles.modes} disabled={Boolean(running)}>
          <legend>نوع التجربة</legend>
          <label className={mode === "direct" ? styles.modeSelected : styles.mode}><input type="radio" name="mode" checked={mode === "direct"} onChange={() => setMode("direct")} /><span><strong>مباشرة إلى المنفّذ</strong><small>حقول محددة ← النموذج المحلي. لا يُستدعى أي نموذج خارجي.</small></span></label>
          <label className={mode === "assisted" ? styles.modeSelected : styles.mode}><input type="radio" name="mode" checked={mode === "assisted"} disabled={!reasoningReady} onChange={() => setMode("assisted")} /><span><strong>بمساعدة مزود التفكير</strong><small>{reasoningReady ? `يُرسل نص طلبك إلى ${status.reasoning.provider} لاستخراج الحقول فقط، ثم ينفّذ النموذج المحلي.` : "غير متاح: لا يوجد مزود تفكير جاهز."}</small></span></label>
        </fieldset>
        <label className={styles.field}>المهمة
          <select value={capability} disabled={Boolean(running)} onChange={event => { setCapability(event.target.value as Capability); setResult(null); setError(""); }}>
            {TASKS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <small>{task.note}</small>
        </label>
        {mode === "assisted" ? <label className={styles.field}>اكتب الطلب بكلماتك<textarea rows={3} maxLength={1000} value={requestText} disabled={Boolean(running)} onChange={event => setRequestText(event.target.value)} placeholder={capability === "json.check.v1:inclusive-interval" ? "هل الرقم 15 بين 10 و20؟" : capability === "json.transform.v1:integers-to-strings" ? "حوّل الأعداد 3 و-8 و250 إلى نصوص" : "اكتب دالة اسمها addTwo تضيف 2"} /></label>
          : capability === "json.transform.v1:integers-to-strings" ? <label className={styles.field}>الأعداد<input dir="ltr" value={values} disabled={Boolean(running)} onChange={event => setValues(event.target.value)} placeholder="7, -42, 1024" /><small>افصل بفواصل. قائمة فارغة مسموحة.</small></label>
          : capability === "json.check.v1:inclusive-interval" ? <div className={styles.row}>{(["value", "minimum", "maximum"] as const).map(key => <label className={styles.field} key={key}>{key === "value" ? "القيمة" : key === "minimum" ? "الحد الأدنى" : "الحد الأعلى"}<input dir="ltr" inputMode="numeric" value={interval[key]} disabled={Boolean(running)} onChange={event => setInterval_(current => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
          : <div className={styles.row}><label className={styles.field}>اسم الدالة<input dir="ltr" value={delta.name} disabled={Boolean(running)} onChange={event => setDelta(current => ({ ...current, name: event.target.value }))} /></label><label className={styles.field}>الزيادة<input dir="ltr" inputMode="numeric" value={delta.increment} disabled={Boolean(running)} onChange={event => setDelta(current => ({ ...current, increment: event.target.value }))} /></label></div>}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <div className={styles.actions}>
          {running ? <button type="button" className={styles.stop} onClick={() => void cancel()}><Square size={14} />إلغاء التجربة</button> : null}
          <button type="submit" className="primary-button" disabled={offline || !available || Boolean(running) || executor?.busy === true || (mode === "assisted" && (!reasoningReady || requestText.trim().length < 3))}>{running ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{running ? "يعمل النموذج…" : "تشغيل التجربة"}</button>
        </div>
      </form>

      {result ? <ResultView result={result} /> : null}
    </>}
    <AdsLabPanel offline={offline} />
  </section>;
}

function ResultView({ result }: { result: Run }) {
  const verification = result.verification;
  return <article className={styles.result} aria-live="polite">
    <div className={styles.resultHead}>
      <h3>{runLabels[result.status] ?? result.status}</h3>
      {verification ? <span className={verification.status === "passed" ? styles.badgeOk : verification.status === "rejected" ? styles.badgeBad : styles.badgeWarn}>{verification.status === "passed" ? <><Check size={13} />اجتاز الفحص المستقل</> : verification.status === "rejected" ? <><X size={13} />رفضه الفحص المستقل</> : "غير مُتحقق منه"}</span> : null}
    </div>
    <p className={styles.cardNote}>{result.message}</p>
    {result.missingContextKeys?.length ? <p className={styles.cardNote}>الحقول الناقصة: <code dir="ltr">{result.missingContextKeys.join(", ")}</code></p> : null}
    {result.candidate ? <>
      <h4>مخرج النموذج كما هو</h4>
      <pre dir="ltr" className={styles.output}>{result.candidate.text || "(نص فارغ)"}</pre>
      <p className={styles.meta}>{result.candidate.outputTokens} رمز · توليد {result.candidate.generationMs} ms · توقف: <code dir="ltr">{result.candidate.stopReason}</code></p>
    </> : null}
    {verification ? <p className={styles.meta}>الفاحص: <code dir="ltr">{verification.method}</code>{verification.reason ? ` · ${verification.reason}` : ""}{verification.sandbox ? ` · ${verification.sandbox.provider}، الشبكة ${verification.sandbox.network === "denied" ? "محجوبة" : verification.sandbox.network}` : ""}</p> : null}
    <dl className={styles.attribution}>
      <dt>المنفّذ</dt><dd>{result.executor.called ? `النموذج المحلي ${result.executor.modelVersion ?? ""} على ${result.executor.device}` : "لم يُستدعَ النموذج"}</dd>
      <dt>نقطة الحفظ</dt><dd dir="ltr" title={result.executor.checkpointId ?? ""}>{short(result.executor.checkpointId)}</dd>
      <dt>مساعدة خارجية</dt><dd>{result.external.length ? result.external.map(call => `${call.provider} ${call.model}: استخراج الحقول (${call.inputTokens}+${call.outputTokens} رمز، ${call.durationMs} ms)`).join("؛ ") : "لا شيء: لم يُرسل أي طلب إلى نموذج خارجي"}</dd>
      <dt>الحقول المرسلة</dt><dd dir="ltr"><code>{JSON.stringify(result.submitted.fields)}</code></dd>
      <dt>الزمن</dt><dd>{result.timing.executorMs !== null ? `المنفّذ ${result.timing.executorMs} ms (تشغيل العملية والتحميل والتوليد)` : "—"} · الإجمالي {result.timing.totalMs} ms</dd>
    </dl>
    <p className={styles.warning}><ShieldCheck size={14} />{verification?.status === "passed" ? "نجاح هذه الحالة لا يجعل النموذج جاهزًا: نسبة نجاحه المقاسة في هذه العائلة أقل من البوابة." : "يبقى المخرج غير موثوق ما لم يجتز الفحص المستقل."}</p>
  </article>;
}
