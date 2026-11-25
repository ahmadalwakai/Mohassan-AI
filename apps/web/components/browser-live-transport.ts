import {
  browserLiveBudget,
  ChatBrowserActivitySchema,
  type BrowserLiveAttention,
  type BrowserLiveFrame,
  type BrowserLiveMetrics,
  type BrowserLiveMode,
  type BrowserLiveSnapshot,
  type BrowserLiveInput,
  type ChatBrowserActivity,
  type ChatConversation,
} from '@mohassan/contracts';

export function browserLiveSnapshot(detail: ChatConversation, conversationId: string): BrowserLiveSnapshot | null {
  if (detail.id !== conversationId || !detail.browser?.live) return null;
  const visibility = detail.visibility ?? {
    version: 1, level: 2, code: 'browser_started', reason: 'المتصفح يعمل في الخلفية',
    lang: 'ar', decidedAt: detail.updatedAt, requested: 2, canView: false, history: [],
  };
  if (visibility.level !== 2 && visibility.level !== 3) return null;
  return {
    conversationId, runId: detail.run?.id ?? null, status: detail.status, title: detail.browser.title,
    caption: detail.progress ?? detail.steps.at(-1)?.text ?? visibility.reason,
    visibility, secure: detail.secure, approval: detail.approval,
    ...(detail.browserPremium ? { premium: detail.browserPremium } : {}),
  };
}

const secureAttention = {
  login: { code: 'needs_login', message: 'سجّل الدخول هنا ثم اضغط متابعة' },
  code: { code: 'needs_code', message: 'أدخل رمز التحقق هنا ثم اضغط متابعة' },
  hands_on: { code: 'hands_on', message: 'أكمل الخطوة هنا ثم اضغط متابعة' },
} as const;

export function browserLiveAttention(snapshot: BrowserLiveSnapshot): BrowserLiveAttention | null {
  if (snapshot.visibility.level !== 3) return null;
  if (snapshot.status === 'waiting_input' && snapshot.secure) {
    const attention = secureAttention[snapshot.secure.kind];
    return attention.code === snapshot.visibility.code ? { ...attention, id: snapshot.secure.id, detail: snapshot.secure.prompt } : null;
  }
  if (snapshot.status === 'waiting_approval' && snapshot.approval && snapshot.visibility.code === 'needs_approval') {
    return {
      code: 'needs_approval', id: snapshot.approval.id, message: 'راجع الإجراء ثم اضغط موافقة ومتابعة',
      detail: [snapshot.approval.prompt, snapshot.approval.detail, snapshot.approval.target, snapshot.approval.consequence].filter(Boolean).join(' '),
    };
  }
  return null;
}

