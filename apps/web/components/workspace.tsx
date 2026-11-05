"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Spinner } from "@chakra-ui/react";
import { motion } from "motion/react";
import dynamic from "next/dynamic";
import {
  Activity, ArrowLeft, ArrowUpLeft, Bell, Boxes, Check, CheckCheck,
  ChevronLeft, CircleHelp, Code2, Database, Fingerprint, Globe2,
  LayoutDashboard, ListTodo, LoaderCircle, LogOut, Menu, MessageCircle, Monitor, Plus,
  RefreshCw, Search, ShieldCheck, Sparkles, Terminal, Unplug,
  Workflow, X, Zap, type LucideIcon,
} from "lucide-react";
import { BrowserTaskInputSchema, browserReadOrigins, detectBrowserOpenIntent, type Autonomy, type Capability, type CodingWorkspace, type Integration, type Task, type TaskEvent, type TaskStatus, type WorkspaceSnapshot } from "@mohassan/contracts";
import { PlanningResultView } from "./planning-result";
import { AiConnection } from "./ai-connection";
import { CodingProjects } from "./coding-projects";
import { CodingResultView } from "./coding-result";
import { BrowserOpenResult } from "./browser-open-result";
import browserStyles from "./browser-open-result.module.css";

const StudioAiResult = dynamic(() => import("./studio-ai-panel").then(module => module.StudioAiResult));
const VisualStudio = dynamic(() => import("./visual-studio").then(module => module.VisualStudio));
const BrowserWorkspace = dynamic(() => import("./browser-workspace").then(module => module.BrowserWorkspace));
const MemoryWorkspace = dynamic(() => import("./memory-workspace").then(module => module.MemoryWorkspace));
const WindowsWorkspace = dynamic(() => import("./windows-workspace").then(module => module.WindowsWorkspace));
const AssistantApp = dynamic(() => import("./assistant-app").then(module => module.AssistantApp));

type View = "chat" | "overview" | "tasks" | "browser" | "memory" | "windows" | "studio" | "coding" | "capabilities" | "integrations" | "roadmap";
type Session = { user: { id: string; name: string; email: string } };
type Detail = { task: Task; events: TaskEvent[] };

