"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Check, ChevronDown, Copy, ExternalLink, Globe, ImagePlus, KeyRound, Laptop, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Settings2, ShieldAlert, SquarePen, Square, Trash2, X } from "lucide-react";
import type { ChatCapabilities, ChatConversation as Conversation, ChatConversationSummary as Summary, ChatSecureRequest } from "@mohassan/contracts";

/** What each capability the server reports is called on the banner (2026-11-23: the banner listed a fixed three before). */
const CAPABILITY_LABELS: Record<ChatCapabilities["available"][number], string> = {
  computation: "الحساب", web: "البحث في الويب", browser: "فتح الصفحات وقراءتها", memory: "الذاكرة", knowledge: "مستنداتك المحفوظة",
  documents: "ملفات PDF", sites: "بناء المواقع", skills: "المهارات المفعّلة", planner: "تخطيط الأسبوع", letters: "قوالب الرسائل",
  imageReading: "قراءة النص في الصور", ads: "إعلانات Google", pc: "التحكم بالكمبيوتر",
};
/** The banner shown when no language model is connected, built from the server's own capability list when it sends one. */
function localModeText(capabilities: ChatCapabilities | null | undefined): string {
  if (!capabilities?.available.length) return "موحسن يعمل بقدرات محلية محددة: الحساب، واسترجاع الذاكرة والمستندات، والبحث. المحادثة الحرة غير متاحة في هذه الجلسة.";
  return `لا يتصل بهذه الجلسة نموذج لغوي، فالردود الحرة غير متاحة. ما يعمل الآن دون نموذج: ${capabilities.available.map(id => CAPABILITY_LABELS[id]).join("، ")}.`;
}
import { Markdown, plainText } from "./markdown";
import { takeoverInput } from "./takeover-input";
import { BrowserFilesPanel } from './browser-files-panel';
import { DocumentsPanel } from './documents-panel';
import { BrowserViewport } from './browser-viewport';
import { CampaignCard } from "./campaign-card";

const ADS_WORDS = /حمل[ةت]|حملات|إعلان|اعلان|google ads|campaign|\bads?\b|advertis|ppc/i;
import { ActivityLine, AgentActivity } from "./agent-activity";
import { RunDetails, RunVerdict } from "./run-status";
import { isNewerSnapshot, steerable } from "./run-view";
import { QuestionPanel, withoutQuestionList } from "./question-card";
import { ChromeExtensionPanel } from "./chrome-extension-panel";
import { adsConnectProblems, pendingAdsConnect } from "./ads-connect";
import { NOTICE_AFTER_MS, declineNoticeOffer, noticeKindFor, noticeOfferOpen, requestNoticePermission, showTaskNotice } from "./task-notices";
import { RemindersSettings } from "./reminders-settings";
import styles from "./assistant-app.module.css";

/** Plan §5.2 P5: the first useful progress line should show within half a second; a local answer is ready in ~30 ms. */
const POLL_MS = 450;
/** How long the server may hold one request open for a change (its own cap is 8 s, chat-wait.ts). */
const WAIT_MS = 8_000;
/** Proposed in the plan (§6.3): a hidden tab keeps following its task, slowly, instead of stopping. */
const HIDDEN_POLL_MS = 15_000;
const HISTORY_POLL_MS = 5_000;
const SAVED_CONVERSATION = "mohassan-conversation";
const PANEL_SETTING = "mohassan-browser-panel";
const SEEN_TASKS = "mohassan-seen-tasks";
/** «اعرض المتصفح»: when a step needs me (default), always, or only for sign-in and the like. */
type PanelSetting = "needed" | "always" | "necessary";
type Visibility = NonNullable<Conversation["visibility"]>;
const PANEL_SETTINGS: { value: PanelSetting; label: string }[] = [
  { value: "needed", label: "عند الحاجة (افتراضي)" }, { value: "always", label: "دائمًا" }, { value: "necessary", label: "عند الضرورة فقط" },
];
/** Mirrors opensPanel() in the server's browser-visibility module: level 3 opens the panel; «necessary» leaves explicit asks closed. */
function panelOpens(visibility: Visibility, setting: PanelSetting): boolean {
  if (!visibility.canView) return false;
  if (setting === "always") return visibility.level >= 2;
  if (visibility.level !== 3) return false;
  return setting === "needed" || (visibility.code !== "explicit_show" && visibility.code !== "open_only");
}
/** The phone layout never opens the panel by itself (plan §6.1); the chip stays. */
const narrowViewport = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
const panelSetting = {
  get(): PanelSetting { try { const value = localStorage.getItem(PANEL_SETTING); return value === "always" || value === "necessary" ? value : "needed"; } catch { return "needed"; } },
  set(value: PanelSetting) { try { localStorage.setItem(PANEL_SETTING, value); } catch { /* Convenience only. */ } },
};
const seenTasks = {
  get(): Record<string, string> { try { const raw = JSON.parse(localStorage.getItem(SEEN_TASKS) ?? "{}"); return raw && typeof raw === "object" ? raw : {}; } catch { return {}; } },
  set(value: Record<string, string>) { try { localStorage.setItem(SEEN_TASKS, JSON.stringify(value)); } catch { /* Convenience only. */ } },
};

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 429 && body?.error?.code !== "MEMBER_DAILY_LIMIT" ? "طلبات كثيرة متتابعة. انتظر لحظة ثم حاول مجددًا." : body?.error?.message ?? "تعذر إتمام الطلب. حاول مجددًا.");
  return body as T;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "تعذر الاتصال. حاول مجددًا.";

const MAX_ATTACHMENTS = 4;
interface Attachment { id: string; width: number; height: number; url: string; name: string }
const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("تعذر ترميز الصورة.")), type, quality));
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
/** Shrinks an image in the browser so uploads stay small; screenshots keep PNG so their text stays crisp for the reader. */
async function encodeForUpload(file: File): Promise<{ mimeType: "image/png" | "image/jpeg"; data: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("تعذر تجهيز الصورة في المتصفح.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const photo = file.type === "image/jpeg";
    let blob = await toBlob(canvas, photo ? "image/jpeg" : "image/png", 0.92);
    if (blob.size > 4_500_000 && !photo) blob = await toBlob(canvas, "image/jpeg", 0.9);
    if (blob.size > 4_500_000) throw new Error("الصورة كبيرة جدًا حتى بعد التصغير؛ جرّب صورة أصغر.");
    return { mimeType: blob.type === "image/jpeg" ? "image/jpeg" : "image/png", data: await base64Of(blob) };
  } finally {
    bitmap.close();
  }
}
const saved = {
  get() { try { return localStorage.getItem(SAVED_CONVERSATION); } catch { return null; } },
  set(id: string | null) { try { if (id) localStorage.setItem(SAVED_CONVERSATION, id); else localStorage.removeItem(SAVED_CONVERSATION); } catch { /* Convenience only. */ } },
};

