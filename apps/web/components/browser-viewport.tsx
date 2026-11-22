"use client";

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { ChatBrowserActivity } from '@mohassan/contracts';
import styles from './browser-viewport.module.css';

const ACTION_LABELS = { move: 'تحريك', click: 'نقر', type: 'كتابة', select: 'اختيار', scroll: 'تمرير', press: 'لوحة المفاتيح' } as const;
const FRAME_INTERVAL_MS = 1200;
const ACTIVITY_INTERVAL_MS = 300;
const CURSOR_FRAME_MS = 220;
const MAX_PENDING_CURSOR_EVENTS = 6;
type CursorEvent = { sequence: number; cursor: ChatBrowserActivity['cursor'] };
const newPlayback = () => ({ sessionId: null as string | null, sequence: null as number | null,
  queue: [] as CursorEvent[], shown: null as ChatBrowserActivity['cursor'],
  timer: undefined as ReturnType<typeof setTimeout> | undefined, hasBeenActive: false });

function sameTarget(first: ChatBrowserActivity['cursor'], second: ChatBrowserActivity['cursor']): boolean {
  return first?.x === second?.x && first?.y === second?.y && first?.action === second?.action;
}

function sameActivity(first: ChatBrowserActivity | null, second: ChatBrowserActivity | null): boolean {
  return first?.sessionId === second?.sessionId && first?.sequence === second?.sequence && first?.cursor?.updatedAt === second?.cursor?.updatedAt
    && first?.cursor?.x === second?.cursor?.x && first?.cursor?.y === second?.cursor?.y
    && first?.cursor?.action === second?.cursor?.action && first?.cursor?.phase === second?.cursor?.phase;
}

type Props = {
  conversationId: string;
  screenUrl: string;
  title: string;
  live: boolean;
  running: boolean;
  handsOn: boolean;
  onPoint: (x: number, y: number) => void;
};

