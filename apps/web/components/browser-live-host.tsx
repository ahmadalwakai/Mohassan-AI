"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { BrowserLiveSnapshot, ChatConversation, ChatConversationSummary } from "@mohassan/contracts";
import { browserLiveDesktop } from "./browser-live-desktop";
import { browserLiveAttention, browserLiveSnapshot } from "./browser-live-transport";
import { BrowserLiveView } from "./browser-premium-view";
import { isNewerSnapshot } from "./run-view";

const discoveryInterval = 4_000;
const activeInterval = 1_000;
const hiddenInterval = 15_000;
const noPageInterval = 30_000;
const selectedKey = "mohassan-conversation";
const sessionSignal = "mohassan-browser-live-session";
const finishedEvent = "mohassan-browser-live-finished";
const attentionStatuses = new Set(["waiting_input", "waiting_approval"]);

type Hint = { id: string; mark: string };
const Host = createContext<{ account: (id: string | null) => void; hint: (hint: Hint | null) => void } | null>(null);

export function useBrowserLiveAccount(id: string | null) {
  const host = useContext(Host);
  useEffect(() => { host?.account(id); }, [host, id]);
}

export function useBrowserLiveHint(
  conversation: ChatConversation | null, update: Dispatch<SetStateAction<ChatConversation | null>>, refreshHistory: () => Promise<unknown>,
) {
  const host = useContext(Host);
  const id = conversation?.id;
  const mark = conversation?.version ?? conversation?.updatedAt;
  useEffect(() => { if (id && mark) host?.hint({ id, mark }); }, [host, id, mark]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const sync = (candidate: unknown) => {
      if (candidate !== id) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      void read<ChatConversation>(`/api/chat/conversations/${encodeURIComponent(id)}`, signal)
        .then((next) => {
          if (!controller.signal.aborted && next?.id === id) {
            update((current) => current?.id === id && isNewerSnapshot(current, next) ? next : current);
            void refreshHistory().catch(() => {});
          }
        }).catch(() => {});
    };
    const sameWindow = (event: Event) => sync((event as CustomEvent<unknown>).detail);
    const channel = browserLiveFinishChannel();
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => sync(event.data);
    window.addEventListener(finishedEvent, sameWindow);
    return () => {
      controller.abort();
      channel?.close();
      window.removeEventListener(finishedEvent, sameWindow);
    };
  }, [id, refreshHistory, update]);
}

function browserLiveFinishChannel() {
  try { return new BroadcastChannel(finishedEvent); } catch { return null; }
}