const statusText: Record<TaskStatus, string> = {
  queued: "في الانتظار", running: "قيد التنفيذ", waiting_approval: "بانتظار موافقتك",
  verifying: "جارٍ التحقق", completed: "مكتملة", failed: "تعذرت", cancelled: "ملغاة", paused: "متوقفة مؤقتًا",
};
const autonomyText: Record<Autonomy, string> = { assisted: "بموافقتك", scoped: "تنفيذ ضمن النطاق", shadow: "اقتراح فقط" };
const terminal = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const navigation: { id: View; title: string; icon: LucideIcon }[] = [
  { id: "chat", title: "المحادثة", icon: MessageCircle },
  { id: "overview", title: "نظرة عامة", icon: LayoutDashboard },
  { id: "tasks", title: "المهام والتنفيذ", icon: ListTodo },
  { id: "coding", title: "مشاريع البرمجة", icon: Code2 },
  { id: "studio", title: "الاستوديو البصري", icon: Monitor },
  { id: "browser", title: "المتصفح والبحث", icon: Globe2 },
  { id: "memory", title: "الذاكرة والتعلّم", icon: Sparkles },
  { id: "windows", title: "التحكم بالكمبيوتر", icon: Monitor },
  { id: "capabilities", title: "القدرات والأدوات", icon: Boxes },
  { id: "integrations", title: "الاتصالات", icon: Globe2 },
  { id: "roadmap", title: "خطة البناء", icon: Workflow },
];
const phases = [
  ["البنية الأساسية", "التطبيق والمصادقة والعقود وقاعدة البيانات"],
  ["محرك التنفيذ", "المهام الدائمة والصلاحيات والأحداث والتحقق"],
  ["الذكاء التنفيذي", "الأهداف والتخطيط وتوجيه النماذج"],
  ["مختبر البرمجة", "بيئات معزولة واختبارات ونقاط استعادة"],
  ["الاستوديو البصري", "المعاينة واختيار العناصر ومقارنة التعديلات"],
  ["المتصفح والبحث", "جلسات مستقلة ومصادر موثقة"],
  ["الذاكرة والتعلّم", "أدلة ومهارات وتقييم قابل للقياس"],
  ["التحكم في Windows", "ربط آمن للأجهزة وبث الشاشة"],
  ["تطبيق iPhone", "متابعة المهام والموافقات والتحكم"],
  ["خبير Google Ads", "تحليل الحملات والتحويلات وتحسين الإنفاق"],
  ["الموثوقية والأمان", "المراقبة والنسخ والاستعادة"],
  ["الإصدار الإنتاجي", "اختبارات متكاملة ونشر وتشغيل"],
];

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options, cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 429 ? "طلبات متتابعة كثيرة. انتظر قليلًا ثم أعد المحاولة." : body?.error?.message ?? (typeof body?.message === "string" ? body.message : "تعذر إتمام الطلب. حاول مجددًا.");
    throw new ApiError(message, response.status);
  }
  return body as T;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "تعذر الاتصال بالخدمة. تأكد من تشغيلها وحاول مجددًا.";
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "brand-compact" : ""}`}><div className="brand-mark"><Sparkles size={24} strokeWidth={1.6} /></div><div><strong dir="ltr">Mohassan<span> AI</span></strong><small>مساحة عملك الذكية</small></div></div>;
}

function Empty({ icon: Icon = ListTodo, title, children }: { icon?: LucideIcon; title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={26} strokeWidth={1.5} /></span><h3>{title}</h3><p>{children}</p></div>;
}

function Status({ status, capabilityId, autonomy, goal }: { status: TaskStatus; capabilityId?: string; autonomy: Autonomy; goal?: string }) {
  const label = status === "completed" && autonomy === "shadow" ? "اكتمل الاقتراح" : status === "completed" && capabilityId === "browser.open" ? "فُتحت الصفحة" : status === "completed" && capabilityId === "system.diagnostic" && goal && detectBrowserOpenIntent(goal) ? "اكتمل التشخيص فقط" : status === "completed" && ["coding.change", "studio.change"].includes(capabilityId ?? "") ? "جاهز للمراجعة" : capabilityId === "plan.draft" ? status === "completed" ? "اكتمل إعداد الخطة" : status === "running" ? "جارٍ إعداد الخطة" : status === "verifying" ? "جارٍ التحقق من الخطة" : statusText[status] : statusText[status];
  return <Badge className={`status status-${status}`}><span className="status-dot" />{label}</Badge>;
}

const checkLabels: Record<string, string> = {
  database: "اتصال قاعدة البيانات",
  capability_registry: "جاهزية سجل القدرات",
  permission_scope: "نطاق صلاحية القراءة",
};
const checkEvidence: Record<string, string> = {
  database: "استجابت قاعدة البيانات لطلب اختبار الاتصال.",
  capability_registry: "أداة التشخيص مسجلة ومتاحة للتنفيذ.",
  permission_scope: "اقتصرت العملية على صلاحية القراءة المحددة.",
};

function TaskResult({ result, capabilityId, goal, offline = false, onChanged, onOpenBrowser }: { result: Record<string, unknown>; capabilityId: string; goal?: string; offline?: boolean; onChanged?: () => void; onOpenBrowser?: (sessionId: string) => void }) {
  if (result.kind === "browser_open") return <BrowserOpenResult result={result} onOpenBrowser={onOpenBrowser} />;
  if (result.kind === "plan") return <PlanningResultView result={result} />;
  if (result.kind === "coding") return <CodingResultView result={result} />;
  if (result.kind === "studio_change") return <StudioAiResult result={result} offline={offline} onApplied={() => { onChanged?.(); window.dispatchEvent(new CustomEvent("mohassan-studio-applied", { detail: result.sessionId })); }} />;
  const summary = typeof result.summary === "string" ? result.summary : "حُفظت النتيجة بعد التحقق منها.";
  const checks = Array.isArray(result.checks) ? result.checks.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
  const proposed = Array.isArray(result.proposedChecks) ? result.proposedChecks.filter((item): item is string => typeof item === "string") : [];
  return <section className="result-box"><h3><CheckCheck size={18} />{result.kind === "shadow" ? "اقتراح المهمة" : "نتيجة المهمة"}</h3>{capabilityId === "system.diagnostic" && goal && detectBrowserOpenIntent(goal) ? <p className="inline-error" role="alert">اكتمل تشخيص الخدمة فقط. هذا السجل لا يثبت فتح الصفحة أو التقاط صورة لها. أنشئ مهمة بقدرة فتح الصفحة في المتصفح لتنفيذ طلبك.</p> : null}<p className="result-summary">{summary}</p>{result.kind === "shadow" ? <><p className="shadow-notice"><ShieldCheck size={15} />{capabilityId === "browser.open" ? "وضع الاقتراح: لم تُفتح الصفحة ولم تُلتقط صورة لها." : capabilityId === "plan.draft" ? "وضع الاقتراح: لم يُرسل طلب إلى Groq ولم تُشغّل أدوات الخطة." : ["coding.change", "studio.change"].includes(capabilityId ?? "") ? "وضع الاقتراح: لم يُرسل طلب إلى النموذج ولم تُعدّل ملفات أو تُشغّل اختبارات." : "وضع الاقتراح: لم تُشغّل أداة التشخيص."}</p>{proposed.length ? <ul className="proposed-checks">{proposed.map((name) => <li key={name}>{checkLabels[name] ?? name}</li>)}</ul> : null}</> : <>{checks.map((check, index) => <div className="result-check" key={typeof check.name === "string" ? check.name : index}><div><span>{check.passed === true ? <Check size={15} /> : <X size={15} />}{typeof check.name === "string" ? checkLabels[check.name] ?? check.name : "فحص مسجل"}</span>{check.passed === true && typeof check.name === "string" && checkEvidence[check.name] ? <small>{checkEvidence[check.name]}</small> : null}</div><strong>{check.passed === true ? "اجتاز الفحص" : "لم يجتز الفحص"}</strong></div>)}{typeof result.observedAt === "string" ? <p className="result-observed">وقت الفحص: <time dateTime={result.observedAt}>{dateLabel(result.observedAt)}</time></p> : null}</>}<details className="evidence-details"><summary>الأدلة التفصيلية</summary><pre dir="ltr">{JSON.stringify(result, null, 2)}</pre></details></section>;
}

function AuthScreen({ needsSetup, onAuthenticated, onRetry }: { needsSetup: boolean; onAuthenticated: (session: Session) => void; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") ?? "");
    const password = String(values.get("password") ?? "");
    setBusy(true); setError("");
    try {
      if (needsSetup) await request("/api/setup", { method: "POST", body: JSON.stringify({ name: values.get("name"), email, password, setupToken: values.get("setupToken") }) });
      await request("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
      const session = await request<Session | null>("/api/auth/get-session");
      if (!session?.user) throw new Error("missing session");
      onAuthenticated(session);
    } catch (caught) {
      setError(errorMessage(caught));
      if (needsSetup) onRetry();
    } finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-form-panel"><div className="auth-form-wrap"><h2>{needsSetup ? "أنشئ حساب المالك" : "تسجيل الدخول"}</h2><form onSubmit={submit} className="stack-form">{needsSetup ? <label>الاسم<input name="name" autoComplete="name" required maxLength={80} placeholder="كيف نناديك؟" /></label> : null}<label>البريد الإلكتروني<input name="email" type="email" dir="ltr" autoComplete="email" required placeholder="you@example.com" /></label><label>كلمة المرور<input name="password" type="password" dir="ltr" autoComplete={needsSetup ? "new-password" : "current-password"} required minLength={needsSetup ? 12 : undefined} placeholder={needsSetup ? "12 حرفًا على الأقل" : "كلمة المرور"} /></label>{needsSetup ? <label>رمز الإعداد المحلي<input name="setupToken" type="password" dir="ltr" autoComplete="off" required placeholder="رمز التحقق المحلي" /><small>تجده في الملف المحلي <code dir="ltr">.data/setup-token</code> داخل المشروع.</small></label> : null}{error ? <p className="inline-error" role="alert">{error}</p> : null}<Button type="submit" className="primary-button auth-submit" loading={busy} disabled={busy}>{needsSetup ? "إنشاء الحساب" : "دخول"}</Button></form></div></section></main>;
}

function CapabilityCard({ capability }: { capability: Capability }) {
  const active = capability.status === "active";
  const Icon = capability.id.includes("coding") ? Code2 : capability.id.includes("browser") ? Globe2 : capability.id.includes("remote") ? Monitor : capability.id.includes("diagnostic") ? Terminal : Sparkles;
  return <article className="capability-card"><div className="card-topline"><span className={`tool-icon ${active ? "tool-active" : ""}`}><Icon size={23} strokeWidth={1.6} /></span><span className={`subtle-badge ${active ? "badge-green" : ""}`}>{active ? "متاحة الآن" : capability.status === "needs_configuration" ? "تحتاج إعدادًا" : "قيد التطوير"}</span></div><h3>{capability.name}</h3><p>{capability.description}</p><div className="capability-footer"><code dir="ltr">v{capability.version}</code><span><ShieldCheck size={13} />{active ? "نطاق محدد" : "غير مفعّلة"}</span></div></article>;
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const Icon = integration.id.includes("groq") ? Sparkles : integration.id.includes("ads") ? Activity : integration.id.includes("windows") ? Monitor : integration.id.includes("database") || integration.id.includes("neon") ? Database : Globe2;
  return <article className="integration-card"><span className="tool-icon"><Icon size={23} strokeWidth={1.6} /></span><div><div className="integration-title"><h3>{integration.name}</h3><span className={`subtle-badge ${integration.status === "connected" ? "badge-green" : ""}`}>{integration.status === "connected" ? "متصل" : integration.status === "needs_configuration" ? "غير متصل" : "مخطط"}</span></div><p>{integration.description}</p><small>{integration.detail}</small></div></article>;
}

function TaskList({ tasks, onSelect, compact = false }: { tasks: Task[]; onSelect: (id: string) => void; compact?: boolean }) {
  if (tasks.length === 0) return <Empty title="مساحة لأولى إنجازاتك">أنشئ مهمة تشخيص آمنة، وتابع انتقالها من الطلب إلى النتيجة الموثّقة.</Empty>;
  return <div className="task-list">{tasks.map((task) => <button key={task.id} className="task-row" onClick={() => onSelect(task.id)}><span className={`task-symbol ${task.status === "completed" ? "task-symbol-done" : ""}`}>{task.status === "completed" ? <CheckCheck size={20} /> : task.status === "running" || task.status === "verifying" ? <LoaderCircle className="spin" size={20} /> : <Terminal size={20} />}</span><span className="task-row-main"><strong>{task.title}</strong><small>{compact ? autonomyText[task.autonomy] : task.goal}</small></span><span className="task-row-meta"><Status status={task.status} capabilityId={task.capabilityId} autonomy={task.autonomy} goal={task.goal} /><time dateTime={task.createdAt}>{dateLabel(task.createdAt)}</time></span><ChevronLeft size={17} className="task-chevron" /></button>)}</div>;
}

function CreateDialog({ open, onClose, offline, activeCapabilities, coding, onCreated }: { open: boolean; onClose: () => void; offline: boolean; activeCapabilities: Capability[]; coding?: CodingWorkspace; onCreated: (task: Task) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy>("assisted");
  const [capabilityId, setCapabilityId] = useState<"system.diagnostic" | "plan.draft" | "coding.change" | "browser.open">("system.diagnostic");
  const [browserUrl, setBrowserUrl] = useState("");
  const [diagnosticTitleEdited, setDiagnosticTitleEdited] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [drafts, setDrafts] = useState({
    "system.diagnostic": { title: "فحص جاهزية مساحة العمل", goal: "التحقق من اتصال التخزين وسلامة محرك التنفيذ وتوثيق النتيجة.", measures: "" },
    "plan.draft": { title: "إعداد خطة لهدفي", goal: "", measures: "" },
    "coding.change": { title: "تعديل كود داخل نسخة معزولة", goal: "", measures: "" },
    "browser.open": { title: "فتح صفحة في المتصفح", goal: "افتح الصفحة في المتصفح واعرض لقطة منها بعد تحميلها.", measures: "" },
  });
  const isPlan = capabilityId === "plan.draft";
  const isCoding = capabilityId === "coding.change";
  const draft = drafts[capabilityId];
  const inferredBrowserIntent = capabilityId === "system.diagnostic" ? detectBrowserOpenIntent(draft.goal) : null;
  const effectiveCapabilityId = inferredBrowserIntent ? "browser.open" : capabilityId;
  const isBrowser = effectiveCapabilityId === "browser.open";
  const targetUrl = inferredBrowserIntent?.url ?? browserUrl.trim();
  const allowedOrigins = browserReadOrigins(targetUrl);
  const title = inferredBrowserIntent && !diagnosticTitleEdited && draft.title === "فحص جاهزية مساحة العمل" ? "فتح صفحة في المتصفح" : draft.title;
  const validBrowserUrl = BrowserTaskInputSchema.safeParse({ url: targetUrl }).success;
  const selectedCapability = activeCapabilities.find((capability) => capability.id === effectiveCapabilityId && (!isCoding || coding?.sandbox.available));
  const available = activeCapabilities.filter((capability) => capability.id === "system.diagnostic" || capability.id === "plan.draft" || capability.id === "browser.open" || capability.id === "coding.change" && coding?.sandbox.available);
  const selectedProject = coding?.projects.find((project) => project.id === projectId);
  function update(field: "title" | "goal" | "measures", value: string) {
    if (capabilityId === "system.diagnostic" && field === "title") setDiagnosticTitleEdited(true);
    setDrafts((current) => ({ ...current, [capabilityId]: { ...current[capabilityId], [field]: value } }));
  }
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open && dialog.current?.open) dialog.current?.close(); }, [open]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || offline || !selectedCapability || isCoding && (!coding?.sandbox.available || !selectedProject) || isBrowser && !validBrowserUrl) return;
    const goal = [draft.goal.trim(), ...(isPlan && draft.measures.trim() ? [`مقاييس النجاح المطلوبة:\n${draft.measures.trim()}`] : [])].join("\n\n");
    const input = { title: title.trim(), goal, capabilityId: effectiveCapabilityId, autonomy, ...(isCoding ? { projectId } : {}), ...(isBrowser ? { browserInput: { url: targetUrl, allowedOrigins } } : {}) };
    const fingerprint = JSON.stringify(input);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const task = await request<Task>("/api/tasks", { method: "POST", headers: { "Idempotency-Key": retry.current.key }, body: fingerprint });
      retry.current = null;
      onCreated(task); onClose();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="app-dialog create-dialog" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="dialog-header"><div><span className="eyebrow">من الفكرة إلى التنفيذ</span><h2>مهمة جديدة</h2></div><button className="icon-button" aria-label="إغلاق" onClick={onClose} disabled={busy}><X size={21} /></button></div>
    <form className="stack-form" onSubmit={submit}>
      <label>القدرة المطلوبة<select name="capabilityId" value={effectiveCapabilityId} disabled={busy} onChange={(event) => { if (event.target.value === "system.diagnostic" || event.target.value === "plan.draft" || event.target.value === "coding.change" || event.target.value === "browser.open") { setCapabilityId(event.target.value); setError(""); } }}>{available.map((capability) => <option key={capability.id} value={capability.id}>{capability.name}</option>)}{isBrowser && !available.some((capability) => capability.id === "browser.open") ? <option value="browser.open" disabled>فتح الصفحة في المتصفح — غير متاح الآن</option> : null}</select></label>
      {isCoding ? <label>مشروع البرمجة<select name="projectId" value={projectId} required disabled={busy || !coding?.sandbox.available} onChange={(event) => setProjectId(event.target.value)}><option value="">اختر مشروعًا مسجلًا</option>{coding?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><small>{coding?.projects.length ? "التعديل محصور بالملفات المصرح بها داخل هذا المشروع." : "سجل مشروعًا من قسم مشاريع البرمجة أولًا. لن يبدأ أي تشغيل دون عزل متاح."}</small>{selectedProject ? <span className="coding-selected-paths">{selectedProject.allowedPaths.map((path) => <code key={path} dir="ltr">{path}</code>)}</span> : null}</label> : null}
      <label>عنوان المهمة<input name="title" required minLength={3} maxLength={120} value={title} onChange={(event) => update("title", event.target.value)} disabled={busy} placeholder="عنوان واضح ومختصر" /></label>
      <label>{isPlan ? "ما الهدف الذي تريد التخطيط له؟" : isCoding ? "ما التغيير البرمجي المطلوب؟" : isBrowser ? "ما الصفحة التي تريد فتحها؟" : "ما الذي تريد التحقق منه؟"}<textarea name="goal" required minLength={isBrowser ? 5 : 10} maxLength={isPlan ? 3000 : 4000} rows={4} value={draft.goal} onChange={(event) => update("goal", event.target.value)} disabled={busy} placeholder={isPlan ? "صف النتيجة المطلوبة والوقت المتاح والموارد والقيود…" : isCoding ? "صف السلوك المطلوب إصلاحه ومعيار نجاحه، دون أوامر تشغيل حرة…" : isBrowser ? "صف طلب فتح الصفحة وعرض اللقطة…" : "صف ما تريد التحقق منه…"} /><small>{isPlan ? "اكتب هدفك بحرية. ستُعرض الافتراضات والأسئلة والمقاييس المقترحة داخل الخطة." : isCoding ? "يدعم هذا الإصدار ملفات JavaScript واختبارات Node المدمجة فقط. لا تثبيت للاعتماديات أو دمج تلقائي." : isBrowser ? "ستُفتح الصفحة للقراءة في جلسة مستقلة، وتظهر المشاهدة واللقطة الفعلية عند توفرها." : "فحص آمن للخدمة، دون تعديل ملفات أو حسابات خارجية."}</small></label>
      {isBrowser && !inferredBrowserIntent ? <label>عنوان الصفحة<input name="browserUrl" type="url" dir="ltr" required maxLength={2048} pattern="https://.*" value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} disabled={busy} placeholder="https://ads.google.com/home/" /><small>أدخل عنوان HTTPS عامًا وكاملًا دون بيانات دخول أو عنوان داخلي.</small></label> : null}
      {isBrowser ? <div className={browserStyles.target} role="status" aria-label="وجهة فتح الصفحة"><strong>{inferredBrowserIntent ? "تعرّفنا على طلب فتح صفحة، واخترنا قدرة المتصفح." : "وجهة فتح الصفحة"}</strong>{targetUrl ? <code dir="ltr">{targetUrl}</code> : <span>أدخل عنوان الصفحة للمتابعة.</span>}{allowedOrigins.length ? <><span>المواقع المسموحة للقراءة وتحميل الصفحة:</span>{allowedOrigins.map((origin) => <code dir="ltr" key={origin}>{origin}</code>)}</> : null}<p>الطلب يفتح الصفحة ويقرأها ويلتقط صورة عند توفرها. تسجيل الدخول وإرسال النماذج وتعديل الحسابات تحتاج إجراءات منفصلة.</p></div> : null}
      {isPlan ? <label>كيف ستقيس النجاح؟ <span className="optional-label">اختياري</span><textarea name="successMeasures" rows={2} maxLength={800} value={draft.measures} onChange={(event) => update("measures", event.target.value)} disabled={busy} placeholder="مثال: تقرير بمصادر موثقة، أو اجتياز اختبارات محددة، أو موعد تسليم…" /></label> : null}
      <div className="selected-tool"><span className="tool-icon tool-active">{isPlan ? <Sparkles size={22} /> : isCoding ? <Code2 size={22} /> : isBrowser ? <Globe2 size={22} /> : <Terminal size={22} />}</span><div><strong>{isPlan ? "إعداد خطة ذكية" : isCoding ? "تعديل واختبار داخل نسخة معزولة" : isBrowser ? "فتح صفحة ولقطة موثقة" : "تشخيص النظام"}</strong><small>{isPlan ? "ناتجها أهداف ومعايير وخطوات وتبعيات؛ لا تنفّذ أدوات الخطة." : isCoding ? "صلاحيات كتابة وتشغيل محددة بالمشروع وملفاته؛ تحتاج موافقتك دائمًا." : isBrowser ? "جلسة مستقلة للقراءة، مع عنوان الصفحة ووقت مشاهدتها ودليل اللقطة." : "فحص آمن داخل الخدمة، دون تعديل ملفات أو حسابات خارجية."}</small></div><Check size={18} /></div>
      <fieldset className="autonomy-field"><legend>مستوى الاستقلالية</legend>{(["assisted", "scoped", "shadow"] as Autonomy[]).map((mode) => <label className={`autonomy-option ${autonomy === mode ? "selected" : ""}`} key={mode}><input type="radio" name="autonomy" value={mode} checked={autonomy === mode} disabled={busy} onChange={() => setAutonomy(mode)} /><span><strong>{autonomyText[mode]}</strong><small>{isCoding ? mode === "shadow" ? "اقتراح مسار فقط دون طلب نموذج أو تعديل ملفات أو تشغيل اختبارات." : "تنتظر موافقتك قبل طلب التعديل والكتابة والاختبارات، حتى في التنفيذ ضمن النطاق." : isPlan ? mode === "assisted" ? "تنتظر المهمة موافقتك قبل إرسال طلب التخطيط إلى Groq." : mode === "scoped" ? "إرسال طلب التخطيط المحدود لهذه المهمة فقط." : "حفظ اقتراح المسار دون إرسال أي طلب إلى النموذج." : isBrowser ? mode === "assisted" ? "تنتظر المهمة موافقتك قبل فتح العنوان المحدد وقراءة الصفحة." : mode === "scoped" ? "فتح العنوان المحدد وقراءة الصفحة ضمن هذه المهمة." : "تسجيل اقتراح دون فتح الصفحة أو التقاط صورة." : mode === "assisted" ? "تنتظر المهمة موافقتك قبل تشغيل الأداة." : mode === "scoped" ? "تشغيل الفحص الآمن تلقائيًا ضمن هذه المهمة." : "تسجيل اقتراح دون تشغيل الأداة."}</small></span></label>)}</fieldset>
      {isPlan ? <div className="ai-disclosure"><ShieldCheck size={17} /><p>{autonomy === "shadow" ? "وضع الاقتراح لا يرسل أي طلب إلى Groq ولا يشغّل أدوات." : `سيُرسل وصف الهدف ومقاييسه إلى Groq لإعداد الخطة${autonomy === "assisted" ? " بعد موافقتك" : " ضمن نطاق هذه المهمة"}. راجع ما تشاركه قبل المتابعة. لا تمنح هذه المهمة إذن تنفيذ خطوات الخطة.`}</p></div> : null}
      {isCoding ? <div className="ai-disclosure coding-disclosure"><ShieldCheck size={17} /><p>{autonomy === "shadow" ? "وضع الاقتراح لا يستدعي النموذج ولا يعدل ملفات ولا يشغّل اختبارات." : "تحتاج هذه المهمة موافقة صريحة قبل إرسال الهدف ومحتوى الملفات المحددة إلى Groq، ثم كتابة التعديل واختباره داخل نسخة عمل معزولة. تظل الاختبارات ضمن ملف Node المدمج؛ لا تثبيت لاعتماديات أو دمج أو نشر."}</p></div> : null}
      {!selectedCapability ? <p className="inline-error" role="alert">هذه القدرة غير متاحة الآن. اختر قدرة نشطة من السجل.</p> : null}
      {isBrowser && targetUrl && !validBrowserUrl ? <p className="inline-error" role="alert">يلزم عنوان HTTPS عام دون بيانات دخول أو منفذ مخصص أو جزء يبدأ بـ #.</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {offline ? <p className="inline-error" role="alert">الاتصال منقطع. أعد الاتصال قبل إنشاء المهمة.</p> : null}
      <div className="dialog-footer"><span><ShieldCheck size={15} />كل خطوة محفوظة في سجل التنفيذ</span><Button type="submit" className="primary-button" loading={busy} disabled={busy || offline || !selectedCapability || isCoding && !selectedProject || isBrowser && !validBrowserUrl}>إنشاء المهمة<ArrowLeft size={16} /></Button></div>
    </form>
  </dialog>;
}
function TaskDialog({ id, onClose, offline, onChanged, onOpenBrowser }: { id: string | null; onClose: () => void; offline: boolean; onChanged: () => void; onOpenBrowser?: (sessionId: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (!id) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    setDetail(null); setError("");
    let active = true;
    let controller: AbortController | null = null;
    let fetching = false;
    async function load() {
      if (document.hidden || fetching) return;
      fetching = true; controller = new AbortController();
      try { const result = await request<Detail>(`/api/tasks/${id}`, { signal: controller.signal }); if (active) { setDetail(result); setError(""); } }
      catch (caught) { if (active && !(caught instanceof DOMException && caught.name === "AbortError")) setError(errorMessage(caught)); }
      finally { fetching = false; }
    }
    void load();
    const interval = setInterval(() => { void load(); }, 3000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [id, refreshKey]);
  async function action(type: "approve" | "cancel") {
    if (!id || busy || offline) return;
    setBusy(true); setError("");
    try { const task = await request<Task>(`/api/tasks/${id}/${type}`, { method: "POST", body: "{}" }); setDetail((current) => current ? { ...current, task } : current); onChanged(); setRefreshKey((key) => key + 1); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="app-dialog detail-dialog" onClose={onClose}><div className="dialog-header"><div><span className="eyebrow">سجل التنفيذ</span><h2>{detail?.task.title ?? "تفاصيل المهمة"}</h2></div><button className="icon-button" aria-label="إغلاق التفاصيل" onClick={onClose}><X size={21} /></button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}{!detail ? <div className="dialog-loading"><Spinner size="lg" /><p>جارٍ تحميل السجل…</p></div> : <><div className="detail-summary"><Status status={detail.task.status} capabilityId={detail.task.capabilityId} autonomy={detail.task.autonomy} goal={detail.task.goal} /><span>{autonomyText[detail.task.autonomy]}</span><span>المحاولة {detail.task.attempt} من {detail.task.maxAttempts}</span></div><p className="detail-goal">{detail.task.goal}</p>{detail.task.status === "waiting_approval" ? <div className="approval-box"><ShieldCheck size={24} /><div><strong>هذه المهمة تنتظر قرارك</strong><p>{detail.task.capabilityId === "plan.draft" ? "الموافقة تجيز إرسال الهدف إلى Groq لإعداد خطة فقط؛ لا تجيز تنفيذ خطواتها." : detail.task.capabilityId === "studio.change" ? "الموافقة تجيز إرسال الوصف والملفات المحددة والصورة المرفقة، إن وجدت، إلى النموذج، ثم بناء مقترح ومراجعته معزولًا. تطبيق المقترح على نسخة الاستوديو يحتاج قرارًا منفصلًا." : detail.task.capabilityId === "coding.change" ? "الموافقة تجيز إرسال الهدف والملفات المحددة لاقتراح تعديل، ثم الكتابة والاختبارات داخل نسخة العمل المعزولة فقط. لا تجيز دمجًا أو نشرًا." : detail.task.capabilityId === "browser.open" ? "الموافقة تسمح بفتح العنوان المحدد وقراءة الصفحة والتقاط صورة عند توفرها، ضمن هذه المهمة فقط. تسجيل الدخول والإرسال وتعديل الحسابات تحتاج إجراءات منفصلة." : "الموافقة تسمح بتشخيص النظام لهذه المهمة فقط، ضمن مدتها المحددة."}</p></div><Button className="primary-button" disabled={busy || offline} loading={busy} onClick={() => { void action("approve"); }}>موافقة وتنفيذ</Button></div> : null}<h3 className="section-label">تسلسل الأحداث <span>{detail.events.length}</span></h3><ol className="event-timeline">{detail.events.map((event) => <li key={event.id}><span className="event-point" /><div><strong>{event.message}</strong><time dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></div></li>)}</ol>{detail.task.result != null ? <TaskResult result={detail.task.result} capabilityId={detail.task.capabilityId} goal={detail.task.goal} offline={offline} onChanged={onChanged} onOpenBrowser={onOpenBrowser} /> : null}{detail.task.error ? <p className="inline-error" role="alert">{typeof detail.task.error === "string" ? detail.task.error : JSON.stringify(detail.task.error)}</p> : null}<div className="detail-bottom"><code dir="ltr">{detail.task.id}</code>{!terminal.has(detail.task.status) ? <Button className="danger-button" variant="outline" disabled={busy || offline || detail.task.cancellationRequested} onClick={() => { void action("cancel"); }}>{detail.task.cancellationRequested ? "طُلب الإلغاء" : "إلغاء المهمة"}</Button> : null}</div></>}</dialog>;
}

export function Workspace() {
  const [boot, setBoot] = useState<"loading" | "setup" | "signin" | "ready" | "error" | "unconfigured">("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [advanced, setAdvancedView] = useState(false);
  const setAdvanced = useCallback((value: boolean) => {
    setAdvancedView(value);
    history.replaceState(null, "", value ? "#tools" : location.pathname);
  }, []);
  useEffect(() => { if (location.hash === "#tools") setAdvancedView(true); }, []);
  const [offline, setOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function initialize() {
      setBoot("loading"); setError("");
      try {
        const [setup, existing] = await Promise.all([request<{ needsSetup: boolean; setupAvailable?: boolean }>("/api/setup", { signal: controller.signal }), request<Session | null>("/api/auth/get-session", { signal: controller.signal })]);
        if (!active) return;
        if (existing?.user) { setSession(existing); setBoot("ready"); } else setBoot(setup.needsSetup ? setup.setupAvailable === false ? "unconfigured" : "setup" : "signin");
      } catch (caught) { if (active && !(caught instanceof DOMException && caught.name === "AbortError")) { setError(errorMessage(caught)); setBoot("error"); } }
    }
    void initialize();
    return () => { active = false; controller.abort(); };
  }, []);

  useEffect(() => {
    if (boot !== "ready" || !advanced) return;
    let active = true;
    let controller: AbortController | null = null;
    let fetching = false;
    async function load() {
      if (document.hidden || fetching) return;
      fetching = true; controller = new AbortController();
      try {
        const result = await request<WorkspaceSnapshot>("/api/workspace", { signal: controller.signal });
        if (active) { setSnapshot(result); setOffline(false); setError(""); setLastUpdated(new Date().toISOString()); }
      } catch (caught) {
        if (active && !(caught instanceof DOMException && caught.name === "AbortError")) {
          if (caught instanceof ApiError && caught.status === 401) { setSession(null); setSnapshot(null); setBoot("signin"); }
          else { setOffline(true); setError(errorMessage(caught)); }
        }
      } finally { fetching = false; }
    }
    void load();
    const interval = setInterval(() => { void load(); }, 3000);
    const visible = () => { if (!document.hidden) void load(); };
    const disconnected = () => setOffline(true);
    document.addEventListener("visibilitychange", visible); window.addEventListener("online", visible); window.addEventListener("offline", disconnected);
    return () => { active = false; controller?.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", visible); window.removeEventListener("offline", disconnected); };
  }, [boot, refreshKey, advanced]);

  async function retryBoot() {
    try { const setup = await request<{ needsSetup: boolean; setupAvailable?: boolean }>("/api/setup"); setBoot(setup.needsSetup ? setup.setupAvailable === false ? "unconfigured" : "setup" : "signin"); setError(""); }
    catch (caught) { setError(errorMessage(caught)); setBoot("error"); }
  }
  async function signOut() {
    try {
      await request("/api/auth/sign-out", { method: "POST", body: "{}" });
      setSnapshot(null); setSession(null); setView("overview"); setAdvanced(false);
      setMobileMenu(false); setSelectedTask(null); setCreateOpen(false);
      setQuery(""); setOffline(false); setError(""); setLastUpdated(null);
      setBoot("signin");
    }
    catch (caught) { setError(errorMessage(caught)); }
  }

  if (boot === "loading") return <div className="boot-screen"><Brand compact /><Spinner size="lg" /><p>نجهّز مساحة عملك…</p></div>;
  if (boot === "error") return <div className="boot-screen"><Brand compact /><span className="empty-icon"><Unplug size={28} /></span><h1>الخدمة غير متاحة الآن</h1><p role="alert">{error}</p><Button className="primary-button" onClick={() => { void retryBoot(); }}><RefreshCw size={16} />إعادة المحاولة</Button></div>;
  if (boot === "unconfigured") return <main className="boot-screen"><Brand compact /><span className="empty-icon"><ShieldCheck size={28} /></span><h1>يلزم إعداد حساب المالك</h1><p>إنشاء الحساب الأول متاح من بيئة الخادم فقط. بعد إتمامه، أعد المحاولة للدخول إلى مساحة العمل.</p><Button className="primary-button" onClick={() => { void retryBoot(); }}><RefreshCw size={16} />إعادة المحاولة</Button></main>;
  if (boot === "setup" || boot === "signin") return <AuthScreen needsSetup={boot === "setup"} onAuthenticated={(value) => { setSession(value); setBoot("ready"); }} onRetry={() => { void request<{ needsSetup: boolean; setupAvailable?: boolean }>("/api/setup").then((value) => { if (!value.needsSetup) setBoot("signin"); }).catch(() => {}); }} />;

  if (!advanced) return <AssistantApp name={session?.user.name ?? "بك"} onAdvanced={() => setAdvanced(true)} onSignOut={() => { void signOut(); }} />;

  const tasks = snapshot?.tasks ?? [];
  const capabilities = snapshot?.capabilities ?? [];
  const integrations = snapshot?.integrations ?? [];
  const user = snapshot?.user ?? session?.user;
  const activeTasks = tasks.filter((task) => ["queued", "running", "verifying"].includes(task.status));
  const waiting = tasks.filter((task) => task.status === "waiting_approval");
  const completed = tasks.filter((task) => task.status === "completed");
  const activeCapabilities = capabilities.filter((capability) => capability.status === "active");
  const filteredTasks = tasks.filter((task) => `${task.title} ${task.goal}`.toLocaleLowerCase("ar").includes(query.toLocaleLowerCase("ar")));
  const navigate = (target: View) => { if (target === "chat") { setAdvanced(false); return; } setView(target); setMobileMenu(false); setQuery(""); };

  return <div className="workspace-shell"><a className="skip-link" href="#workspace-main">انتقل إلى المحتوى</a>{mobileMenu ? <button className="mobile-backdrop" aria-label="إغلاق القائمة" onClick={() => setMobileMenu(false)} /> : null}<aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}><Brand /><div className="workspace-switch"><span className="workspace-avatar">م</span><div><strong>مساحتي الشخصية</strong><small>مركز القيادة الموحد</small></div><ShieldCheck size={16} /></div><span className="nav-label">مساحة العمل</span><nav aria-label="التنقل الرئيسي">{navigation.map(({ id, title, icon: Icon }) => <button className={view === id ? "nav-item active" : "nav-item"} key={id} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.6} /><span>{title}</span>{id === "tasks" && waiting.length > 0 ? <span className="nav-count">{waiting.length}</span> : null}</button>)}</nav><div className="sidebar-bottom"><div className="profile-row"><span className="profile-avatar">{user?.name?.charAt(0) ?? "م"}</span><div><strong>{user?.name ?? "حساب المالك"}</strong><small>مساحة شخصية محمية</small></div><button className="icon-button" aria-label="تسجيل الخروج" title="تسجيل الخروج" onClick={() => { void signOut(); }}><LogOut size={17} /></button></div></div></aside><div className="workspace-body"><header className="topbar"><div className="topbar-title"><button className="icon-button mobile-toggle" aria-label="فتح القائمة" onClick={() => setMobileMenu(true)}><Menu size={22} /></button><span className="breadcrumb">مساحة العمل<ChevronLeft size={14} /><strong>{navigation.find((item) => item.id === view)?.title}</strong></span></div><div className="topbar-actions"><span className={`connection-label ${offline ? "connection-offline" : ""}`}><span />{offline ? "الاتصال منقطع" : snapshot ? "النظام متصل" : "جارٍ الاتصال"}</span><button className="icon-button" aria-label="عرض المهام التي تحتاج موافقة" title="الموافقات" onClick={() => { if (waiting[0]) setSelectedTask(waiting[0].id); else navigate("tasks"); }}><Bell size={19} />{waiting.length > 0 ? <i className="notification-dot" /> : null}</button><span className="topbar-divider" /><span className="topbar-avatar">{user?.name?.charAt(0) ?? "م"}</span></div></header><main id="workspace-main" className="main-content">{offline ? <div className="offline-banner" role="alert"><Unplug size={18} /><div><strong>نعرض آخر حالة محفوظة</strong><span>{error || "أعد الاتصال لمتابعة التحديثات وتنفيذ الإجراءات."}{lastUpdated ? ` آخر تحديث: ${dateLabel(lastUpdated)}.` : ""}</span></div><Button size="sm" variant="outline" onClick={refresh}><RefreshCw size={14} />إعادة المحاولة</Button></div> : error ? <p className="inline-error" role="alert">{error}</p> : null}<div className="page-heading"><div><span className="eyebrow">{view === "chat" ? "من طلبك إلى النتيجة" : view === "overview" ? "كل شيء في مكانه" : "MOHASSAN WORKSPACE"}</span><h1>{["chat", "overview"].includes(view) ? `أهلًا، ${user?.name?.split(" ")[0] ?? "بك"}` : navigation.find((item) => item.id === view)?.title}<span className="heading-dot">.</span></h1><p>{view === "chat" ? "اكتب طلبك، وتابع ما يحدث في المتصفح بجانب المحادثة." : view === "overview" ? "مساحة واحدة لأفكارك، مهامك، وما يأتي بعدها." : view === "tasks" ? "تابع ما يجري، وراجع كل خطوة ونتيجة." : view === "studio" ? "معاينة مباشرة، واختيار دقيق، وتعديلات محفوظة للمراجعة." : view === "browser" ? "جلسات مستقلة، وقراءة موثقة، وموافقة قبل الإرسال." : view === "memory" ? "خبرات بمصادر واضحة، ومهارات تختبر وتقاس قبل تفعيلها." : view === "windows" ? "اربط الجهاز، وحدد نطاق المشاهدة والتحكم ومدة الإذن." : view === "coding" ? "مشروعات محددة، ونسخ عمل معزولة، واختبارات ومراجعة بأدلة." : view === "capabilities" ? "أدوات واضحة، وصلاحيات محددة، وتنفيذ قابل للتحقق." : view === "integrations" ? "حالة الاتصالات الفعلية ومتطلبات تفعيلها." : "نبني المنصة على مراحل مترابطة، بمعايير قبول واضحة."}</p></div>{view !== "chat" ? <Button className="primary-button" disabled={offline || !snapshot} onClick={() => setCreateOpen(true)}><Plus size={17} />مهمة جديدة</Button> : null}</div>{!snapshot && !offline ? <div className="content-loading"><Spinner size="lg" /><p>جارٍ تحميل بيانات مساحة العمل…</p></div> : <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} key={view}>{null}{view === "overview" ? <><section className="welcome-card"><div className="welcome-content"><span className="welcome-label"><span />بداية صغيرة. أساس متين.</span><h2>من هدفك التالي،<br />إلى إنجاز يمكنك الوثوق به.</h2><p>ابدأ بفحص مساحة العمل. راجع الصلاحيات، ثم شاهد محرك التنفيذ يوثّق كل خطوة ويتحقق من النتيجة.</p><Button className="welcome-button" disabled={offline || !snapshot} onClick={() => setCreateOpen(true)}>ابدأ أول خطوة<ArrowLeft size={16} /></Button></div><div className="runtime-illustration" aria-hidden="true"><div className="runtime-grid" /><span className="illustration-tag tag-top"><Fingerprint size={15} />صلاحية محددة</span><span className="illustration-tag tag-bottom"><CheckCheck size={15} />تحقق مستقل</span><div className="runtime-ring ring-one" /><div className="runtime-ring ring-two" /><div className="runtime-center"><Sparkles size={41} strokeWidth={1.2} /></div><span className="runtime-node node-one"><Terminal size={18} /></span><span className="runtime-node node-two"><Database size={18} /></span><span className="runtime-node node-three"><ShieldCheck size={18} /></span></div></section><section className="stats-grid" aria-label="إحصاءات مساحة العمل">{[{ label: "مهام قيد التنفيذ", value: activeTasks.length, icon: Workflow, note: "الطابور والتنفيذ والتحقق" }, { label: "مهام مكتملة", value: completed.length, icon: CheckCheck, note: "نتائج اجتازت التحقق" }, { label: "تنتظر موافقتك", value: waiting.length, icon: ShieldCheck, note: "القرار بين يديك" }, { label: "قدرات متاحة", value: activeCapabilities.length, icon: Zap, note: "من سجل القدرات الفعلي" }].map(({ label, value, icon: Icon, note }) => <article className="stat-card" key={label}><div><span>{label}</span><Icon size={18} strokeWidth={1.6} /></div><strong>{value.toLocaleString("ar")}</strong><small>{note}</small></article>)}</section><div className="overview-grid"><section className="panel recent-tasks"><div className="panel-heading"><div><h2>آخر المهام</h2><p>ما طلبته، وما يجري الآن.</p></div><button className="text-button" onClick={() => navigate("tasks")}>كل المهام<ArrowLeft size={14} /></button></div><TaskList tasks={tasks.slice(0, 4)} onSelect={setSelectedTask} compact /></section><section className="panel readiness-panel"><div className="panel-heading"><div><h2>جاهزية المساحة</h2><p>حالة المكونات الفعلية.</p></div><span className="small-icon"><Activity size={18} /></span></div><div className="readiness-row"><span><Database size={17} />التخزين الدائم</span><strong className={snapshot?.storage.healthy ? "text-green" : "text-amber"}>{snapshot?.storage.healthy ? "متصل" : "غير متاح"}</strong></div><div className="readiness-row"><span><Terminal size={17} />أداة التشخيص</span><strong className={activeCapabilities.some((item) => item.id === "system.diagnostic") ? "text-green" : "text-amber"}>{activeCapabilities.some((item) => item.id === "system.diagnostic") ? "جاهزة" : "غير متاحة"}</strong></div><div className="readiness-row"><span><ShieldCheck size={17} />حماية الجلسة</span><strong className="text-green">مفعّلة</strong></div><div className="storage-note"><CircleHelp size={16} /><p>{snapshot?.storage.mode === "embedded" ? "تخزين محلي للتطوير. ربط Neon مطلوب قبل التشغيل الإنتاجي." : "يستخدم النظام PostgreSQL. راجع خطة النسخ والاستعادة قبل الإنتاج."}</p></div></section></div><section className="section-block"><div className="section-heading"><div><span className="eyebrow">قدرات تنمو معك</span><h2>الأدوات في مساحتك</h2></div><button className="text-button" onClick={() => navigate("capabilities")}>عرض السجل<ArrowLeft size={14} /></button></div><div className="capability-grid">{capabilities.slice(0, 3).map((capability) => <CapabilityCard key={capability.id} capability={capability} />)}</div></section></> : null}{view === "tasks" ? <section className="panel"><div className="panel-heading task-toolbar"><div><h2>سجل المهام <span className="count-label">{tasks.length}</span></h2><p>الطلبات والنتائج محفوظة في قاعدة البيانات.</p></div><label className="search-input"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="البحث في المهام…" aria-label="البحث في المهام" /></label></div>{tasks.length > 0 && filteredTasks.length === 0 ? <Empty icon={Search} title="لا توجد نتائج مطابقة">جرّب عنوانًا أو كلمات أخرى من هدف المهمة.</Empty> : <TaskList tasks={filteredTasks} onSelect={setSelectedTask} />}</section> : null}{view === "browser" ? <BrowserWorkspace offline={offline} /> : null}{view === "memory" ? <MemoryWorkspace offline={offline} /> : null}{view === "windows" ? <WindowsWorkspace offline={offline} /> : null}{view === "studio" && user ? <VisualStudio offline={offline} ownerId={user.id} onTaskCreated={(task) => { refresh(); setSelectedTask(task.id); }} /> : null}{view === "coding" ? <CodingProjects coding={snapshot?.coding} offline={offline} onRefresh={refresh} onProjectAdded={(project) => { setSnapshot((current) => current?.coding ? { ...current, coding: { ...current.coding, projects: [project, ...current.coding.projects.filter((item) => item.id !== project.id)] } } : current); refresh(); }} /> : null}{view === "capabilities" ? <><div className="info-strip"><ShieldCheck size={20} /><p>وجود القدرة في السجل لا يمنحها صلاحية التنفيذ. الأدوات غير الجاهزة تبقى غير مفعّلة.</p></div><div className="capability-grid full-grid">{capabilities.map((capability) => <CapabilityCard key={capability.id} capability={capability} />)}</div></> : null}{view === "integrations" ? <>{snapshot?.ai ? <AiConnection ai={snapshot.ai} offline={offline} onVerified={(status) => setSnapshot((current) => current ? { ...current, ai: status } : current)} onRefresh={refresh} /> : null}<div className="info-strip"><Unplug size={20} /><p>لا يُفعّل أي حساب خارجي تلقائيًا. الاتصالات التي تحتاج بيانات اعتماد تظهر بحالتها الفعلية.</p></div><div className="integrations-grid">{integrations.length ? integrations.map((integration) => <IntegrationCard key={integration.id} integration={integration} />) : <Empty icon={Globe2} title="لا توجد اتصالات مهيأة">ستظهر هنا الخدمات عند إضافتها إلى سجل الاتصالات.</Empty>}</div></> : null}{view === "roadmap" ? <><div className="info-strip"><Workflow size={20} /><p>الإصدار يشمل محرك المهام والتخطيط والبرمجة المحدودة، والاستوديو مع مراجعة التعديلات الذكية والصور، والمتصفح والبحث الموثق، والذاكرة والمهارات المقاسة، ومرافق Windows بصلاحيات مؤقتة. تشغيل Next الكامل يحتاج ربط مشغّل المعاينة. تطبيق iPhone والإعلانات والموثوقية الإنتاجية والنشر هي المراحل التالية.</p></div><div className="roadmap-grid">{phases.map(([title, description], index) => <article className="roadmap-card" key={title}><span className={`phase-number ${index < 8 ? "phase-current" : ""}`}>{String(index + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{description}</p><span className={`subtle-badge ${index < 8 ? "badge-green" : ""}`}>{index < 4 ? "ضمن نطاق الإصدار الحالي" : index === 4 ? "تشغيل محلي؛ Next الكامل يحتاج ربطًا" : index < 8 ? "تنفيذ محلي وضوابط تشغيل" : "مرحلة لاحقة"}</span></div></article>)}</div></> : null}</motion.div>}<footer className="workspace-footer"><span><Sparkles size={14} /><span dir="ltr">Mohassan AI</span><span className="footer-dot">·</span>الأساس الذي يُبنى عليه</span><span>{lastUpdated ? `آخر تحديث ${dateLabel(lastUpdated)}` : "في انتظار بيانات الخدمة"}</span></footer></main></div><CreateDialog coding={snapshot?.coding} activeCapabilities={activeCapabilities} open={createOpen} onClose={() => setCreateOpen(false)} offline={offline} onCreated={(task) => { refresh(); setSelectedTask(task.id); }} /><TaskDialog id={selectedTask} onClose={() => setSelectedTask(null)} offline={offline} onChanged={refresh} /></div>;
}
