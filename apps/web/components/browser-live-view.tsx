"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Globe2, Grip, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { browserTakeoverKeys, type BrowserLiveCorner, type BrowserLiveInput, type BrowserLiveMode, type BrowserLiveSnapshot } from "@mohassan/contracts";
import { browserLiveDesktop } from "./browser-live-desktop";
import { BrowserLiveFrame } from "./browser-live-frame";
import {
  browserLiveCornerAt, browserLiveCorners, browserLivePreferenceKey, browserLivePresentation,
  defaultBrowserLivePreferences, readBrowserLivePreferences, writeBrowserLivePreferences, type BrowserLiveApp,
} from "./browser-live-layout";
import { browserLiveAttention, createBrowserLiveInput, finishBrowserLiveAttention } from "./browser-live-transport";
import styles from "./browser-live-view.module.css";

const levels = ["محلي", "عبر الشبكة", "في الخلفية", "أمامك", "محظور"] as const;

type Drag = { pointerId: number; x: number; y: number };
type Control = { scope: string; input: ReturnType<typeof createBrowserLiveInput> };

type Props = {
  snapshot: BrowserLiveSnapshot | null;
  app: BrowserLiveApp;
  desktopMini?: boolean;
  onAttentionFinished: (conversationId: string) => void;
};

export function BrowserLiveView({ snapshot, app, desktopMini, onAttentionFinished }: Props) {
  const [pageVisible, setPageVisible] = useState(false);
  const [preferences, setPreferences] = useState(defaultBrowserLivePreferences);
  const [override, setOverride] = useState<{ scope: string; mode: BrowserLiveMode } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [controlScope, setControlScope] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [finishedScope, setFinishedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const control = useRef<Control | null>(null);
  const keyboard = useRef<HTMLInputElement>(null);
  const flushWheel = useRef<(() => void) | null>(null);
  const takeOverButton = useRef<HTMLButtonElement>(null);
  const keyboardHint = useId();
  const attention = snapshot ? browserLiveAttention(snapshot) : null;
  const run = snapshot ? `${snapshot.conversationId}:${snapshot.runId ?? "legacy"}` : "";
  const scope = attention ? `${run}:${attention.code}:${attention.id}` : run;
  const mode = snapshot ? browserLivePresentation(scope, Boolean(attention), preferences.size, override) : "closed";
  const visible = mode === "small" || mode === "medium";
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
    if (desktopMini) void browserLiveDesktop()?.update({ corner: preferences.corner, mode }).catch(() => {});
  }, [desktopMini, mode, preferences.corner]);

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
    if (key === "Escape") takeOverButton.current?.focus({ preventScroll: true });
  }

  if (!snapshot || mode === "closed") return null;
  const offset = dragOffset ? { translate: `${dragOffset.x}px ${dragOffset.y}px` } as CSSProperties : undefined;

  return <aside key={scope} className={styles.panel} aria-label="المشاهدة الحية للمتصفح"
    data-testid="browser-live-view" data-mode={mode} data-corner={preferences.corner}
    data-level={snapshot.visibility.level} data-attention={attention?.code}
    data-desktop-mini={desktopMini || undefined} data-dragging={Boolean(dragOffset) || undefined} style={offset}>
    <header className={styles.bar}>
      <button type="button" className={styles.drag} aria-label="نقل المشاهدة الحية بمفاتيح الأسهم" title="اسحب إلى إحدى الزوايا"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={snap} onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag} onKeyDown={keyboardSnap}><Grip size={17} aria-hidden="true" /></button>
      {mode === "pill" ? <button type="button" className={styles.reopen} onClick={() => setOverride(null)}>
        <Globe2 size={15} aria-hidden="true" /> {attention ? "المتصفح يحتاجك" : "عرض المتصفح الحي"}
      </button> : <>
        <div className={styles.heading}><Globe2 size={15} aria-hidden="true" /><strong>المتصفح الحي</strong></div>
        <select className={styles.corner} value={preferences.corner} aria-label="زاوية المشاهدة الحية"
          onChange={(event) => changePreferences({ ...preferences, corner: event.target.value as BrowserLiveCorner })}>
          {browserLiveCorners.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className={styles.icon} aria-label={mode === "small" ? "تكبير المشاهدة الحية" : "تصغير المشاهدة الحية"}
          onClick={() => changeMode(mode === "small" ? "medium" : "small")}>
          {mode === "small" ? <Maximize2 size={14} aria-hidden="true" /> : <Minimize2 size={14} aria-hidden="true" />}
        </button>
        <button type="button" className={styles.icon} aria-label="طي المشاهدة الحية" onClick={() => changeMode("pill")}><Minus size={16} aria-hidden="true" /></button>
      </>}
      <button type="button" className={styles.icon} aria-label="إغلاق المشاهدة الحية" onClick={() => changeMode("closed")}><X size={16} aria-hidden="true" /></button>
    </header>
    {visible ? <>
      <div className={styles.caption}>
        <span dir="auto" title={snapshot.caption}>{snapshot.caption}</span>
        <span className={styles.level} aria-label={`مستوى الظهور ${snapshot.visibility.level}: ${levels[snapshot.visibility.level]}`}>
          {snapshot.visibility.level} · {levels[snapshot.visibility.level]}
        </span>
      </div>
      {pageVisible ? <BrowserLiveFrame conversationId={snapshot.conversationId} title={snapshot.title} size={mode}
        controlling={controlling && !busy} send={send} focusKeyboard={focusKeyboard} flushWheel={flushWheel} /> : null}
      {attention ? <div className={styles.attention}>
        <p role="status">{attention.message}</p>
        {attention.detail ? <p dir="auto" className={styles.detail}>{attention.detail}</p> : null}
        {controlling ? <>
          <input ref={keyboard} type="password" dir="auto" autoComplete="off" autoCapitalize="none" spellCheck={false}
            maxLength={2000} aria-label="الكتابة في صفحة المتصفح" aria-describedby={keyboardHint}
            placeholder="انقر في الصفحة ثم اكتب هنا"
            onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) typeInPage(event.currentTarget); }}
            onCompositionEnd={(event) => typeInPage(event.currentTarget)} onKeyDown={handleKey} />
          <span id={keyboardHint} className={styles.srOnly}>يرسل Tab إلى الصفحة. اضغط Escape للعودة إلى أزرار التحكم.</span>
        </> : null}
        <div className={styles.actions}>
          <button ref={takeOverButton} type="button" disabled={busy || finished} onClick={startControl} aria-pressed={controlling}>تولَّ التحكم</button>
          <button type="button" disabled={busy || finished} onClick={() => void finish("continue")}>{attention.code === "needs_approval" ? "موافقة ومتابعة" : "متابعة"}</button>
          <button type="button" disabled={busy || finished} onClick={() => void finish("cancel")}>إلغاء</button>
        </div>
        {error?.scope === scope ? <p className={styles.failure} role="alert">{error.message}</p> : null}
      </div> : null}
    </> : null}
  </aside>;
}
