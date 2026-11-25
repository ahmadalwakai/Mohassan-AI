import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationFromNotification, currentPushDevice, notificationConversationLink, takeConversationFromNotification,
  releaseThisBrowser, showHiddenNotification, subscribeThisBrowser, unsubscribeDevice,
} from '../apps/web/components/notification-client';

const conversationId = '203c0660-d439-411c-8fe5-3d596586a4d0';
const taskId = 'e3b87764-9c2c-4a0c-891d-749ba47f1df7';
const origin = 'https://mohassan.example';
const task = { taskId, conversationId, kind: 'needs_you' as const };
const workerScript = readFileSync(new URL('../apps/web/public/notifications-sw.js', import.meta.url), 'utf8');

afterEach(() => vi.unstubAllGlobals());

function startWorker({
  windows = [] as { url: string; focus?: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }[],
  status = 204,
  receipts,
}: { windows?: { url: string; focus?: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }[]; status?: number; receipts?: Map<string, Response> } = {}) {
  const handlers = new Map<string, (value: unknown) => void>();
  const openWindow = vi.fn();
  const showNotification = vi.fn();
  const fetch = vi.fn(async () => ({ status }));
  runInNewContext(workerScript, {
    URL, Response, AbortSignal, setTimeout, fetch,
    self: {
      location: { origin },
      clients: { matchAll: async () => windows, openWindow },
      registration: { showNotification },
      caches: receipts && { open: async () => ({
        match: async (key: string) => receipts.get(key),
        put: async (key: string, response: Response) => receipts.set(key, response),
        keys: async () => [...receipts.keys()],
        delete: async (key: string) => receipts.delete(key),
      }) },
      addEventListener: (event: string, handler: (value: unknown) => void) => handlers.set(event, handler),
    },
  });
  async function dispatch(name: string, fields: object) {
    let done: Promise<unknown> | undefined;
    handlers.get(name)?.({ ...fields, waitUntil: (promise: Promise<unknown>) => { done = promise; } });
    expect(done).toBeDefined();
    await done;
  }
  return { dispatch, openWindow, showNotification, fetch };
}

describe('web push worker', () => {
  it('opens the notification conversation and prefers an existing app window', async () => {
    const close = vi.fn();
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => ({ focus }));
    const worker = startWorker({ windows: [{ url: `${origin}/`, navigate }] });
    const url = `${origin}/?conversation=${conversationId}`;
    const event = { notification: { data: { conversationId }, close } };

    await worker.dispatch('notificationclick', event);
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(url);
    expect(focus).toHaveBeenCalledOnce();
    expect(worker.openWindow).not.toHaveBeenCalled();

    const fresh = startWorker();
    await fresh.dispatch('notificationclick', event);
    expect(fresh.openWindow).toHaveBeenCalledWith(url);
    expect(conversationFromNotification(new URL(url))).toBe(conversationId);
  });

  it('keeps malformed conversation links on the app origin', async () => {
    const worker = startWorker();
    await worker.dispatch('notificationclick', { notification: { data: { conversationId: 'https://other.example' }, close() {} } });
    expect(worker.openWindow).toHaveBeenCalledWith(`${origin}/`);
    expect(conversationFromNotification(new URL(`${origin}/?conversation=//other.example`))).toBeNull();
  });

  it('authenticates the recipient and displays only the allowed Arabic lock-screen fields', async () => {
    const worker = startWorker();
    await worker.dispatch('push', { data: { json: () => ({ ...task, message: 'private reply' }) } });
    expect(worker.fetch).toHaveBeenCalledWith(`/api/notifications/events/${taskId}`, { credentials: 'same-origin', cache: 'no-store' });
    expect(worker.showNotification).toHaveBeenCalledWith('تحتاجك خطوة', {
      body: undefined, data: { conversationId }, tag: `mohassan-task-${taskId}`, dir: 'rtl', lang: 'ar',
    });

    await worker.dispatch('push', { data: { json: () => ({ ...task, conversationTitle: 'عنوان المحادثة' }) } });
    expect(worker.showNotification).toHaveBeenLastCalledWith('تحتاجك خطوة', expect.objectContaining({ body: 'عنوان المحادثة' }));

    const unauthorized = startWorker({ status: 404 });
    await unauthorized.dispatch('push', { data: { json: () => task } });
    await unauthorized.dispatch('push', { data: { json: () => ({ ...task, conversationId: null, kind: 'task_completed' }) } });
    expect(unauthorized.showNotification).not.toHaveBeenCalled();
  });

  it('shows a reminder only after checking ownership and never displays its text', async () => {
    const push = { data: { json: () => ({ ...task, kind: 'reminder_due', text: 'private reminder' }) } };
    const worker = startWorker();
    await worker.dispatch('push', push);
    expect(worker.fetch).toHaveBeenCalledOnce();
    expect(worker.showNotification).toHaveBeenCalledExactlyOnceWith('حان موعد التذكير', expect.objectContaining({
      body: undefined, data: { conversationId },
    }));

    const unauthorized = startWorker({ status: 404 });
    await unauthorized.dispatch('push', push);
    expect(unauthorized.showNotification).not.toHaveBeenCalled();
  });

  it('displays the background push body and only shows one notification across a worker restart', async () => {
    const receipts = new Map<string, Response>();
    const first = startWorker({ receipts });
    const push = { data: { json: () => ({
      ...task, runId: taskId, runKind: 'run-blocked', title: 'Sign in to continue',
      body: 'One of the sources needs you to sign in.', language: 'en',
      conversationTitle: 'Private conversation',
    }) } };

    await Promise.all([first.dispatch('push', push), first.dispatch('push', push)]);
    expect(first.showNotification).toHaveBeenCalledExactlyOnceWith('Sign in to continue', {
      body: 'One of the sources needs you to sign in.', data: { conversationId },
      tag: `mohassan-task-${taskId}`, dir: 'ltr', lang: 'en', renotify: false,
    });
    expect(receipts.size).toBe(1);
    expect(await [...receipts.values()][0]?.text()).toBe('');

    const restarted = startWorker({ receipts });
    await restarted.dispatch('push', push);
    expect(restarted.fetch).toHaveBeenCalledOnce();
    expect(restarted.showNotification).not.toHaveBeenCalled();
  });

  it('retries a background notification ownership check when the server is restarting', async () => {
    const worker = startWorker();
    worker.fetch.mockResolvedValueOnce({ status: 503 });
    const push = { data: { json: () => ({ ...task, runId: taskId, runKind: 'run-blocked' }) } };
    await worker.dispatch('push', push);
    expect(worker.fetch).toHaveBeenCalledTimes(2);
    expect(worker.showNotification).toHaveBeenCalledOnce();

    const unauthorized = startWorker({ status: 404 });
    await unauthorized.dispatch('push', push);
    expect(unauthorized.fetch).toHaveBeenCalledOnce();
    expect(unauthorized.showNotification).not.toHaveBeenCalled();
  });
});