/** Screen and host cursor have separate clocks, so a slow JPEG cannot freeze the cursor. */
export function BrowserViewport({ conversationId, screenUrl, title, live, running, handsOn, onPoint }: Props) {
  const active = running || handsOn;
  const [sample, setSample] = useState<{ conversationId: string; epoch: number; value: ChatBrowserActivity | null } | null>(null);
  const sampleEpoch = useRef(0);
  const [displayed, setDisplayed] = useState<CursorEvent | null>(null);
  const playback = useRef<ReturnType<typeof newPlayback>>(newPlayback());
  const [revision, setRevision] = useState(0);
  const [image, setImage] = useState<{ source: string; base: string; phase: 'ready' | 'error'; failures: number } | null>(null);
  const source = `${screenUrl}${screenUrl.includes('?') ? '&' : '?'}frame=${revision}`;
  const failed = image?.source === source && image.phase === 'error';
  const cursor = live ? displayed?.cursor : null;

  useEffect(() => {
    sampleEpoch.current++;
    const previous = playback.current;
    clearTimeout(previous.timer);
    playback.current = newPlayback();
    setSample(null);
    setDisplayed(null);
    return () => {
      clearTimeout(playback.current.timer);
      playback.current = newPlayback();
    };
  }, [conversationId, live]);

  // A fast type followed by navigation can happen entirely between polls.
  // Show the host's bounded real event history without delaying browser input.
  useEffect(() => {
    const state = playback.current;
    if (active) state.hasBeenActive = true;
    if (!live || sample?.conversationId !== conversationId || sample.epoch !== sampleEpoch.current) return;
    const value = sample.value;
    if (!value) {
      clearTimeout(state.timer);
      playback.current = newPlayback();
      playback.current.hasBeenActive = state.hasBeenActive || active;
      setDisplayed(null);
      return;
    }
    const sessionId = value.sessionId ?? 'legacy';
    if (state.sessionId !== null && state.sessionId !== sessionId) {
      clearTimeout(state.timer);
      state.timer = undefined; state.queue = []; state.sequence = null; state.shown = null;
      setDisplayed(null);
    }
    state.sessionId = sessionId;
    if (state.sequence !== null && value.sequence <= state.sequence) return;
    if (state.sequence === null && !active && !state.hasBeenActive) {
      state.sequence = value.sequence; state.shown = value.cursor;
      setDisplayed({ sequence: value.sequence, cursor: value.cursor });
      return;
    }
    const after = state.sequence ?? -1;
    const events = [...(value.events ?? [{ sequence: value.sequence, cursor: value.cursor,
      updatedAt: value.cursor?.updatedAt ?? new Date().toISOString() }])]
      .filter(event => event.sequence > after && Date.parse(event.updatedAt) >= Date.now() - 8000)
      .sort((first, second) => first.sequence - second.sequence);
    state.sequence = value.sequence;
    if (!events.length) {
      clearTimeout(state.timer);
      state.timer = undefined; state.queue = []; state.shown = value.cursor;
      setDisplayed({ sequence: value.sequence, cursor: value.cursor });
      return;
    }
    for (const event of events) {
      const next = { sequence: event.sequence, cursor: event.cursor };
      const tail = state.queue.at(-1);
      if (tail && sameTarget(tail.cursor, next.cursor)) state.queue[state.queue.length - 1] = next;
      else if (!state.queue.length && sameTarget(state.shown, next.cursor)) {
        state.shown = next.cursor; setDisplayed(next);
      } else state.queue.push(next);
    }
    if (state.queue.length > MAX_PENDING_CURSOR_EVENTS) state.queue.splice(0, state.queue.length - MAX_PENDING_CURSOR_EVENTS);
    const advance = () => {
      if (playback.current !== state || state.timer) return;
      let next = state.queue.shift();
      // A navigation clear between two recorded positions need not hide the
      // pointer for a single paint; a final clear still takes effect.
      while (next?.cursor === null && state.queue[0]?.cursor) next = state.queue.shift();
      if (!next) return;
      state.shown = next.cursor; setDisplayed(next);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        advance();
      }, next.cursor ? CURSOR_FRAME_MS : 0);
    };
    advance();
  }, [active, conversationId, live, sample]);

  useEffect(() => {
    if (!live) return;
    const epoch = sampleEpoch.current;
    let stopped = false, pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    async function readActivity() {
      if (stopped || pending) return;
      if (document.hidden) {
        if (active) timer = setTimeout(() => void readActivity(), 1000);
        return;
      }
      pending = true;
      request = new AbortController();
      const timeout = setTimeout(() => request?.abort(), 2000);
      let nextDelay = ACTIVITY_INTERVAL_MS;
      try {
        const response = await fetch(`/api/chat/conversations/${conversationId}/browser/activity`, {
          cache: 'no-store', credentials: 'same-origin', signal: request.signal,
        });
        if (!response.ok) { nextDelay = response.status === 429 ? 4000 : 1500; return; }
        const value = await response.json() as ChatBrowserActivity | null;
        if (!stopped) setSample(previous => previous?.conversationId === conversationId && previous.epoch === epoch && sameActivity(previous.value, value)
          ? previous : { conversationId, epoch, value });
      } catch {
        nextDelay = 1500;
      } finally {
        clearTimeout(timeout);
        pending = false;
        if (!stopped && active) timer = setTimeout(() => void readActivity(), nextDelay);
      }
    }
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void readActivity(); } };
    document.addEventListener('visibilitychange', visible);
    void readActivity();
    return () => { stopped = true; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, [conversationId, live, active]);

  useEffect(() => {
    if (!live || image?.source !== source) return;
    const retry = image.phase === 'error' && image.failures <= 3;
    if (!retry && (!active || image.phase !== 'ready')) return;
    const delay = retry ? Math.min(4000, 500 * 2 ** (image.failures - 1)) : FRAME_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout>;
    const nextFrame = () => {
      if (document.hidden) { timer = setTimeout(nextFrame, 1000); return; }
      setRevision(value => value + 1);
    };
    timer = setTimeout(nextFrame, delay);
    return () => clearTimeout(timer);
  }, [active, live, image, source]);

  function point(event: MouseEvent<HTMLImageElement>) {
    if (!handsOn) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) onPoint(
      Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    );
  }

  return <div className={`${styles.viewport} ${handsOn ? styles.handsOn : ''} ${!live ? styles.closed : ''}`}
    data-hands-on={handsOn ? 'true' : undefined}>
    {live ? <div className={styles.screen}>
      <img src={source} alt={`الصفحة: ${title}`} onClick={point} draggable={false}
        hidden={failed}
        onLoad={() => setImage({ source, base: screenUrl, phase: 'ready', failures: 0 })}
        onError={() => setImage(previous => ({ source, base: screenUrl, phase: 'error', failures: previous?.base === screenUrl ? previous.failures + 1 : 1 }))} />
      {cursor && !failed ? <span className={styles.cursor} aria-hidden="true" data-testid="agent-cursor"
        data-action={cursor.action} data-phase={cursor.phase}
        data-edge={cursor.x > .7 ? 'right' : 'left'} data-bottom={cursor.y > .85}
        style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}>
        <span key={displayed?.sequence} className={styles.pulse} />
        <MousePointer2 size={25} strokeWidth={1.6} className={styles.arrow} />
        <span className={styles.label}>{ACTION_LABELS[cursor.action]}</span>
      </span> : null}
      {failed ? <div className={styles.unavailable} role="status">
        <p>{(image?.failures ?? 0) <= 3 ? 'تُعاد محاولة تحديث المشاهدة…' : 'تعذّر تحديث المشاهدة.'}</p>
        <button type="button" onClick={() => { setImage(null); setRevision(value => value + 1); }}>إعادة تحميل المشاهدة</button>
      </div> : null}
    </div> : <p className={styles.unavailable}>أُغلقت هذه الصفحة.</p>}
  </div>;
}
