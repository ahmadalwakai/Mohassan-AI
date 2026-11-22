'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Spinner } from '@chakra-ui/react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { SkillRemoteStartResultSchema, SkillRemoteStatusSchema, type SkillRemoteStatus } from '@mohassan/contracts';
import { SkillApiError, skillDate, skillErrorText, skillPost, skillRequest } from './skill-client';
import shared from './skill-library.module.css';
import styles from './skill-remote-panel.module.css';

const POLL_MS = 2000;
const verdicts: Record<string, string> = { pass: 'اجتاز الفحص', review: 'يحتاج مراجعة الملاحظات', fail: 'لم يجتز الفحص', incompatible: 'غير متوافق' };

/** The GitHub skills source: read-only status plus one owner action, «مزامنة الآن». Activation decisions stay in the skill detail. */
export function SkillRemotePanel({ offline, engineEnabled, onOpenSkill, onChanged }: { offline: boolean; engineEnabled: boolean; onOpenSkill(id: string): void; onChanged(): void }) {
  const [status, setStatus] = useState<SkillRemoteStatus | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const latest = useRef(0), abort = useRef<AbortController | null>(null), inFlight = useRef(false), wasRunning = useRef(false);

  const read = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    const sequence = ++latest.current;
    try {
      const value = await skillRequest('/api/skills/remote', SkillRemoteStatusSchema, { signal: controller.signal });
      if (controller.signal.aborted || sequence !== latest.current) return;
      setStatus(value); setError('');
    } catch (caught) {
      if (controller.signal.aborted || sequence !== latest.current) return;
      setError(skillErrorText(caught));
    }
  }, []);

  // First read, and again whenever the connection comes back.
  useEffect(() => {
    if (offline) { abort.current?.abort(); return; }
    let cancelled = false;
    setLoading(true);
    void read().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; abort.current?.abort(); };
  }, [offline, read]);

  // A setTimeout chain while a run is in flight: each answer arms the next poll; stops when the run ends, offline, or unmount.
  useEffect(() => {
    if (offline || !status?.running) return;
    const handle = setTimeout(() => { void read(); }, POLL_MS);
    return () => clearTimeout(handle);
  }, [offline, status, read]);

  // When a run that was running finishes with visible results, let the library refresh its list once.
  useEffect(() => {
    if (!status) return;
    if (status.running) { wasRunning.current = true; return; }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    const counts = status.last?.counts;
    if (counts && counts.activated + counts.pendingReview + counts.rejected > 0) onChanged();
  }, [status, onChanged]);

  const start = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setError('');
    try { await skillPost('/api/skills/remote/sync', {}, SkillRemoteStartResultSchema); }
    catch (caught) {
      // Someone (the scheduler, another tab) already started one: just follow it.
      if (!(caught instanceof SkillApiError && caught.code === 'SKILL_REMOTE_SYNC_RUNNING')) { setError(skillErrorText(caught)); inFlight.current = false; return; }
    }
    inFlight.current = false;
    await read();
  }, [read]);

  const engineOff = !engineEnabled || status?.engineEnabled === false;
  const last = status?.last ?? null, finished = last && last.status !== 'running' ? last : null;
  const itemErrors = finished?.items.filter(item => item.outcome === 'error') ?? [];
  const quota = status?.quota, nearQuota = Boolean(quota && quota.limit > 0 && quota.used / quota.limit >= 0.9);
  const canSync = Boolean(status?.configured) && !offline && !engineOff && !status?.running && !loading;

  return <div className={styles.block} aria-label="مصدر GitHub">
    {loading && !status ? <p role="status" className={shared.hint}><Spinner size="sm"/> جارٍ قراءة حالة المصدر…</p> : null}
    {error && !status ? <p role="alert" className={shared.error}>{error}</p> : null}
    {status && !status.configured ? (status.problem
      ? <p role="alert" className={shared.error}>إعداد مصدر GitHub غير صالح؛ راجع قيم SKILL_REMOTE في ملف .env.</p>
      : <p className={shared.hint}>لم يُضبط مستودع مهارات. أضف SKILL_REMOTE_REPO إلى ملف .env ثم أعد تشغيل الخدمة.</p>) : null}
    {status?.configured ? <>
      <p className={styles.header}><GitBranch size={15} aria-hidden="true"/><bdi dir="ltr"><code>{status.repo}@{status.ref}:{status.path}</code></bdi><Badge colorPalette={status.autoActivate ? 'green' : 'gray'}>{status.autoActivate ? 'التفعيل التلقائي: مفعّل' : 'التفعيل التلقائي: متوقف'}</Badge></p>
      {engineOff ? <p className={shared.warning}>محرك المهارات غير مفعّل؛ المزامنة متوقفة.</p> : null}
      <div className={styles.status} aria-busy={status.running || undefined}>
        {status.running ? <p role="status"><Spinner size="sm"/> جارٍ جلب المهارات من GitHub…</p> : null}
        {status.lastSuccess ? <p>آخر مزامنة ناجحة: {skillDate(status.lastSuccess.finishedAt)} · <code dir="ltr">{status.lastSuccess.commit.slice(0, 7)}</code></p> : <p>لم تُجرَ مزامنة بعد.</p>}
        {finished ? <p className={shared.hint}>مفعّلة تلقائيًا {finished.counts.activated} · بانتظار مراجعتك {finished.counts.pendingReview} · مرفوضة {finished.counts.rejected} · أخطاء {finished.counts.errors}</p> : null}
        {finished?.status === 'failed' ? <p role="alert" className={shared.error}>فشلت آخر مزامنة ({finished.errorCode ?? 'SKILL_REMOTE_SYNC_FAILED'}). المهارات المفعّلة سابقًا ما زالت تعمل.</p> : null}
        {itemErrors.length ? <ul className={`${shared.warning} ${styles.errors}`}>{itemErrors.map(item => <li key={item.slug}><bdi>{item.slug}</bdi>: {item.message ?? 'تعذر استيراد هذه المهارة.'} ({item.code ?? 'SKILL_REMOTE_ITEM_FAILED'})</li>)}</ul> : null}
        {status.nextSyncAt && !status.running ? <p className={shared.hint}>المزامنة التالية المقدّرة: {skillDate(status.nextSyncAt)}</p> : null}
      </div>
      {status.pending.length ? <section aria-label="بانتظار مراجعتك"><h4>بانتظار مراجعتك</h4><div className={styles.rows}>{status.pending.map(item => <div className={styles.row} key={item.id}><span><bdi>{item.name}</bdi> · {item.version} · {item.verdict ? verdicts[item.verdict] ?? item.verdict : 'بلا فحص محفوظ'}</span><Button size="sm" variant="outline" onClick={() => onOpenSkill(item.id)} aria-label={`مراجعة ${item.name}`}>مراجعة</Button></div>)}</div></section> : null}
      {finished?.orphans.length ? <section aria-label="حُذفت من المستودع"><p className={shared.warning}>حُذفت من المستودع وما زالت مفعّلة هنا</p><div className={styles.rows}>{finished.orphans.map(item => <div className={styles.row} key={item.versionId}><span><bdi>{item.slug}</bdi></span><Button size="sm" variant="outline" onClick={() => onOpenSkill(item.versionId)} aria-label={`فتح ${item.slug}`}>فتح</Button></div>)}</div></section> : null}
      {quota ? <p className={nearQuota ? shared.warning : shared.hint}>الإصدارات المستوردة: {quota.used}/{quota.limit}{nearQuota ? ' · اقترب الحد الأقصى؛ لا يوجد حذف للإصدارات القديمة.' : ''}</p> : null}
      {error ? <p role="alert" className={shared.error}>{error}</p> : null}
    </> : null}
    <div className={shared.actions}><Button disabled={!canSync} onClick={() => void start()}><RefreshCw size={15}/>مزامنة الآن</Button></div>
  </div>;
}
