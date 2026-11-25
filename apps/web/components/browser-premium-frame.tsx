"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { MousePointer2 } from "lucide-react";
import type { BrowserLiveFrame, BrowserLiveInput, BrowserLiveMetrics, BrowserPremiumTarget, ChatBrowserActivity } from "@mohassan/contracts";
import type { BrowserLiveSize } from "./browser-live-layout";
import { subscribeBrowserLiveActivity, subscribeBrowserLiveFrames } from "./browser-live-transport";
import styles from "./browser-premium-view.module.css";

type Point = { x: number; y: number };
type Slot = { frame: BrowserLiveFrame; ready: boolean };
type Buffers = { conversationId: string; active: 0 | 1 | null; slots: [Slot | null, Slot | null] };
type WheelInput = Extract<BrowserLiveInput, { kind: "scroll" }>;

type Props = {
  conversationId: string;
  title: string;
  size: BrowserLiveSize;
  controlling: boolean;
  target?: BrowserPremiumTarget;
  send: (event: BrowserLiveInput) => void;
  focusKeyboard: () => void;
  flushWheel: RefObject<(() => void) | null>;
};

const clamp = (coordinate: number) => Math.min(1, Math.max(0, coordinate));
const percent = (coordinate: number) => `${coordinate * 100}%`;
const wheelLimit = (delta: number) => Math.min(1200, Math.max(-1200, delta));
const wheelInterval = 180;
const emptyBuffers = (conversationId: string): Buffers => ({ conversationId, active: null, slots: [null, null] });

function point(viewport: HTMLElement, x: number, y: number): Point {
  const box = viewport.getBoundingClientRect();
  return { x: clamp((x - box.left) / box.width), y: clamp((y - box.top) / box.height) };
}

