import type { NotificationPreferences } from '@mohassan/contracts';
import { completionSoundEnabled } from './background-notification-client';
import styles from './notification-settings.module.css';

export function BackgroundNotificationPreferences({ preferences, onChange }: {
  preferences: NotificationPreferences;
  onChange: (preferences: NotificationPreferences) => void;
}) {
  return <>
    <label className={styles.check}>
      <input type="checkbox" checked={completionSoundEnabled(preferences.completionSound)} onChange={event => onChange({ ...preferences, completionSound: event.target.checked })} />
      تشغيل صوت اكتمال مهمة الخلفية في هذه الصفحة
    </label>
    <label className={styles.check}>
      <input type="checkbox" checked={preferences.showResultPreview ?? false} onChange={event => onChange({ ...preferences, showResultPreview: event.target.checked })} />
      عرض السطر الأول من النتيجة في الإشعارات، بما فيها شاشة القفل
    </label>
  </>;
}
