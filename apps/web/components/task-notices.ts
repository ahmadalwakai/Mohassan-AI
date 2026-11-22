/**
 * System notifications for background tasks (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §6.3).
 *
 * Three kinds only, and only while the tab is hidden: the task finished, a step needs the user, or the task
 * failed. One notification per task at most; «تحتاجك» wins over the others. Permission is never asked on page
 * load: the app offers it once, from a click, after a background task has run longer than NOTICE_AFTER_MS.
 * Everything here is a per-viewer convenience; a browser without the API simply shows nothing.
 */
export type NoticeKind = 'done' | 'needs_you' | 'failed';
/** Proposed in the plan (§6.1, level 2); the owner fixes it after the Phase 1 measurement. */
export const NOTICE_AFTER_MS = 20_000;
const OFFER_KEY = 'mohassan-notices-offer';
const TITLES: Record<NoticeKind, string> = { done: 'اكتملت المهمة', needs_you: 'تحتاجك خطوة', failed: 'تعذّر الإكمال' };

export function noticesSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function noticePermission(): NotificationPermission | 'unsupported' {
  return noticesSupported() ? Notification.permission : 'unsupported';
}

/** True while the offer has neither been accepted nor declined by the viewer. */
export function noticeOfferOpen(): boolean {
  if (!noticesSupported() || Notification.permission !== 'default') return false;
  try { return localStorage.getItem(OFFER_KEY) !== 'declined'; } catch { return true; }
}

export function declineNoticeOffer(): void {
  try { localStorage.setItem(OFFER_KEY, 'declined'); } catch { /* Convenience only. */ }
}

/** Must run from a user gesture: browsers ignore or silently block the prompt otherwise. */
export async function requestNoticePermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!noticesSupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/** Shows one notification when the tab is hidden and permission was granted. Returns whether it was shown. */
export function showTaskNotice(kind: NoticeKind, body: string, onOpen: () => void): boolean {
  if (!noticesSupported() || Notification.permission !== 'granted' || !document.hidden) return false;
  try {
    const notice = new Notification(TITLES[kind], { body: body.slice(0, 160), tag: `mohassan-task-${kind}-${body.slice(0, 40)}`, lang: 'ar', dir: 'rtl' });
    notice.onclick = () => { try { window.focus(); } catch { /* Some browsers refuse. */ } onOpen(); notice.close(); };
    return true;
  } catch { return false; }
}

/** The kind a conversation status maps to, or null while it is still working. */
export function noticeKindFor(status: string): NoticeKind | null {
  if (status === 'waiting_input' || status === 'waiting_approval' || status === 'waiting_user') return 'needs_you';
  if (status === 'failed') return 'failed';
  if (status === 'idle') return 'done';
  return null;
}
