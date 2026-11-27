import type { ReactNode } from "react";
import styles from "./route-fallback.module.css";

export type RouteErrorProps = { error: unknown; retry: () => void };

export const routeErrorTitle = "تعذّر عرض الصفحة";

export function RouteFallback({ heading, description, children }: {
  heading: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className={styles.page} lang="ar" dir="rtl">
      <h1>{heading}</h1>
      <p>{description}</p>
      <div className={styles.actions}>{children}</div>
    </main>
  );
}

export function RouteErrorFallback({ retry }: RouteErrorProps) {
  return (
    <RouteFallback heading={routeErrorTitle} description="حدث خطأ أثناء تحميل الصفحة.">
      <button className={styles.primary} type="button" onClick={retry}>إعادة المحاولة</button>
    </RouteFallback>
  );
}