describe('notifications in an open tab', () => {
  it('extracts the linked conversation and consumes its URL parameter', () => {
    vi.stubGlobal('location', { href: `${origin}/?conversation=${conversationId}` });
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    expect(takeConversationFromNotification()).toBe(conversationId);
    expect(replaceState.mock.calls[0]?.[2].href).toBe(`${origin}/`);
  });

  it('displays the event only while hidden and does not manufacture a private title', async () => {
    const shown = vi.fn();
    const assign = vi.fn();
    const closed = vi.fn();
    let clicked: (() => void) | null = null;
    class FakeNotification {
      static permission = 'granted';
      constructor(title: string, options: NotificationOptions) { shown(title, options); }
      set onclick(listener: () => void) { clicked = listener; }
      close() { closed(); }
    }
    const document = { hidden: false };
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('window', { Notification: FakeNotification, focus: vi.fn(), location: { assign } });
    vi.stubGlobal('document', document);
    await showHiddenNotification(task);
    expect(shown).not.toHaveBeenCalled();

    document.hidden = true;
    await showHiddenNotification(task);
    expect(shown).toHaveBeenCalledWith('تحتاجك خطوة', expect.objectContaining({ body: undefined, tag: `mohassan-task-${taskId}` }));
    expect(clicked).toBeTypeOf('function');
    if (typeof clicked === 'function') (clicked as () => void)();
    expect(assign).toHaveBeenCalledWith(notificationConversationLink(conversationId));
    expect(closed).toHaveBeenCalledOnce();
  });

  it('rotates the browser subscription when the provider endpoint belongs to a different account', async () => {
    const old = { endpoint: 'https://push.example/old', toJSON: () => ({ keys: { p256dh: 'public', auth: 'auth' } }), unsubscribe: vi.fn(async () => true) };
    const fresh = { ...old, endpoint: 'https://push.example/new' };
    const create = vi.fn(async () => fresh);
    const registration = { pushManager: { getSubscription: async () => old, subscribe: create } };
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(), ready: Promise.resolve(registration) } });
    const local = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key), setItem: (key: string, value: string) => local.set(key, value) });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'PUSH_ENDPOINT_IN_USE' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ device: { id: 'device-id' } }));
    vi.stubGlobal('fetch', fetch);

    await subscribeThisBrowser('member', 'AQID', 'Browser');
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).endpoint).toBe(fresh.endpoint);
    expect(currentPushDevice('member')).toBe('device-id');
    expect(currentPushDevice('owner')).toBeNull();
  });

  it('does not unsubscribe another browser profile’s replacement endpoint when removing an old device', async () => {
    const unsubscribe = vi.fn();
    const subscription = { endpoint: 'https://push.example/replacement', unsubscribe };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ viewerId: 'owner', id: 'device-id', endpoint: 'https://push.example/old' }),
      removeItem: vi.fn(),
    });
    const fetch = vi.fn(async () => Response.json({ removed: true }));
    vi.stubGlobal('fetch', fetch);

    await unsubscribeDevice('owner', 'device-id');
    expect(fetch).toHaveBeenCalledWith('/api/notifications/devices/device-id', expect.objectContaining({ method: 'DELETE' }));
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('removes this browser’s owned subscription at sign-out with a bounded server request', async () => {
    const endpoint = 'https://push.example/current';
    const unsubscribe = vi.fn();
    const registration = { pushManager: { getSubscription: async () => ({ endpoint, unsubscribe }) } };
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ viewerId: 'owner', id: 'device-id', endpoint }),
      removeItem: vi.fn(),
    });
    const fetch = vi.fn(async () => Response.json({ removed: true }));
    vi.stubGlobal('fetch', fetch);

    await releaseThisBrowser('member');
    expect(fetch).not.toHaveBeenCalled();
    await releaseThisBrowser('owner');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/notifications/devices/device-id', expect.objectContaining({ method: 'DELETE', signal: expect.any(AbortSignal) }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
