import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './activation-console.module.css';

export function ActivationFrame({ children }: { children: ReactNode }) {
  return <main className={styles.console} dir="rtl" lang="ar">
    <header className={styles.header}>
      <Link href="/#tools" prefetch={false}>العودة إلى مساحة العمل</Link>
      <h1>تفعيل القدرات</h1>
    </header>
    {children}
  </main>;
}

export function ActivationAccessMessage({ kind }: { kind: 'signin' | 'forbidden' }) {
  return <p className={styles.message} role="alert">
    {kind === 'signin' ? 'سجّل الدخول بحساب المالك لعرض إعدادات الإنتاج.' : 'هذه الصفحة متاحة لحساب المالك فقط.'}
  </p>;
}
