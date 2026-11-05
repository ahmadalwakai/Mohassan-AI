"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Code2, Columns2, Download, Eye, FolderOpen, MousePointer2, Plus, RefreshCw, Save, ShieldCheck, Smartphone, Undo2 } from "lucide-react";
import { StudioPreviewSchema, StudioSelectionMessageSchema, StudioSessionSchema, StudioWorkspaceSchema, type StudioElement, type StudioPreview, type StudioSession, type StudioSessionSummary, type Task } from "@mohassan/contracts";

import { StudioAiPanel } from "./studio-ai-panel";
import { StudioLivePanel } from "./studio-live-panel";

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {...options, credentials:"same-origin", cache:"no-store", headers:{"Content-Type":"application/json", ...options.headers}});
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? "تعذر الاتصال بالاستوديو. أعد المحاولة.");
  return body;
}
const failure = (error: unknown) => error instanceof Error ? error.message : "تعذر إكمال الطلب.";
type StudioFramework = "static" | "react" | "next";
const frameworkNames: Record<StudioFramework, string> = {static:"HTML/CSS",react:"React — معاينة أولية",next:"Next — صفحة بسيطة"};
const frameworkEntries: Record<StudioFramework, string> = {static:"index.html",react:"src/App.tsx",next:"app/page.tsx"};

function colorControlValue(value: string, fallback: string): string {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(value);
  if (!rgb || rgb[4] !== undefined && Number(rgb[4]) === 0) return fallback;
  const channels = rgb.slice(1, 4).map(Number);
  return channels.every(channel => channel >= 0 && channel <= 255)
    ? `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`
    : fallback;
}

function FileComparison({session}: {session: StudioSession}) {
  const changed = session.files.filter(file => file.content !== session.baseFiles.find(base => base.path === file.path)?.content);
  return <section className="studio-code" aria-label="مقارنة ملفات المشروع"><div className="studio-section-title"><Code2 size={16}/><h3>تغييرات نسخة المراجعة</h3><span>{changed.length} ملفات</span></div>{changed.length === 0 ? <p className="studio-muted">تطابق هذه النسخة الملفات الأصلية المحفوظة.</p> : changed.map(file => <details key={file.path} open><summary dir="ltr">{file.path}</summary><div className="studio-code-pair"><div><h4>الأصل</h4><pre dir="ltr">{session.baseFiles.find(base => base.path === file.path)?.content}</pre></div><div><h4>بعد التعديل</h4><pre dir="ltr">{file.content}</pre></div></div></details>)}</section>;
}

