"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { MousePointer2 } from "lucide-react";
import type { BrowserLiveFrame, BrowserLiveInput, BrowserLiveMetrics, ChatBrowserActivity } from "@mohassan/contracts";
import { subscribeBrowserLiveActivity, subscribeBrowserLiveFrames } from "./browser-live-transport";
import type { BrowserLiveSize } from "./browser-live-layout";
import styles from "./browser-live-view.module.css";

type Props = {
  conversationId: string;
  title: string;
  size: BrowserLiveSize;
  controlling: boolean;
  send: (event: BrowserLiveInput) => void;
  focusKeyboard: () => void;
  flushWheel: RefObject<(() => void) | null>;
};

const clamp = (coordinate: number) => Math.min(1, Math.max(0, coordinate));
const wheelLimit = (delta: number) => Math.min(1200, Math.max(-1200, delta));
const wheelInterval = 180;
type WheelInput = Extract<BrowserLiveInput, { kind: "scroll" }>;

function point(image: HTMLImageElement, x: number, y: number) {
  const box = image.getBoundingClientRect();
  return { x: clamp((x - box.left) / box.width), y: clamp((y - box.top) / box.height) };
}

export function BrowserLiveFrame({ conversationId, title, size, controlling, send, focusKeyboard, flushWheel }: Props) {
  const [frame, setFrame] = useState<BrowserLiveFrame | null>(null);
  const [failed, setFailed] = useState(false);
  const [metrics, setMetrics] = useState<BrowserLiveMetrics | null>(null);
  const [cursor, setCursor] = useState<ChatBrowserActivity["cursor"]>(null);
  const image = useRef<HTMLImageElement>(null);
  const hasFrame = Boolean(frame);

  useEffect(() => {
    setFrame(null);
    setFailed(false);
    return subscribeBrowserLiveFrames({
      conversationId, mode: size, onFrame: (next) => { setFrame(next); setFailed(false); },
      onMetrics: setMetrics,
      onError: () => setFailed(true),
    });
  }, [conversationId, size]);

  useEffect(() => {
    if (controlling) { setCursor(null); return; }
    return subscribeBrowserLiveActivity({ conversationId, onActivity: (activity) => setCursor(activity?.cursor ?? null) });
  }, [conversationId, controlling]);

  useEffect(() => {
    const element = image.current;
    if (!element || !controlling) return;
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
  }, [hasFrame, controlling, send, flushWheel]);

  return <div className={styles.frame} dir="ltr" data-frame-bytes={frame?.byteLength}
    data-bytes-per-second={metrics && Math.round(metrics.bytesPerSecond)}>
    {frame ? <img ref={image} src={frame.url} alt={`الصفحة: ${title}`} draggable={false} data-testid="browser-live-view-frame"
      data-controlling={controlling} onClick={(event) => {
        if (!controlling) return;
        send({ kind: "pointer", ...point(event.currentTarget, event.clientX, event.clientY) });
        focusKeyboard();
      }} /> : <p className={styles.frameStatus} role="status">{failed ? "تعذّر تحديث المشاهدة. تُعاد المحاولة…" : "جارٍ تحميل المشاهدة…"}</p>}
    {frame && cursor && !controlling ? <MousePointer2 className={styles.cursor} aria-hidden="true"
      size={17} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} /> : null}
    {frame && failed ? <p className={styles.frameError} role="status">تعذّر تحديث المشاهدة.</p> : null}
  </div>;
}
