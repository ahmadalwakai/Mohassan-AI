"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  AlertCircle, Check, ChevronDown, Clock3, Globe2, Grip, Hand, KeyRound, ListOrdered, LoaderCircle,
  Maximize2, Minimize2, Minus, ShieldCheck, X,
} from "lucide-react";
import { browserTakeoverKeys, type BrowserLiveAttentionCode, type BrowserLiveCorner, type BrowserLiveInput, type BrowserLiveMode, type BrowserLiveSnapshot } from "@mohassan/contracts";
import { browserLiveDesktop } from "./browser-live-desktop";
import {
  browserLiveCornerAt, browserLiveCorners, browserLivePreferenceKey, browserLivePresentation,
  defaultBrowserLivePreferences, readBrowserLivePreferences, writeBrowserLivePreferences, type BrowserLiveApp,
} from "./browser-live-layout";
import { browserLiveAttention, createBrowserLiveInput, finishBrowserLiveAttention } from "./browser-live-transport";
import { BrowserPremiumFrame } from "./browser-premium-frame";
import {
  browserPremiumFavicon, browserPremiumNarration, browserPremiumSiteDomain, browserPremiumStatusLabels, browserPremiumStepLabels,
} from "./browser-premium-narration";
import theme from "./browser-premium-tokens.module.css";
import styles from "./browser-premium-view.module.css";

type Drag = { pointerId: number; x: number; y: number };
type Control = { scope: string; input: ReturnType<typeof createBrowserLiveInput> };
type Props = {
  snapshot: BrowserLiveSnapshot | null;
  app: BrowserLiveApp;
  desktopMini?: boolean;
  onAttentionFinished: (conversationId: string) => void;
};

const coachCopy: Record<BrowserLiveAttentionCode, { title: string; instruction: string; waiting: string; icon: typeof Hand }> = {
  needs_login: {
    title: "سجّل الدخول",
    instruction: "تولَّ التحكم وسجّل الدخول إلى الموقع بحسابك. إذا بقيت المهمة متوقفة، اضغط متابعة.",
    waiting: "ينتظر اكتمال تسجيل الدخول",
    icon: KeyRound,
  },
  needs_code: {
    title: "أدخل رمز التحقق",
    instruction: "تولَّ التحكم وأدخل رمز التحقق في الحقل المحدد. إذا بقيت المهمة متوقفة، اضغط متابعة.",
    waiting: "ينتظر قبول رمز التحقق",
    icon: KeyRound,
  },
  hands_on: {
    title: "أكمل الخطوة في الموقع",
    instruction: "تولَّ التحكم وأكمل الخطوة الموضّحة. إذا بقيت المهمة متوقفة، اضغط متابعة.",
    waiting: "ينتظر إكمال الخطوة",
    icon: Hand,
  },
  needs_approval: {
    title: "راجع الإجراء",
    instruction: "راجع الإجراء في الموقع، ثم اضغط موافقة ومتابعة للسماح بتنفيذه.",
    waiting: "ينتظر موافقتك",
    icon: ShieldCheck,
  },
};

function Site({ domain, favicon, compact }: { domain: string | null; favicon: string | null; compact?: boolean }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  return <div className={styles.site}>
    <span className={styles.favicon}>
      {favicon && failedIcon !== favicon
        ? <img src={favicon} referrerPolicy="no-referrer" alt="" onError={() => setFailedIcon(favicon)} />
        : <Globe2 size={15} aria-hidden="true" />}
    </span>
    <div className={styles.siteText}>
      {!compact ? <strong>المتصفح الحي</strong> : null}
      {domain ? <bdi dir="ltr" title={domain}>{domain}</bdi> : null}
    </div>
  </div>;
}

function Status({ status }: Pick<ReturnType<typeof browserPremiumNarration>, "status">) {
  const Icon = status === "done" ? Check : status === "failed" ? AlertCircle : LoaderCircle;
  return <span className={styles.status} data-testid="browser-premium-status" data-status={status}>
    <span className={styles.ring}><Icon aria-hidden="true" size={14} /></span>
    {browserPremiumStatusLabels[status]}
  </span>;
}

