import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserLiveBudget,
  ChatKeyboardSchema,
  type ChatConversation,
} from '@mohassan/contracts';
import { boundedBrowserLiveFrame } from '../apps/web/app/api/[...path]/browser-live-frame';
import {
  browserLiveAttention,
  browserLiveSnapshot,
  createBrowserLiveInput,
  finishBrowserLiveAttention,
  subscribeBrowserLiveFrames,
} from '../apps/web/components/browser-live-transport';
import { completeBrowserLiveInput } from '../apps/server/src/assistant/browser-live-handoff';

const conversationId = 'bfc95c7c-5630-46a3-92d7-875558771874';
const cardId = 'd61a31e8-5523-41fa-b512-bc79f7b25601';
const now = '2026-11-25T12:00:00.000Z';

function detail(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: conversationId, title: 'Run', status: 'running', updatedAt: now, configured: false,
    messages: [], steps: [], question: null, approval: null, secure: null, error: null, progress: 'Reading the page',
    browser: { live: true, title: 'Fixture', url: 'https://example.test/', observedAt: now, screenUrl: '/not-used' },
    visibility: { version: 1, code: 'browser_started', level: 2, reason: 'Visible fixture', decidedAt: now, requested: 2, canView: true, lang: 'en', history: [] },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser live transport', () => {
  it('accepts the requested live conversation and denies mismatched, closed and forbidden projections', () => {
    const owned = detail();
    expect(browserLiveSnapshot(owned, conversationId)).toMatchObject({ title: 'Fixture', caption: 'Reading the page' });
    expect(browserLiveSnapshot(owned, cardId)).toBeNull();
    expect(browserLiveSnapshot(detail({ browser: null }), conversationId)).toBeNull();
    expect(browserLiveSnapshot(detail({ visibility: { ...owned.visibility!, level: 4, canView: false } }), conversationId)).toBeNull();
    expect(browserLiveSnapshot(detail({ visibility: { ...owned.visibility!, canView: false }, progress: null,
      steps: [{ id: cardId, text: 'Current step', createdAt: now }],
    }), conversationId)).toMatchObject({ caption: 'Current step' });
  });

  it.each([
    ['login', 'needs_login', 'سجّل الدخول'],
    ['code', 'needs_code', 'أدخل رمز التحقق'],
    ['hands_on', 'hands_on', 'أكمل الخطوة'],
  ] as const)('prompts for %s only while its card waits', (kind, code, message) => {
    const expected = detail({
      status: 'waiting_input',
      secure: { id: cardId, kind, site: 'example.test', prompt: 'Fixture prompt', fields: [], note: null },
      visibility: { ...detail().visibility!, level: 3, code },
    });
    const snapshot = browserLiveSnapshot(expected, conversationId)!;
    expect(browserLiveAttention(snapshot)).toMatchObject({ id: cardId, code, message: expect.stringContaining(message) });
    expect(browserLiveAttention({ ...snapshot, status: 'running' })).toBeNull();
    expect(browserLiveAttention({ ...snapshot, visibility: { ...snapshot.visibility, code: 'open_only' } })).toBeNull();
  });

  it('binds approval to the pending card and sends the existing continue and cancel operations', async () => {
    const snapshot = browserLiveSnapshot(detail({
      status: 'waiting_approval',
      approval: { id: cardId, prompt: 'Review the action', detail: 'POST /fixture' },
      visibility: { ...detail().visibility!, level: 3, code: 'needs_approval' },
    }), conversationId)!;
    const approval = browserLiveAttention(snapshot)!;
    expect(approval).toMatchObject({ id: cardId, code: 'needs_approval', detail: 'Review the action POST /fixture' });

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    await finishBrowserLiveAttention(conversationId, approval, 'continue', fetcher);
    await finishBrowserLiveAttention(conversationId, { ...approval, code: 'needs_login' }, 'continue', fetcher);
    await finishBrowserLiveAttention(conversationId, approval, 'cancel', fetcher);
    expect(fetcher.mock.calls.map(([path, init]) => [String(path).split('/').at(-1), JSON.parse(String(init?.body))])).toEqual([
      ['approve', { approvalId: cardId, approved: true }],
      ['secure', { requestId: cardId, action: 'done' }],
      ['cancel', {}],
    ]);
  });

  it('uses normalized pointer, wheel and keyboard events in order before handing control back', async () => {
    let finishClick!: () => void;
    const waitForClick = new Promise<void>(resolve => { finishClick = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      await waitForClick;
      return new Response(null, { status: 204 });
    }).mockImplementation(async () => new Response(null, { status: 204 }));
    const input = createBrowserLiveInput(conversationId, fetcher);
    const events = [
      input.send({ kind: 'pointer', x: 0.2, y: 0.5 }),
      input.send({ kind: 'text', text: 'fixture input' }),
      input.send({ kind: 'key', key: 'Enter' }),
      input.send({ kind: 'scroll', x: 0.3, y: 0.7, deltaX: 0, deltaY: -130 }),
    ];
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    finishClick();
    await input.drain();
    await Promise.all(events);
    expect(fetcher.mock.calls.map(([path, init]) => [String(path).split('/').at(-1), JSON.parse(String(init?.body))])).toEqual([
      ['pointer', { x: 0.2, y: 0.5 }], ['keyboard', { text: 'fixture input' }], ['keyboard', { key: 'Enter' }],
      ['keyboard', { wheel: { x: 0.3, y: 0.7, deltaX: 0, deltaY: -130 } }],
    ]);
    expect(ChatKeyboardSchema.safeParse({ wheel: { x: 0, y: 1, deltaX: -1201, deltaY: 0 } }).success).toBe(false);
  });

  it('keeps request values out of errors and never retries an uncertain write', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-only input'));
    const input = createBrowserLiveInput(conversationId, fetcher);
    await expect(input.send({ kind: 'text', text: 'fixture-only input' })).rejects.toThrow('تعذّر إرسال الإدخال');
    await expect(input.drain()).rejects.toThrow('تعذّر إرسال الإدخال');
    input.close();
    await expect(input.send({ kind: 'key', key: 'Enter' })).rejects.toThrow('تعذّر إرسال الإدخال');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([['small', 1], ['medium', 4], ['pill', 0], ['closed', 0]] as const)(
    'keeps %s within its %s fps budget and cancels polling on cleanup', async (mode, fps) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const fetcher = vi.fn(async () => new Response(new Uint8Array(512), { headers: { 'Content-Type': 'image/jpeg' } }));
      vi.stubGlobal('fetch', fetcher);
      const onMetrics = vi.fn();
      const cleanup = subscribeBrowserLiveFrames({ conversationId, mode, onFrame: () => {}, onMetrics });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).toHaveBeenCalledTimes(fps);
      if (fps) expect(onMetrics.mock.lastCall?.[0]).toMatchObject({ frames: fps, bytes: fps * 512, bytesPerSecond: fps * 512 });
      cleanup();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher).toHaveBeenCalledTimes(fps);
    },
  );
});

