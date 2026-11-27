"use client";

import { useEffect, useId, useRef, useState, type Dispatch, type FormEvent, type MouseEvent, type SetStateAction } from 'react';
import { ChevronDown, Monitor } from 'lucide-react';
import { browserLiveBudget, browserLiveKeys, ChatKeyboardSchema, readBrowserLiveHandover, type BrowserLiveInput, type BrowserLiveStatus, type ChatConversation } from '@mohassan/contracts';
import { browserLivePath, createBrowserLiveStream, type DisplayedBrowserFrame } from './browser-live-stream';
import { isNewerSnapshot } from './run-view';
import styles from './browser-live-panel.module.css';

const read = (url: string, signal: AbortSignal) => fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
type Handover = NonNullable<BrowserLiveStatus['handover']>;
type ManualInput = Omit<Extract<BrowserLiveInput, { kind: 'pointer' }>, 'handoverId' | 'frameId'>
  | Omit<Extract<BrowserLiveInput, { kind: 'keyboard' }>, 'handoverId' | 'frameId'>;

export function useBrowserLive(conversation: ChatConversation | null, setConversation: Dispatch<SetStateAction<ChatConversation | null>>, initiallyOpen: boolean) {
  const card = readBrowserLiveHandover(conversation?.secure);
  const cardId = card?.id;
  const id = conversation?.visibility?.canView
    && (conversation.status === 'running' || conversation.status === 'waiting_approval' || (conversation.status === 'waiting_input' && cardId)) ? conversation.id : null;
  const runId = conversation?.run?.id ?? null;
  const [sample, setSample] = useState<{ conversationId: string; status: BrowserLiveStatus } | null>(null);
  const completed = useRef<string | null>(null);
  const snapshot = id && sample?.conversationId === id && (!runId || sample.status.runId === runId) ? sample.status : null;

  useEffect(() => {
    if (!id) return;
    const scope = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let denied = false;
    async function poll() {
      if (!id) return;
      try {
        const response = await read(browserLivePath(id), scope.signal);
        if ([401, 403, 404].includes(response.status)) {
          denied = true;
          await response.body?.cancel();
          if (!scope.signal.aborted) setSample(null);
          return;
        }
        if (!response.ok) { await response.body?.cancel(); return; }
        const current: BrowserLiveStatus = await response.json();
        if (scope.signal.aborted) return;
        const handover = current.handover?.id === completed.current ? null : current.handover;
        setSample(previous => previous?.conversationId === id && previous.status.runId === current.runId
          && previous.status.handover?.id === handover?.id && previous.status.handover?.prompt === handover?.prompt
          ? previous : { conversationId: id, status: { runId: current.runId, handover } });
        if (cardId && handover?.id !== cardId) {
          const chat = await read(`/api/chat/conversations/${encodeURIComponent(id)}`, scope.signal);
          if (!chat.ok) { await chat.body?.cancel(); return; }
          const next: ChatConversation = await chat.json();
          if (!scope.signal.aborted) setConversation(previous => previous?.id === id && isNewerSnapshot(previous, next) ? next : previous);
        }
      } catch {
        // Keep the panel through a transient metadata failure. Each frame is independently authorized.
      } finally {
        if (!denied && !scope.signal.aborted) timer = setTimeout(() => void poll(), browserLiveBudget.intervalMs);
      }
    }
    void poll();
    return () => { scope.abort(); clearTimeout(timer); };
  }, [id, runId, cardId, setConversation]);

  const activeRunId = snapshot?.runId;
  const panel = id && snapshot && activeRunId ? <BrowserLivePanel key={`${id}:${activeRunId}`} endpoint={`${browserLivePath(id)}/${encodeURIComponent(activeRunId)}`}
    initiallyOpen={initiallyOpen} handover={snapshot.handover} onUnavailable={() => setSample(null)} onContinued={(handoverId) => {
      completed.current = handoverId;
      setSample(previous => previous?.conversationId === id && previous.status.handover?.id === handoverId
        ? { conversationId: id, status: { runId: activeRunId, handover: null } } : previous);
    }} /> : null;
  return { panel, active: Boolean(activeRunId) || Boolean(card), manualHandover: Boolean(card), handoverWithoutPage: id && card && !panel ? card : null };
}

function BrowserLivePanel({ endpoint, initiallyOpen, handover, onContinued, onUnavailable }: {
  endpoint: string;
  initiallyOpen: boolean;
  handover: Handover | null;
  onContinued: (handoverId: string) => void;
  onUnavailable: () => void;
}) {
  const [shown, setShown] = useState(initiallyOpen || Boolean(handover));
  const [frame, setFrame] = useState<DisplayedBrowserFrame | null>(null);
  const handoverId = handover?.id;
  const contentId = useId();
  const stream = useRef<ReturnType<typeof createBrowserLiveStream> | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => { if (handoverId) setShown(true); }, [handoverId]);
  useEffect(() => {
    const session = createBrowserLiveStream({ endpoint, onFrame: setFrame, onUnavailable: () => unavailable.current() });
    stream.current = session;
    return () => { stream.current = null; session.close(); };
  }, [endpoint]);
  useEffect(() => { stream.current?.setShown(shown); }, [endpoint, shown]);

  return <aside className={styles.panel} dir="rtl" aria-label="المتصفح المباشر" data-testid="browser-live-panel" data-open={shown} data-manual={Boolean(handover)}>
    <button className={styles.toggle} type="button" aria-expanded={shown} aria-controls={contentId} data-testid="browser-live-toggle" onClick={() => setShown(value => !value)}>
      <Monitor size={17} aria-hidden="true" />{shown ? 'إخفاء المتصفح المباشر' : handover ? 'المتصفح المباشر يحتاجك' : 'عرض المتصفح المباشر'}
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    <div id={contentId} hidden={!shown}>
      {shown && (handover ? <ManualControls key={handover.id} endpoint={endpoint} handover={handover} frame={frame}
        onContinued={onContinued} invalidateFrame={() => stream.current?.invalidateFrame()} /> : <LiveImage frame={frame} />)}
    </div>
  </aside>;
}

