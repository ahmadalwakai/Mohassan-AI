"use client";

import { useEffect, useState } from 'react';
import type {
  NotificationClaimResponse,
  NotificationKind,
  NotificationPayload,
  NotificationSettingsResponse,
  NotificationSyncRequest,
  NotificationSyncResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushUnsubscribeResponse,
} from '@mohassan/contracts';
import { declineNoticeOffer, noticeOfferOpen, noticePermission, requestNoticePermission } from './task-notices';

const titles: Record<NotificationKind, string> = {
  task_completed: 'اكتملت المهمة',
  needs_you: 'تحتاجك خطوة',
  task_failed: 'تعذّر الإكمال',
};
const conversationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const syncPath = '/api/notifications/sync';
const pollMs = 10_000;
let offerHandled = false;

export function conversationFromNotification(url: URL): string | null {
  const id = url.searchParams.get('conversation');
  return id && conversationIdPattern.test(id) ? id : null;
}

function takeConversationFromNotification(): string | null {
  const url = new URL(location.href);
  const id = conversationFromNotification(url);
  if (id) {
    url.searchParams.delete('conversation');
    history.replaceState(history.state, '', url);
  }
  return id;
}

export function restoreNotificationConversation(
  recent: { id: string }[], saved: string | null, select: (id: string) => void,
): void {
  const linked = takeConversationFromNotification();
  if (linked) select(linked);
  else if (saved && recent.some(conversation => conversation.id === saved)) select(saved);
}

export function notificationConversationLink(conversationId: string | null): string {
  return conversationId && conversationIdPattern.test(conversationId) ? `/?conversation=${conversationId}` : '/';
}

class NotificationRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export async function notificationRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new NotificationRequestError(body?.error?.message ?? 'تعذّر إتمام الطلب. حاول مجددًا.', body?.error?.code);
  return body as T;
}

export const notificationPost = <T>(path: string, value: object, signal?: AbortSignal) =>
  notificationRequest<T>(path, { method: 'POST', body: JSON.stringify(value), signal });

export function browserPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

export function browserDeviceLabel(): string {
  const agent = navigator.userAgent;
  if (agent.includes('Edg/')) return 'Microsoft Edge';
  if (agent.includes('Firefox/')) return 'Firefox';
  if (agent.includes('Chrome/')) return 'Chrome';
  if (agent.includes('Safari/')) return 'Safari';
  return 'هذا المتصفح';
}

const deviceKey = 'mohassan-notification-device-v1';

interface BrowserDevice { viewerId: string; id: string; endpoint: string }

function browserDevice(viewerId: string): BrowserDevice | null {
  try {
    const value: Partial<BrowserDevice> | null = JSON.parse(localStorage.getItem(deviceKey) ?? 'null');
    return value?.viewerId === viewerId && typeof value.id === 'string' && typeof value.endpoint === 'string'
      ? { viewerId, id: value.id, endpoint: value.endpoint } : null;
  } catch { return null; }
}

export function currentPushDevice(viewerId: string): string | null {
  return browserDevice(viewerId)?.id ?? null;
}

async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/notifications-sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

function decodePublicKey(key: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - key.length % 4) % 4);
  const value = atob((key + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(value, character => character.charCodeAt(0));
}

async function saveSubscription(subscription: PushSubscription, label: string): Promise<PushSubscribeResponse> {
  const { keys } = subscription.toJSON();
  if (!keys?.p256dh || !keys.auth) throw new Error('تعذّر الحصول على مفاتيح هذا الجهاز.');
  const request: PushSubscribeRequest = { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label };
  return notificationPost('/api/notifications/subscribe', request);
}

export async function subscribeThisBrowser(viewerId: string, publicKey: string, label = browserDeviceLabel()): Promise<PushSubscribeResponse> {
  const { pushManager } = await workerRegistration();
  const create = () => pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodePublicKey(publicKey) });
  const existing = await pushManager.getSubscription();
  let subscription = existing ?? await create();
  let saved: PushSubscribeResponse;
  try { saved = await saveSubscription(subscription, label); }
  catch (error) {
    if (!existing || !(error instanceof NotificationRequestError) || error.code !== 'PUSH_ENDPOINT_IN_USE') throw error;
    await existing.unsubscribe();
    subscription = await create();
    saved = await saveSubscription(subscription, label);
  }
  const device: BrowserDevice = { viewerId, id: saved.device.id, endpoint: subscription.endpoint };
  try { localStorage.setItem(deviceKey, JSON.stringify(device)); } catch { /* The server still keeps the device. */ }
  return saved;
}

