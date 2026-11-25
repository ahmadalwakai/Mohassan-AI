'use client';

import { useEffect, useState } from 'react';
import type { FeedbackDecision, FeedbackItem, FeedbackMetrics, FeedbackPolicy, FeedbackQueue } from '@mohassan/contracts';
import styles from './review.module.css';

const DECISIONS: Record<FeedbackDecision, string> = { correct: 'صحيح', wrong: 'خطأ', unsure: 'غير متأكد' };
const VERDICTS: Record<FeedbackItem['verdict'], string> = { useful: 'مفيد', wrong: 'خطأ', incomplete: 'ناقص' };
const JUDGE_DECISIONS = { send: 'إرسال', fix: 'تصحيح', withhold: 'حجب' };
const DATE = new Intl.DateTimeFormat('ar', { dateStyle: 'medium' });
const NUMBER = new Intl.NumberFormat('ar');
const PERCENT = new Intl.NumberFormat('ar', { style: 'percent', maximumFractionDigits: 1 });

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/feedback${path}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.message ?? 'تعذر إتمام الطلب. حاول مجددًا.');
  return data;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'تعذر الاتصال. حاول مجددًا.';
}

function EvidenceUrl({ url }: { url: string }) {
  return <bdi dir="ltr">{/^https?:\/\//i.test(url)
    ? <a href={url} target="_blank" rel="noreferrer">{url}</a>
    : url}</bdi>;
}

function Metrics({ metrics }: { metrics: FeedbackMetrics }) {
  return <dl className={styles.metrics}>
    <div>
      <dt>نسبة تكرار الخطأ</dt>
      <dd>{metrics.repeatErrorRate === null ? '—' : PERCENT.format(metrics.repeatErrorRate)}</dd>
      <small>{metrics.answerOpportunities
        ? `${NUMBER.format(metrics.repeatedWrongAnswers)} تكرار من ${NUMBER.format(metrics.answerOpportunities)} إجابة لاحقة عن أسئلة أُبلغ عنها كخطأ`
        : 'لا توجد إجابات لاحقة لقياسها بعد.'}</small>
    </div>
    <div>
      <dt>حالات اختبار الانحدار</dt>
      <dd>{NUMBER.format(metrics.regressionSize)}</dd>
    </div>
  </dl>;
}

function ReviewItem({ item, isOwner, disabled, onReview, onClear, onTraining }: {
  item: FeedbackItem;
  isOwner: boolean;
  disabled: boolean;
  onReview: (decision: FeedbackDecision) => void;
  onClear: (policyId: string) => void;
  onTraining: (allowed: boolean) => void;
}) {
  return <article className={styles.item} aria-labelledby={`question-${item.id}`}>
    <header className={styles.itemHeading}>
      <h3 id={`question-${item.id}`} dir="auto">{item.question}</h3>
      <time dateTime={item.createdAt}>{DATE.format(new Date(item.createdAt))}</time>
    </header>
    <dl className={styles.details}>
      <dt>الرد</dt><dd dir="auto">{item.reply}</dd>
      <dt>تقييم المستخدم</dt><dd>{VERDICTS[item.verdict]}</dd>
      {item.note ? <><dt>كلمات المستخدم</dt><dd dir="auto">{item.note}</dd></> : null}
      <dt>مسار الإجابة</dt><dd dir="auto">{item.route ?? 'غير مسجّل'}</dd>
      <dt>قرار المقيّم</dt><dd>{item.judgeDecision ? JUDGE_DECISIONS[item.judgeDecision] : 'غير مسجّل'}</dd>
      <dt>قرار المراجعة</dt><dd>{item.decision ? DECISIONS[item.decision] : 'قيد المراجعة'}</dd>
      <dt>المصادر</dt>
      <dd>{item.evidenceUrls.length ? <ul className={styles.sources}>
        {item.evidenceUrls.map(url => <li key={url}><EvidenceUrl url={url} /></li>)}
      </ul> : 'لا توجد صفحات استند إليها الرد.'}</dd>
    </dl>
    {isOwner ? <div className={styles.effects}>
      <h4>الأثر على الإجابات</h4>
      {item.policies.length ? <ul className={styles.policies}>{item.policies.map(policy => <li key={policy.id}>
        <div>
          <strong>{policy.kind === 'block' ? 'حظر المصدر' : 'تفضيل المصدر'}</strong>
          <span> · {policy.scope === 'workspace' ? 'مساحة العمل' : 'لصاحب الملاحظة'}</span>
          <span> · {policy.active ? `حتى ${DATE.format(new Date(policy.expiresAt))}` : policy.clearedAt ? 'أُلغي' : 'انتهت الصلاحية'}</span>
          <div><EvidenceUrl url={policy.url} /></div>
        </div>
        {policy.active ? <button type="button" disabled={disabled} onClick={() => onClear(policy.id)}>
          {policy.kind === 'block' ? 'رفع الحظر' : 'إلغاء التفضيل'}
        </button> : null}
      </li>)}</ul> : <p>لا توجد قاعدة مصدر مرتبطة بهذه الملاحظة.</p>}
      {item.caseSha256 ? <div className={styles.case}>
        <p>بصمة حالة الاختبار <code dir="ltr">{item.caseSha256}</code></p>
        <p>{item.trainingAllowed ? 'هذه الحالة مسموحة للتدريب.' : 'هذه الحالة مخصصة للاختبار فقط.'}</p>
        <button type="button" disabled={disabled} onClick={() => onTraining(!item.trainingAllowed)}>
          {item.trainingAllowed ? 'إلغاء السماح بالتدريب' : 'السماح بالتدريب على هذه الحالة'}
        </button>
      </div> : null}
    </div> : null}
    {isOwner && !item.decision ? <fieldset className={styles.actions} disabled={disabled}>
      <legend>راجع الإجابة</legend>
      <button type="button" onClick={() => onReview('correct')}>صحيح</button>
      <button type="button" onClick={() => onReview('wrong')}>خطأ</button>
      <button type="button" onClick={() => onReview('unsure')}>غير متأكد</button>
    </fieldset> : null}
  </article>;
}

