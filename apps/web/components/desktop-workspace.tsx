"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AppWindow, Camera, Code2, FilePlus2, FileText, Folder, FolderOpen, FolderPlus, HardDrive, Laptop, ListTodo, Maximize2, Minimize2, Play, RefreshCw, Save, Terminal, Trash2, X } from "lucide-react";
import styles from "./desktop-workspace.module.css";

/**
 * The desktop panel: projects, files, programs, windows and the screen on this computer.
 * Every button calls the same engine the chat uses, so a sentence in the chat and a click
 * here do exactly the same thing.
 */
type Template = { id: string; label: string; labelAr: string; descriptionAr: string; needsInstall: boolean };
type Status = { enabled: boolean; native?: boolean; projectsRoot?: string; roots?: string[]; screenshotsDir?: string; projects?: number; templates?: Template[]; apps?: { id: string; label: string; labelAr: string }[]; recent?: AuditEntry[] };
type Project = { id: string; name: string; path: string; template: string; createdAt: string; git: boolean; exists: boolean; display: string };
type Entry = { name: string; kind: "file" | "folder" | "link" | "other"; size: number; modifiedAt: string; hidden: boolean };
type Listing = { path: string; display: string; parent: string | null; entries: Entry[]; truncated: boolean; total: number };
type Content = { path: string; display: string; text: string; size: number; truncated: boolean; binary: boolean };
type WindowInfo = { handle: number; title: string; processName: string; minimized: boolean; foreground: boolean; width: number; height: number };
type ShellRun = { verdict: { level: "safe" | "dangerous" | "forbidden"; reasonAr: string }; cwd: string; result: { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean } | null };
type SystemInfo = { hostname: string; user: string; os: string; release: string; cpu: { model: string; cores: number }; memory: { totalBytes: number; freeBytes: number }; disks: { drive: string; label: string; totalBytes: number; freeBytes: number }[]; battery: { percent: number; charging: boolean | null } | null; gpus: string[]; uptimeSeconds: number };
type AuditEntry = { at: string; kind: string; detail: Record<string, unknown>; ok: boolean };
type CommandReply = { understood: boolean; label?: string; outcome: { status: "completed" | "partial" | "blocked" | "needs_approval"; text: string; approval?: { prompt: string; detail: string; label: string }; screenshot?: { file: string | null } } | null };

