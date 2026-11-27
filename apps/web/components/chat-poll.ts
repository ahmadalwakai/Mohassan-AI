import { useSyncExternalStore } from "react";
import { isSessionExpired, pollBackoffMs } from "./chat-connection";

function subscribeConnection(listener: () => void) {
  window.addEventListener("offline", listener);
  window.addEventListener("online", listener);
  return () => {
    window.removeEventListener("offline", listener);
    window.removeEventListener("online", listener);
  };
}

const isOffline = () => navigator.onLine === false;
export const useBrowserOffline = () => useSyncExternalStore(subscribeConnection, isOffline, () => false);

interface ChatPoll {
  interval: number;
  hiddenInterval: number | null;
  firstDelay: number;
  run: (signal: AbortSignal) => Promise<number | void>;
  onError?: (error: unknown) => void;
}

export function startChatPoll({ interval, hiddenInterval, firstDelay, run, onError }: ChatPoll): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  let stopped = false;
  let failures = 0;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay: number | null) {
    clearTimer();
    if (!stopped && !request && !isOffline() && delay !== null) timer = setTimeout(poll, delay);
  }

  async function poll() {
    timer = undefined;
    if (stopped || request || isOffline() || (document.hidden && hiddenInterval === null)) return;
    const controller = new AbortController();
    request = controller;
    let delay = interval;
    try {
      delay = (await run(controller.signal)) ?? interval;
      if (!controller.signal.aborted) failures = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isSessionExpired(error)) {
        stopped = true;
        return;
      }
      delay = Math.max(interval, pollBackoffMs(++failures));
      onError?.(error);
    } finally {
      if (request === controller) {
        request = null;
        const next = hiddenInterval === null ? null : Math.max(delay, hiddenInterval);
        schedule(document.hidden ? next : delay);
      }
    }
  }

  function pause() {
    clearTimer();
    request?.abort();
    request = null;
  }
  function reconnect() {
    failures = 0;
    schedule(document.hidden ? hiddenInterval : firstDelay);
  }
  function visibilityChanged() {
    if (!document.hidden && (!failures || timer === undefined)) schedule(0);
  }

  const unsubscribe = subscribeConnection(() => {
    if (isOffline()) pause();
    else reconnect();
  });
  document.addEventListener("visibilitychange", visibilityChanged);
  schedule(document.hidden ? hiddenInterval : firstDelay);
  return () => {
    stopped = true;
    pause();
    unsubscribe();
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
