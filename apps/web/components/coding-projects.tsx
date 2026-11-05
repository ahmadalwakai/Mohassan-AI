"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { Code2, FolderGit2, Plus, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { ProjectSchema, RegisterProjectSchema, type CodingWorkspace, type Project } from "@mohassan/contracts";

async function saveProject(path: string, body: unknown, signal: AbortSignal): Promise<Project> {
  const response = await fetch(path, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "object" && data.error !== null && "message" in data.error && typeof data.error.message === "string" ? data.error.message : "تعذر حفظ المشروع. تحقق من النطاق المسموح وأعد تحديث القائمة.";
    throw new Error(message);
  }
  const parsed = ProjectSchema.safeParse(data);
  if (!parsed.success) throw new Error("وصل رد مشروع غير صالح. أعد تحديث القائمة قبل تكرار الطلب.");
  return parsed.data;
}

export function CodingProjects({ coding, offline, onProjectAdded, onRefresh }: { coding?: CodingWorkspace; offline: boolean; onProjectAdded: (project: Project) => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState<"demo" | "register" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const registerForm = useRef<HTMLFormElement>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function save(kind: "demo" | "register", body: unknown) {
    if (busy || pending.current || offline) return;
    const controller = new AbortController();
    pending.current = controller; setBusy(kind); setError(""); setNotice("");
    try {
      const project = await saveProject(kind === "demo" ? "/api/coding/projects/demo" : "/api/coding/projects", body, controller.signal);
      if (!controller.signal.aborted) {
        onProjectAdded(project); setNotice(kind === "demo" ? "أُنشئ المشروع التجريبي. يمكنك اختياره في مهمة برمجة عند توفر العزل." : "سُجل المشروع ونطاق ملفاته. لم يبدأ أي تشغيل.");
        if (kind === "register") registerForm.current?.reset();
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error && !(caught instanceof TypeError) ? caught.message : "تعذر الاتصال. حدّث قائمة المشاريع قبل تكرار الإنشاء لأن الطلب السابق قد يكون حُفظ.");
    } finally {
      if (!controller.signal.aborted) { setBusy(null); onRefresh(); }
      if (pending.current === controller) pending.current = null;
    }
  }

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = RegisterProjectSchema.safeParse({ name: String(data.get("name") ?? "").trim(), path: String(data.get("path") ?? "").trim(), allowedPaths: String(data.get("allowedPaths") ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean) });
    if (!parsed.success) { setError("أدخل اسم المشروع ومسار المستودع، ومن ملف واحد إلى خمسة ملفات نسبية مسموحة."); return; }
    void save("register", parsed.data);
  }

  if (!coding) return <section className="panel coding-unavailable"><span className="empty-icon"><FolderGit2 size={26} /></span><h2>خدمة مشاريع البرمجة غير متاحة الآن</h2><p>أعد تحميل حالتها من الخادم. لن يبدأ تشغيل أي كود دون بيئة عزل متاحة.</p><Button variant="outline" onClick={onRefresh} disabled={offline}><RefreshCw size={15} />تحديث الحالة</Button></section>;

  return <div className="coding-projects" aria-label="مشاريع البرمجة">
    <section className={`coding-sandbox-status ${coding.sandbox.available ? "sandbox-ready" : "sandbox-blocked"}`} aria-label="حالة عزل البرمجة"><ShieldCheck size={23} /><div><h2>{coding.sandbox.available ? "بيئة العزل متاحة" : "تشغيل الكود متوقف لعدم توفر العزل"}</h2><p>{coding.sandbox.message}</p>{coding.sandbox.provider ? <small>المزوّد: <code dir="ltr">{coding.sandbox.provider}</code></small> : null}</div><span className="subtle-badge">{coding.sandbox.available ? "متاحة" : "لا تنفيذ"}</span></section>
    <section className="panel coding-project-controls"><div className="panel-heading"><div><h2>ابدأ بمشروع محدد</h2><p>النسخة الأولى تستخدم اختبارات Node المدمجة، داخل نسخة عمل معزولة وبموافقة صريحة.</p></div><Button className="primary-button" loading={busy === "demo"} disabled={offline || busy !== null} onClick={() => { void save("demo", {}); }}><Plus size={16} />إنشاء مشروع تجريبي</Button></div><div className="coding-profile-note"><Terminal size={17} /><p>لا تثبيت لاعتماديات أو إدخال أوامر تشغيل حرة. كتابة التعديل وتشغيل الاختبار يحتاجان موافقة حتى عند اختيار التنفيذ ضمن النطاق.</p></div>
      <details className="coding-register"><summary>تسجيل مستودع محلي</summary><p>أدخل بنفسك مسار مستودع Git داخل المجلدات المسموح بها في الخادم. التسجيل يحدد نطاق المشروع ولا يبدأ تعديلًا أو اختبارًا.</p><form ref={registerForm} onSubmit={register} className="stack-form"><label>اسم مشروع البرمجة<input name="name" required minLength={2} maxLength={100} disabled={busy !== null} placeholder="اسم واضح للمشروع" /></label><label>مسار المستودع المحلي<input name="path" dir="ltr" required minLength={3} maxLength={500} disabled={busy !== null} placeholder="C:\MyProjects\example" autoComplete="off" /></label><label>الملفات المسموح بتعديلها<textarea name="allowedPaths" dir="ltr" required rows={3} maxLength={910} disabled={busy !== null} placeholder={"src/index.js\nsrc/helpers.js"} /><small>مسار نسبي لكل سطر، من ملف واحد إلى خمسة ملفات محددة؛ لا تمنح وصولًا إلى المستودع كله.</small></label><Button type="submit" className="primary-button" loading={busy === "register"} disabled={offline || busy !== null}>تسجيل المشروع<FolderGit2 size={16} /></Button></form></details>
    </section>
    {busy ? <p className="coding-action-status" role="status"><Spinner size="sm" />{busy === "demo" ? "جارٍ إنشاء المشروع التجريبي وحفظ نطاقه…" : "جارٍ التحقق من المستودع ونطاق الملفات…"}</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{notice ? <p className="coding-success-note" role="status">{notice}</p> : null}
    <div className="section-heading coding-project-heading"><div><span className="eyebrow">نطاق واضح لكل تغيير</span><h2>المشاريع المسجلة <span className="count-label">{coding.projects.length}</span></h2></div><button className="text-button" onClick={onRefresh} disabled={offline || busy !== null}><RefreshCw size={14} />تحديث</button></div>
    {coding.projects.length === 0 ? <section className="panel"><div className="empty-state"><span className="empty-icon"><FolderGit2 size={27} /></span><h3>لا توجد مشاريع برمجة مسجلة</h3><p>أنشئ المشروع التجريبي، أو سجل مستودعًا محليًا بنطاق ملفات صريح، ثم اختره داخل مهمة جديدة.</p></div></section> : <div className="coding-project-grid">{coding.projects.map((project) => <article className="coding-project-card" key={project.id}><div className="coding-project-title"><span className="tool-icon"><Code2 size={23} /></span><div><h3>{project.name}</h3><span className="subtle-badge">اختبارات Node المدمجة</span></div></div><p className="coding-project-path" dir="ltr">{project.path}</p><div className="coding-project-files"><h4>نطاق الملفات</h4><ul>{project.allowedPaths.map((path) => <li key={path}><code dir="ltr">{path}</code></li>)}</ul></div><div className="coding-project-revision"><span>إصدار الأساس عند التسجيل</span><code dir="ltr" title={project.baseCommit}>{project.baseCommit.slice(0, 12)}</code></div><p className="coding-project-hint">اختر قدرة البرمجة من القدرات المتاحة داخل «مهمة جديدة». لا تعديل للمستودع الأصلي ولا دمج من هذه الشاشة.</p></article>)}</div>}
  </div>;
}
