import { browserLiveBudget, browserLiveFrameHeader } from '@mohassan/contracts';
import { z } from 'zod';

export const browserLivePath = (conversationId: string) =>
  `/api/chat/conversations/${encodeURIComponent(conversationId)}/browser/live`;

export type DisplayedBrowserFrame = { id: string; url: string };
const frameIdSchema = z.uuid();

async function boundedJpeg(response: Response): Promise<Blob | null> {
  const { maxFrameBytes } = browserLiveBudget;
  if (response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg'
    || Number(response.headers.get('content-length')) > maxFrameBytes || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return size ? new Blob(parts, { type: 'image/jpeg' }) : null;
      size += value.byteLength;
      if (size > maxFrameBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

interface FrameStreamOptions {
  endpoint: string;
  onFrame: (frame: DisplayedBrowserFrame | null) => void;
  onUnavailable: () => void;
  documentState?: Pick<Document, 'hidden'> & EventTarget;
  fetcher?: typeof fetch;
}

// The cancellable frame loop follows PR #36 (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/pull/36/files
export function createBrowserLiveStream({ endpoint, onFrame, onUnavailable, documentState = document, fetcher = fetch }: FrameStreamOptions) {
  let shown = false;
  let closed = false;
  let unavailable = false;
  let nextAt = 0;
  let frame: DisplayedBrowserFrame | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  const active = () => shown && !documentState.hidden && !closed && !unavailable;

  function publish(nextFrame: DisplayedBrowserFrame | null) {
    if (frame) URL.revokeObjectURL(frame.url);
    frame = nextFrame;
    if (!closed) onFrame(nextFrame);
  }

  function schedule() {
    clearTimeout(timer);
    if (!active()) {
      pending?.abort();
      pending = undefined;
      if (frame) publish(null);
      return;
    }
    if (!pending) timer = setTimeout(() => void next(), Math.max(0, nextAt - Date.now()));
  }

  async function next() {
    if (!active() || pending) return;
    const request = new AbortController();
    pending = request;
    nextAt = Date.now() + browserLiveBudget.intervalMs;
    let delay: number = browserLiveBudget.intervalMs;
    try {
      const response = await fetcher(`${endpoint}/frame`, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (request.signal.aborted) { await response.body?.cancel(); return; }
      if (response.status === 200) {
        const frameId = frameIdSchema.safeParse(response.headers.get(browserLiveFrameHeader));
        if (!frameId.success) {
          await response.body?.cancel();
          if (active() && !request.signal.aborted) publish(null);
          return;
        }
        const jpeg = await boundedJpeg(response);
        if (active() && !request.signal.aborted) publish(jpeg && { id: frameId.data, url: URL.createObjectURL(jpeg) });
      } else {
        await response.body?.cancel();
        if (request.signal.aborted) return;
        if ([401, 403, 404].includes(response.status)) {
          unavailable = true;
          onUnavailable();
        }
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after')) * 1000;
          if (Number.isFinite(retry)) delay = Math.max(delay, retry);
        } else publish(null);
      }
    } catch {
      if (active() && !request.signal.aborted) publish(null);
    } finally {
      if (pending === request) {
        pending = undefined;
        nextAt = Date.now() + delay;
      }
      schedule();
    }
  }

  documentState.addEventListener('visibilitychange', schedule);
  return {
    setShown(value: boolean) { shown = value; schedule(); },
    invalidateFrame() {
      pending?.abort();
      pending = undefined;
      if (frame) publish(null);
      schedule();
    },
    close() {
      closed = true;
      documentState.removeEventListener('visibilitychange', schedule);
      schedule();
    },
  };
}