function SecureCard({ request, busy, onSubmit }: { request: ChatSecureRequest; busy: boolean; onSubmit: (action: "submit" | "done" | "skip", values?: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [request.id]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const filled = request.fields.every((field) => field.id === "username" && request.fields.length > 1 ? true : values[field.id]?.trim());
    if (filled) { onSubmit("submit", values); setValues({}); }
  }
  const handsOn = request.kind === "hands_on";
  return <form className={styles.card} onSubmit={submit} autoComplete="off">
    <div className={styles.cardTitle}><KeyRound size={16} />{handsOn ? "هذه الخطوة تحتاجك" : request.kind === "code" ? "رمز التحقق" : `تسجيل الدخول إلى ${request.site}`}</div>
    {request.note ? <p className={styles.cardNote} role="alert">{request.note}</p> : null}
    {request.fields.map((field, index) => <label key={field.id} className={styles.field}>
      <span>{field.label}</span>
      <input
        dir="ltr" name={`mh-${field.id}`} autoFocus={index === 0} autoComplete={field.type === "code" ? "one-time-code" : "off"}
        type={field.type === "password" ? "password" : "text"} inputMode={field.type === "code" ? "numeric" : undefined}
        value={values[field.id] ?? ""} disabled={busy} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
      />
    </label>)}
    {!handsOn ? <p className={styles.cardHint}>تذهب هذه البيانات إلى الموقع مباشرة. لا يراها النموذج ولا تُحفظ.</p> : null}
    <div className={styles.cardActions}>
      {handsOn ? <button type="button" className={styles.primary} disabled={busy} onClick={() => onSubmit("done")}><Check size={15} />أكملت</button> : <button type="submit" className={styles.primary} disabled={busy}>متابعة</button>}
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => onSubmit("skip")}>تخطي</button>
    </div>
  </form>;
}

const stepCount = (count: number) => count === 1 ? "خطوة واحدة" : count === 2 ? "خطوتان" : count <= 10 ? `${count} خطوات` : `${count} خطوة`;

/** A finished run whose verdict is not «completed» shows its verdict even when it took no step (a refusal, a blocked request). */
const unfinishedVerdict = (conversation: Conversation) => conversation.status !== "running" && Boolean(conversation.run?.verdict && conversation.run.verdict.status !== "completed");

function Steps({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false);
  const running = conversation.status === "running";
  const run = conversation.run ?? null;
  if (!running && !conversation.steps.length && !unfinishedVerdict(conversation)) return null;
  // The request's own time: its user message, so a reload keeps the count honest.
  const since = conversation.messages.filter((message) => message.role === "user").at(-1)?.createdAt ?? null;
  return <div className={styles.steps}>
    <button type="button" className={styles.stepsToggle} aria-expanded={open} disabled={!conversation.steps.length} onClick={() => setOpen((value) => !value)}>
      {/* The finished run shows the server's verdict (2026-11-23); a check mark was drawn for blocked and partial runs too. */}
      {running ? <ActivityLine text={conversation.progress ?? "يعمل…"} since={since} />
        : <>{run?.verdict ? <RunVerdict run={run} /> : <Check size={14} />}{conversation.steps.length ? <span dir="auto">{stepCount(conversation.steps.length)}</span> : null}</>}
      {conversation.steps.length ? <ChevronDown size={14} className={open ? styles.flipped : ""} /> : null}
    </button>
    {open ? <ol className={styles.stepList}>
      {conversation.steps.map((step) => <li key={step.id} dir="auto">{step.text}</li>)}
      {running ? <li className={styles.activeStep} aria-current="step"><AgentActivity variant="spinner" /><span dir="auto">{conversation.progress ?? "يعمل…"}</span></li> : null}
    </ol> : null}
    {!running && run ? <RunDetails key={run.id} run={run} /> : null}
  </div>;
}