export function VisualStudio({offline, ownerId, onTaskCreated}: {offline: boolean; ownerId: string; onTaskCreated: (task: Task) => void}) {
  const [sessions, setSessions] = useState<StudioSessionSummary[]>([]);
  const [session, setSession] = useState<StudioSession | null>(null);
  const [preview, setPreview] = useState<StudioPreview | null>(null);
  const [baseline, setBaseline] = useState<StudioPreview | null>(null);
  const [selected, setSelected] = useState<StudioElement | null>(null);
  const [text, setText] = useState("");
  const [color, setColor] = useState("#172d2b");
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [fontSize, setFontSize] = useState(24);
  const [changedStyles, setChangedStyles] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobile, setMobile] = useState(false);
  const [selecting, setSelecting] = useState(true);
  const [compare, setCompare] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importFramework, setImportFramework] = useState<StudioFramework>("static");
  const [importEntry, setImportEntry] = useState(frameworkEntries.static);
  const [frameVersion, setFrameVersion] = useState(0);
  const [initializationVersion, setInitializationVersion] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);
  const sequence = useRef(0);
  const wasOffline = useRef(offline);
  const storageKey = `mohassan-studio:${ownerId}`;
  const textChanged = Boolean(selected?.editableText && text !== selected.text);
  const dirty = textChanged || Object.values(changedStyles).some(Boolean);
  const writable = !offline && !busy && Boolean(session && preview?.revision === session.revision);
  const styleWritable = writable && selected?.editableStyles !== false;
  const currentSelection = useRef({selected, dirty});
  currentSelection.current = {selected, dirty};

  const adopt = useCallback((next: StudioSession, rendered: StudioPreview) => {
    if (next.revision !== rendered.revision) throw new Error("تغيرت النسخة أثناء التحميل. حدّث المشروع قبل المتابعة.");
    frameReady.current = false;
    setSession(next); setPreview(rendered); setSelected(null); setChangedStyles({}); setBaseline(null); setCompare(false);
    setSessions(current => [next, ...current.filter(item => item.id !== next.id)]);
    try { localStorage.setItem(storageKey, next.id); } catch { /* Storage is optional. SQL is authoritative. */ }
  }, [storageKey]);

  const load = useCallback(async (id: string) => {
    const ticket = ++sequence.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const [detail, rendered] = await Promise.all([api(`/api/studio/sessions/${id}`), api(`/api/studio/sessions/${id}/preview`)]);
      if (sequence.current === ticket) adopt(StudioSessionSchema.parse(detail), StudioPreviewSchema.parse(rendered));
    } catch (caught) { if (sequence.current === ticket) setError(failure(caught)); }
    finally { if (sequence.current === ticket) setBusy(false); }
  }, [adopt]);

  useEffect(() => {
    const applied = (event: Event) => {
      if (!session || (event as CustomEvent).detail !== session.id) return;
      if (currentSelection.current.dirty) setNotice("طُبق المقترح المحفوظ. حدّث المعاينة بعد مراجعة تجربتك غير المحفوظة.");
      else void load(session.id);
    };
    window.addEventListener("mohassan-studio-applied", applied);
    return () => window.removeEventListener("mohassan-studio-applied", applied);
  }, [session?.id, load]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const result = StudioWorkspaceSchema.parse(await api("/api/studio/sessions"));
        if (!active) return;
        setSessions(result.sessions);
        let saved: string | null = null;
        try { saved = localStorage.getItem(storageKey); } catch { /* Optional preference. */ }
        const first = result.sessions.find(item => item.id === saved) ?? result.sessions[0];
        if (first) await load(first.id); else setBusy(false);
      } catch (caught) { if (active) {setError(failure(caught)); setBusy(false);} }
    }
    void initialize();
    return () => {active = false; sequence.current += 1;};
  }, [load, storageKey, initializationVersion]);

  useEffect(() => {
    if (wasOffline.current && !offline && !session) setInitializationVersion(value => value + 1);
    wasOffline.current = offline;
  }, [offline, session]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      // srcdoc with allow-scripts, without allow-same-origin, has an opaque origin.
      if (busy || !preview || preview.revision !== session?.revision || event.origin !== "null" || event.source !== frame.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data) || ![4, 5].includes(Object.keys(event.data).length)) return;
      const parsed = StudioSelectionMessageSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.nonce !== preview.nonce || parsed.data.revision !== preview.revision || !selecting) return;
      const element = preview.elements.find(item => item.id === parsed.data.elementId);
      if (!element) return;
      if (currentSelection.current.selected?.id === element.id) return;
      const discarded = currentSelection.current.dirty;
      if (discarded) {
        // Reload only the trusted document; the previous element's trial must not
        // remain in the canvas when the inspector now represents another element.
        frameReady.current = false;
        setFrameVersion(value => value + 1);
      }
      setSelected(element); setText(element.text ?? ""); setChangedStyles({});
      setNotice(discarded ? "أُلغيت تجربة العنصر السابق غير المحفوظة عند اختيار عنصر آخر." : "");
      const displayStyles = parsed.data.styles ?? element.styles;
      setColor(colorControlValue(displayStyles.color, "#172d2b"));
      setBackgroundColor(colorControlValue(displayStyles.backgroundColor, "#ffffff"));
      setFontSize(Math.max(8, Math.min(96, Math.round(parseFloat(displayStyles.fontSize)) || 24)));
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [busy, preview, selecting, session?.revision]);

  const sendMode = useCallback(() => {
    if (preview && frameReady.current) frame.current?.contentWindow?.postMessage({type:"mohassan:studio:mode",nonce:preview.nonce,revision:preview.revision,selecting}, "*");
  }, [preview, selecting]);
  useEffect(sendMode, [sendMode]);

  const sendDraft = useCallback(() => {
    if (!preview || !selected || !frameReady.current) return;
    const styles = selected.editableStyles === false ? {} : {...(changedStyles.color ? {color} : {}), ...(changedStyles.backgroundColor ? {backgroundColor} : {}), ...(changedStyles.fontSize ? {fontSize} : {})};
    frame.current?.contentWindow?.postMessage({type:"mohassan:studio:draft",nonce:preview.nonce,revision:preview.revision,elementId:selected.id,...(selected.editableText ? {text} : {}),styles}, "*");
  }, [preview, selected, text, color, backgroundColor, fontSize, changedStyles]);
  useEffect(sendDraft, [sendDraft]);

  const syncFrame = useCallback(() => {
    frameReady.current = true;
    sendMode();
    sendDraft();
  }, [sendMode, sendDraft]);

  async function create(event?: FormEvent<HTMLFormElement>, framework: StudioFramework = "static") {
    event?.preventDefault();
    if (offline || busy) return;
    const values = event ? new FormData(event.currentTarget) : null;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = StudioSessionSchema.parse(await api(values ? "/api/studio/sessions" : "/api/studio/sessions/demo", {method:"POST",body:JSON.stringify(values ? {name:values.get("name"),path:values.get("path"),entryPath:values.get("entryPath"),framework:importFramework} : framework === "static" ? {} : {framework})}));
      const rendered = StudioPreviewSchema.parse(await api(`/api/studio/sessions/${next.id}/preview`));
      adopt(next, rendered); setShowImport(false);
    } catch (caught) { setError(failure(caught)); } finally {setBusy(false);}
  }

  async function persist(undo = false) {
    if (!writable || !session || !undo && (!selected || !dirty)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const styles = selected?.editableStyles === false ? {} : {...(changedStyles.color ? {color} : {}), ...(changedStyles.backgroundColor ? {backgroundColor} : {}), ...(changedStyles.fontSize ? {fontSize} : {})};
      const input = undo ? {revision:session.revision} : {revision:session.revision,elementId:selected!.id,...(textChanged ? {text} : {}),...(Object.keys(styles).length ? {styles} : {})};
      const next = StudioSessionSchema.parse(await api(`/api/studio/sessions/${session.id}/${undo ? "undo" : "edits"}`, {method:"POST",body:JSON.stringify(input)}));
      const rendered = StudioPreviewSchema.parse(await api(`/api/studio/sessions/${next.id}/preview`));
      adopt(next, rendered); setNotice(undo ? "استُعيد آخر إصدار محفوظ." : "حُفظ التعديل في نسخة المراجعة.");
    } catch (caught) {setError(failure(caught));} finally {setBusy(false);}
  }

  async function toggleComparison() {
    if (!session || busy || offline) return;
    if (compare) {setCompare(false); return;}
    setBusy(true); setError("");
    try {
      const rendered = StudioPreviewSchema.parse(await api(`/api/studio/sessions/${session.id}/baseline`));
      if (rendered.revision !== session.revision) throw new Error("تغيرت النسخة. حدّث المشروع لعرض المقارنة.");
      setBaseline(rendered); setCompare(true);
    } catch (caught) {setError(failure(caught));} finally {setBusy(false);}
  }

  function downloadFiles() {
    if (!session) return;
    const blob = new Blob([JSON.stringify({name:session.name,framework:session.framework,entryPath:session.entryPath,revision:session.revision,files:session.files}, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "studio-review.json"; anchor.click(); URL.revokeObjectURL(url);
  }

  return <section className="visual-studio" aria-label="الاستوديو البصري" aria-busy={busy}>
    <div className="studio-intro"><div><span className="eyebrow">من المعاينة إلى المصدر</span><h2>صمّم وأنت ترى النتيجة.</h2><p>اختر عنصرًا، جرّب تعديلك مباشرة، ثم احفظ نسخة قابلة للمراجعة.</p></div><span className="studio-safety"><ShieldCheck size={16}/>نسخة مراجعة خاصة</span></div>
    <div className="studio-project-toolbar"><label className="studio-project-picker"><FolderOpen size={17}/><select aria-label="المشروع البصري" disabled={busy || offline} value={session?.id ?? ""} onChange={event => void load(event.target.value)}><option value="" disabled>اختر مشروعًا</option>{sessions.map(item => <option value={item.id} key={item.id}>{item.name} · {frameworkNames[item.framework]}</option>)}</select></label><div><button className="secondary-button" disabled={busy || offline} onClick={() => void create()}><Plus size={15}/>إنشاء تجربة بصرية</button><button className="secondary-button" disabled={busy || offline} onClick={() => void create(undefined, "react")}><Plus size={15}/>إنشاء تجربة React</button><button className="secondary-button" disabled={busy || offline} onClick={() => void create(undefined, "next")}><Plus size={15}/>إنشاء صفحة Next</button><button className="secondary-button" disabled={busy || offline} onClick={() => setShowImport(value => !value)}><FolderOpen size={15}/>استيراد مشروع</button></div></div>
    <p className="studio-muted">المعاينة المحفوظة تعرض النتيجة الأولية للمكوّن، وتُفحص النسخة في بيئة مستقلة قبل الحفظ. المعاينة التفاعلية الكاملة تحتاج ربط مشغّل Next.</p>
    {showImport ? <form className="studio-import stack-form" onSubmit={create}><p>تُحفظ نسخة من المشروع داخل الجذور المصرح بها. معاينة React وNext محدودة بصفحة صغيرة تستخدم React والملفات المحلية؛ لا تُثبّت حزم المشروع أو تُشغّل أوامره.</p><label>نوع المشروع<select aria-label="نوع المشروع" value={importFramework} disabled={busy || offline} onChange={event => {const framework=event.target.value as StudioFramework;setImportFramework(framework);setImportEntry(frameworkEntries[framework]);}}><option value="static">HTML/CSS</option><option value="react">React — معاينة أولية</option><option value="next">Next — صفحة بسيطة</option></select></label><label>اسم المشروع<input name="name" required minLength={3} maxLength={100} placeholder="صفحتي الجديدة"/></label><label>مجلد المشروع<input name="path" dir="ltr" required maxLength={1000} placeholder="C:\Projects\my-page"/></label><label>ملف البداية<input name="entryPath" dir="ltr" value={importEntry} onChange={event => setImportEntry(event.target.value)} required maxLength={180}/></label><button className="primary-button" disabled={busy || offline} type="submit">{importFramework === "static" ? "استيراد نسخة للمراجعة" : "استيراد ومعاينة معزولة"}</button></form> : null}
    {error ? <p className="inline-error" role="alert">{error} {session ? "يمكنك إعادة تحميل النسخة المحفوظة من زر التحديث." : ""}</p> : null}
    {notice ? <p className="studio-notice" role="status">{notice}</p> : null}
    {!session ? <div className="studio-empty"><span><MousePointer2 size={30}/></span><h3>{busy ? "جارٍ تحميل الاستوديو…" : "أول صفحة تبدأ من هنا"}</h3><p>أنشئ تجربة بصرية أو مشروع React صغيرًا لاختيار العناصر وتعديلها، أو استورد مشروعًا من جهازك.</p><small>تدعم هذه الشريحة HTML/CSS ومعاينة React الأولية وصفحة Next بسيطة. يمكنك طلب تعديل بالوصف أو إرفاق تصميم مرجعي بعد اختيار المشروع.</small></div> : <>
      {preview?.verification ? <div className="studio-notice studio-build-status" role="status" aria-label="تحقق المعاينة المعزولة"><strong><ShieldCheck size={15}/> {frameworkNames[session.framework]} · عزل متحقق</strong><p>أُنتجت هذه المعاينة داخل بيئة معزولة بلا شبكة. الحفظ يعيد اختبار التعديل قبل تحديث نسخة المراجعة.</p><details><summary>أدلة المعاينة</summary><code dir="ltr">{preview.verification.provider} · {preview.verification.isolation} · network: {preview.verification.network}</code></details></div> : null}
      <div className="studio-workbench"><div className="studio-canvas"><div className="studio-canvas-toolbar"><div className="studio-segment"><button aria-label="وضع اختيار العناصر" aria-pressed={selecting} onClick={() => setSelecting(true)}><MousePointer2 size={16}/><span>اختيار</span></button><button aria-label="وضع المعاينة" aria-pressed={!selecting} onClick={() => setSelecting(false)}><Eye size={16}/><span>معاينة</span></button></div><div className="studio-segment"><button aria-label="عرض سطح المكتب" aria-pressed={!mobile} onClick={() => setMobile(false)}><Columns2 size={16}/></button><button aria-label="عرض الهاتف" aria-pressed={mobile} onClick={() => setMobile(true)}><Smartphone size={16}/></button><button aria-label="تحديث المعاينة" disabled={offline || busy} onClick={() => void load(session.id)}><RefreshCw size={15} className={busy ? "spin" : ""}/></button></div></div><div className={`studio-preview-area ${mobile ? "studio-mobile-preview" : ""} ${compare ? "studio-compare" : ""}`}><div className="studio-preview-column"><div className="studio-frame-label"><span>{dirty ? "تجربة غير محفوظة" : "نسخة المراجعة"}</span><code>{session.entryPath}</code></div>{preview ? <iframe key={frameVersion} ref={frame} title="معاينة المشروع" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={preview.document} onLoad={syncFrame}/> : <p>تعذر تحميل المعاينة. أعد المحاولة.</p>}</div>{compare && baseline ? <div className="studio-preview-column"><div className="studio-frame-label"><span>الأصل المحفوظ عند الاستيراد</span></div><iframe title="المعاينة الأصلية" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={baseline.document}/></div> : null}</div><div className="studio-canvas-footer"><span><i/>{busy ? "جارٍ الحفظ أو التحميل" : dirty ? "التجربة لم تُحفظ بعد" : "معاينة إصدار محفوظ"}</span><code title={session.revision}>{session.revision.slice(0,12)}</code></div></div>
      <aside className="studio-inspector"><div className="studio-section-title"><MousePointer2 size={17}/><h3>خصائص العنصر</h3></div>{selected ? <><div className="studio-selected-element"><code>&lt;{selected.tag}&gt;</code><span data-testid="studio-source-location" dir="ltr">{selected.file}:{selected.line}</span></div><div className="stack-form studio-properties">{selected.editableText ? <label>نص العنصر<textarea aria-label="نص العنصر" maxLength={4000} rows={3} value={text} disabled={!writable} onChange={event => setText(event.target.value)}/></label> : <p className="studio-muted">نص هذا العنصر ديناميكي أو يحتوي عناصر فرعية. اختر عنصرًا ذا نص مباشر لتعديله.</p>}{selected.editableStyles === false ? <p className="studio-muted">تنسيق هذا العنصر ديناميكي؛ تعديله البصري يحتاج ربطًا أدق بالمصدر.</p> : null}<div className="studio-color-fields"><label>لون النص<input type="color" value={color} disabled={!styleWritable} onChange={event => {setColor(event.target.value);setChangedStyles(current => ({...current,color:true}));}}/></label><label>لون الخلفية<input type="color" value={backgroundColor} disabled={!styleWritable} onChange={event => {setBackgroundColor(event.target.value);setChangedStyles(current => ({...current,backgroundColor:true}));}}/></label></div><label>حجم الخط<span className="studio-number"><input aria-label="حجم الخط" type="number" min={8} max={96} value={fontSize} disabled={!styleWritable} onChange={event => {const value = Number(event.target.value);if(Number.isInteger(value) && value >= 8 && value <= 96){setFontSize(value);setChangedStyles(current => ({...current,fontSize:true}));}}}/><span>px</span></span></label><button className="primary-button" disabled={!writable || !dirty} onClick={() => void persist()}><Save size={15}/>حفظ التعديل</button>{dirty ? <button className="text-button" disabled={busy || offline} onClick={() => void load(session.id)}>إلغاء التجربة وإعادة التحميل</button> : null}</div></> : <div className="studio-inspector-empty"><MousePointer2 size={27}/><h4>اختر عنصرًا من الصفحة</h4><p>سيظهر هنا ملف المصدر وخصائص العنصر. التعديلات تظهر مباشرة قبل الحفظ.</p></div>}<div className="studio-review-actions"><button className="secondary-button" aria-pressed={compare} disabled={!writable} onClick={() => void toggleComparison()}><Columns2 size={15}/>مقارنة مع الأصل</button><button className="secondary-button" disabled={!writable || session.historyCount === 0} onClick={() => void persist(true)}><Undo2 size={15}/>التراجع عن آخر تعديل</button><button className="text-button" onClick={downloadFiles} disabled={busy}><Download size={15}/>تنزيل ملفات المراجعة</button></div><p className="studio-copy-note">الحفظ هنا يحدّث النسخة الخاصة فقط. يحتفظ الأصل بملفاته، ويمكنك تنزيل النتيجة للمراجعة.</p></aside></div>
      {preview?.warnings.length ? <details className="studio-warnings"><summary>حدود المعاينة ({preview.warnings.length})</summary><ul>{preview.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></details> : null}
      <StudioLivePanel session={session} offline={offline || busy || dirty} onSelect={element => {
        const mapped=preview?.elements.find(item=>item.id===element.id&&item.file===element.file&&item.line===element.line);
        if(!mapped||dirty){setNotice("حدّث نسخة المراجعة واختر عنصرًا مرتبطًا بالمصدر قبل تعديله.");return;}
        setSelected(mapped);setText(mapped.text??"");setChangedStyles({});setColor(colorControlValue(mapped.styles.color,"#172d2b"));setBackgroundColor(colorControlValue(mapped.styles.backgroundColor,"#ffffff"));setFontSize(Math.max(8,Math.min(96,Math.round(parseFloat(mapped.styles.fontSize))||24)));
      }}/>
      <StudioAiPanel session={session} selectedElementId={selected?.id} offline={offline || busy || dirty} onTaskCreated={onTaskCreated}/>
      <FileComparison session={session}/>
    </>}
  </section>;
}
