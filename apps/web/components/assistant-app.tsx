"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowUp, Check, ChevronDown, ExternalLink, Globe, KeyRound, LoaderCircle, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Settings2, ShieldAlert, SquarePen, Square, Trash2, X } from "lucide-react";
import type { ChatConversation as Conversation, ChatConversationSummary as Summary, ChatSecureRequest } from "@mohassan/contracts";
import { Markdown } from "./markdown";
import { takeoverInput } from "./takeover-input";
import { BrowserFilesPanel } from './browser-files-panel';
import { CampaignCard } from "./campaign-card";
import { adsConnectProblems, pendingAdsConnect } from "./ads-connect";
import styles from "./assistant-app.module.css";

const POLL_MS = 900;
const HANDS_ON_REFRESH_MS = 1200;
const SAVED_CONVERSATION = "mohassan-conversation";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 429 && body?.error?.code !== "MEMBER_DAILY_LIMIT" ? "طلبات كثيرة متتابعة. انتظر لحظة ثم حاول مجددًا." : body?.error?.message ?? "تعذر إتمام الطلب. حاول مجددًا.");
  return body as T;
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : "تعذر الاتصال. حاول مجددًا.";
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

function Steps({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false);
  const running = conversation.status === "running";
  if (!running && !conversation.steps.length) return null;
  return <div className={styles.steps}>
    <button type="button" className={styles.stepsToggle} aria-expanded={open} disabled={!conversation.steps.length} onClick={() => setOpen((value) => !value)}>
      {running ? <span className={styles.pulse} /> : <Check size={14} />}
      <span className={running ? styles.shimmer : ""} dir="auto">{running ? conversation.progress ?? "يعمل…" : stepCount(conversation.steps.length)}</span>
      {conversation.steps.length ? <ChevronDown size={14} className={open ? styles.flipped : ""} /> : null}
    </button>
    {open ? <ol className={styles.stepList}>{conversation.steps.map((step) => <li key={step.id} dir="auto">{step.text}</li>)}</ol> : null}
  </div>;
}

function BrowserPanel({ conversation, onClose, onError, onRestore, onReview, busy }: { conversation: Conversation; onClose: () => void; onError: (message: string) => void; onRestore:()=>void; onReview:()=>void; busy:boolean }) {
  const page = conversation.browser!;
  const handsOn = conversation.status === "waiting_input" && conversation.secure?.kind === "hands_on";
  const [tick, setTick] = useState(0);
  const [typed, setTyped] = useState("");
  const [broken, setBroken] = useState<string | null>(null);
  const [reviewedToken,setReviewedToken]=useState<string|null>(null);
  const reviewed=Boolean(page.recoveryToken&&reviewedToken===page.recoveryToken);
  useEffect(() => {
    if (!handsOn) return;
    const timer = setInterval(() => setTick((value) => value + 1), HANDS_ON_REFRESH_MS);
    return () => clearInterval(timer);
  }, [handsOn]);
  const source = `${page.screenUrl}${handsOn ? `&t=${tick}` : ""}`;
  const base = `/api/chat/conversations/${conversation.id}/browser`;
  function point(event: MouseEvent<HTMLImageElement>) {
    if (!handsOn) return;
    const box = event.currentTarget.getBoundingClientRect();
    void api(`${base}/pointer`, { method: "POST", body: JSON.stringify({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }) }).catch((caught) => onError(messageOf(caught)));
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
    <p className={styles.cardHint}>حساب المتصفح: {conversation.browserAccount||'الافتراضي'}</p>
    <div className={`${styles.viewport} ${handsOn ? styles.viewportActive : ""}`}>
      {page.live && broken !== source ? <img src={source} alt={`الصفحة: ${page.title}`} onClick={point} onError={() => setBroken(source)} draggable={false} /> : <p className={styles.noView}>{page.live ? "تتحمّل الصفحة…" : "أُغلقت هذه الصفحة."}</p>}
    </div>
    {!page.live&&page.recovery==='available'?<div className={styles.card}><p>استعد قراءة الصفحة قبل متابعة العمل.</p><button type="button" className={styles.secondary} disabled={busy||WORKING.has(conversation.status)} onClick={onRestore}>استعادة الصفحة</button></div>:null}
    {page.recovery==='review_required'?<div className={styles.card}><p>تحتاج الجلسة السابقة إلى مراجعة. تحقق من نتيجتها في الموقع قبل المتابعة.</p><label><input type="checkbox" checked={reviewed} onChange={event=>setReviewedToken(event.target.checked?page.recoveryToken??null:null)}/> راجعت بنفسي أثر الإجراء السابق.</label><button type="button" className={styles.secondary} disabled={!reviewed||busy||WORKING.has(conversation.status)} onClick={onReview}>تسجيل المراجعة دون تكرار الإجراء</button></div>:null}
    {handsOn ? <form className={styles.takeover} onSubmit={typeInPage}>
      <input dir="auto" autoComplete="off" value={typed} placeholder="انقر على الصورة، واكتب هنا لإدخال نص في الصفحة" onChange={(event) => setTyped(event.target.value)} />
      <button type="submit" className={styles.primary}>إدخال</button>
    </form> : null}
    <BrowserFilesPanel key={conversation.id} conversationId={conversation.id} disabled={busy || WORKING.has(conversation.status) || !page.live} />
  </aside>;
}

const SUGGESTIONS = ["لخّص لي أهم أخبار اليوم", "اكتب رسالة بريد احترافية", "افتح موقعًا واعرض لي محتواه", "ساعدني في التخطيط لأسبوعي"];
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
        <button type="button" className={styles.danger} disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className={styles.spin} /> : <Trash2 size={15} />}حذف</button>
        <button type="button" className={styles.secondary} disabled={busy} autoFocus onClick={onCancel}>إلغاء</button>
      </div>
    </div> : null}
  </dialog>;
}

