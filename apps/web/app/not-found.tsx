import type { Metadata } from "next";
import Link from "next/link";
import { RouteFallback } from "./route-fallback";
import styles from "./route-fallback.module.css";

const title = "الصفحة غير موجودة";

export const metadata: Metadata = { title };

export default function NotFound() {
  return (
    <RouteFallback heading={title} description="تحقق من الرابط أو عُد إلى الصفحة الرئيسية.">
      <a className={styles.primary} href="">إعادة المحاولة</a>
      <Link href="/">العودة إلى الرئيسية</Link>
    </RouteFallback>
  );
}