function visibleTarget(target?: BrowserPremiumTarget): BrowserPremiumTarget | null {
  if (!target || ![target.x, target.y, target.width, target.height].every(Number.isFinite)) return null;
  const x = clamp(target.x);
  const y = clamp(target.y);
  const width = clamp(target.x + target.width) - x;
  const height = clamp(target.y + target.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function BrowserPremiumFrame({ conversationId, title, size, controlling, target, send, focusKeyboard, flushWheel }: Props) {
  const [buffers, setBuffers] = useState(() => emptyBuffers(conversationId));
  const [failed, setFailed] = useState(false);
  const [metrics, setMetrics] = useState<BrowserLiveMetrics | null>(null);
  const [activity, setActivity] = useState<{ conversationId: string; cursor: ChatBrowserActivity["cursor"] } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const userCursor = useRef<SVGSVGElement>(null);

  const { active, slots } = buffers.conversationId === conversationId ? buffers : emptyBuffers(conversationId);
  const frame = active === null ? null : slots[active]?.frame;
  const hasFrame = Boolean(frame);
  const interactive = hasFrame && controlling;
  const cursor = activity?.conversationId === conversationId ? activity.cursor : null;
  const highlight = visibleTarget(target);

  useEffect(() => {
    setFailed(false);
    setMetrics(null);
    setBuffers((current) => current.conversationId === conversationId ? current : emptyBuffers(conversationId));
    return subscribeBrowserLiveFrames({
      conversationId,
      mode: size,
      onFrame: (next) => setBuffers((previous) => {
        const current = previous.conversationId === conversationId ? previous : emptyBuffers(conversationId);
        const slots: Buffers["slots"] = [...current.slots];
        // Keep the loaded <img> mounted even after its Blob URL is revoked.
        slots[current.active === 0 ? 1 : 0] = { frame: next, ready: false };
        return { ...current, slots };
      }),
      onMetrics: setMetrics,
      onError: () => setFailed(true),
    });
  }, [conversationId, size]);

  useEffect(() => {
    if (controlling) { setActivity(null); return; }
    return subscribeBrowserLiveActivity({
      conversationId,
      onActivity: (activity) => setActivity({ conversationId, cursor: activity?.cursor ?? null }),
    });
  }, [conversationId, controlling]);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !interactive) return;
    let pending: WheelInput | null = null;
    let nextAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let touch: { id: number; x: number; y: number; panning: boolean } | null = null;

    function flush() {
      clearTimeout(timer);
      timer = undefined;
      if (!pending) return;
      const input = pending;
      pending = null;
      nextAt = performance.now() + wheelInterval;
      send(input);
    }

    function queueScroll(x: number, y: number, deltaX: number, deltaY: number) {
      if (!element) return;
      pending = {
        kind: "scroll", ...point(element, x, y),
        deltaX: wheelLimit((pending?.deltaX ?? 0) + deltaX),
        deltaY: wheelLimit((pending?.deltaY ?? 0) + deltaY),
      };
      const delay = nextAt - performance.now();
      if (delay <= 0) flush();
      else timer ??= setTimeout(flush, delay);
    }

    function wheel(event: WheelEvent) {
      if (!element || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      queueScroll(event.clientX, event.clientY, event.deltaX * multiplier, event.deltaY * multiplier);
    }

    function startTouch(event: TouchEvent) {
      const probe = event.touches.length === 1 ? event.touches.item(0) : null;
      touch = probe ? { id: probe.identifier, x: probe.clientX, y: probe.clientY, panning: false } : null;
    }

    function moveTouch(event: TouchEvent) {
      const probe = event.touches.length === 1 ? event.touches.item(0) : null;
      if (!touch || !probe || touch.id !== probe.identifier) return;
      const deltaX = touch.x - probe.clientX;
      const deltaY = touch.y - probe.clientY;
      if (!touch.panning && Math.hypot(deltaX, deltaY) < 8) return;
      if (event.cancelable) event.preventDefault();
      touch = { id: probe.identifier, x: probe.clientX, y: probe.clientY, panning: true };
      queueScroll(touch.x, touch.y, deltaX, deltaY);
    }

    function endTouch(event: TouchEvent) {
      if (touch?.panning && event.type === "touchend" && event.cancelable) event.preventDefault();
      touch = null;
    }

    flushWheel.current = flush;
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchstart", startTouch, { passive: true });
    element.addEventListener("touchmove", moveTouch, { passive: false });
    element.addEventListener("touchend", endTouch, { passive: false });
    element.addEventListener("touchcancel", endTouch, { passive: true });
    return () => {
      flushWheel.current = null;
      clearTimeout(timer);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", startTouch);
      element.removeEventListener("touchmove", moveTouch);
      element.removeEventListener("touchend", endTouch);
      element.removeEventListener("touchcancel", endTouch);
    };
  }, [interactive, send, flushWheel]);

  function showUserCursor(at: Point) {
    if (!userCursor.current) return;
    const { style } = userCursor.current;
    style.left = percent(at.x);
    style.top = percent(at.y);
    style.visibility = "visible";
  }

  function activate(at: Point) {
    showUserCursor(at);
    send({ kind: "pointer", ...at });
    focusKeyboard();
  }

  function keyboardActivate(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    activate(highlight ? { x: highlight.x + highlight.width / 2, y: highlight.y + highlight.height / 2 } : { x: 0.5, y: 0.5 });
  }

  function markLoaded(index: 0 | 1, loaded: BrowserLiveFrame) {
    setBuffers((current) => {
      if (current.conversationId !== conversationId || current.slots[index]?.frame !== loaded) return current;
      const slots: Buffers["slots"] = [...current.slots];
      slots[index] = { frame: loaded, ready: true };
      return { ...current, active: index, slots };
    });
    setFailed(false);
  }

  return (
    <div ref={viewport} className={styles.frame} dir="ltr" data-testid="browser-premium-frame"
      data-controlling={interactive} data-frame-bytes={frame?.byteLength}
      data-bytes-per-second={metrics && Math.round(metrics.bytesPerSecond)}
      role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? "التفاعل مع الصفحة الحية" : undefined}
      onPointerMove={(event) => { if (interactive) showUserCursor(point(event.currentTarget, event.clientX, event.clientY)); }}
      onPointerLeave={() => { if (userCursor.current) userCursor.current.style.visibility = "hidden"; }}
      onClick={(event) => { if (interactive) activate(point(event.currentTarget, event.clientX, event.clientY)); }}
      onKeyDown={keyboardActivate}>
      {([0, 1] as const).map((index) => {
        const slot = slots[index];
        if (!slot) return null;
        const current = index === active;
        return <img key={index} className={styles.frameImage} src={slot.frame.url}
          alt={current ? `الصفحة: ${title}` : ""} aria-hidden={!current || undefined} draggable={false}
          data-testid={current ? "browser-live-view-frame" : undefined}
          data-current={current} data-ready={slot.ready} data-controlling={interactive}
          onLoad={() => markLoaded(index, slot.frame)} onError={() => setFailed(true)} />;
      })}
      {!hasFrame && <p className={styles.frameStatus} role="status" dir="rtl">
        {failed ? "تعذّر تحديث المشاهدة. تُعاد المحاولة…" : "جارٍ تحميل المشاهدة…"}
      </p>}
      {hasFrame && highlight && <span className={styles.target} data-testid="browser-premium-target" aria-hidden="true"
        style={{ left: percent(highlight.x), top: percent(highlight.y), width: percent(highlight.width), height: percent(highlight.height) }} />}
      {interactive ? (
        <MousePointer2 key={conversationId} ref={userCursor} className={styles.cursor} aria-hidden="true" data-user-cursor
          size={18} style={{ visibility: "hidden" }} />
      ) : hasFrame && cursor ? (
        <MousePointer2 className={styles.cursor} aria-hidden="true"
          size={18} style={{ left: percent(cursor.x), top: percent(cursor.y) }} />
      ) : null}
      {hasFrame && failed && <p className={styles.frameError} role="status" dir="rtl">تعذّر تحديث المشاهدة.</p>}
    </div>
  );
}