describe('browser live server adapters', () => {
  it('serves a bounded JPEG and cancels chunked or declared oversized frames', async () => {
    const headers = new Headers({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    const jpeg = new Uint8Array([255, 216, 255, 217]);
    const allowed = await boundedBrowserLiveFrame(new Response(jpeg), headers);
    expect(allowed.headers.get('content-length')).toBe(String(jpeg.byteLength));
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(jpeg);
    const cancelled = vi.fn();
    const tooLarge = await boundedBrowserLiveFrame(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(browserLiveBudget.maxFrameBytes + 1)); },
      cancel: cancelled,
    })), headers);
    expect(tooLarge.status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();
    const declared = await boundedBrowserLiveFrame(new Response(jpeg, { headers: { 'Content-Length': String(browserLiveBudget.maxFrameBytes + 1) } }), headers);
    expect(declared.status).toBe(413);
  });

  it('releases the autofill page hash only for explicit manual completion', () => {
    const state = { authAttempts: 3, securePageHash: 'original-page' };
    completeBrowserLiveInput(state, 'submit');
    completeBrowserLiveInput(state, 'skip');
    expect(state).toEqual({ authAttempts: 3, securePageHash: 'original-page' });
    completeBrowserLiveInput(state, 'done');
    expect(state).toEqual({ authAttempts: 0, securePageHash: null });
  });
});