function BrowserPanel({ conversation, reason, onClose, onError, onRestore, onReview, busy }: { conversation: Conversation; reason: string | null; onClose: () => void; onError: (message: string) => void; onRestore:()=>void; onReview:()=>void; busy:boolean }) {
  const page = conversation.browser!;
  const handsOn = conversation.status === "waiting_input" && conversation.secure?.kind === "hands_on";
  const [typed, setTyped] = useState("");
  const [reviewedToken,setReviewedToken]=useState<string|null>(null);
  const reviewed=Boolean(page.recoveryToken&&reviewedToken===page.recoveryToken);
  const base = `/api/chat/conversations/${conversation.id}/browser`;
  function point(x: number, y: number) {
    if (!handsOn) return;
    void api(`${base}/pointer`, { method: "POST", body: JSON.stringify({ x, y }) }).catch((caught) => onError(messageOf(caught)));
  }
  function send(input: { text?: string; key?: string }) {
    void api(`${base}/keyboard`, { method: "POST", body: JSON.stringify(input) }).catch((caught) => onError(messageOf(caught)));
  }
  function typeInPage(event: FormEvent) {
    event.preventDefault();
    send(takeoverInput(typed));
    setTyped("");
  }
  return <aside className={styles.browser} aria-label="المتصفح">
    <header className={styles.browserBar}>
      <button type="button" className={styles.iconButton} aria-label="إغلاق المتصفح" onClick={onClose}><PanelLeftClose size={18} /></button>
      <div className={styles.address} dir="ltr"><Globe size={13} /><span>{page.url}</span></div>
      <a className={styles.iconButton} href={page.url} target="_blank" rel="noopener noreferrer" aria-label="فتح في نافذة جديدة"><ExternalLink size={16} /></a>
    </header>
    {reason ? <p className={styles.needsYou} role="status" data-testid="browser-reason"><KeyRound size={15} /><span dir="auto">{reason}</span></p> : null}
    <p className={styles.cardHint}>حساب المتصفح: {conversation.browserAccount||'الافتراضي'}</p>
    <BrowserViewport key={`viewport:${conversation.id}`} conversationId={conversation.id} screenUrl={page.screenUrl} title={page.title}
      live={page.live} running={conversation.status === 'running'} handsOn={handsOn} onPoint={point} />
    {!page.live&&page.recovery==='available'?<div className={styles.card}><p>استعد قراءة الصفحة قبل متابعة العمل.</p><button type="button" className={styles.secondary} disabled={busy||WORKING.has(conversation.status)} onClick={onRestore}>استعادة الصفحة</button></div>:null}
    {/* While the owner has the controls (signing in by hand) the review cannot be recorded (the chat
        is busy), and on a narrow panel its card covered the page image: it waits until afterwards. */}
    {page.recovery==='review_required'&&!handsOn?<div className={styles.card}><p>تحتاج الجلسة السابقة إلى مراجعة. تحقق من نتيجتها في الموقع قبل المتابعة.</p><label><input type="checkbox" checked={reviewed} onChange={event=>setReviewedToken(event.target.checked?page.recoveryToken??null:null)}/> راجعت بنفسي أثر الإجراء السابق.</label><button type="button" className={styles.secondary} disabled={!reviewed||busy||WORKING.has(conversation.status)} onClick={onReview}>تسجيل المراجعة دون تكرار الإجراء</button></div>:null}
    {handsOn ? <form className={styles.takeover} onSubmit={typeInPage}>
      <input dir="auto" autoComplete="off" value={typed} placeholder="انقر على الصورة، واكتب هنا لإدخال نص في الصفحة" onChange={(event) => setTyped(event.target.value)} />
      <button type="submit" className={styles.primary}>إدخال</button>
    </form> : null}
    <BrowserFilesPanel key={conversation.id} conversationId={conversation.id} disabled={busy || WORKING.has(conversation.status) || !page.live} />
  </aside>;
}

const SUGGESTIONS = ["لخّص لي أهم أخبار اليوم", "اكتب رسالة بريد احترافية", "اصنع لي ملف PDF من نصّ أكتبه", "افتح موقعًا واعرض لي محتواه", "ساعدني في التخطيط لأسبوعي"];
const WORKING = new Set(["running", "waiting_input", "waiting_approval", "waiting_user"]);

function DeleteDialog({ target, busy, error, onCancel, onConfirm }: { target: Summary | null; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (target && !element.open) element.showModal();
    if (!target && element.open) element.close();
  }, [target]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="delete-title" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    {target ? <div className={styles.dialogBody}>
      <span className={styles.dialogIcon} aria-hidden="true"><Trash2 size={18} /></span>
      <h2 id="delete-title">حذف المحادثة؟</h2>
      <p className={styles.dialogText}>ستُحذف «<bdi>{target.title}</bdi>» برسائلها وخطواتها نهائيًا، ولا يمكن استرجاعها.{WORKING.has(target.status) ? " وسيتوقف العمل الجاري فيها." : ""}</p>
      {error ? <p className={styles.problem} role="alert">{error}</p> : null}
      <div className={styles.dialogActions}>
        <button type="button" className={styles.danger} disabled={busy} onClick={onConfirm}>{busy ? <AgentActivity variant="spinner" /> : <Trash2 size={15} />}حذف</button>
        <button type="button" className={styles.secondary} disabled={busy} autoFocus onClick={onCancel}>إلغاء</button>
      </div>
    </div> : null}
  </dialog>;
}

/** Owner-only views a failed turn can point to. The executor is a separate local experiment, never a stand-in for the chat model. */
export type AssistantToolView = "integrations" | "executor" | "desktop";

