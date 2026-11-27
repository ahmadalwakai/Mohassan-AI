"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cpu, LoaderCircle, Play, RefreshCw, ShieldAlert } from "lucide-react";
import type { ModelInfo, ModelList, ModelUse } from "@mohassan/contracts";
import { ModelRunForm } from "./model-run-form";
import { modelsRequest } from "./models-api";
import styles from "./models-workspace.module.css";

const USE_LABELS: Record<ModelUse, string> = { chat: "يغيّر ردود المحادثة", council: "عضو في مجلس النماذج", page: "يعمل من هذه الصفحة" };
const RUNTIME_LABELS: Record<ModelInfo["runtime"], string> = { "node-cpu": "Node على المعالج", "python-worker": "Python على المعالج", gpu: "بطاقة الرسوم" };
type Filter = "all" | "ready" | "council";

function focusRunForm(form: HTMLFormElement) {
  form.focus({ preventScroll: true });
  form.scrollIntoView({ block: "start" });
}

/** One model as a card: what it does, where it is used, its measured result, and why the page cannot run it when it cannot. */
export function ModelCard({ model, selected, onSelect }: { model: ModelInfo; selected: boolean; onSelect?: (id: string, opener: HTMLButtonElement) => void }) {
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
      {model.measured ? <><dt>المقاس</dt><dd>{model.measured}</dd></> : null}
      {model.gates.length ? <><dt>الاختبارات</dt><dd dir="auto">{model.gates.join("؛ ")}</dd></> : null}
    </dl>
    {model.unavailable ? <p className={styles.warning}><ShieldAlert size={13} aria-hidden="true" />{model.unavailable}</p> : null}
    {runnable && onSelect ? <button type="button" className="secondary-button" onClick={event => onSelect(model.id, event.currentTarget)} aria-pressed={selected}>
      <Play size={13} aria-hidden="true" />جرّبه</button> : null}
  </article>;
}

export function ModelsWorkspace({ offline }: { offline: boolean }) {
  const [list, setList] = useState<ModelList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState({ text: "", passage: "" });
  const form = useRef<HTMLFormElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const activeFilter = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try { setList(await modelsRequest<ModelList>("/api/models")); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "تعذر تحميل النماذج."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const model = useMemo(() => list?.models.find(item => item.id === selected && item.present && item.input !== "none") ?? null, [list, selected]);
  const shown = useMemo(() => (list?.models ?? []).filter(item => filter === "all" ? true
    : filter === "ready" ? item.present && item.input !== "none" : item.uses.includes("council")), [list, filter]);
  const counts = useMemo(() => ({
    all: list?.models.length ?? 0,
    present: list?.models.filter(item => item.present).length ?? 0,
    runnable: list?.models.filter(item => item.present && item.input !== "none").length ?? 0,
    council: list?.models.filter(item => item.uses.includes("council")).length ?? 0,
  }), [list]);

  const attachForm = useCallback((node: HTMLFormElement | null) => {
    form.current = node;
    if (node) focusRunForm(node);
  }, []);

  function choose(id: string, button: HTMLButtonElement) {
    opener.current = button;
    if (selected === id && form.current) focusRunForm(form.current);
    setSelected(id);
  }

  function close() {
    setSelected(null);
    (opener.current?.isConnected ? opener.current : activeFilter.current)?.focus();
    opener.current = null;
  }

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
        {(["all", "ready", "council"] as const).map(item => <button key={item} type="button" aria-pressed={filter === item} ref={filter === item ? activeFilter : undefined}
          className={filter === item ? styles.filterOn : styles.filter} onClick={() => setFilter(item)}>
          {item === "all" ? "الكل" : item === "ready" ? "الجاهزة للتجربة" : "أعضاء المجلس"}</button>)}
      </div>

      {model ? <ModelRunForm key={`${model.id}:${model.version}:${model.input}`} model={model} draft={draft} onDraftChange={setDraft}
        offline={offline} formRef={attachForm} onClose={close} /> : null}

      {shown.length ? <div className={styles.cards}>{shown.map(item => <ModelCard key={item.id} model={item} selected={item.id === selected} onSelect={choose} />)}</div>
        : <div className={styles.empty}>لا نماذج في هذا التصنيف.</div>}
    </> : null}
  </section>;
}
