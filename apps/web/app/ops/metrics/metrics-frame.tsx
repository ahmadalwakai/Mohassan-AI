import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./metrics.module.css";

export function MetricsFrame({ children }: { children: ReactNode }) {
  return (
    <main className={styles.page} dir="rtl" lang="ar">
      <header className={styles.header}>
        <Link href="/#tools" prefetch={false}>العودة إلى مساحة العمل</Link>
        <h1>مقاييس الإنتاج</h1>
      </header>
      {children}
    </main>
  );
}