export function AssistantApp({ name, onAdvanced, onOpenTool, onSignOut }: { name: string; onAdvanced: () => void; onOpenTool?: (view: AssistantToolView) => void; onSignOut: () => void }) {
  const [history, setHistory] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [chatConfigured, setChatConfigured] = useState<boolean | null>(null);
  const [chatCapabilities, setChatCapabilities] = useState<ChatCapabilities | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [browserAccount,setBrowserAccount]=useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The panel starts closed. A level-3 step opens it once (autoOpened remembers which), the owner can open it from the
  // chip, and «closed» keeps it shut after they close it until the conversation changes.
  const [browserOpen, setBrowserOpen] = useState(false);
  const openedBy = useRef<"auto" | "user" | "closed" | null>(null);
  const autoOpened = useRef<string | null>(null);
  const [setting, setSetting] = useState<PanelSetting>("needed");
  const [unread, setUnread] = useState(0);
  const [noticeOffer, setNoticeOffer] = useState(false);
  const tasks = useRef(new Map<string, { startedAt: number; done: boolean; noticed: boolean }>());
  const seen = useRef<Record<string, string> | null>(null);
  const [itemMenu, setItemMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Summary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [notice, setNotice] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<string | null>(null);
  selection.current = selectedId;

  const refreshHistory = useCallback(async () => {
    const result = await api<{ conversations: Summary[]; configured?: boolean; capabilities?: ChatCapabilities }>("/api/chat/conversations");
    setHistory(result.conversations);
    if (typeof result.configured === "boolean") setChatConfigured(result.configured);
    if (result.capabilities) setChatCapabilities(result.capabilities);
    return result.conversations;
  }, []);

  // Back from Google's consent page: answer the waiting question so the task continues by itself.
  useEffect(() => {
    const result = new URLSearchParams(location.search).get("googleAds");
    if (!result) return;
    const pending = pendingAdsConnect.take();
    if (!pending) return;
    window.history.replaceState(null, "", location.pathname);
    saved.set(pending.conversationId);
    setSelectedId(pending.conversationId);
    if (result !== "connected") { setError(adsConnectProblems[result] ?? adsConnectProblems.failed!); return; }
    void api<Conversation>(`/api/chat/conversations/${pending.conversationId}/respond`, { method: "POST", body: JSON.stringify({ questionId: pending.questionId, optionId: "connected" }) })
      .then((next) => { setConversation(next); void refreshHistory().catch(() => {}); })
      .catch((caught) => setError(messageOf(caught)));
  }, [refreshHistory]);

  useEffect(() => {
    let active = true;
    void refreshHistory().then((items) => {
      const last = saved.get();
      if (active && last && items.some((item) => item.id === last)) setSelectedId(last);
    }).catch((caught) => { if (active) setError(messageOf(caught)); });
    return () => { active = false; };
  }, [refreshHistory]);

  useEffect(() => {
    if (!selectedId) return;
    saved.set(selectedId);
    if (conversation?.id === selectedId) return;
    let active = true;
    void api<Conversation>(`/api/chat/conversations/${selectedId}`).then((result) => { if (active) setConversation(result); }).catch((caught) => { if (active) setError(messageOf(caught)); });
    return () => { active = false; };
  }, [selectedId, conversation?.id]);

  const status = conversation?.status;
  const hasThread = Boolean(conversation?.messages.length);
  useEffect(() => {
    if (!conversation || status !== "running") return;
    const id = conversation.id;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = new AbortController();
    // The server's mark of what this view shows (2026-11-23). While the tab is shown, the next request asks the server to
    // answer as soon as the mark changes (up to WAIT_MS), so a reply appears when it is written, not on the next poll.
    // A server without marks, or one that answers at once with the same mark, is polled every POLL_MS as before.
    let since = conversation.version;
    // A hidden tab keeps following its task every 15 s instead of stopping, and catches up the moment it is shown again.
    const schedule = (delay: number) => { clearTimeout(timer); timer = setTimeout(poll, delay); };
    const poll = () => {
      if (!active) return;
      if (inFlight) { schedule(POLL_MS); return; }
      inFlight = true;
      const waiting = Boolean(since) && !document.hidden;
      const sent = Date.now(), asked = since;
      let next = POLL_MS;
      void api<Conversation>(`/api/chat/conversations/${id}${waiting ? `?since=${asked}&wait=${WAIT_MS}` : ""}`, { signal: held.signal }).then((result) => {
        if (!active || selection.current !== id) return;
        // A slow answer never moves the view back past a newer one (run-view.ts isNewerSnapshot).
        setConversation((current) => isNewerSnapshot(current, result) ? result : current);
        setError("");
        if (result.status !== "running") void refreshHistory().catch(() => {});
        since = result.version;
        // Waited on and answered: ask again at once. The same mark back within moments means the server did not wait.
        // An answer that shows the task ended waits POLL_MS instead: this effect is replaced within moments and its timer
        // cleared, so no request starts only to be cancelled (browser check of 2026-11-23); and when the view kept a newer
        // snapshot over it (isNewerSnapshot, a task superseded while running), the following goes on.
        if (result.status === "running" && waiting && result.version && !(result.version === asked && Date.now() - sent < WAIT_MS / 2)) next = 0;
      }).catch((caught) => { if (active) setError(messageOf(caught)); }).finally(() => { inFlight = false; if (active) schedule(document.hidden ? HIDDEN_POLL_MS : next); });
    };
    const shown = () => { if (!document.hidden) schedule(0); };
    document.addEventListener("visibilitychange", shown);
    schedule(document.hidden ? HIDDEN_POLL_MS : since ? 0 : POLL_MS);
    return () => { active = false; clearTimeout(timer); held.abort(); document.removeEventListener("visibilitychange", shown); };
  }, [conversation?.id, status, refreshHistory]);

  useEffect(() => { setSetting(panelSetting.get()); }, []);

  // Browser levels (plan §6): the panel opens by itself only at level 3, once per step, never on a narrow screen,
  // and folds back when the step is answered. «دائمًا» opens it for any hidden browser instead.
  const visibility = conversation?.visibility ?? null;
  const episode = conversation ? `${conversation.id}:${conversation.secure?.id ?? conversation.approval?.id ?? visibility?.code ?? ""}` : null;
  useEffect(() => {
    if (!conversation?.browser || !visibility || openedBy.current === "closed") return;
    if (panelOpens(visibility, setting) && episode && autoOpened.current !== episode && !narrowViewport()) {
      autoOpened.current = episode;
      openedBy.current = "auto";
      setBrowserOpen(true);
    } else if (visibility.level < 3 && setting !== "always" && openedBy.current === "auto" && browserOpen) {
      openedBy.current = null;
      setBrowserOpen(false);
    }
  }, [conversation?.id, conversation?.browser, visibility, episode, setting, browserOpen]);

  // Task center (plan §6.2–6.3): the list follows running tasks (slowly when hidden), counts what finished since the
  // viewer last looked, puts the count in the tab title, and shows at most one system notice per task.
  const anyRunning = status === "running" || history.some((item) => WORKING.has(item.status) && item.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => { if (active) void refreshHistory().catch(() => {}).finally(() => { if (active) timer = setTimeout(tick, document.hidden ? HIDDEN_POLL_MS : HISTORY_POLL_MS); }); };
    timer = setTimeout(tick, document.hidden ? HIDDEN_POLL_MS : HISTORY_POLL_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [anyRunning, refreshHistory]);
  useEffect(() => {
    seen.current ??= seenTasks.get();
    const record = seen.current;
    const now = Date.now();
    let offer = false;
    for (const item of history) {
      const task = tasks.current.get(item.id);
      if (item.status === "running") {
        if (!task || task.done) tasks.current.set(item.id, { startedAt: now, done: false, noticed: false });
        else if (now - task.startedAt >= NOTICE_AFTER_MS) offer = true;
        continue;
      }
      // A conversation first seen already finished is old news, never a new result.
      if (!(item.id in record)) record[item.id] = item.updatedAt;
      if (task && !task.done) {
        task.done = true;
        const kind = noticeKindFor(item.status);
        if (kind && !task.noticed) task.noticed = showTaskNotice(kind, item.title, () => open(item.id));
      }
    }
    if (offer && noticeOfferOpen()) setNoticeOffer(true);
    setUnread(history.filter((item) => item.status !== "running" && item.id in record && item.updatedAt > record[item.id] && item.id !== selection.current).length);
    seenTasks.set(record);
  }, [history]);
  useEffect(() => {
    // Looking at a conversation while the tab is shown marks it seen.
    const mark = () => {
      if (document.hidden || !conversation || conversation.status === "running") return;
      seen.current ??= seenTasks.get();
      if (seen.current[conversation.id] !== conversation.updatedAt) { seen.current[conversation.id] = conversation.updatedAt; seenTasks.set(seen.current); }
      setUnread(history.filter((item) => item.status !== "running" && seen.current && item.id in seen.current && item.updatedAt > seen.current[item.id] && item.id !== conversation.id).length);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [conversation?.id, conversation?.updatedAt, conversation?.status, history]);
  // The hidden tab's title carries the live words while a run is going; the unread count stays in front of the name.
  useEffect(() => {
    const apply = () => {
      const name = unread ? `(${unread}) موحسن` : "موحسن";
      document.title = status === "running" && document.hidden && conversation?.progress ? `${conversation.progress} · ${name}` : name;
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, [unread, status, conversation?.progress]);

  useEffect(() => {
    const viewport = thread.current, content = threadContent.current;
    if (!viewport || !content) return;
    followEnd.current = true;
    let frame = 0;
    let size = { width: viewport.clientWidth, height: viewport.clientHeight, content: viewport.scrollHeight };
    const onScroll = () => {
      // Reaching the end always opts back in, including while an entry's CSS
      // animation temporarily changes scroll overflow without changing its box.
      if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64) {
        followEnd.current = true;
        return;
      }
      // Layout changes can emit a scroll event before ResizeObserver runs.
      // They must not turn a reader following the latest answer into history mode.
      if (viewport.clientWidth === size.width && viewport.clientHeight === size.height && viewport.scrollHeight === size.content)
        followEnd.current = false;
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followEnd.current) viewport.scrollTop = viewport.scrollHeight;
        size = { width: viewport.clientWidth, height: viewport.clientHeight, content: viewport.scrollHeight };
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport); observer.observe(content);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); viewport.removeEventListener("scroll", onScroll); };
  }, [conversation?.id, hasThread]);

  useEffect(() => {
    if (followEnd.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [conversation?.messages.length, conversation?.progress, conversation?.status]);

  const running = status === "running";
  const answering = status === "waiting_user";
  // The request's own time, for the counter on the chip's live line.
  const requestedAt = conversation?.messages.filter((message) => message.role === "user").at(-1)?.createdAt ?? null;
  const blocked = status === "waiting_input" || status === "waiting_approval";
  // While a task works or waits for approval or for the owner's hands, a typed message corrects it (the server ends the
  // old run, drops what it had queued and starts the corrected one); «توقف» alone stops it. Images do not steer.
  const steering = Boolean(selectedId) && steerable(status, conversation?.secure?.kind);
  const canSend = !busy && uploading === 0 && (steering ? draft.trim().length > 0 && attachments.length === 0
    : !running && !blocked && (draft.trim().length > 0 || attachments.length > 0));
  // The brain's questions take the input's place, one at a time, as in Claude.
  const asking = answering && !!conversation?.question?.fields?.length;

  async function act(operation: () => Promise<Conversation>): Promise<boolean> {
    if (busy) return false;
    followEnd.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      setConversation((current) => isNewerSnapshot(current, result) ? result : current);
      setSelectedId(result.id);
      // A sidebar refresh failure must not make a successful send look rejected.
      await refreshHistory().catch(() => {});
      return true;
    } catch (caught) {
      setError(messageOf(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, body: unknown) => api<Conversation>(`/api/chat/conversations/${conversation!.id}/${path}`, { method: "POST", body: JSON.stringify(body) });

  async function connectGoogleAds() {
    if (busy || !conversation?.question) return;
    setBusy(true);
    setError("");
    try {
      const { authorizationUrl } = await api<{ authorizationUrl: string }>("/api/google-ads/connect", { method: "POST", body: "{}" });
      pendingAdsConnect.set({ conversationId: conversation.id, questionId: conversation.question.id });
      location.assign(authorizationUrl);
    } catch (caught) {
      setError(messageOf(caught));
      setBusy(false);
    }
  }

  /** Image files from the picker, a paste or a drop: shrunk in the browser, then uploaded for the own reader. */
  async function uploadFiles(list: Iterable<File>) {
    const files = [...list].filter((file) => /^image\/(?:png|jpeg|webp|gif|bmp)$/.test(file.type)).slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length));
    if (!files.length) return;
    setError("");
    setUploading((count) => count + files.length);
    for (const file of files) {
      try {
        const encoded = await encodeForUpload(file);
        const result = await api<{ id: string; width: number; height: number; url: string }>("/api/chat/images", { method: "POST", body: JSON.stringify(encoded) });
        setAttachments((current) => current.length >= MAX_ATTACHMENTS ? current : [...current, { id: result.id, width: result.width, height: result.height, url: result.url, name: file.name || "صورة" }]);
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setUploading((count) => count - 1);
      }
    }
    composer.current?.focus();
  }
  function onPaste(event: { clipboardData: DataTransfer | null; preventDefault(): void }) {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void uploadFiles(files);
  }
  function onDrop(event: { dataTransfer: DataTransfer | null; preventDefault(): void }) {
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void uploadFiles(files);
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    if(!selectedId&&browserAccount.trim()&&!/^[a-zA-Z0-9_-]{1,128}$/.test(browserAccount.trim())){setError('استخدم حروفًا إنجليزية وأرقامًا وشرطة لاسم حساب المتصفح.');return;}
    // Send the actual input bytes. The server owns display trimming and must
    // detect any change before promising to save a literal note exactly.
    const text = draft;
    const images = attachments.map((item) => item.id);
    const withImages = images.length ? { images } : {};
    const sent = await act(() => selectedId
      ? api<Conversation>(`/api/chat/conversations/${selectedId}/messages`, { method: "POST", body: JSON.stringify({ ...(text ? { text } : {}), ...withImages }) })
      : api<Conversation>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ ...(text.trim() ? { goal: text } : {}), ...withImages, ...(browserAccount.trim() ? { browserAccount: browserAccount.trim() } : {}) }) }));
    if (sent) { setDraft((current) => current === text ? "" : current); setAttachments((current) => current.filter((item) => !images.includes(item.id))); }
    composer.current?.focus();
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }
  function startNew() {
    saved.set(null);
    setSelectedId(null);
    setConversation(null);
    setDraft("");
    setBrowserAccount("");
    setError("");
    setSidebarOpen(false);
    composer.current?.focus();
  }
  useEffect(() => {
    if (!itemMenu) return;
    const onPointer = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.("[data-item-menu]")) setItemMenu(null); };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setItemMenu(null); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [itemMenu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  function askDelete(item: Summary) {
    setItemMenu(null);
    setDeleteError("");
    setDeleting(item);
  }
  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    const target = deleting;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await api<{ ok: true }>(`/api/chat/conversations/${target.id}`, { method: "DELETE" });
      setHistory((items) => items.filter((item) => item.id !== target.id));
      if (selection.current === target.id) {
        saved.set(null);
        setSelectedId(null);
        setConversation(null);
        setError("");
      }
      setDeleting(null);
      setNotice("حُذفت المحادثة.");
      void refreshHistory().catch(() => {});
    } catch (caught) {
      setDeleteError(messageOf(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  function open(id: string) {
    if (id !== selectedId) { setConversation(null); setBrowserOpen(false); openedBy.current = null; autoOpened.current = null; }
    setSelectedId(id);
    setError("");
    setSidebarOpen(false);
  }
  function showPanel() { openedBy.current = "user"; setBrowserOpen(true); }
  function hidePanel() { openedBy.current = "closed"; setBrowserOpen(false); }
  function chooseSetting(value: PanelSetting) { panelSetting.set(value); setSetting(value); }
  async function enableNotices() { await requestNoticePermission(); setNoticeOffer(false); }

  const empty = !conversation || !conversation.messages.length;
  // The Chrome bar belongs to Google Ads work: campaign events, or a campaign asked for in this conversation.
  const adsConversation = Boolean(conversation?.campaign?.events.length
    || conversation?.messages.some(message => message.role === "user" && ADS_WORDS.test(message.text)));
  const showBrowser = Boolean(conversation?.browser && browserOpen);
  const firstName = name.trim().split(/\s+/)[0];
  const form = <form className={styles.composer} onSubmit={send} onPaste={onPaste} onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
    {!selectedId?<details className={styles.browserAccount}><summary>حساب المتصفح: {browserAccount||'الافتراضي'}</summary><label htmlFor="browser-account">اسم جلسة الحساب</label><input id="browser-account" dir="ltr" value={browserAccount} maxLength={128} pattern="[a-zA-Z0-9_-]{1,128}" placeholder="work-account" disabled={busy} onChange={event=>setBrowserAccount(event.target.value)}/><small>اتركه فارغًا للحساب الافتراضي، أو استخدم اسمًا بحروف إنجليزية وأرقام لفصل حسابات المواقع.</small></details>:null}
    {attachments.length || uploading ? <div className={styles.attachments}>
      {attachments.map((item) => <span key={item.id} className={styles.attachment}><img src={item.url} alt={item.name} /><button type="button" aria-label="إزالة الصورة" onClick={() => setAttachments((current) => current.filter((other) => other.id !== item.id))}><X size={12} /></button></span>)}
      {uploading ? <span className={styles.attachmentBusy} aria-label="جارٍ رفع الصورة"><AgentActivity variant="spinner" /></span> : null}
    </div> : null}
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden onChange={(event) => { const files = event.currentTarget.files; if (files) void uploadFiles(files); event.currentTarget.value = ""; }} />
    <button type="button" className={styles.attach} aria-label="إرفاق صورة" title="أرفق صورة ليقرأها موحسن" disabled={blocked || running || attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}><ImagePlus size={18} /></button>
    <label className={styles.hidden} htmlFor="assistant-message">رسالتك</label>
    <textarea
      id="assistant-message" ref={composer} dir="auto" rows={1} maxLength={4000} value={draft} autoFocus
      placeholder={steering ? "صحّح الطلب أو وجّهه… («توقف» يوقفه)" : answering ? "اكتب إجابتك…" : attachments.length ? "اسأل عن الصورة أو أرسلها مباشرة…" : "اكتب طلبك هنا…"} disabled={blocked && !steering}
      onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`; }}
      onKeyDown={onComposerKey}
    />
    {running || blocked || answering
      ? <button type="button" className={styles.stop} aria-label="إيقاف" disabled={busy} onClick={() => void act(() => post("cancel", {}))}><Square size={13} fill="currentColor" /></button>
      : null}
    {!running || draft.trim() ? <button type="submit" className={styles.send} aria-label={steering ? "إرسال التصحيح" : "إرسال"} disabled={!canSend}>{busy ? <AgentActivity variant="spinner" /> : <ArrowUp size={19} />}</button> : null}
  </form>;

  return <div className={styles.app}>
    {sidebarOpen ? <button className={styles.scrim} aria-label="إغلاق القائمة" onClick={() => setSidebarOpen(false)} /> : null}
    <nav className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`} aria-label="المحادثات">
      <div className={styles.brandRow}>
        <span className={styles.brand}><span className={styles.brandMark} aria-hidden="true">م</span><strong>موحسن</strong></span>
        <button className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="إغلاق القائمة" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
      </div>
      <button className={styles.newChat} onClick={startNew}><SquarePen size={16} />محادثة جديدة</button>
      <div className={styles.history}>
        {history.length ? <span className={styles.historyLabel}>المحادثات{unread ? <span className={styles.unreadBadge} aria-label={`${unread} غير مقروء`}>{unread}</span> : null}</span> : <p className={styles.historyEmpty}><MessageSquare size={16} />ستظهر محادثاتك هنا.</p>}
        {history.map((item) => {
          const current = item.id === selectedId;
          const shown = itemMenu === item.id;
          return <div key={item.id} className={`${styles.historyItem} ${current ? styles.current : ""} ${shown ? styles.menuShown : ""}`} data-item-menu="">
            <button className={styles.historyOpen} aria-current={current ? "true" : undefined} onClick={() => open(item.id)} title={item.title}>
              {item.status === "running" ? <span className={styles.livePip} role="img" aria-label="يعمل الآن" />
                : item.status === "idle" && seen.current && item.id in seen.current && item.updatedAt > seen.current[item.id] && !current ? <span className={styles.doneDot} role="img" aria-label="اكتمل" /> : null}
              <span dir="auto">{item.title}</span>
              {item.status === "waiting_input" || item.status === "waiting_approval" || item.status === "waiting_user" ? <span className={`${styles.taskTag} ${styles.needs}`}>تحتاجك</span>
                : item.status === "failed" ? <span className={`${styles.taskTag} ${styles.failed}`}>تعذّر</span> : null}
            </button>
            <button className={styles.itemMenuButton} aria-label={`خيارات المحادثة: ${item.title}`} aria-haspopup="menu" aria-expanded={shown} onClick={() => setItemMenu(shown ? null : item.id)}><MoreHorizontal size={16} /></button>
            {shown ? <div className={styles.itemMenu} role="menu">
              <button role="menuitem" className={styles.dangerItem} autoFocus onClick={() => askDelete(item)}><Trash2 size={15} />حذف</button>
            </div> : null}
          </div>;
        })}
      </div>
      <div className={styles.account}>
        {menuOpen ? <div className={styles.menu}>
          <label className={styles.settingRow}><span>اعرض المتصفح</span>
            <select value={setting} onChange={(event) => chooseSetting(event.target.value as PanelSetting)}>{PANEL_SETTINGS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </label>
          {onOpenTool ? <button onClick={() => { setMenuOpen(false); onOpenTool("desktop"); }}><Laptop size={15} />سطح المكتب</button> : null}
          <button onClick={() => { setMenuOpen(false); onAdvanced(); }}><Settings2 size={15} />الأدوات المتقدمة</button>
          <button onClick={onSignOut}><LogOut size={15} />تسجيل الخروج</button>
        </div> : null}
        <button className={styles.profile} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><span>{firstName.charAt(0)}</span><strong dir="auto">{name}</strong></button>
      </div>
    </nav>

    <main className={`${styles.main} ${showBrowser ? styles.withBrowser : ""}`}>
      <header className={styles.topbar}>
        <button className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="فتح القائمة" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
        <span dir="auto">{conversation?.title !== "محادثة جديدة" ? conversation?.title : ""}</span>
        {conversation?.browser && !browserOpen && visibility?.canView !== false ? <button className={`${styles.showBrowser} ${running ? styles.background : ""}`} onClick={showPanel} aria-label="عرض المتصفح" data-testid="browser-chip">
          {running
            ? <><span className={styles.chipName}>المتصفح ·</span><ActivityLine text={conversation.progress ?? "يعمل في الخلفية"} since={requestedAt} compact /><span className={styles.chipAction}>· عرض</span></>
            : <><Globe size={15} />المتصفح · عرض</>}</button> : null}
        {conversation ? <button className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="محادثة جديدة" onClick={startNew}><SquarePen size={18} /></button> : null}
        <RemindersSettings conversation={conversation} selection={selection} setConversation={setConversation} refreshHistory={refreshHistory} onOpenConversation={open} />
      </header>
      {noticeOffer ? <div className={styles.noticeBar} role="status" data-testid="notice-offer">
        <span>مهمة تعمل في الخلفية منذ أكثر من 20 ثانية. أعلمك عند انتهاء المهام حين يكون التبويب مخفيًا؟</span>
        <button type="button" className={styles.primary} onClick={() => void enableNotices()}>تفعيل الإشعارات</button>
        <button type="button" className={styles.secondary} onClick={() => { declineNoticeOffer(); setNoticeOffer(false); }}>ليس الآن</button>
      </div> : null}
      {onOpenTool ? <ChromeExtensionPanel relevant={adsConversation} /> : null}
      {empty ? <div className={styles.welcome}>
        <span className={styles.welcomeMark} aria-hidden="true">م</span>
        <h1>كيف أساعدك اليوم، {firstName}؟</h1>
        {form}
        <div className={styles.suggestions}>
          {SUGGESTIONS.map((text) => <button key={text} type="button" onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}
        </div>
        {(conversation?.configured ?? chatConfigured) === false ? <p className={styles.localMode} role="status">{localModeText(conversation?.capabilities ?? chatCapabilities)}</p> : null}
        {error ? <p className={styles.problem} role="alert">{error}</p> : null}
      </div> : <>
        <div ref={thread} className={styles.thread} role="log" aria-label="المحادثة">
          <div ref={threadContent} className={styles.column}>
            {conversation!.olderMessages ? <p className={styles.localMode} role="note">{`رسائل أقدم غير معروضة هنا (${conversation!.olderMessages})، والمعروض آخر ${conversation!.messages.length} رسالة.`}</p> : null}
            {conversation!.messages.map((message, index) => <article key={message.id} className={message.role === "user" ? styles.userTurn : styles.assistantTurn}>
              {message.role === "user" && message.images?.length ? <div className={styles.messageImages}>{message.images.map((image) => <a key={image.id} href={`/api/chat/images/${image.id}`} target="_blank" rel="noreferrer"><img src={`/api/chat/images/${image.id}`} alt="صورة مرفقة" width={image.width} height={image.height} /></a>)}</div> : null}
              {message.role === "user" ? <p dir="auto">{message.text}</p> : <Markdown text={asking && index === conversation!.messages.length - 1 ? withoutQuestionList(message.text) : message.text} />}
              {message.role === "assistant" && message.text.trim() ? <div className={styles.replyTools}><CopyButton text={message.text} /><FeedbackButtons key={message.id} conversationId={conversation!.id} messageId={message.id} /></div> : null}
              {index === conversation!.messages.length - 1 && message.role === "user" ? <Steps conversation={conversation!} /> : null}
            </article>)}
            {conversation!.messages.at(-1)?.role === "assistant" && (running || conversation!.steps.length > 0 || unfinishedVerdict(conversation!)) && !answering && !blocked ? <Steps conversation={conversation!} /> : null}
            {conversation!.campaign?.events.length ? <CampaignCard stream={conversation!.campaign} running={running} /> : null}
            {conversation!.question?.fields?.length ? null
            : conversation!.question ? <div className={styles.choices}>{conversation!.question.options.map((option) => <button key={option.id} disabled={busy} onClick={() => conversation!.question!.action === "google_ads_connect" && option.id === "connect" ? void connectGoogleAds() : void act(() => post("respond", { questionId: conversation!.question!.id, optionId: option.id }))}>{option.label}</button>)}</div> : null}
            {conversation!.approval ? <div className={styles.card}>
              <div className={styles.cardTitle}><ShieldAlert size={16} />يحتاج موافقتك</div>
              {/* What the server's permission gate bound this approval to (2026-11-23): the exact target, what follows, and whether it can be undone. */}
              {conversation!.approval.target ? <p className={styles.cardHint} data-testid="approval-target"><strong>الهدف:</strong> <bdi>{conversation!.approval.target}</bdi></p> : null}
              {conversation!.approval.consequence ? <p className={styles.cardHint}><strong>ما سيحدث:</strong> {conversation!.approval.consequence}</p> : null}
              {typeof conversation!.approval.reversible === "boolean" ? <p className={styles.cardHint}>{conversation!.approval.reversible ? "يمكن التراجع عنه." : "لا يمكن التراجع عنه."}</p> : null}
              <p className={styles.cardHint}>{conversation!.approval.detail}</p>
              <p className={styles.cardHint}>تنطبق الموافقة على هذا الإجراء بتفاصيله هذه فقط. وإن كتبت تصحيحًا بدلها، يُلغى هذا الإجراء ولا يُنفَّذ.</p>
              <div className={styles.cardActions}>
                <button className={styles.primary} disabled={busy} onClick={() => void act(() => post("approve", { approvalId: conversation!.approval!.id, approved: true }))}>موافق</button>
                <button className={styles.secondary} disabled={busy} onClick={() => void act(() => post("approve", { approvalId: conversation!.approval!.id, approved: false }))}>لا تفعل</button>
              </div>
            </div> : null}
            {conversation!.secure ? <SecureCard request={conversation!.secure} busy={busy} onSubmit={(action, values) => void act(() => post("secure", { requestId: conversation!.secure!.id, action, ...(values ? { values } : {}) }))} /> : null}
            {conversation!.error || error ? <p className={styles.problem} role="alert">{conversation!.error || error}</p> : null}
            {conversation!.status === "failed" && conversation!.error && onOpenTool ? <div className={styles.problemActions}>
              <button type="button" className={styles.secondary} onClick={() => onOpenTool("integrations")}><Settings2 size={15} />حالة مزودي النماذج</button>
              <button type="button" className={styles.secondary} onClick={() => onOpenTool("executor")}>المنفّذ المحلي (مهام محددة فقط)</button>
            </div> : null}
            <DocumentsPanel key={`documents:${conversation!.id}`} conversationId={conversation!.id} version={conversation!.messages.length} busy={busy} />
          </div>
        </div>
        <div className={styles.dock}>{asking ? <QuestionPanel key={conversation!.question!.id} fields={conversation!.question!.fields!} busy={busy}
            onSubmit={(_text, answers) => void act(() => post("messages", { answers, questionId: conversation!.question!.id }))}
            onStop={conversation!.question!.options.some(option => option.id === "stop") ? () => void act(() => post("respond", { questionId: conversation!.question!.id, optionId: "stop" })) : undefined} />
          : <>{form}<p className={styles.dockHint}>{steering
            ? "رسالتك الآن تصحّح المهمة الجارية: يُلغى ما كان معلّقًا منها ولا يُنفَّذ، وتبدأ بالطلب المصحّح."
            : <><kbd>Enter</kbd> للإرسال، و<bdi dir="ltr"><kbd>Shift</kbd> + <kbd>Enter</kbd></bdi> لسطر جديد</>}</p></>}</div>
      </>}
    </main>
    {showBrowser ? <BrowserPanel conversation={conversation!} reason={visibility?.level === 3 ? visibility.reason : null} onClose={hidePanel} onError={setError} busy={busy} onRestore={()=>void act(()=>post("browser/restore",{}))} onReview={()=>void act(()=>post("browser/review",{reviewed:true,checkpointToken:conversation?.browser?.recoveryToken}))} /> : null}
    <DeleteDialog target={deleting} busy={deleteBusy} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />
    {notice ? <div className={styles.toast} role="status"><Check size={15} />{notice}</div> : null}
  </div>;
}

/** Copies one reply as plain text, so it can be pasted anywhere without ** or > marks. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const value = plainText(text);
    let done = false;
    try { await navigator.clipboard.writeText(value); done = true; } catch { done = copyBySelection(value); }
    setCopied(done);
    if (done) setTimeout(() => setCopied(false), 1800);
  }
  return <button type="button" className={styles.copyReply} onClick={() => void copy()} aria-label="نسخ الرد" title="نسخ الرد">
    {copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? "تم النسخ" : "نسخ"}</span>
  </button>;
}

/** «مفيد / خطأ / ناقص» under a reply (plan §7.5): one click records the verdict; «خطأ» and «ناقص» can take a short note. */
function FeedbackButtons({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const [verdict, setVerdict] = useState<"useful" | "wrong" | "incomplete" | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);
  async function send(value: "useful" | "wrong" | "incomplete", text?: string) {
    setFailed(false);
    try {
      await api(`/api/chat/conversations/${conversationId}/feedback`, { method: "POST", body: JSON.stringify({ messageId, verdict: value, ...(text?.trim() ? { note: text.trim() } : {}) }) });
      setVerdict(value);
      setNoting(value !== "useful" && !text);
    } catch { setFailed(true); }
  }
  const labels = { useful: "مفيد", wrong: "خطأ", incomplete: "ناقص" } as const;
  return <div className={styles.feedback} role="group" aria-label="تقييم الرد">
    {(["useful", "wrong", "incomplete"] as const).map((value) => <button key={value} type="button" className={`${styles.copyReply} ${verdict === value ? styles.chosen : ""}`} aria-pressed={verdict === value} onClick={() => void send(value)}>{labels[value]}</button>)}
    {noting ? <form className={styles.feedbackNote} onSubmit={(event) => { event.preventDefault(); void send(verdict!, note); setNoting(false); }}>
      <input dir="auto" value={note} maxLength={500} placeholder="ما الذي كان خطأ أو ناقصًا؟ (اختياري)" onChange={(event) => setNote(event.target.value)} />
      <button type="submit" className={styles.secondary}>حفظ</button>
    </form> : null}
    {failed ? <span className={styles.problem}>لم يُحفظ التقييم.</span> : null}
  </div>;
}

/** For pages without the Clipboard API (plain http from a phone) or where it is blocked. */
function copyBySelection(value: string): boolean {
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let done = false;
  try { done = document.execCommand("copy"); } catch { done = false; }
  area.remove();
  return done;
}