const chatPath = (conversationId: string) => `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
const inputError = () => new Error('تعذّر إرسال الإدخال إلى المتصفح.');

async function sendBrowserLivePost(fetcher: typeof fetch, route: string, body: object, signal?: AbortSignal) {
  try {
    const response = await fetcher(route, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await response.body?.cancel();
    if (response.ok) return;
  } catch {
    // Transport errors can carry request data. Only return a fixed error.
  }
  throw inputError();
}

/** One serial input queue per takeover. No payload is retried or sent to a logger. */
export function createBrowserLiveInput(conversationId: string, fetcher: typeof fetch = fetch) {
  const path = chatPath(conversationId);
  const controller = new AbortController();
  let tail = Promise.resolve();
  let hasFailed = false;
  return {
    send(event: BrowserLiveInput): Promise<void> {
      const pending = tail.then(async () => {
        if (controller.signal.aborted) throw inputError();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        switch (event.kind) {
          case 'pointer':
            return sendBrowserLivePost(fetcher, `${path}/browser/pointer`, { x: event.x, y: event.y }, signal);
          case 'key':
            return sendBrowserLivePost(fetcher, `${path}/browser/keyboard`, { key: event.key }, signal);
          case 'text':
            return sendBrowserLivePost(fetcher, `${path}/browser/keyboard`, { text: event.text }, signal);
          case 'scroll':
            return sendBrowserLivePost(fetcher, `${path}/browser/keyboard`, {
              wheel: { x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY },
            }, signal);
        }
      });
      tail = pending.catch(() => { hasFailed = true; });
      return pending;
    },
    async drain() {
      await tail;
      if (hasFailed) {
        hasFailed = false;
        throw inputError();
      }
    },
    close() { controller.abort(); },
  };
}

export function finishBrowserLiveAttention(
  conversationId: string, attention: BrowserLiveAttention, action: 'continue' | 'cancel', fetcher: typeof fetch = fetch,
): Promise<void> {
  const path = chatPath(conversationId);
  if (action === 'cancel') return sendBrowserLivePost(fetcher, `${path}/cancel`, {});
  if (attention.code === 'needs_approval') return sendBrowserLivePost(fetcher, `${path}/approve`, { approvalId: attention.id, approved: true });
  return sendBrowserLivePost(fetcher, `${path}/secure`, { requestId: attention.id, action: 'done' });
}

interface FrameSubscription {
  conversationId: string;
  mode: BrowserLiveMode;
  onFrame: (frame: BrowserLiveFrame) => void;
  onMetrics?: (metrics: BrowserLiveMetrics) => void;
  onError?: () => void;
}

export function subscribeBrowserLiveFrames({ conversationId, mode, onFrame, onMetrics, onError }: FrameSubscription) {
  const rate = browserLiveBudget.framesPerSecond[mode];
  if (!rate) return () => {};
  const interval = 1000 / rate;
  let url: string | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let bytes = 0;
  let frames = 0;
  const started = performance.now();
  const controller = new AbortController();

  async function next() {
    const frameStart = performance.now();
    let delay = interval;
    try {
      const response = await fetch(`${chatPath(conversationId)}/screen?liveView=1`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get('retry-after'));
        delay = Math.max(interval, retryAfter * 1000 || 0);
        throw new Error('Browser frame unavailable');
      }
      const jpeg = await response.blob();
      if (!jpeg.size || jpeg.size > browserLiveBudget.maxFrameBytes) throw new Error('Browser frame exceeds its budget');
      if (controller.signal.aborted) return;
      frames++;
      bytes += jpeg.size;
      const previous = url;
      url = URL.createObjectURL(jpeg);
      onFrame({ url, byteLength: jpeg.size });
      if (previous) URL.revokeObjectURL(previous);
      onMetrics?.({ frames, bytes, bytesPerSecond: 1000 * bytes / Math.max(interval, performance.now() - started + interval) });
    } catch {
      if (!controller.signal.aborted) onError?.();
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(next, Math.max(0, Math.ceil(delay - (performance.now() - frameStart))));
    }
  }
  void next();
  return () => {
    controller.abort();
    clearTimeout(timer);
    if (url) URL.revokeObjectURL(url);
  };
}

export function subscribeBrowserLiveActivity({ conversationId, onActivity }: {
  conversationId: string;
  onActivity: (activity: ChatBrowserActivity | null) => void;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let previous: ChatBrowserActivity | null = null;
  async function next() {
    let delay = 1000;
    try {
      const response = await fetch(`${chatPath(conversationId)}/browser/activity`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        delay = Math.max(delay, Number(response.headers.get('retry-after')) * 1000 || 0);
        return;
      }
      const result = ChatBrowserActivitySchema.nullable().safeParse(await response.json());
      if (controller.signal.aborted || !result.success) return;
      if (result.data?.sequence === previous?.sequence && result.data?.sessionId === previous?.sessionId) return;
      previous = result.data;
      onActivity(previous);
    } catch {
      // A missing activity sample does not interrupt the separate frame subscription.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(next, delay);
    }
  }
  void next();
  return () => { controller.abort(); clearTimeout(timer); };
}