export function FeedbackReview() {
  const [data, setData] = useState<FeedbackQueue | null>(null);
  const [status, setStatus] = useState<'pending' | 'all' | null>(null);
  const [offsets, setOffsets] = useState([0]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reviewed, setReviewed] = useState<FeedbackItem | null>(null);
  const offset = offsets.at(-1) ?? 0;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ offset: String(offset) });
    if (status) query.set('status', status);
    setLoading(true);
    setError('');
    request<FeedbackQueue>(`?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(page => { if (!controller.signal.aborted) setData(page); })
      .catch(problem => { if (!controller.signal.aborted) setError(messageOf(problem)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, reload, status]);

  async function act(run: () => Promise<void>, confirmation: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
      setNotice(confirmation);
      setReload(revision => revision + 1);
    } catch (problem) {
      setError(messageOf(problem));
    } finally {
      setBusy(false);
    }
  }

  const isOwner = data?.role === 'owner';
  const filter = status ?? (isOwner ? 'pending' : 'all');
  const disabled = loading || busy;
  const card = (item: FeedbackItem) => <ReviewItem key={item.id} item={item} isOwner={isOwner} disabled={disabled}
    onReview={decision => { void act(async () => {
      setReviewed(await post<FeedbackItem>(`/${item.id}/review`, { decision }));
    }, 'حُفظ قرار المراجعة وأضيفت حالة الاختبار.'); }}
    onClear={policyId => { void act(async () => {
      const policy = await post<FeedbackPolicy>(`/policies/${policyId}/clear`, {});
      setReviewed(current => current ? { ...current, policies: current.policies.map(existing => existing.id === policy.id ? policy : existing) } : current);
    }, 'أُلغيت قاعدة المصدر.'); }}
    onTraining={allowed => { void act(async () => {
      const updated = await post<FeedbackItem>(`/${item.id}/training`, { allowed });
      setReviewed(current => current?.id === item.id ? updated : current);
    }, allowed ? 'سُمح باستخدام الحالة في التدريب.' : 'أُلغي السماح باستخدام الحالة في التدريب.'); }}
  />;

  return <>
    {data?.role === 'owner' ? <Metrics metrics={data.metrics} /> : null}
    {error ? <div className={styles.error} role="alert">
      <p>{error}</p><button type="button" disabled={disabled} onClick={() => setReload(revision => revision + 1)}>إعادة التحميل</button>
    </div> : null}
    <p role="status" className={styles.status}>{loading ? 'جارٍ تحميل الملاحظات…' : notice}</p>
    {data ? <section className={styles.queue} aria-busy={disabled} aria-labelledby="feedback-queue">
      <div className={styles.toolbar}>
        <h2 id="feedback-queue">{isOwner ? 'قائمة المراجعة' : 'ملاحظاتي'}</h2>
        {isOwner ? <div className={styles.controls} aria-label="تصفية الملاحظات">
          <button type="button" aria-pressed={filter === 'pending'} disabled={disabled} onClick={() => { setStatus('pending'); setOffsets([0]); }}>قيد المراجعة</button>
          <button type="button" aria-pressed={filter === 'all'} disabled={disabled} onClick={() => { setStatus('all'); setOffsets([0]); }}>كل الملاحظات</button>
        </div> : null}
      </div>
      {data.items.length ? data.items.map(card) : <p className={styles.empty}>
        {isOwner && filter === 'pending' ? 'لا توجد ملاحظات تنتظر المراجعة.' : 'لا توجد ملاحظات في هذه الصفحة.'}
      </p>}
      {offsets.length > 1 || data.nextOffset !== null ? <nav className={styles.controls} aria-label="صفحات المراجعة">
        <button type="button" disabled={disabled || offsets.length < 2} onClick={() => setOffsets(current => current.slice(0, -1))}>السابقة</button>
        <button type="button" disabled={disabled || data.nextOffset === null} onClick={() => {
          const next = data.nextOffset;
          if (next !== null) setOffsets(current => [...current, next]);
        }}>التالية</button>
      </nav> : null}
    </section> : null}
    {isOwner && reviewed && filter === 'pending' && !data?.items.some(item => item.id === reviewed.id) ? <section className={styles.queue}>
      <h2>تمت مراجعتها للتو</h2>
      {card(reviewed)}
    </section> : null}
  </>;
}