async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(parsed?.error?.message ?? "تعذر إتمام الطلب."), { status: response.status, code: parsed?.error?.code });
  return parsed as T;
}
const message = (caught: unknown) => (caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة.");
const bytes = (value: number) => (value <= 0 ? "0 B" : value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(0)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`);
const when = (value: string) => new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(value));
const auditLabel: Record<string, string> = { project_create: "إنشاء مشروع", project_adopt: "تسجيل مجلد كمشروع", project_forget: "إزالة مشروع من القائمة", file_read: "قراءة ملف", file_write: "كتابة ملف", folder_create: "إنشاء مجلد", move: "نقل", copy: "نسخ", recycle: "نقل إلى سلة المحذوفات", open_path: "فتح", open_url: "فتح رابط", reveal: "إظهار في المستكشف", launch: "تشغيل برنامج", open_editor: "فتح في المحرر", open_terminal: "فتح طرفية", shell: "تنفيذ أمر", shell_refused: "رفض أمر", window_focus: "تركيز نافذة", window_close: "إغلاق نافذة", window_minimize: "تصغير نافذة", window_maximize: "تكبير نافذة", screenshot: "لقطة شاشة", input_type: "كتابة", input_keys: "ضغط مفاتيح", input_click: "نقرة", click_element: "نقر عنصر", input_scroll: "تمرير", clipboard_set: "نسخ إلى الحافظة", error: "خطأ" };
const QUICK_APPS = ["notepad", "calculator", "explorer", "code", "terminal", "edge", "settings", "taskmgr"];
const SHORTCUTS: [string, string][] = [["المشاريع", "projects"], ["سطح المكتب", "desktop"], ["المستندات", "documents"], ["التنزيلات", "downloads"]];

export function DesktopWorkspace({ offline }: { offline: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [preview, setPreview] = useState<Content | null>(null);
  const [draft, setDraft] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [shot, setShot] = useState<{ url: string; file: string | null; at: string } | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [quick, setQuick] = useState("");
  const [quickReply, setQuickReply] = useState<CommandReply | null>(null);
  const [shell, setShell] = useState("");
  const [shellRun, setShellRun] = useState<ShellRun | null>(null);
  const [template, setTemplate] = useState("web");
  const mounted = useRef(true);
  const homeFolders = useRef<Record<string, string>>({});

  const browse = useCallback(async (path?: string) => {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const value = await api<Listing>(`/api/desktop/files${query}`);
    if (!mounted.current) return;
    setListing(value); setPathInput(value.path); setPreview(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const value = await api<Status>("/api/desktop");
      if (!mounted.current) return;
      setStatus(value);
      if (!value.enabled) return;
      setTemplates(value.templates ?? []);
      const [list, open, log] = await Promise.all([api<{ projects: Project[] }>("/api/desktop/projects"), api<{ windows: WindowInfo[] }>("/api/desktop/windows").catch(() => ({ windows: [] })), api<{ entries: AuditEntry[] }>("/api/desktop/audit?limit=40")]);
      if (!mounted.current) return;
      setProjects(list.projects); setWindows(open.windows); setAudit(log.entries);
      if (!listing && value.projectsRoot) {
        const home = value.roots?.find(root => /\\Users\\[^\\]+$/u.test(root)) ?? value.roots?.[1] ?? "";
        homeFolders.current = { projects: value.projectsRoot, desktop: `${home}\\Desktop`, documents: `${home}\\Documents`, downloads: `${home}\\Downloads` };
        await browse(value.projectsRoot).catch(() => browse());
      }
      setError("");
    } catch (caught) { if (mounted.current) setError(message(caught)); }
  }, [browse, listing]);

  useEffect(() => { mounted.current = true; if (!offline) void load(); return () => { mounted.current = false; }; }, [load, offline]);

  async function act(label: string, operation: () => Promise<string | void>, refresh = true) {
    if (busy || offline) return;
    setBusy(label); setError(""); setNotice("");
    try { const said = await operation(); if (said) setNotice(said); if (refresh) await load(); }
    catch (caught) { setError(message(caught)); }
    finally { if (mounted.current) setBusy(""); }
  }

  async function runQuick(event: FormEvent, approved = false) {
    event.preventDefault();
    const text = quick.trim();
    if (!text) return;
    await act("quick", async () => {
      const reply = await api<CommandReply>("/api/desktop/command", { text, approved });
      setQuickReply(reply);
      if (reply.outcome?.screenshot) await refreshScreenshot();
      if (listing) await browse(listing.path).catch(() => undefined);
    });
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const name = String(form.get("name") ?? "").trim();
    if (!name) return;
    await act("project", async () => {
      const created = await api<Project & { files: string[]; install: string }>("/api/desktop/projects", { name, template, parent: String(form.get("parent") ?? "").trim() || undefined, git: form.get("git") === "on", install: form.get("install") === "on", open: form.get("open") === "on" ? "editor" : "none", description: String(form.get("description") ?? "").trim() || undefined });
      (event.target as HTMLFormElement).reset?.();
      await browse(created.path).catch(() => undefined);
      return `أُنشئ المشروع «${created.name}» (${created.files.length} ملفات) في ${created.display}.`;
    });
  }

  async function openProject(project: Project, target: "folder" | "editor" | "terminal") {
    await act(`open-${project.id}`, async () => { await api(`/api/desktop/projects/${project.id}/open`, { target }); return target === "folder" ? "فُتح مجلد المشروع." : target === "editor" ? "فُتح المشروع في المحرر." : "فُتحت طرفية داخل المشروع."; }, false);
  }

  async function openPreview(entry: Entry) {
    if (!listing) return;
    const path = `${listing.path}\\${entry.name}`;
    if (entry.kind === "folder") { await act("browse", () => browse(path), false); return; }
    await act("read", async () => { const content = await api<Content>(`/api/desktop/files/content?path=${encodeURIComponent(path)}`); setPreview(content); setDraft(content.text); }, false);
  }

  async function savePreview() {
    if (!preview) return;
    await act("save", async () => { await api("/api/desktop/files", { op: "write", path: preview.path, content: draft, overwrite: true }); const content = await api<Content>(`/api/desktop/files/content?path=${encodeURIComponent(preview.path)}`); setPreview(content); return `حُفظ ${content.display}.`; });
  }

  async function newEntry(kind: "file" | "folder") {
    if (!listing) return;
    const name = window.prompt(kind === "file" ? "اسم الملف الجديد:" : "اسم المجلد الجديد:")?.trim();
    if (!name) return;
    await act("new", async () => {
      const path = `${listing.path}\\${name}`;
      if (kind === "file") await api("/api/desktop/files", { op: "write", path, content: "" }); else await api("/api/desktop/files", { op: "mkdir", path });
      await browse(listing.path);
      return kind === "file" ? `أُنشئ الملف ${name}.` : `أُنشئ المجلد ${name}.`;
    });
  }

  async function recycle(path: string, name: string) {
    if (!window.confirm(`نقل «${name}» إلى سلة المحذوفات؟ يمكنك استعادته من هناك.`)) return;
    await act("recycle", async () => { await api("/api/desktop/files", { op: "recycle", path }); setPreview(null); if (listing) await browse(listing.path); return `نُقل «${name}» إلى سلة المحذوفات.`; });
  }

  async function runShell(event: FormEvent, approved = false) {
    event.preventDefault();
    const command = shell.trim();
    if (!command) return;
    await act("shell", async () => {
      const run = await api<ShellRun>("/api/desktop/shell", { command, cwd: listing?.path, approved });
      setShellRun(run);
      if (run.verdict.level === "forbidden") return `لن يُنفَّذ هذا الأمر: ${run.verdict.reasonAr}.`;
      if (!run.result) return undefined;
      if (listing) await browse(listing.path).catch(() => undefined);
      return run.result.timedOut ? "انتهت مهلة الأمر." : `انتهى الأمر برمز ${run.result.exitCode} خلال ${(run.result.durationMs / 1000).toFixed(1)} ث.`;
    });
  }

  async function windowAction(item: WindowInfo, action: "focus" | "close" | "minimize" | "maximize") {
    await act(`win-${item.handle}-${action}`, async () => { await api("/api/desktop/windows", { handle: item.handle, action }); return undefined; });
  }

  async function refreshScreenshot() {
    const response = await fetch("/api/desktop/screenshot?save=true&maxWidth=1600", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "تعذر التقاط الشاشة.");
    const meta = JSON.parse(response.headers.get("x-desktop-capture") ?? "{}") as { file?: string | null; capturedAt?: string };
    const blob = await response.blob();
    setShot(previous => { if (previous) URL.revokeObjectURL(previous.url); return { url: URL.createObjectURL(blob), file: meta.file ?? null, at: meta.capturedAt ?? new Date().toISOString() }; });
  }

  async function launch(id: string) { await act(`app-${id}`, async () => { await api("/api/desktop/open", { kind: "app", name: id }); return "شُغّل البرنامج."; }); }
  async function loadSystem() { await act("system", async () => { setSystem(await api<SystemInfo>("/api/desktop/system")); }, false); }

  if (status && !status.enabled) return <section className={styles.workspace} aria-label="سطح المكتب"><div className={styles.disabled}><Laptop size={36} /><h3>محرك سطح المكتب يعمل على جهاز المالك فقط.</h3><p>شغّل موحسن من تطبيق سطح المكتب أو من أمر التشغيل المحلي على جهاز Windows، وسيظهر هنا كل ما يخص المشاريع والملفات والنوافذ.</p></div></section>;

  const foreground = windows.find(item => item.foreground);
  return <section className={styles.workspace} aria-label="سطح المكتب">
    <div className={styles.intro}><div><span>DESKTOP</span><h2>جهازك بين يديك.</h2><p>اكتب ما تريد بجملة واحدة، أو استعمل الأزرار: مشاريع جاهزة بقوالب، ملفات ومجلدات، برامج ونوافذ، لقطة شاشة، وأوامر طرفية. الحذف يذهب إلى سلة المحذوفات، والأوامر الخطرة تسأل أولًا.</p></div>
      <dl><dt>مجلد المشاريع</dt><dd>{status?.projectsRoot ?? "…"}</dd><dt>لقطات الشاشة</dt><dd>{status?.screenshotsDir ?? "…"}</dd><dt>التحكم بالنوافذ</dt><dd>{status ? status.native ? "متاح" : "غير متاح على هذا النظام" : "…"}</dd></dl></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{notice ? <p className={styles.notice} role="status">{notice}</p> : null}

    <div className={styles.card}><h3><Play size={16} />أمر سريع<small>المحلل نفسه الذي تستعمله المحادثة</small></h3>
      <form className={styles.command} onSubmit={event => void runQuick(event)}>
        <textarea value={quick} onChange={event => setQuick(event.target.value)} placeholder="مثال: أنشئ مشروع ويب اسمه متجري · أنشئ ملف ملاحظات.txt في سطح المكتب بمحتوى: مرحبا · ما النوافذ المفتوحة؟ · خذ لقطة شاشة · افتح المفكرة" disabled={offline || busy === "quick"} dir="auto" />
        <button type="submit" className="primary-button" disabled={offline || !quick.trim() || Boolean(busy)}>{busy === "quick" ? "يعمل…" : "نفّذ"}</button>
      </form>
      {quickReply ? quickReply.understood && quickReply.outcome ? <>
        <div className={styles.result} dir="auto">{quickReply.outcome.text}</div>
        {quickReply.outcome.status === "needs_approval" && quickReply.outcome.approval ? <div className={styles.approval}><span>{quickReply.outcome.approval.prompt}</span><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={event => void runQuick(event as unknown as FormEvent, true)}>نعم، نفّذ</button><button type="button" className="secondary-button" onClick={() => setQuickReply(null)}>لا</button></div> : null}
      </> : <p className={styles.hint}>لم أفهم هذه الجملة كأمر على الجهاز. جرّب صيغة مثل «أنشئ ملف X في Y» أو «افتح المفكرة» أو «ما النوافذ المفتوحة».</p> : null}
    </div>

    <div className={styles.grid}>
      <form className={styles.card} onSubmit={event => void createProject(event)}><h3><FolderPlus size={16} />مشروع جديد</h3>
        <label className={styles.field}>اسم المشروع<input name="name" required maxLength={100} placeholder="مثال: متجري" disabled={offline} dir="auto" /></label>
        <div className={styles.templates}>{templates.map(item => <button type="button" key={item.id} className={item.id === template ? styles.templateSelected : styles.template} onClick={() => setTemplate(item.id)}><strong>{item.labelAr}</strong><small>{item.descriptionAr}</small></button>)}</div>
        <label className={styles.field}>وصف قصير <span>(اختياري)</span><input name="description" maxLength={500} placeholder="يُكتب في README والصفحة الأولى" dir="auto" /></label>
        <label className={styles.field}>المجلد الأب <span>(اختياري، الافتراضي مجلد المشاريع)</span><input name="parent" maxLength={1024} placeholder={status?.projectsRoot ?? ""} dir="ltr" /></label>
        <div className={styles.checks}><label><input type="checkbox" name="git" defaultChecked />مستودع Git بأول حفظ</label><label><input type="checkbox" name="open" />افتحه في المحرر</label>{templates.find(item => item.id === template)?.needsInstall ? <label><input type="checkbox" name="install" />شغّل npm install (دقائق)</label> : null}</div>
        <div className={styles.row}><button type="submit" className="primary-button" disabled={offline || Boolean(busy)}>{busy === "project" ? "يُنشأ…" : "أنشئ المشروع"}</button></div>
      </form>
      <div className={styles.card}><h3><ListTodo size={16} />المشاريع<small>{projects.length}</small></h3>
        {projects.length ? <ul className={styles.projects}>{projects.map(project => <li key={project.id} className={styles.project}><Folder size={18} /><div><strong dir="auto">{project.name}</strong><small>{project.display}{project.exists ? "" : " — المجلد غير موجود"}</small></div>
          <div className={styles.actions}><button type="button" className={styles.mini} disabled={!project.exists || Boolean(busy)} onClick={() => void openProject(project, "folder")}><FolderOpen size={13} />المجلد</button><button type="button" className={styles.mini} disabled={!project.exists || Boolean(busy)} onClick={() => void openProject(project, "editor")}><Code2 size={13} />المحرر</button><button type="button" className={styles.mini} disabled={!project.exists || Boolean(busy)} onClick={() => void openProject(project, "terminal")}><Terminal size={13} />طرفية</button><button type="button" className={styles.mini} disabled={!project.exists || Boolean(busy)} onClick={() => void act("browse", () => browse(project.path), false)}><FileText size={13} />الملفات</button><button type="button" className={`${styles.mini} ${styles.danger}`} disabled={Boolean(busy)} onClick={() => void act("forget", async () => { await api(`/api/desktop/projects/${project.id}/forget`, {}); return "أُزيل من القائمة دون حذف ملفاته."; })}><X size={13} /></button></div></li>)}</ul>
          : <p className={styles.hint}>لا مشاريع بعد. أنشئ واحدًا من النموذج، أو قل في المحادثة: «أنشئ مشروع ويب اسمه متجري».</p>}
      </div>
    </div>

    <div className={styles.card}><h3><HardDrive size={16} />الملفات<small>{listing ? `${listing.total} عنصرًا` : ""}</small></h3>
      <div className={styles.pathBar}><input value={pathInput} onChange={event => setPathInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void act("browse", () => browse(pathInput), false); } }} aria-label="المسار" />
        <button type="button" className={styles.mini} disabled={Boolean(busy)} onClick={() => void act("browse", () => browse(pathInput), false)}>اذهب</button>
        <button type="button" className={styles.mini} disabled={!listing?.parent || Boolean(busy)} onClick={() => listing?.parent && void act("browse", () => browse(listing.parent!), false)}>↑ الأعلى</button>
        <button type="button" className={styles.mini} disabled={!listing || Boolean(busy)} onClick={() => listing && void act("browse", () => browse(listing.path), false)}><RefreshCw size={13} /></button></div>
      <div className={styles.shortcuts}>{SHORTCUTS.map(([label, key]) => <button key={key} type="button" className={styles.chip} disabled={Boolean(busy)} onClick={() => { const target = homeFolders.current[key]; if (target) void act("browse", () => browse(target), false); }}>{label}</button>)}
        <button type="button" className={styles.chip} disabled={!listing || Boolean(busy)} onClick={() => void newEntry("file")}><FilePlus2 size={13} />ملف جديد</button><button type="button" className={styles.chip} disabled={!listing || Boolean(busy)} onClick={() => void newEntry("folder")}><FolderPlus size={13} />مجلد جديد</button>
        <button type="button" className={styles.chip} disabled={!listing || Boolean(busy)} onClick={() => listing && void act("reveal", async () => { await api("/api/desktop/open", { kind: "path", target: listing.path }); return "فُتح المجلد في مستكشف الملفات."; }, false)}><FolderOpen size={13} />افتح في المستكشف</button>
        <button type="button" className={styles.chip} disabled={!listing || Boolean(busy)} onClick={() => listing && void act("terminal", async () => { await api("/api/desktop/open", { kind: "terminal", target: listing.path }); return "فُتحت طرفية هنا."; }, false)}><Terminal size={13} />طرفية هنا</button></div>
      <div className={styles.browser}>
        <ul className={styles.entries}>{listing?.entries.length ? listing.entries.map(entry => <li key={entry.name}><button type="button" className={`${styles.entry} ${preview?.path === `${listing.path}\\${entry.name}` ? styles.entrySelected : ""}`} onClick={() => void openPreview(entry)}>{entry.kind === "folder" ? <Folder size={15} /> : <FileText size={15} />}<span>{entry.name}</span><small>{entry.kind === "file" ? bytes(entry.size) : ""}</small></button></li>) : <li className={styles.previewEmpty}>{listing ? "المجلد فارغ." : "جارٍ القراءة…"}</li>}</ul>
        <div className={styles.preview}>{preview ? <>
          <header><FileText size={14} /><code>{preview.display}</code><small>{bytes(preview.size)}{preview.truncated ? " (مقتطع)" : ""}</small></header>
          {preview.binary ? <p className={styles.hint}>ملف ثنائي؛ لا يُعرض كنص.</p> : <textarea className={styles.textarea} value={draft} onChange={event => setDraft(event.target.value)} rows={14} dir="auto" />}
          <div className={styles.row}><button type="button" className="primary-button" disabled={preview.binary || preview.truncated || Boolean(busy) || draft === preview.text} onClick={() => void savePreview()}><Save size={14} />حفظ</button>
            <button type="button" className={styles.mini} disabled={Boolean(busy)} onClick={() => void act("openfile", async () => { await api("/api/desktop/open", { kind: "path", target: preview.path }); return "فُتح الملف بالبرنامج الافتراضي."; }, false)}>فتح</button>
            <button type="button" className={styles.mini} disabled={Boolean(busy)} onClick={() => void act("editor", async () => { await api("/api/desktop/open", { kind: "editor", target: preview.path }); return "فُتح في المحرر."; }, false)}><Code2 size={13} />المحرر</button>
            <button type="button" className={`${styles.mini} ${styles.danger}`} disabled={Boolean(busy)} onClick={() => void recycle(preview.path, preview.display)}><Trash2 size={13} />سلة المحذوفات</button></div>
        </> : <div className={styles.previewEmpty}>اختر ملفًا لعرضه وتعديله هنا.</div>}</div>
      </div>
    </div>

    <div className={styles.grid}>
      <div className={styles.card}><h3><Terminal size={16} />الطرفية<small>{listing ? `في ${listing.display}` : ""}</small></h3>
        <form onSubmit={event => void runShell(event)}><textarea className={styles.textarea} value={shell} onChange={event => setShell(event.target.value)} placeholder="npm test · git status · dir" rows={3} />
          <div className={styles.row} style={{ marginTop: 8 }}><button type="submit" className="primary-button" disabled={offline || !shell.trim() || Boolean(busy)}>{busy === "shell" ? "يعمل…" : "نفّذ"}</button><span className={styles.hint}>الأوامر الخطرة (حذف، إيقاف، نشر) تسأل أولًا؛ أوامر النظام ممنوعة.</span></div></form>
        {shellRun && shellRun.verdict.level === "dangerous" && !shellRun.result ? <div className={styles.approval}><span>هذا الأمر {shellRun.verdict.reasonAr}. تنفّذه؟</span><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={event => void runShell(event as unknown as FormEvent, true)}>نعم، نفّذ</button><button type="button" className="secondary-button" onClick={() => setShellRun(null)}>لا</button></div> : null}
        {shellRun?.result ? <pre className={styles.output}>{`$ ${shell}\n${shellRun.result.stdout}${shellRun.result.stderr ? `\n${shellRun.result.stderr}` : ""}`.trim() || "(لا مخرجات)"}</pre> : null}
      </div>
      <div className={styles.card}><h3><AppWindow size={16} />النوافذ المفتوحة<small>{windows.length}{foreground ? ` · النشطة: ${foreground.title.slice(0, 30)}` : ""}</small></h3>
        <ul className={styles.windows}>{windows.map(item => <li key={item.handle} className={`${styles.window} ${item.foreground ? styles.foreground : ""}`}><strong>{item.title}</strong><small>{item.processName}{item.minimized ? " · مصغّرة" : ""}</small>
          <button type="button" className={styles.mini} disabled={Boolean(busy)} onClick={() => void windowAction(item, "focus")} aria-label="تركيز"><Maximize2 size={12} />تركيز</button><button type="button" className={styles.mini} disabled={Boolean(busy)} onClick={() => void windowAction(item, "minimize")} aria-label="تصغير"><Minimize2 size={12} /></button><button type="button" className={`${styles.mini} ${styles.danger}`} disabled={Boolean(busy)} onClick={() => void windowAction(item, "close")} aria-label="إغلاق"><X size={12} /></button></li>)}</ul>
        <div className={styles.row}><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void act("windows", async () => { setWindows((await api<{ windows: WindowInfo[] }>("/api/desktop/windows")).windows); }, false)}><RefreshCw size={14} />تحديث</button>
          <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void act("shot", async () => { await refreshScreenshot(); return "التُقطت الشاشة وحُفظت."; }, false)}><Camera size={14} />لقطة شاشة</button></div>
        {shot ? <div className={styles.shot}><img src={shot.url} alt="لقطة الشاشة" /><small>{when(shot.at)}{shot.file ? ` · ${shot.file}` : ""}</small></div> : null}
      </div>
    </div>

    <div className={styles.grid}>
      <div className={styles.card}><h3><Play size={16} />برامج سريعة</h3><div className={styles.apps}>{(status?.apps ?? []).filter(app => QUICK_APPS.includes(app.id)).map(app => <button key={app.id} type="button" className={styles.chip} disabled={Boolean(busy)} onClick={() => void launch(app.id)}>{app.labelAr}</button>)}</div>
        <p className={styles.hint}>في المحادثة: «افتح المفكرة»، «شغّل الحاسبة»، «افتح مجلد التنزيلات».</p></div>
      <div className={styles.card}><h3><Laptop size={16} />معلومات الجهاز</h3>{system ? <dl className={styles.facts}><dt>الجهاز</dt><dd>{system.hostname} · {system.os} {system.release}</dd><dt>المعالج</dt><dd>{system.cpu.model} ({system.cpu.cores})</dd><dt>الذاكرة</dt><dd>{bytes(system.memory.freeBytes)} حرة من {bytes(system.memory.totalBytes)}</dd>{system.disks.map(disk => <span key={disk.drive} style={{ display: "contents" }}><dt>القرص {disk.drive}</dt><dd>{bytes(disk.freeBytes)} حرة من {bytes(disk.totalBytes)}</dd></span>)}{system.gpus.length ? <><dt>الرسوم</dt><dd>{system.gpus.join("، ")}</dd></> : null}{system.battery ? <><dt>البطارية</dt><dd>{system.battery.percent}%{system.battery.charging ? " (تشحن)" : ""}</dd></> : null}</dl> : <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadSystem()}>اقرأ المواصفات</button>}</div>
    </div>

    <div className={styles.card}><h3><ListTodo size={16} />آخر الإجراءات<small>{audit.length}</small></h3>
      {audit.length ? <ol className={styles.audit}>{audit.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.ok ? "" : styles.failed}><strong>{auditLabel[entry.kind] ?? entry.kind}</strong><span>{String(entry.detail.path ?? entry.detail.name ?? entry.detail.command ?? entry.detail.title ?? entry.detail.app ?? entry.detail.message ?? "")}</span><time dateTime={entry.at}>{when(entry.at)}</time></li>)}</ol> : <p className={styles.hint}>لا إجراءات بعد.</p>}
    </div>
  </section>;
}
