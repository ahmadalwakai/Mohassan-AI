"use client";

import { useRef, useState, type FormEvent } from 'react';
import { Bell, X } from 'lucide-react';
import {
  NotificationPreferencesSchema,
  type NotificationPreferences,
  type NotificationQuietHours,
  type NotificationSettingsResponse,
  type PushTestResponse,
  type PushUnsubscribeResponse,
} from '@mohassan/contracts';
import {
  browserPushSupported, currentPushDevice, notificationPost, notificationRequest,
  subscribeThisBrowser, unsubscribeDevice, type NotificationControls,
} from './notification-client';
import { noticePermission } from './task-notices';
import { BackgroundNotificationPreferences } from './background-notification-preferences';
import chatStyles from './assistant-app.module.css';
import styles from './notification-settings.module.css';

const path = '/api/notifications/settings';

function homeQuietHours(): NotificationQuietHours {
  return { start: '22:00', end: '07:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
}

const dateLabel = (value: string) => new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function NotificationOffer({ controls }: { controls: NotificationControls }) {
  if (!controls.offer) return null;
  return <div className={chatStyles.noticeBar} role="status" data-testid="notice-offer">
    <span>استغرقت مهمة في الخلفية 20 ثانية أو أكثر. هل تريد تلقي إشعارات المهام أثناء غيابك؟</span>
    <button type="button" className={chatStyles.primary} onClick={controls.enable}>تفعيل الإشعارات</button>
    <button type="button" className={chatStyles.secondary} onClick={controls.dismiss}>ليس الآن</button>
  </div>;
}

export function NotificationSettings({ viewerId }: { viewerId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<NotificationSettingsResponse | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences>({ quietHours: null, hideTitle: false });
  const [permission, setPermission] = useState<ReturnType<typeof noticePermission>>('default');
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'تعذّر الاتصال. حاول مجددًا.'); }
    finally { setBusy(false); }
  }

  async function reload() {
    const next = await notificationRequest<NotificationSettingsResponse>(path);
    setSettings(next);
    setCurrentDevice(currentPushDevice(viewerId));
    return next;
  }

  function open() {
    setPermission(noticePermission());
    dialog.current?.showModal();
    void run(async () => { setPreferences((await reload()).preferences); });
  }

  function updateHours(values: Partial<NotificationQuietHours>) {
    setPreferences(current => ({ ...current, quietHours: current.quietHours && { ...current.quietHours, ...values } }));
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const parsed = NotificationPreferencesSchema.safeParse(preferences);
    if (!parsed.success) { setError('أدخل وقت بدء ووقت انتهاء ومنطقة زمنية صالحة مثل Europe/London.'); return; }
    void run(async () => {
      await notificationPost(path, parsed.data);
      setSettings(current => current && { ...current, preferences: parsed.data });
      setStatus('حُفظت إعدادات الإشعارات.');
    });
  }

  function enableDevice() {
    if (!settings?.publicKey) return;
    const key = settings.publicKey;
    void run(async () => {
      await subscribeThisBrowser(viewerId, key);
      await reload();
      setStatus('فُعّلت إشعارات هذا الجهاز.');
    });
  }

  function removeDevice(id: string) {
    void run(async () => {
      await unsubscribeDevice(viewerId, id);
      await reload();
      setStatus('أُزيل الجهاز.');
    });
  }

  function removeIosDevice(id: string) {
    void run(async () => {
      const result = await notificationRequest<PushUnsubscribeResponse>(
        `/api/push/devices/registrations/${encodeURIComponent(id)}`, { method: 'DELETE' },
      );
      await reload();
      setStatus(result.removed ? 'أُزيل جهاز الآيفون.' : 'لم يعد جهاز الآيفون مسجّلًا.');
    });
  }

  function sendTest() {
    void run(async () => {
      const result = await notificationPost<PushTestResponse>('/api/notifications/test', {});
      await reload();
      setStatus(result.delivered ? 'أُرسل إشعار الاختبار.' : 'لم يصل إشعار الاختبار إلى أي جهاز.');
    });
  }

  const hours = preferences.quietHours;
  const iosDevices = settings?.iosDevices ?? [];
  const thisDeviceEnabled = !!currentDevice && settings?.devices.some(device => device.id === currentDevice);
  const canEnableDevice = permission === 'granted' && !!settings?.publicKey && browserPushSupported() && !thisDeviceEnabled;

  return <>
    <button type="button" onClick={open}><Bell size={15} />الإشعارات</button>
    <dialog ref={dialog} className={styles.panel} aria-labelledby="notification-settings-title" dir="rtl">
      <header className={styles.header}>
        <h2 id="notification-settings-title">الإشعارات</h2>
        <button type="button" className={styles.close} onClick={() => dialog.current?.close()} aria-label="إغلاق إعدادات الإشعارات" autoFocus><X size={19} /></button>
      </header>
      {permission === 'denied' ? <p className={styles.hint}>الإشعارات محظورة لهذا الموقع. يمكنك السماح بها من إعدادات المتصفح.</p> : null}
      {permission === 'unsupported' ? <p className={styles.hint}>إشعارات النظام غير متاحة في هذا المتصفح.</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {status ? <p className={styles.hint} role="status">{status}</p> : null}
      {!settings && busy ? <p className={styles.hint} role="status">جارٍ تحميل الإعدادات…</p> : null}
      {settings ? <>
        <form onSubmit={save} className={styles.section}>
          <fieldset disabled={busy}>
            <legend>ساعات الهدوء</legend>
            <label className={styles.check}><input type="checkbox" checked={hours !== null} onChange={event => setPreferences({ ...preferences, quietHours: event.target.checked ? homeQuietHours() : null })} />إيقاف الإشعارات خلال ساعات الهدوء</label>
            {hours ? <div className={styles.hours}>
              <label>من<input type="time" required value={hours.start} onChange={event => updateHours({ start: event.target.value })} /></label>
              <label>إلى<input type="time" required value={hours.end} onChange={event => updateHours({ end: event.target.value })} /></label>
              <label className={styles.zone}>المنطقة الزمنية<input dir="ltr" required maxLength={100} placeholder="Asia/Riyadh" value={hours.timeZone} onChange={event => updateHours({ timeZone: event.target.value })} /></label>
            </div> : null}
          </fieldset>
          <fieldset disabled={busy}>
            <legend>الخصوصية</legend>
            <label className={styles.check}><input type="checkbox" checked={preferences.hideTitle} onChange={event => setPreferences({ ...preferences, hideTitle: event.target.checked })} />إخفاء عنوان المحادثة من الإشعارات</label>
            <BackgroundNotificationPreferences preferences={preferences} onChange={setPreferences} />
          </fieldset>
          <button type="submit" className={styles.action} disabled={busy}>حفظ الإعدادات</button>
        </form>
        <section className={styles.section} aria-labelledby="notification-devices-title">
          <h3 id="notification-devices-title">المتصفحات</h3>
          {settings.devices.length ? <ul className={styles.devices}>
            {settings.devices.map(device => <li key={device.id}>
              <div>
                <strong><bdi>{device.label}</bdi>{currentDevice === device.id ? ' (هذا الجهاز)' : ''}</strong>
                <small>أُضيف في <time dateTime={device.createdAt}>{dateLabel(device.createdAt)}</time></small>
                {device.lastSuccessAt ? <small>آخر إرسال ناجح في <time dateTime={device.lastSuccessAt}>{dateLabel(device.lastSuccessAt)}</time></small> : null}
                {device.failureCount > 0 ? <small>محاولات الإرسال المتعثّرة {device.failureCount}</small> : null}
              </div>
              <button type="button" className={styles.action} disabled={busy} aria-label={`إزالة جهاز ${device.label}`} onClick={() => removeDevice(device.id)}>إزالة</button>
            </li>)}
          </ul> : <p className={styles.hint}>لا توجد متصفّحات مسجّلة.</p>}
          {!settings.publicKey ? <p className={styles.hint}>إشعارات المتصفّحات بعد الإغلاق غير مهيّأة على الخادم.</p> : null}
          <div className={styles.actions}>
            {canEnableDevice ? <button type="button" className={styles.action} disabled={busy} onClick={enableDevice}>تفعيل هذا الجهاز</button> : null}
            <button type="button" className={styles.action} disabled={busy || !settings.publicKey || !settings.devices.length} onClick={sendTest}>إرسال إشعار اختبار</button>
          </div>
        </section>
        <section className={styles.section} aria-labelledby="notification-ios-devices-title">
          <h3 id="notification-ios-devices-title">أجهزة آيفون</h3>
          {iosDevices.length ? <ul className={styles.devices} role="list">
            {iosDevices.map(device => <li key={device.id}>
              <div>
                <strong><bdi>{device.label}</bdi></strong>
                <small>سُجّل في <time dateTime={device.registeredAt}>{dateLabel(device.registeredAt)}</time></small>
                {device.lastDeliveryAt
                  ? <small>آخر إرسال ناجح في <time dateTime={device.lastDeliveryAt}>{dateLabel(device.lastDeliveryAt)}</time></small>
                  : <small>لم يُسجّل أي إرسال ناجح بعد.</small>}
              </div>
              <button type="button" className={styles.action} disabled={busy} aria-label={`إزالة جهاز ${device.label}`} onClick={() => removeIosDevice(device.id)}>إزالة</button>
            </li>)}
          </ul> : <p className={styles.hint}>لا توجد أجهزة آيفون مسجّلة.</p>}
        </section>
      </> : null}
    </dialog>
  </>;
}
