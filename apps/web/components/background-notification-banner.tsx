'use client';

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { X } from 'lucide-react';
import type { NotificationPayload } from '@mohassan/contracts';
import {
  backgroundNoticeEvent, backgroundViewerEvent, listenForCompletionChime, shouldPlayCompletionSound,
  type OpenBackgroundNotice,
} from './background-notification-client';
import { notificationConversationLink } from './notification-client';
import styles from './background-notification-banner.module.css';

export function BackgroundNotificationBanner() {
  const [notices, setNotices] = useState<NotificationPayload[]>([]);

  useEffect(() => {
    const chime = listenForCompletionChime(document);
    const delivered = new Set<string>();
    let viewerId: string | undefined;

    function changeViewer(event: Event) {
      viewerId = (event as CustomEvent<string | undefined>).detail;
      delivered.clear();
      setNotices([]);
    }

    function notify(event: Event) {
      const { viewerId: recipient, notification } = (event as CustomEvent<OpenBackgroundNotice>).detail;
      if (recipient !== viewerId) return;
      event.preventDefault();
      if (delivered.has(notification.taskId)) return;
      delivered.add(notification.taskId);
      flushSync(() => setNotices(current => [...current, notification]));
      void chime.play(shouldPlayCompletionSound(notification));
    }

    window.addEventListener(backgroundViewerEvent, changeViewer);
    window.addEventListener(backgroundNoticeEvent, notify);
    return () => {
      window.removeEventListener(backgroundViewerEvent, changeViewer);
      window.removeEventListener(backgroundNoticeEvent, notify);
      chime.dispose();
    };
  }, []);

  return <div className={styles.stack}>
    {notices.map(notice => {
      const english = notice.language === 'en';
      const open = english ? 'Open conversation' : 'افتح المحادثة';
      const dismiss = english ? 'Dismiss notification' : 'إخفاء الإشعار';
      return <div className={styles.banner} key={notice.taskId} data-testid="background-notification" dir={english ? 'ltr' : 'rtl'} lang={english ? 'en' : 'ar'}>
        <div className={styles.copy} role="status">
          <strong>{notice.title}</strong>
          {notice.body ? <p dir="auto">{notice.body}</p> : null}
        </div>
        <a className={styles.open} href={notificationConversationLink(notice.conversationId)}>{open}</a>
        <button className={styles.dismiss} type="button" aria-label={dismiss} onClick={() => setNotices(current => current.filter(item => item.taskId !== notice.taskId))}><X size={16} /></button>
      </div>;
    })}
  </div>;
}
