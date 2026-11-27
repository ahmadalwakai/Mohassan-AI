'use client';

import { useState } from 'react';
import type { FeedbackItem, FeedbackReviewInput } from '@mohassan/contracts';
import { feedbackPath, requestFeedbackPage, saveFeedbackReview, type ReviewFilter, type ReviewPage } from './review-data';
import styles from './review.module.css';

const VERDICTS: Record<FeedbackItem['verdict'], string> = { useful: 'مفيد', wrong: 'خطأ', incomplete: 'ناقص' };
const DECISIONS: Record<NonNullable<FeedbackItem['decision']>, string> = { pin: 'تفضيل مصدر', block: 'استبعاد مصدر', dismiss: 'تمت المراجعة دون تغيير' };
const DATE = new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeZone: 'UTC' });

function EvidenceUrl({ url }: { url: string }) {
  return <bdi dir="ltr">{/^https?:\/\//i.test(url)
    ? <a href={url} target="_blank" rel="noreferrer">{url}</a>
    : url}</bdi>;
}

export function FeedbackReviewItem({ item, disabled, onReview }: {
  item: FeedbackItem;
  disabled: boolean;
  onReview(review: FeedbackReviewInput): void;
}) {
  return <article className={styles.card} aria-labelledby={`feedback-${item.id}`}>
    <header className={styles.row}>
      <h3 id={`feedback-${item.id}`} dir="auto">{item.question ?? 'السؤال غير متاح للمراجعة'}</h3>
      <time dateTime={item.createdAt}>{DATE.format(new Date(item.createdAt))}</time>
    </header>
    <dl className={styles.details}>
      {item.reply ? <><dt>الرد</dt><dd dir="auto">{item.reply}</dd></> : null}
      <dt>التقييم</dt><dd>{VERDICTS[item.verdict]}</dd>
      {item.note ? <><dt>الملاحظة</dt><dd dir="auto">{item.note}</dd></> : null}
      <dt>المراجعة</dt><dd>{item.decision ? DECISIONS[item.decision] : 'قيد المراجعة'}</dd>
      {item.sourceUrl ? <><dt>المصدر المحدد</dt><dd><EvidenceUrl url={item.sourceUrl} /></dd></> : null}
    </dl>
    <fieldset className={styles.actions} disabled={disabled}>
      <legend>المصادر المسجّلة</legend>
      {item.evidenceUrls.length ? <ul className={styles.sources}>
        {item.evidenceUrls.map(sourceUrl => <li key={sourceUrl}>
          <EvidenceUrl url={sourceUrl} />
          {!item.decision ? <div className={styles.controls}>
            <button type="button" onClick={() => onReview({ decision: 'pin', sourceUrl })}>فضّل المصدر</button>
            <button type="button" onClick={() => onReview({ decision: 'block', sourceUrl })}>استبعد المصدر</button>
          </div> : null}
        </li>)}
      </ul> : <p>لا يوجد مصدر مسجّل لهذه الإجابة.</p>}
      {item.decision
        ? <button type="button" onClick={() => onReview({ decision: 'clear' })}>إلغاء قرار المراجعة</button>
        : <button type="button" onClick={() => onReview({ decision: 'dismiss' })}>تمت المراجعة دون تغيير</button>}
    </fieldset>
  </article>;
}

const ACCESS_MESSAGES = {
  signin: 'سجّل الدخول من المحادثة لعرض الملاحظات.',
  forbidden: 'المراجعة متاحة لحساب المالك فقط.',
  disabled: 'مراجعة الملاحظات غير مفعّلة.',
};

export function FeedbackReview({ initialPage }: { initialPage: ReviewPage }) {
  const [page, setPage] = useState(initialPage);
  const [filter, setFilter] = useState<ReviewFilter>('pending');
  const [offsets, setOffsets] = useState([0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(nextFilter: ReviewFilter, nextOffsets: number[]) {
    const query = new URLSearchParams({ status: nextFilter, offset: String(nextOffsets.at(-1) ?? 0) });
    setPage(await requestFeedbackPage(`${feedbackPath}?${query}`));
    setFilter(nextFilter);
    setOffsets(nextOffsets);
  }

  async function navigate(nextFilter: ReviewFilter, nextOffsets: number[]) {
    setError('');
    setNotice('');
    setBusy(true);
    await load(nextFilter, nextOffsets);
    setBusy(false);
  }

  async function review(id: string, input: FeedbackReviewInput) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (!await saveFeedbackReview(id, input)) throw new Error('Unable to save review');
      setNotice(input.decision === 'clear' ? 'أُلغي القرار وأعيدت الملاحظة إلى قائمة المراجعة.' : 'حُفظ قرار المراجعة.');
      // A decision can remove a pending item and shift all following pages.
      await load(filter, filter === 'pending' ? [0] : offsets);
    } catch {
      setError('تعذّر حفظ قرار المراجعة. حاول مجددًا.');
    } finally {
      setBusy(false);
    }
  }

  if (page.kind === 'signin' || page.kind === 'forbidden' || page.kind === 'disabled') {
    return <p className={styles.card} role="status">{ACCESS_MESSAGES[page.kind]}</p>;
  }
  const queue = page.kind === 'ready' ? page.queue : null;
  const nextOffset = queue?.nextOffset ?? null;

  return <section className={styles.queue} aria-labelledby="feedback-queue">
    <div className={styles.row}>
      <h2 id="feedback-queue">قائمة المراجعة</h2>
      <div className={styles.controls}>
        <button type="button" aria-pressed={filter === 'pending'} disabled={busy} onClick={() => void navigate('pending', [0])}>قيد المراجعة</button>
        <button type="button" aria-pressed={filter === 'all'} disabled={busy} onClick={() => void navigate('all', [0])}>كل الملاحظات</button>
      </div>
    </div>
    <p className={styles.status} role="status">{busy ? 'جارٍ التحديث…' : notice}</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {page.kind === 'error' ? <div className={styles.card} role="alert">
      <p>تعذّر تحميل الملاحظات.</p>
      <button type="button" disabled={busy} onClick={() => void navigate(filter, offsets)}>إعادة المحاولة</button>
    </div> : null}
    <div className={styles.queue} aria-busy={busy}>
      {queue?.items.map(item => <FeedbackReviewItem key={item.id} item={item} disabled={busy} onReview={input => void review(item.id, input)} />)}
      {queue?.items.length === 0 ? <p className={styles.card}>{filter === 'pending' ? 'لا توجد ملاحظات تنتظر المراجعة.' : 'لا توجد ملاحظات في هذه الصفحة.'}</p> : null}
    </div>
    {offsets.length > 1 || nextOffset !== null ? <nav className={styles.controls} aria-label="صفحات المراجعة">
      <button type="button" disabled={busy || offsets.length < 2} onClick={() => void navigate(filter, offsets.slice(0, -1))}>السابقة</button>
      <button type="button" disabled={busy || nextOffset === null} onClick={() => {
        if (nextOffset !== null) void navigate(filter, [...offsets, nextOffset]);
      }}>التالية</button>
    </nav> : null}
  </section>;
}
