"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Cpu, ImagePlus, LoaderCircle, Play, RefreshCw, ShieldAlert } from "lucide-react";
import type { ModelInfo, ModelList, ModelRunResponse, ModelUse } from "@mohassan/contracts";
import styles from "./models-workspace.module.css";

const USE_LABELS: Record<ModelUse, string> = { chat: "يغيّر ردود المحادثة", council: "عضو في مجلس النماذج", page: "يعمل من هذه الصفحة" };
const RUNTIME_LABELS: Record<ModelInfo["runtime"], string> = { "node-cpu": "Node على المعالج", "python-worker": "Python على المعالج", gpu: "بطاقة الرسوم" };
const REASONS: Record<string, string> = {
  absent: "ملفاته غير موجودة على الخادم.", busy: "مشغّل النماذج مشغول بنموذج آخر، أعد المحاولة بعد قليل.", timeout: "انتهى الوقت قبل أن يجيب.",
  unhealthy: "تعذّر تشغيله.", unsupported: "لا يقبل هذا النوع من المدخلات.", incompatible: "ملفاته لا تطابق بصماتها المسجلة.",
  "invalid-input": "المدخلات غير مقبولة لهذا النموذج.", "memory-budget": "لا تكفي ذاكرة الخادم المخصصة له.", "gpu-locked": "بطاقة الرسوم محجوزة لتدريب.",
};
type Filter = "all" | "ready" | "council";

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", headers: init.body ? { "Content-Type": "application/json" } : undefined });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error?.message ?? (response.status === 429 ? "طلبات كثيرة متتابعة. انتظر قليلًا." : "تعذر إتمام الطلب."), response.status);
  return body as T;
}

