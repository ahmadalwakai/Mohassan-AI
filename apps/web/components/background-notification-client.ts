import type { NotificationClaimResponse, NotificationPayload } from '@mohassan/contracts';

export const backgroundNoticeEvent = 'mohassan-background-notice';
export const backgroundViewerEvent = 'mohassan-background-viewer';
// The service worker uses the same receipts when a tab closes during delivery.
const backgroundPushReceipts = 'mohassan-background-push-v1';

export interface OpenBackgroundNotice {
  viewerId: string;
  notification: NotificationPayload;
}

export function announceBackgroundViewer(viewerId?: string): void {
  window.dispatchEvent(new CustomEvent(backgroundViewerEvent, { detail: viewerId }));
}

interface OpenBackgroundClaim {
  viewerId: string;
  tabId: string;
  signal: AbortSignal;
  request: (path: string, init: RequestInit) => Promise<NotificationClaimResponse>;
}

async function rememberNotice(receipts: Cache, key: string) {
  await receipts.put(key, new Response(null, { status: 204 }));
  const entries = await receipts.keys();
  await Promise.all(entries.slice(0, Math.max(0, entries.length - 512)).map(entry => receipts.delete(entry)));
}

export async function claimOpenBackgroundNotifications(
  pending: NotificationPayload[],
  { viewerId, tabId, signal, request }: OpenBackgroundClaim,
): Promise<void> {
  if (!pending.some(event => event.runKind)) return;
  const receipts = await window.caches?.open(backgroundPushReceipts).catch(() => null);
  for (const { taskId, runKind } of pending) {
    if (signal.aborted) return;
    if (!runKind) continue;
    const eventPath = `/api/notifications/events/${encodeURIComponent(taskId)}`;
    const claimPath = `${eventPath}/claim`;
    const { notification } = await request(claimPath, { method: 'POST', body: JSON.stringify({ tabId }), signal });
    if (signal.aborted) return;
    if (!notification?.runKind) continue;
    const key = new URL(eventPath, window.location.origin).href;
    const seen = await receipts?.match(key).catch(() => null);
    if (signal.aborted) return;
    if (!seen) {
      const delivery = new CustomEvent<OpenBackgroundNotice>(backgroundNoticeEvent, { cancelable: true, detail: { viewerId, notification } });
      // A mounted banner confirms that it accepted the notice by canceling this event.
      if (window.dispatchEvent(delivery)) continue;
      if (receipts) await rememberNotice(receipts, key).catch(() => {});
    }
    await request(claimPath, { method: 'POST', body: JSON.stringify({ tabId, acknowledge: true }), keepalive: true }).catch(() => {});
  }
}

export function completionSoundEnabled(setting?: boolean): boolean {
  return setting !== false;
}

export function shouldPlayCompletionSound(notification: NotificationPayload): boolean {
  return notification.runKind === 'run-completed' && completionSoundEnabled(notification.sound);
}

export function listenForCompletionChime(target: Document) {
  const gestures = ['pointerdown', 'pointerup', 'keydown'] as const;
  let context: AudioContext | undefined;
  let resumed: Promise<void> | undefined;
  let clip: Promise<AudioBuffer> | undefined;

  function unlock(event: Event) {
    if (!event.isTrusted || target.defaultView?.navigator.userActivation?.isActive === false) return;
    if (event.type === 'pointerdown' && (event as PointerEvent).pointerType !== 'mouse') return;
    if (event.type === 'pointerup' && (event as PointerEvent).pointerType === 'mouse') return;
    if (event.type === 'keydown' && (event as KeyboardEvent).key === 'Escape') return;
    if (context?.state === 'running') return;
    try {
      context ??= new AudioContext();
      // Resume during the gesture itself, including on browsers without sticky media activation.
      resumed = context.resume().catch(() => {});
    } catch { /* Audio is optional on browsers without Web Audio. */ }
  }

  for (const gesture of gestures) target.addEventListener(gesture, unlock, true);
  return {
    async play(enabled: boolean): Promise<void> {
      const audio = context;
      if (!enabled || !audio) return;
      await resumed;
      if (context !== audio || audio.state !== 'running') return;
      try {
        clip ??= fetch('/mohassan-done.wav').then(async response => {
          if (!response.ok) throw new Error('Completion chime unavailable');
          return audio.decodeAudioData(await response.arrayBuffer());
        });
        const buffer = await clip;
        if (context !== audio || audio.state !== 'running') return;
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(audio.destination);
        source.start();
      } catch { clip = undefined; }
    },
    dispose() {
      for (const gesture of gestures) target.removeEventListener(gesture, unlock, true);
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      context = undefined;
    },
  };
}