function LiveImage({ frame, onClick, onReady }: { frame: DisplayedBrowserFrame | null; onClick?: (event: MouseEvent<HTMLImageElement>) => void; onReady?: (url: string) => void }) {
  return <div className={styles.preview}>
    {frame ? <img src={frame.url} alt="صورة الصفحة الحية" draggable={false} data-testid="browser-live-frame" onClick={onClick} data-interactive={Boolean(onClick)}
      onLoad={event => { if (event.currentTarget.currentSrc === frame.url) onReady?.(frame.url); }} />
      : <p role="status">في انتظار صورة المتصفح…</p>}
  </div>;
}

function ManualControls({ endpoint, handover, frame, onContinued, invalidateFrame }: {
  endpoint: string;
  handover: Handover;
  frame: DisplayedBrowserFrame | null;
  onContinued: (handoverId: string) => void;
  invalidateFrame: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [displayed, setDisplayed] = useState<string | null>(null);
  const frameId = frame && frame.url === displayed ? frame.id : null;
  const interactive = Boolean(frameId) && !working;
  const pending = useRef<AbortController | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function send(input?: ManualInput) {
    if (pending.current || (input && !frameId)) return;
    const failure = input ? 'تعذّر إرسال الإدخال إلى المتصفح.' : 'تعذّرت متابعة المهمة. حاول مجددًا.';
    const request = new AbortController();
    pending.current = request;
    setWorking(true);
    setError('');
    try {
      const response = await fetch(`${endpoint}/${input ? 'input' : 'continue'}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: request.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input ? { handoverId: handover.id, frameId, ...input } : { handoverId: handover.id }),
      });
      if (request.signal.aborted) return;
      if (response.ok) {
        await response.body?.cancel();
        if (!input) onContinued(handover.id);
      } else {
        const error = await response.json().catch(() => null);
        if (request.signal.aborted) return;
        const code: unknown = error?.error?.code;
        if (code === 'AGENT_LIVE_PAGE_MISSING' || response.status === 404) {
          setError('أُغلقت صفحة هذه المهمة. أوقف المهمة وابدأها من جديد.');
        } else if (code === 'AGENT_HUMAN_STEP') {
          setError(typeof error?.error?.message === 'string' ? error.error.message : 'ما زالت هناك خطوة تحتاجك. أكملها في الصفحة ثم اضغط متابعة.');
        } else if (code === 'AGENT_LIVE_FRAME_CHANGED') {
          setError('تغيّرت الصفحة. انتظر الصورة الجديدة ثم حاول مجددًا.');
        } else {
          setError(failure);
        }
      }
    } catch {
      if (!request.signal.aborted) setError(failure);
    } finally {
      pending.current = null;
      if (!request.signal.aborted) {
        if (input) invalidateFrame();
        setWorking(false);
      }
    }
  }

  function pointer(event: MouseEvent<HTMLImageElement>) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    if (width && height) void send({ kind: 'pointer', x: Math.max(0, Math.min(1, (event.clientX - left) / width)), y: Math.max(0, Math.min(1, (event.clientY - top) / height)) });
  }

  function text(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!field.current?.value || !interactive || pending.current) return;
    const value = field.current.value;
    field.current.value = '';
    void send({ kind: 'keyboard', text: value });
  }

  return <div className={styles.takeover}>
    <p className={styles.prompt} role="status" data-testid="browser-live-prompt">{handover.prompt}</p>
    <LiveImage frame={frame} onClick={interactive ? pointer : undefined} onReady={setDisplayed} />
    <form onSubmit={text} autoComplete="off" className={styles.text}>
      <input ref={field} type="password" aria-label="نص لإدخاله في الحقل المحدد" placeholder="نص للحقل المحدد" dir="auto" maxLength={ChatKeyboardSchema.shape.text.unwrap().maxLength ?? undefined} data-testid="browser-live-text" />
      <button type="submit" disabled={!interactive} data-testid="browser-live-send">إدخال النص</button>
    </form>
    <div className={styles.keys} role="group" aria-label="مفاتيح المتصفح" dir="ltr">
      {browserLiveKeys.map(key => <button key={key} type="button" disabled={!interactive} title={`إرسال مفتاح ${key}`}
        data-testid={`browser-live-key-${key}`} onClick={() => void send({ kind: 'keyboard', key })}>{key}</button>)}
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <button type="button" className={styles.continue} disabled={working} data-testid="browser-live-continue" onClick={() => void send()}>متابعة</button>
  </div>;
}
