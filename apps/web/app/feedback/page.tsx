import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { FeedbackReview } from './review';
import { feedbackPath, requestFeedbackPage } from './review-data';
import styles from './review.module.css';

export const metadata: Metadata = { title: 'ملاحظات الإجابات | موحسن' };

export default async function FeedbackPage() {
  // Use the same internal server connection and session cookie as the API relay.
  const secret = process.env.INTERNAL_API_SECRET;
  const cookie = (await headers()).get('cookie');
  const page = secret
    ? await requestFeedbackPage(new URL(feedbackPath, process.env.MOHASSAN_SERVER_URL || 'http://127.0.0.1:4000'), {
      headers: { 'x-mohassan-internal': secret, cookie: cookie ?? '' },
      signal: AbortSignal.timeout(15_000),
    })
    : { kind: 'error' as const };

  return <main className={styles.page}>
    <header className={styles.heading}>
      <Link href="/">العودة إلى المحادثة</Link>
      <h1>ملاحظات الإجابات</h1>
    </header>
    <FeedbackReview initialPage={page} />
  </main>;
}
