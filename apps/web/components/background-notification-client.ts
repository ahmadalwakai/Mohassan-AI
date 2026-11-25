import type { NotificationClaimResponse, NotificationPayload } from '@mohassan/contracts';

export const backgroundNoticeEvent = 'mohassan-background-notice';
export const backgroundViewerEvent = 'mohassan-background-viewer';

export interface OpenBackgroundNotice {
  viewerId: string;
  notification: NotificationPayload;
}

export function announceBackgroundViewer(viewerId?: string): void {
  window.dispatchEvent(new CustomEvent(backgroundViewerEvent, { detail: viewerId }));
}

export async function claimOpenBackgroundNotifications(
  pending: NotificationPayload[],
  viewerId: string,
  signal: AbortSignal,
  claim: (taskId: string) => Promise<NotificationClaimResponse>,
): Promise<void> {
  for (const { taskId, runKind } of pending) {
    if (signal.aborted) return;
    if (!runKind) continue;
    const { notification } = await claim(taskId);
    if (signal.aborted) return;
    if (notification?.runKind) {
      window.dispatchEvent(new CustomEvent<OpenBackgroundNotice>(backgroundNoticeEvent, { detail: { viewerId, notification } }));
    }
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