export async function unsubscribeDevice(viewerId: string, id: string, signal?: AbortSignal): Promise<PushUnsubscribeResponse> {
  const result = await notificationRequest<PushUnsubscribeResponse>(`/api/notifications/devices/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  const device = browserDevice(viewerId);
  if (device?.id !== id) return result;

  try { localStorage.removeItem(deviceKey); } catch { /* The server already removed the device. */ }
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription?.endpoint === device.endpoint) await subscription.unsubscribe();
  } catch { /* The server can no longer send push to this device. */ }
  return result;
}

export async function releaseThisBrowser(viewerId?: string): Promise<void> {
  if (!viewerId) return;
  const device = browserDevice(viewerId);
  if (!device) return;
  try { await unsubscribeDevice(viewerId, device.id, AbortSignal.timeout(1500)); }
  catch { /* Account authorization in the worker guards any later push. */ }
}

export async function showHiddenNotification(payload: NotificationPayload): Promise<void> {
  if (!document.hidden || noticePermission() !== 'granted') return;
  const options: NotificationOptions = {
    body: payload.conversationTitle,
    tag: `mohassan-task-${payload.taskId}`,
    data: { conversationId: payload.conversationId },
    dir: 'rtl',
    lang: 'ar',
  };
  try {
    const notification = new Notification(titles[payload.kind], options);
    notification.onclick = () => {
      try { window.focus(); } catch { /* The browser controls window focus. */ }
      window.location.assign(notificationConversationLink(payload.conversationId));
      notification.close();
    };
  } catch (error) {
    if (!('serviceWorker' in navigator)) throw error;
    const registration = await workerRegistration();
    if (document.hidden) await registration.showNotification(titles[payload.kind], options);
  }
}

export interface NotificationControls {
  viewerId: string | undefined;
  offer: boolean;
  enable: () => void;
  dismiss: () => void;
}

export function useTaskNotifications(viewerId?: string): NotificationControls {
  const [offerViewer, setOfferViewer] = useState<string | null>(null);
  const offer = !!viewerId && offerViewer === viewerId && !offerHandled;

  useEffect(() => {
    if (!viewerId || !globalThis.crypto?.randomUUID) return;
    const activeViewer = viewerId;
    let tabId = crypto.randomUUID();
    let controller = new AbortController();
    let timer: number | undefined;
    let syncing = false;
    let rerun = false;
    let pageClosed = false;

    function close() {
      if (pageClosed) return;
      pageClosed = true;
      controller.abort();
      window.clearTimeout(timer);
      const body: NotificationSyncRequest = { tabId, state: 'closed' };
      void fetch(syncPath, {
        method: 'POST', body: JSON.stringify(body), credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {});
    }

    async function sync() {
      if (pageClosed || controller.signal.aborted) return;
      if (syncing) { rerun = true; return; }
      syncing = true;
      window.clearTimeout(timer);
      try {
        const state = document.hidden ? 'hidden' : 'visible';
        const body: NotificationSyncRequest = { tabId, state };
        const signal = controller.signal;
        const result = await notificationPost<NotificationSyncResponse>(syncPath, body, signal);
        if (signal.aborted || pageClosed) return;
        if (result.backgroundTask && !offerHandled && noticeOfferOpen()) setOfferViewer(activeViewer);
        if (!document.hidden || noticePermission() !== 'granted') return;
        for (const { taskId } of result.pending) {
          if (!document.hidden || pageClosed || signal.aborted) break;
          const { notification } = await notificationPost<NotificationClaimResponse>(
            `/api/notifications/events/${encodeURIComponent(taskId)}/claim`, { tabId: body.tabId }, signal,
          );
          if (notification && !signal.aborted) await showHiddenNotification(notification);
        }
      } catch { /* A transient notification failure should leave chat usable. */ }
      finally {
        syncing = false;
        if (!pageClosed && !controller.signal.aborted) timer = window.setTimeout(sync, rerun ? 0 : pollMs);
        rerun = false;
      }
    }

    const refresh = () => { void sync(); };
    const reopen = () => {
      if (!pageClosed) return;
      pageClosed = false;
      tabId = crypto.randomUUID();
      controller = new AbortController();
      refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', reopen);
    return () => {
      close();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', reopen);
    };
  }, [viewerId]);

  const dismiss = () => {
    offerHandled = true;
    declineNoticeOffer();
    setOfferViewer(null);
  };

  function enable() {
    if (!offer || !viewerId) return;
    const available = noticeOfferOpen();
    dismiss();
    if (!available) return;
    void requestNoticePermission().then(async permission => {
      if (permission !== 'granted' || !browserPushSupported()) return;
      const { publicKey } = await notificationRequest<NotificationSettingsResponse>('/api/notifications/settings');
      if (publicKey) await subscribeThisBrowser(viewerId, publicKey);
    }).catch(() => { /* The device can be activated again in settings. */ });
  }

  return { viewerId, offer, dismiss, enable };
}