function Timeline({ steps }: Pick<ReturnType<typeof browserPremiumNarration>, "steps">) {
  const id = useId();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = hovered || pinned;
  return <div className={styles.timeline} data-testid="browser-premium-timeline" data-expanded={expanded}
    onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
    onPointerLeave={() => setHovered(false)}>
    <button type="button" className={styles.timelineButton} aria-expanded={expanded} aria-controls={id}
      onClick={() => { if (pinned) setHovered(false); setPinned(!pinned); }}>
      <ListOrdered aria-hidden="true" size={14} />
      الخطوات
      <ChevronDown className={styles.chevron} aria-hidden="true" size={12} />
    </button>
    <div className={styles.timelineTrack} id={id} aria-hidden={!expanded}>
      <ol role="list">
        {steps.map((step, index) => <li key={step.id} aria-current={index === steps.length - 1 ? "step" : undefined}>
          {index === steps.length - 1 ? <Clock3 size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
          {browserPremiumStepLabels[step.kind]}
        </li>)}
      </ol>
    </div>
  </div>;
}

export function BrowserLiveView({ snapshot, app, desktopMini, onAttentionFinished }: Props) {
  const [pageVisible, setPageVisible] = useState(false);
  const [preferences, setPreferences] = useState(defaultBrowserLivePreferences);
  const [override, setOverride] = useState<{ scope: string; mode: BrowserLiveMode } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [controlScope, setControlScope] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [finishedScope, setFinishedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const control = useRef<Control | null>(null);
  const keyboard = useRef<HTMLInputElement>(null);
  const flushWheel = useRef<(() => void) | null>(null);
  const wheelButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogClose = useRef<HTMLButtonElement>(null);
  const lastAttention = useRef<{ run: string; scope: string } | null>(null);
  const keyboardHint = useId();
  const dialogHeading = useId();
  const coachHeading = useId();

  const attention = snapshot ? browserLiveAttention(snapshot) : null;
  const attentionId = attention?.id;
  const conversationId = snapshot?.conversationId;
  const run = snapshot ? `${snapshot.conversationId}:${snapshot.runId ?? "legacy"}` : "";
  const scope = attention ? `${run}:${attention.code}:${attention.id}` : run;
  const mode = snapshot ? browserLivePresentation(scope, Boolean(attention), preferences.size, override) : "closed";
  const visible = mode === "small" || mode === "medium";
  const expanded = visible && expandedRun === run;
  const controlling = visible && controlScope === scope;
  const busy = busyScope === scope;
  const finished = finishedScope === scope;

  useEffect(() => {
    const read = () => setPageVisible(!document.hidden);
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);

  useEffect(() => {
    setPreferences(readBrowserLivePreferences(window.localStorage, app));
    const read = (event: StorageEvent) => {
      if (event.key === browserLivePreferenceKey(app) || event.key === null) {
        setPreferences(readBrowserLivePreferences(window.localStorage, app));
      }
    };
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, [app]);

  useEffect(() => {
    if (desktopMini) void browserLiveDesktop()?.update({ corner: preferences.corner, mode, expanded }).catch(() => {});
  }, [desktopMini, mode, expanded, preferences.corner]);

  useEffect(() => {
    if (!expanded || !dialog.current) return;
    const window = dialog.current;
    const trigger = showButton.current;
    window.showModal();
    dialogClose.current?.focus({ preventScroll: true });
    return () => {
      if (window.open) window.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [expanded]);

  useEffect(() => {
    const before = lastAttention.current;
    lastAttention.current = attentionId ? { run, scope } : null;
    if (conversationId && before?.run === run && before.scope !== scope && before.scope !== finishedScope) {
      onAttentionFinished(conversationId);
    }
  }, [attentionId, conversationId, finishedScope, onAttentionFinished, run, scope]);

  useEffect(() => () => {
    if (control.current?.scope === scope) {
      control.current.input.close();
      control.current = null;
    }
  }, [scope]);

  const focusKeyboard = useCallback(() => keyboard.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (controlling) focusKeyboard();
  }, [controlling, focusKeyboard]);

  const send = useCallback((event: BrowserLiveInput) => {
    const active = control.current;
    if (!active || active.scope !== scope || busy) return;
    if (event.kind !== "scroll") flushWheel.current?.();
    void active.input.send(event).catch(() => {
      if (control.current === active) setError({ scope, message: "تعذّر إيصال الإدخال إلى المتصفح. حاول مجددًا." });
    });
  }, [busy, scope]);

  function changePreferences(next: typeof preferences) {
    setPreferences(next);
    writeBrowserLivePreferences(window.localStorage, app, next);
  }

  function changeMode(next: BrowserLiveMode) {
    if (next === "small" || next === "medium") changePreferences({ ...preferences, size: next });
    else {
      setExpandedRun(null);
      control.current?.input.close();
      control.current = null;
      setControlScope(null);
    }
    setOverride({ scope, mode: next });
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const started = drag.current;
    if (started?.pointerId === event.pointerId && !desktopMini) {
      setDragOffset({ x: event.clientX - started.x, y: event.clientY - started.y });
    }
  }

  function stopDrag() {
    drag.current = null;
    setDragOffset(null);
  }

  function snap(event: PointerEvent<HTMLButtonElement>) {
    const started = drag.current;
    stopDrag();
    if (!started || started.pointerId !== event.pointerId ||
      (!desktopMini && Math.hypot(event.clientX - started.x, event.clientY - started.y) < 6)) return;
    if (desktopMini) {
      void browserLiveDesktop()?.cornerAt({ x: event.screenX, y: event.screenY })
        .then((corner) => { if (corner) changePreferences({ ...preferences, corner }); }).catch(() => {});
    } else {
      const corner = browserLiveCornerAt(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
      changePreferences({ ...preferences, corner });
    }
  }

  function keyboardSnap(event: KeyboardEvent<HTMLButtonElement>) {
    const [vertical, horizontal] = preferences.corner.split("-");
    const corner = {
      ArrowUp: `top-${horizontal}`, ArrowDown: `bottom-${horizontal}`,
      ArrowLeft: `${vertical}-left`, ArrowRight: `${vertical}-right`,
    }[event.key];
    if (!corner) return;
    event.preventDefault();
    changePreferences({ ...preferences, corner: corner as BrowserLiveCorner });
  }

  function startControl() {
    if (!snapshot || !attention || busy || finished) return;
    if (!controlling) {
      control.current = { scope, input: createBrowserLiveInput(snapshot.conversationId) };
      setControlScope(scope);
    } else focusKeyboard();
    setError(null);
  }

  async function giveBack() {
    const active = control.current;
    if (!active || active.scope !== scope || busy) return;
    flushWheel.current?.();
    setBusyScope(scope);
    setError(null);
    try {
      await active.input.drain();
      if (control.current !== active) return;
      active.input.close();
      control.current = null;
      setControlScope((current) => current === scope ? null : current);
      wheelButton.current?.focus({ preventScroll: true });
    } catch {
      if (control.current === active) setError({ scope, message: "تعذّر إيصال الإدخال إلى المتصفح. حاول مجددًا." });
    } finally {
      setBusyScope((current) => current === scope ? null : current);
    }
  }

  async function finish(action: "continue" | "cancel") {
    if (!snapshot || !attention || busy || finished) return;
    const active = control.current;
    if (action === "continue") flushWheel.current?.();
    setBusyScope(scope);
    setError(null);
    try {
      if (action === "continue") await active?.input.drain();
      else {
        active?.input.close();
        control.current = null;
        setControlScope(null);
      }
      await finishBrowserLiveAttention(snapshot.conversationId, attention, action);
      active?.input.close();
      if (control.current === active) control.current = null;
      setControlScope((current) => current === scope ? null : current);
      setFinishedScope(scope);
      onAttentionFinished(snapshot.conversationId);
    } catch {
      setError({ scope, message: "تعذّر إتمام الإجراء. تحقق من الصفحة وحاول مجددًا." });
    } finally {
      setBusyScope((current) => current === scope ? null : current);
    }
  }

  function typeInPage(element: HTMLInputElement) {
    const text = element.value;
    element.value = "";
    if (text) send({ kind: "text", text });
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.key === "Tab" && event.shiftKey)) return;
    const key = browserTakeoverKeys.find((candidate) => candidate === event.key);
    if (!key) return;
    event.preventDefault();
    send({ kind: "key", key });
    if (key === "Escape") wheelButton.current?.focus({ preventScroll: true });
  }

  function wrapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.defaultPrevented || event.key !== "Tab") return;
    const available = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    )].filter((element) => element.getClientRects().length);
    const first = available[0];
    const last = available.at(-1);
    if (!first || !last || document.activeElement !== (event.shiftKey ? first : last)) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }

  if (!snapshot || mode === "closed") return null;
  const offset = dragOffset ? { translate: `${dragOffset.x}px ${dragOffset.y}px` } as CSSProperties : undefined;
  const narration = browserPremiumNarration(snapshot, Boolean(attention));
  const domain = snapshot.premium?.site?.domain ?? browserPremiumSiteDomain(snapshot.secure?.site);
  const favicon = browserPremiumFavicon(snapshot.premium?.site?.favicon);
  const coach = attention && coachCopy[attention.code];
  const hasApproval = attention?.code === "needs_approval";

  const body = visible ? <div className={styles.content} data-coaching={Boolean(coach) || undefined}>
    <div className={styles.activity}>
      <Status status={narration.status} />
      <p className={styles.caption} role="status">{narration.caption}</p>
    </div>
    {pageVisible ? <BrowserPremiumFrame key={run} conversationId={snapshot.conversationId} title={snapshot.title}
      size={expanded ? "medium" : mode} controlling={controlling && !busy} send={send}
      focusKeyboard={focusKeyboard} flushWheel={flushWheel} target={attention ? snapshot.premium?.target : undefined} /> : null}
    {coach ? <section className={styles.coach} aria-labelledby={coachHeading} data-testid="browser-premium-coach">
      <div className={styles.coachHead}>
        <span className={styles.cardIcon}><coach.icon size={17} aria-hidden="true" /></span>
        <div className={styles.coachCopy}>
          <h2 id={coachHeading}>{coach.title}</h2>
          {domain ? <bdi dir="ltr" className={styles.siteName} title={domain}>{domain}</bdi> : null}
          <p>{coach.instruction}</p>
          {hasApproval && snapshot.approval ? <>
            <p dir="auto">{snapshot.approval.prompt}</p>
            {snapshot.approval.detail ? <p dir="auto">{snapshot.approval.detail}</p> : null}
            {snapshot.approval.target || snapshot.approval.consequence
              ? <p dir="auto">{snapshot.approval.target} {snapshot.approval.consequence}</p> : null}
          </> : null}
          {!hasApproval && attention?.code === "hands_on" && snapshot.secure?.prompt
            ? <p dir="auto">{snapshot.secure.prompt}</p> : null}
        </div>
      </div>
      <p className={styles.waitingFor} role="status"><Clock3 size={14} aria-hidden="true" />
        {finished ? "جارٍ استئناف التصفح…" : controlling ? `${coach.waiting} · التحكم معك` : coach.waiting}
      </p>
      {attention?.code === "needs_login" || attention?.code === "needs_code"
        ? <p className={styles.resumeHint}>يستأنف موحسن التصفح تلقائيًا عند اكتمال الخطوة.</p> : null}
      {!hasApproval ? <p className={styles.privacy}><ShieldCheck size={14} aria-hidden="true" />
        تبقى حقول الإدخال محجوبة. لا يظهر ما تكتبه في المشاهدة ولا يُسجَّل.
      </p> : null}
      {controlling ? <>
        <input ref={keyboard} type="password" dir="auto" autoComplete="off" autoCapitalize="none" spellCheck={false}
          maxLength={2000} aria-label="الكتابة في صفحة المتصفح" aria-describedby={keyboardHint}
          className={styles.keyboard} data-testid="browser-premium-keyboard" placeholder="انقر في الصفحة ثم اكتب هنا"
          onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) typeInPage(event.currentTarget); }}
          onCompositionEnd={(event) => typeInPage(event.currentTarget)} onKeyDown={handleKey} />
        <span id={keyboardHint} className={styles.srOnly}>يرسل Tab إلى الصفحة. اضغط Escape للعودة إلى أزرار التحكم.</span>
      </> : null}
      <div className={styles.actions}>
        {!hasApproval ? <button ref={wheelButton} type="button" className={`${styles.button} ${styles.primary}`}
          disabled={busy || finished} onClick={controlling ? () => void giveBack() : startControl}>
          <Hand size={15} aria-hidden="true" />{controlling ? "أعد التحكم" : "تولَّ التحكم"}
        </button> : null}
        <button type="button" className={`${styles.button} ${hasApproval ? styles.primary : styles.secondary}`}
          disabled={busy || finished} onClick={() => void finish("continue")}>
          {hasApproval ? "موافقة ومتابعة" : "متابعة"}
        </button>
        <button type="button" className={styles.button} disabled={busy || finished} onClick={() => void finish("cancel")}>إلغاء</button>
      </div>
      {error?.scope === scope ? <p className={styles.failure} role="alert">{error.message}</p> : null}
    </section> : null}
    <footer className={styles.footer}>
      <Timeline steps={narration.steps} />
      {!expanded ? <div className={styles.cornerControls}>
        <select className={styles.corner} value={preferences.corner} aria-label="زاوية المشاهدة الحية"
          onChange={(event) => changePreferences({ ...preferences, corner: event.target.value as BrowserLiveCorner })}>
          {browserLiveCorners.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className={styles.icon}
          aria-label={mode === "small" ? "تكبير المشاهدة الحية" : "تصغير المشاهدة الحية"}
          onClick={() => changeMode(mode === "small" ? "medium" : "small")}>
          {mode === "small" ? <Maximize2 size={15} aria-hidden="true" /> : <Minimize2 size={15} aria-hidden="true" />}
        </button>
      </div> : null}
    </footer>
  </div> : null;

  return <aside className={`${theme.theme} ${styles.panel}`} lang="ar" aria-label="المشاهدة الحية للمتصفح"
    data-testid="browser-live-view" data-mode={mode} data-corner={preferences.corner}
    data-level={snapshot.visibility.level} data-attention={attention?.code}
    data-desktop-mini={desktopMini || undefined} data-dragging={Boolean(dragOffset) || undefined} style={offset}>
    <header className={styles.chrome}>
      <button type="button" className={`${styles.icon} ${styles.drag}`} aria-label="نقل المشاهدة الحية بمفاتيح الأسهم" title="اسحب إلى إحدى الزوايا"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={snap} onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag} onKeyDown={keyboardSnap}><Grip size={17} aria-hidden="true" /></button>
      {mode === "pill" ? <button type="button" className={`${styles.button} ${styles.reopen}`} onClick={() => setOverride(null)}>
        <Globe2 size={16} aria-hidden="true" /> {attention ? "المتصفح يحتاجك" : "عرض المتصفح الحي"}
      </button> : <>
        <Site domain={domain} favicon={favicon} />
        <div className={styles.tools}>
          <button ref={showButton} type="button" className={`${styles.button} ${styles.show}`} aria-haspopup="dialog" onClick={() => setExpandedRun(run)}>
            <Maximize2 size={14} aria-hidden="true" /> أرني
          </button>
          <button type="button" className={styles.icon} aria-label="طي المشاهدة الحية" onClick={() => changeMode("pill")}><Minus size={16} aria-hidden="true" /></button>
        </div>
      </>}
      <button type="button" className={styles.icon} aria-label="إغلاق المشاهدة الحية" onClick={() => changeMode("closed")}><X size={16} aria-hidden="true" /></button>
    </header>
    {expanded ? <dialog ref={dialog} className={`${theme.theme} ${styles.dialog}`} aria-labelledby={dialogHeading}
      data-testid="browser-premium-dialog" onCancel={(event) => { event.preventDefault(); setExpandedRun(null); }} onKeyDown={wrapDialogFocus}>
      <header className={styles.chrome}>
        <h2 id={dialogHeading}>المشاهدة الحية</h2>
        <Site domain={domain} favicon={favicon} compact />
        <button ref={dialogClose} type="button" className={styles.icon} aria-label="إغلاق العرض الموسّع"
          onClick={() => setExpandedRun(null)}><X size={20} aria-hidden="true" /></button>
      </header>
      {body}
    </dialog> : body}
  </aside>;
}
