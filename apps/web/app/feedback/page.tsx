import type { Metadata } from 'next';
import Link from 'next/link';
import { FeedbackReview } from './review';
import styles from './review.module.css';

export const metadata: Metadata = { title: 'ملاحظات الإجابات | موحسن' };

export default function FeedbackPage() {
  return <main className={styles.page}>
    <header className={styles.heading}>
      <Link href="/">العودة إلى المحادثة</Link>
      <h1>ملاحظات الإجابات</h1>
    </header>
    <FeedbackReview />
  </main>;
}