export function AssistantApp({ name, onAdvanced, onSignOut }: { name: string; onAdvanced: () => void; onSignOut: () => void }) {
  const [history, setHistory] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [browserAccount,setBrowserAccount]=useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(true);
  const [itemMenu, setItemMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Summary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [notice, setNotice] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<string | null>(null);
  selection.current = selectedId;

  const refreshHistory = useCallback(async () => {
    const result = await api<{ conversations: Summary[] }>("/api/chat/conversations");
    setHistory(result.conversations);
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
  useEffect(() => {
    if (!conversation || status !== "running") return;
    const id = conversation.id;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      void api<Conversation>(`/api/chat/conversations/${id}`).then((result) => {
        if (!active || selection.current !== id) return;
        setConversation(result);
        setError("");
        if (result.status !== "running") void refreshHistory().catch(() => {});
      }).catch((caught) => { if (active) setError(messageOf(caught)); }).finally(() => { inFlight = false; });
    }, POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [conversation?.id, status, refreshHistory]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation?.messages.length, conversation?.progress, conversation?.status]);

  const running = status === "running";
  const answering = status === "waiting_user";
  const blocked = status === "waiting_input" || status === "waiting_approval";
  const canSend = !busy && !running && !blocked && draft.trim().length > 0;

  async function act(operation: () => Promise<Conversation>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      setConversation(result);
      setSelectedId(result.id);
      setBrowserOpen(true);
      await refreshHistory();
    } catch (caught) {
      setError(messageOf(caught));
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

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    if(!selectedId&&browserAccount.trim()&&!/^[a-zA-Z0-9_-]{1,128}$/.test(browserAccount.trim())){setError('استخدم حروفًا إنجليزية وأرقامًا وشرطة لاسم حساب المتصفح.');return;}
    const text = draft.trim();
    setDraft("");
    await act(() => selectedId
      ? api<Conversation>(`/api/chat/conversations/${selectedId}/messages`, { method: "POST", body: JSON.stringify({ text }) })
      : api<Conversation>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ goal: text,browserAccount:browserAccount.trim()||null }) }));
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
    if (id !== selectedId) setConversation(null);
    setSelectedId(id);
    setBrowserOpen(true);
    setError("");
    setSidebarOpen(false);
  }

  const empty = !conversation || !conversation.messages.length;
  const showBrowser = Boolean(conversation?.browser && browserOpen);
  const firstName = name.trim().split(/\s+/)[0];
  const form = <form className={styles.composer} onSubmit={send}>
    {!selectedId?<details className={styles.browserAccount}><summary>حساب المتصفح: {browserAccount||'الافتراضي'}</summary><label htmlFor="browser-account">اسم جلسة الحساب</label><input id="browser-account" dir="ltr" value={browserAccount} maxLength={128} pattern="[a-zA-Z0-9_-]{1,128}" placeholder="work-account" disabled={busy} onChange={event=>setBrowserAccount(event.target.value)}/><small>اتركه فارغًا للحساب الافتراضي، أو استخدم اسمًا بحروف إنجليزية وأرقام لفصل حسابات المواقع.</small></details>:null}
    <label className={styles.hidden} htmlFor="assistant-message">رسالتك</label>
    <textarea
      id="assistant-message" ref={composer} dir="auto" rows={1} maxLength={4000} value={draft} autoFocus
      placeholder={answering ? "اكتب إجابتك…" : "اكتب طلبك هنا…"} disabled={blocked}
      onChange={(event) => { setDraft(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 220)}px`; }}
      onKeyDown={onComposerKey}
    />
    {running || blocked || answering
      ? <button type="button" className={styles.stop} aria-label="إيقاف" disabled={busy} onClick={() => void act(() => post("cancel", {}))}><Square size={13} fill="currentColor" /></button>
      : null}
    {!running ? <button type="submit" className={styles.send} aria-label="إرسال" disabled={!canSend}>{busy ? <LoaderCircle size={18} className={styles.spin} /> : <ArrowUp size={19} />}</button> : null}
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
        {history.length ? <span className={styles.historyLabel}>المحادثات</span> : <p className={styles.historyEmpty}><MessageSquare size={16} />ستظهر محادثاتك هنا.</p>}
        {history.map((item) => {
          const current = item.id === selectedId;
          const shown = itemMenu === item.id;
          return <div key={item.id} className={`${styles.historyItem} ${current ? styles.current : ""} ${shown ? styles.menuShown : ""}`} data-item-menu="">
            <button className={styles.historyOpen} aria-current={current ? "true" : undefined} onClick={() => open(item.id)} title={item.title}>
              {item.status === "running" ? <span className={styles.livePip} role="img" aria-label="يعمل الآن" /> : null}
              <span dir="auto">{item.title}</span>
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
        {conversation?.browser && !browserOpen ? <button className={styles.showBrowser} onClick={() => setBrowserOpen(true)}><Globe size={15} />المتصفح</button> : null}
        {conversation ? <button className={`${styles.iconButton} ${styles.mobileOnly}`} aria-label="محادثة جديدة" onClick={startNew}><SquarePen size={18} /></button> : null}
      </header>
      {empty ? <div className={styles.welcome}>
        <span className={styles.welcomeMark} aria-hidden="true">م</span>
        <h1>كيف أساعدك اليوم، {firstName}؟</h1>
        {form}
        <div className={styles.suggestions}>
          {SUGGESTIONS.map((text) => <button key={text} type="button" onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}</button>)}
        </div>
        {conversation && !conversation.configured ? <p className={styles.problem} role="alert">لم يُضبط مفتاح Groq في الخادم بعد.</p> : null}
        {error ? <p className={styles.problem} role="alert">{error}</p> : null}
      </div> : <>
        <div className={styles.thread} role="log" aria-label="المحادثة">
          <div className={styles.column}>
            {conversation!.messages.map((message, index) => <article key={message.id} className={message.role === "user" ? styles.userTurn : styles.assistantTurn}>
              {message.role === "user" ? <p dir="auto">{message.text}</p> : <Markdown text={message.text} />}
              {index === conversation!.messages.length - 1 && message.role === "user" ? <Steps conversation={conversation!} /> : null}
            </article>)}
            {conversation!.messages.at(-1)?.role === "assistant" && conversation!.steps.length && !answering && !blocked ? <Steps conversation={conversation!} /> : null}
            {conversation!.campaign?.events.length ? <CampaignCard stream={conversation!.campaign} running={running} /> : null}
            {conversation!.question ? <div className={styles.choices}>{conversation!.question.options.map((option) => <button key={option.id} disabled={busy} onClick={() => conversation!.question!.action === "google_ads_connect" && option.id === "connect" ? void connectGoogleAds() : void act(() => post("respond", { questionId: conversation!.question!.id, optionId: option.id }))}>{option.label}</button>)}</div> : null}
            {conversation!.approval ? <div className={styles.card}>
              <div className={styles.cardTitle}><ShieldAlert size={16} />يحتاج موافقتك</div>
              <p className={styles.cardHint}>{conversation!.approval.detail}</p>
              <div className={styles.cardActions}>
                <button className={styles.primary} disabled={busy} onClick={() => void act(() => post("approve", { approvalId: conversation!.approval!.id, approved: true }))}>موافق</button>
                <button className={styles.secondary} disabled={busy} onClick={() => void act(() => post("approve", { approvalId: conversation!.approval!.id, approved: false }))}>لا تفعل</button>
              </div>
            </div> : null}
            {conversation!.secure ? <SecureCard request={conversation!.secure} busy={busy} onSubmit={(action, values) => void act(() => post("secure", { requestId: conversation!.secure!.id, action, ...(values ? { values } : {}) }))} /> : null}
            {conversation!.error || error ? <p className={styles.problem} role="alert">{conversation!.error || error}</p> : null}
            <div ref={end} />
          </div>
        </div>
        <div className={styles.dock}>{form}<p className={styles.dockHint}><kbd>Enter</kbd> للإرسال، و<bdi dir="ltr"><kbd>Shift</kbd> + <kbd>Enter</kbd></bdi> لسطر جديد</p></div>
      </>}
    </main>
    {showBrowser ? <BrowserPanel conversation={conversation!} onClose={() => setBrowserOpen(false)} onError={setError} busy={busy} onRestore={()=>void act(()=>post("browser/restore",{}))} onReview={()=>void act(()=>post("browser/review",{reviewed:true,checkpointToken:conversation?.browser?.recoveryToken}))} /> : null}
    <DeleteDialog target={deleting} busy={deleteBusy} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()} />
    {notice ? <div className={styles.toast} role="status"><Check size={15} />{notice}</div> : null}
  </div>;
}
