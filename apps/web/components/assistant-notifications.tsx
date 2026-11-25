"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { takeConversationFromNotification, type NotificationControls } from './notification-client';
import { NotificationOffer, NotificationSettings } from './notification-settings';
import chatStyles from './assistant-app.module.css';

export { NOTIFICATION_AFTER_MS as NOTICE_AFTER_MS } from '@mohassan/contracts';
export type { NotificationControls } from './notification-client';

type LegacyNotices = typeof import('./task-notices');

// History summaries are still used for the unread badge. Only server-claimed events can notify or offer permission.
export const noticeOfferOpen: LegacyNotices['noticeOfferOpen'] = () => false;
export const declineNoticeOffer: LegacyNotices['declineNoticeOffer'] = () => {};
export const requestNoticePermission: LegacyNotices['requestNoticePermission'] = async () => 'unsupported';
export const noticeKindFor: LegacyNotices['noticeKindFor'] = () => null;
export const showTaskNotice: LegacyNotices['showTaskNotice'] = () => false;

export function AssistantNotifications({ controls, menuOpen, historyReady, selectConversation }: {
  controls: NotificationControls;
  menuOpen: boolean;
  historyReady: boolean;
  selectConversation: (id: string) => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (historyReady) {
      const linked = takeConversationFromNotification();
      if (linked) selectConversation(linked);
    }
  }, [historyReady, selectConversation]);

  // The account menu exists only while open. Scope the settings portal to this assistant.
  useEffect(() => {
    const app = anchor.current?.closest(`.${chatStyles.app}`);
    setMenu(menuOpen ? app?.querySelector<HTMLElement>(`.${chatStyles.menu}`) ?? null : null);
  }, [menuOpen]);

  return <>
    <span ref={anchor} hidden />
    <NotificationOffer controls={controls} />
    {menuOpen && menu && controls.viewerId ? createPortal(<NotificationSettings viewerId={controls.viewerId} />, menu) : null}
  </>;
}
