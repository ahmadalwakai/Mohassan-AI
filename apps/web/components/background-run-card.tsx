'use client';

import { useEffect, useState } from 'react';
import { Clock, Square } from 'lucide-react';
import type { ChatConversation } from '@mohassan/contracts';
import chatStyles from './assistant-app.module.css';
import styles from './background-run-card.module.css';

export function BackgroundRunCard({ run, busy, onStop }: {
  run: NonNullable<ChatConversation['backgroundRun']>;
  busy: boolean;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const english = run.language === 'en';
  const seconds = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 1_000));
  const elapsed = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  const heading = english ? 'Background task' : 'مهمة في الخلفية';
  const elapsedLabel = english ? 'Elapsed time' : 'الوقت المنقضي';
  return <section className={styles.card} data-testid="background-run" aria-label={heading} dir={english ? 'ltr' : 'rtl'} lang={english ? 'en' : 'ar'}>
    <div className={styles.info}>
      <div className={styles.heading}>
        <strong>{heading}</strong>
        <span className={styles.time} title={elapsedLabel}><Clock size={13} aria-hidden="true" /><time dateTime={`PT${seconds}S`} aria-label={`${elapsedLabel} ${elapsed}`} dir="ltr">{elapsed}</time></span>
      </div>
      <p dir="auto" className={styles.task}>{run.task}</p>
      <p dir="auto" className={styles.step} role="status">{run.step}</p>
    </div>
    <button type="button" className={chatStyles.secondary} disabled={busy} onClick={onStop}><Square size={12} fill="currentColor" aria-hidden="true" />{english ? 'Stop task' : 'إيقاف المهمة'}</button>
  </section>;
}