export function BrowserLiveProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<{ id: string | null; hint: Hint | null }>({ id: null, hint: null });
  const [miniEnabled, setMiniEnabled] = useState(false);
  const [electron, setElectron] = useState(false);

  const bindings = useRef({
    account: (id: string | null) => setIdentity((current) => current.id === id ? current : { id, hint: null }),
    hint: (hint: Hint | null) => setIdentity((current) => ({ ...current, hint })),
  }).current;

  useEffect(() => {
    // A desktop child window shares the same login cookies. This signal only wakes its session check.
    try { window.localStorage.setItem(sessionSignal, String(Date.now())); } catch { /* Polling still checks the session. */ }
  }, [identity.id]);

  useEffect(() => {
    const desktop = browserLiveDesktop();
    if (!desktop) return;
    setElectron(true);
    let active = true;
    let changed = false;
    const unsubscribe = desktop.onEnabledChanged((enabled) => { changed = true; setMiniEnabled(enabled); });
    void desktop.enabled().then((enabled) => { if (active && !changed) setMiniEnabled(enabled); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);

  return <Host.Provider value={bindings}>
    {children}
    {identity.id && !miniEnabled ? <AccountBrowserLiveView key={identity.id} hint={identity.hint} desktop={electron} /> : null}
  </Host.Provider>;
}

async function read<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error("Browser view metadata unavailable");
  return await response.json() as T;
}

async function readBrowserLiveDetail(summary: ChatConversationSummary, signal: AbortSignal) {
  const detail = await read<ChatConversation>(`/api/chat/conversations/${encodeURIComponent(summary.id)}`, signal);
  return detail ? browserLiveSnapshot(detail, summary.id) : null;
}

function savedSelection() {
  try { return window.localStorage.getItem(selectedKey); } catch { return null; }
}

function AccountBrowserLiveView({ hint, desktop, desktopMini }: { hint?: Hint | null; desktop: boolean; desktopMini?: boolean }) {
  const [snapshot, setSnapshot] = useState<BrowserLiveSnapshot | null>(null);
  const [sessionIdentity, setSessionIdentity] = useState<string | null>(null);
  const currentHint = useRef(hint);
  currentHint.current = hint;
  const refresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    const bySummary = new Map<string, { updatedAt: string; checkedAt: number; mark: string | undefined; value: BrowserLiveSnapshot | null }>();
    let timer: ReturnType<typeof setTimeout>;
    let busy = false;
    let refreshAgain = false;
    let selected: BrowserLiveSnapshot | null = null;
    let summaries: ChatConversationSummary[] = [];
    let listAt = 0;
    let miniAccount: string | null = null;
    let authAt = 0;

    function reset() {
      bySummary.clear();
      summaries = [];
      listAt = 0;
      selected = null;
      setSnapshot(null);
    }

    async function poll() {
      if (lifetime.signal.aborted) return;
      if (busy) { refreshAgain = true; return; }
      clearTimeout(timer);
      busy = true;
      let next = discoveryInterval;
      try {
        const now = Date.now();
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
        if (desktopMini && now - authAt >= discoveryInterval) {
          const session = await read<{ user?: { id?: string } }>("/api/auth/get-session", signal);
          const id = session?.user?.id ?? null;
          authAt = now;
          if (id !== miniAccount) {
            reset();
            miniAccount = id;
            setSessionIdentity(id);
          }
        }
        if (desktopMini && !miniAccount) return;
        const announced = currentHint.current;
        const preferred = announced?.id ?? savedSelection();
        if (now - listAt >= discoveryInterval || (announced && !summaries.some((item) => item.id === announced.id))) {
          const list = await read<{ conversations: ChatConversationSummary[] }>("/api/chat/conversations", signal);
          if (!list) { reset(); return; }
          summaries = list.conversations;
          listAt = now;
          for (const id of bySummary.keys()) if (!summaries.some((item) => item.id === id)) bySummary.delete(id);
        }

        const byId = new Map(summaries.map((item) => [item.id, item]));
        const wasWaiting = selected && browserLiveAttention(selected) ? byId.get(selected.conversationId) : undefined;
        const preferredRun = preferred ? byId.get(preferred) : undefined;
        const candidates = new Set([
          wasWaiting,
          ...summaries.filter((item) => attentionStatuses.has(item.status)),
          preferredRun?.status === "running" ? preferredRun : undefined,
          ...summaries.filter((item) => item.status === "running"),
          preferredRun,
          selected ? byId.get(selected.conversationId) : undefined,
          summaries[0],
        ]);
        let checked = 0;
        selected = null;
        for (const item of candidates) {
          if (!item) continue;
          const mark = item.id === announced?.id ? announced.mark : undefined;
          let cached = bySummary.get(item.id);
          const working = item.status === "running" || attentionStatuses.has(item.status);
          const cadence = cached?.value === null ? noPageInterval : working ? activeInterval : discoveryInterval;
          if ((!cached || cached.updatedAt !== item.updatedAt || cached.mark !== mark || now - cached.checkedAt >= cadence) && checked < 4) {
            const value = await readBrowserLiveDetail(item, signal);
            cached = { updatedAt: item.updatedAt, checkedAt: now, mark, value };
            bySummary.set(item.id, cached);
            checked++;
          }
          if (cached?.value) { selected = cached.value; break; }
        }
        if (!lifetime.signal.aborted) setSnapshot(selected);
        next = summaries.some((item) => item.status === "running" || attentionStatuses.has(item.status)) ? activeInterval : discoveryInterval;
      } catch {
        // A transient metadata failure leaves the last verified run visible. The frame endpoint still authorizes every read.
      } finally {
        busy = false;
        if (!lifetime.signal.aborted) {
          const delay = refreshAgain ? 0 : document.hidden && !desktopMini ? hiddenInterval : next;
          refreshAgain = false;
          timer = setTimeout(() => void poll(), delay);
        }
      }
    }

    const wake = () => { listAt = 0; authAt = 0; void poll(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === selectedKey || event.key === sessionSignal) wake();
    };
    refresh.current = () => void poll();
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", wake);
    void poll();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
      refresh.current = null;
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [desktopMini]);

  useEffect(() => { if (hint) refresh.current?.(); }, [hint?.id, hint?.mark]);
  const onAttentionFinished = useCallback((id: string) => {
    refresh.current?.();
    if (desktopMini) {
      const channel = browserLiveFinishChannel();
      channel?.postMessage(id);
      channel?.close();
    } else {
      window.dispatchEvent(new CustomEvent(finishedEvent, { detail: id }));
    }
  }, [desktopMini]);
  return <BrowserLiveView key={sessionIdentity ?? "in-app"} snapshot={snapshot} app={desktop ? "desktop" : "web"} desktopMini={desktopMini}
    onAttentionFinished={onAttentionFinished} />;
}

export function DesktopBrowserLiveView() {
  const [native, setNative] = useState(false);
  useEffect(() => setNative(Boolean(browserLiveDesktop())), []);
  return native ? <AccountBrowserLiveView desktop desktopMini /> : null;
}