async function encodeImage(file: File): Promise<{ mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("اختر صورة PNG أو JPEG أو WebP.");
  if (file.size > 5_000_000) throw new Error("الصورة أكبر من 5 ميغابايت.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { mimeType: file.type as "image/png" | "image/jpeg" | "image/webp", data: btoa(binary) };
}

/** One model as a card: what it does, where it is used, its measured result, and why the page cannot run it when it cannot. */
export function ModelCard({ model, selected, onSelect }: { model: ModelInfo; selected: boolean; onSelect?: (id: string) => void }) {
  const runnable = model.present && model.input !== "none";
  return <article className={`${styles.card} ${selected ? styles.selected : ""}`} data-model={model.id}>
    <h3><Cpu size={15} aria-hidden="true" /><bdi dir="ltr">{model.id}</bdi></h3>
    <p className={styles.task} dir="auto">{model.task}</p>
    <div className={styles.badges}>
      <span className={model.present ? styles.badgeOk : styles.badgeBad}>{model.present ? "ملفاته على الخادم" : "غير موجود"}</span>
      {model.uses.filter(use => use !== "page").map(use => <span key={use} className={styles.badgeInfo}>{USE_LABELS[use]}</span>)}
    </div>
    <dl>
      <dt>الإصدار</dt><dd><bdi dir="ltr">{model.version}</bdi></dd>
      <dt>التشغيل</dt><dd>{RUNTIME_LABELS[model.runtime]}</dd>
      {model.measured ? <><dt>قياسات سابقة</dt><dd>{model.measured}</dd></> : null}
      {model.gates.length ? <><dt>اختبارات مسجّلة</dt><dd dir="auto">{model.gates.join("؛ ")}</dd></> : null}
    </dl>
    {model.unavailable ? <p className={styles.warning}><ShieldAlert size={13} aria-hidden="true" />{model.unavailable}</p> : null}
    {runnable && onSelect ? <button type="button" className="secondary-button" onClick={() => onSelect(model.id)} aria-pressed={selected}>
      <Play size={13} aria-hidden="true" />جرّبه</button> : null}
  </article>;
}

export function ModelsWorkspace({ offline }: { offline: boolean }) {
  const [list, setList] = useState<ModelList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [passage, setPassage] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [result, setResult] = useState<ModelRunResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try { setList(await api<ModelList>("/api/models")); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "تعذر تحميل النماذج."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const model = useMemo(() => list?.models.find(item => item.id === selected) ?? null, [list, selected]);
  const shown = useMemo(() => (list?.models ?? []).filter(item => filter === "all" ? true
    : filter === "ready" ? item.present && item.input !== "none" : item.uses.includes("council")), [list, filter]);
  const counts = useMemo(() => ({
    all: list?.models.length ?? 0,
    present: list?.models.filter(item => item.present).length ?? 0,
    runnable: list?.models.filter(item => item.present && item.input !== "none").length ?? 0,
    council: list?.models.filter(item => item.uses.includes("council")).length ?? 0,
  }), [list]);

  const choose = (id: string) => { setSelected(id); setResult(null); setRunError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!model) return;
    setRunning(true);
    setRunError("");
    setResult(null);
    try {
      const body = model.input === "image"
        ? { image: await (image ? encodeImage(image) : Promise.reject(new Error("اختر صورة أولًا."))) }
        : model.input === "reading" ? { text, passage } : { text };
      setResult(await api<ModelRunResponse>(`/api/models/${encodeURIComponent(model.id)}/run`, { method: "POST", body: JSON.stringify(body) }));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "تعذر تشغيل النموذج.");
    } finally {
      setRunning(false);
    }
  };
  const ready = model?.input === "image" ? Boolean(image) : model?.input === "reading" ? Boolean(text.trim() && passage.trim()) : Boolean(text.trim());

  return <section className={styles.workspace} aria-busy={loading}>
    <div className={styles.intro}>
      <div>
        <span dir="ltr">MODELS</span>
        <h2>نماذجك المدرّبة في مكان واحد</h2>
        <p>كل نموذج مسجّل: هل ملفاته على الخادم، وأين يُستعمل، وما نتيجة اختباره. جرّب أي نموذج جاهز على نصك أو صورتك. مجلس النماذج يعمل في محادثتك تلقائيًا ويعرض نقاشه تحت كل رد.</p>
      </div>
      <div className={styles.toolbar}>
        <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || offline}>
          {loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}تحديث</button>
      </div>
    </div>

    {loadError ? <p className="inline-error" role="alert">{loadError}</p> : null}
    {!list && loading ? <div className={styles.empty}><LoaderCircle size={20} className="spin" aria-hidden="true" />جارٍ تحميل النماذج…</div> : null}

    {list ? <>
      <div className={styles.summary} role="status">
        <span>{counts.all} مسجّل</span><span>{counts.present} ملفاته على الخادم</span><span>{counts.runnable} يعمل من هذه الصفحة</span>
        <span>{list.council ? `${counts.council} في مجلس النماذج` : "مجلس النماذج مطفأ على هذا الخادم"}</span>
      </div>
      <div className={styles.filters} role="group" aria-label="تصفية النماذج">
        {(["all", "ready", "council"] as const).map(item => <button key={item} type="button" aria-pressed={filter === item}
          className={filter === item ? styles.filterOn : styles.filter} onClick={() => setFilter(item)}>
          {item === "all" ? "الكل" : item === "ready" ? "الجاهزة للتجربة" : "أعضاء المجلس"}</button>)}
      </div>

      {model ? <form className={styles.form} onSubmit={event => void submit(event)} aria-label={`تجربة ${model.id}`}>
        <h3>جرّب <bdi dir="ltr">{model.id}</bdi></h3>
        {model.input === "image" ? <label className={styles.field}><span><ImagePlus size={14} aria-hidden="true" />الصورة</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setImage(event.target.files?.[0] ?? null)} /></label> : null}
        {model.input === "reading" ? <label className={styles.field}><span>الفقرة</span>
          <textarea dir="auto" rows={5} value={passage} onChange={event => setPassage(event.target.value)} maxLength={6000} placeholder="الفقرة التي يجيب منها النموذج" /></label> : null}
        {model.input !== "image" ? <label className={styles.field}><span>{model.input === "reading" ? "السؤال" : "النص"}</span>
          <textarea dir="auto" rows={3} value={text} onChange={event => setText(event.target.value)} maxLength={4000} placeholder={model.input === "reading" ? "سؤال عن الفقرة" : "اكتب ما يقرؤه النموذج"} /></label> : null}
        <div className={styles.actions}>
          <button type="submit" className="primary-button" disabled={running || offline || !ready}>
            {running ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{running ? "يعمل…" : "شغّل"}</button>
          <button type="button" className="secondary-button" onClick={() => setSelected(null)}>إغلاق</button>
        </div>
        {runError ? <p className="inline-error" role="alert">{runError}</p> : null}
        {result ? <div className={styles.result} role="status">
          <p className={result.ok ? styles.badgeOk : styles.badgeBad}>{result.ok ? `اكتمل التشغيل في ${(result.elapsedMs / 1000).toFixed(1)} ث` : REASONS[result.reason ?? ""] ?? "تعذّر تشغيله."}</p>
          {result.detail ? <p className={styles.task} dir="auto">{result.detail}</p> : null}
          {result.text ? <p className={styles.answer} dir="auto">{result.text}</p> : null}
          {result.output ? <details><summary>المخرج كما هو</summary><pre dir="ltr" className={styles.output}>{result.output}</pre></details> : null}
        </div> : null}
      </form> : null}

      {shown.length ? <div className={styles.cards}>{shown.map(item => <ModelCard key={item.id} model={item} selected={item.id === selected} onSelect={choose} />)}</div>
        : <div className={styles.empty}>لا نماذج في هذا التصنيف.</div>}
    </> : null}
  </section>;
}
