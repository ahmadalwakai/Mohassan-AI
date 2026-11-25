import type { MonitorHealthMetrics } from "@mohassan/contracts";
import styles from "./metrics.module.css";

const numbers = new Intl.NumberFormat("ar", { maximumFractionDigits: 2 });
const rates = new Intl.NumberFormat("ar", { style: "percent", maximumFractionDigits: 2 });
const count = (value: number | null) => value === null ? "—" : numbers.format(value);

export function hasMonitorHealth(metrics?: MonitorHealthMetrics): metrics is MonitorHealthMetrics {
  return !!metrics && (metrics.checks.attempted > 0 || !!metrics.alerts?.total
    || Object.values(metrics.delivered).some(Boolean) || Object.values(metrics.pauses).some(Boolean));
}

export function MonitorHealth({ metrics }: { metrics: MonitorHealthMetrics }) {
  const { alerts, checkLatenessMs, checks, delivered, pauses } = metrics;
  return (
    <section className={styles.section} aria-labelledby="metrics-monitors">
      <h2 id="metrics-monitors">صحة المراقبات</h2>
      <div className={styles.cards}>
        <article className={styles.card}>
          <h3>الفحوص</h3>
          <dl className={styles.values}>
            <div><dt>نجاح الفحوص</dt><dd>{checks.successRate === null ? "—" : rates.format(checks.successRate)} ({count(checks.succeeded)}/{count(checks.attempted)})</dd></div>
            <div><dt>تأخر الفحص <bdi>p50</bdi> (مللي ثانية)</dt><dd>{count(checkLatenessMs.p50)}</dd></div>
            <div><dt>تأخر الفحص <bdi>p95</bdi> (مللي ثانية)</dt><dd>{count(checkLatenessMs.p95)}</dd></div>
            <div><dt>عينات التأخر</dt><dd>{count(checkLatenessMs.samples)}</dd></div>
          </dl>
        </article>
        <article className={styles.card}>
          <h3>تقييم التنبيهات</h3>
          {!alerts ? <p>تعذّرت قراءة عدّادات تقييم التنبيهات.</p> : (
            <dl className={styles.values}>
              <div><dt>التنبيهات المنشورة</dt><dd>{count(alerts.total)}</dd></div>
              <div><dt>مفيد</dt><dd>{count(alerts.helpful)}</dd></div>
              <div><dt>غير مفيد</dt><dd>{count(alerts.notHelpful)}</dd></div>
              <div><dt>بلا تقييم</dt><dd>{count(alerts.unrated)}</dd></div>
              <div><dt>لم يتغير شيء مهم</dt><dd>{count(alerts.reasons.no_meaningful_change)}</dd></div>
              <div><dt>تأخر التنبيه</dt><dd>{count(alerts.reasons.late)}</dd></div>
              <div><dt>قيمة خاطئة</dt><dd>{count(alerts.reasons.wrong_value)}</dd></div>
            </dl>
          )}
        </article>
        <article className={styles.card}>
          <h3>التسليم حسب القناة</h3>
          <dl className={styles.values}>
            <div><dt>المحادثة</dt><dd>{count(delivered.conversation)}</dd></div>
            <div><dt>تبويب المتصفح</dt><dd>{count(delivered.tab)}</dd></div>
            <div><dt>إشعارات الويب</dt><dd>{count(delivered.webPush)}</dd></div>
            <div><dt>إشعارات آيفون</dt><dd>{count(delivered.apns)}</dd></div>
          </dl>
        </article>
        <article className={styles.card}>
          <h3>أسباب الإيقاف المؤقت</h3>
          <dl className={styles.values}>
            <div><dt>إيقاف يدوي</dt><dd>{count(pauses.manual)}</dd></div>
            <div><dt>العنصر المرصود مفقود</dt><dd>{count(pauses.missing)}</dd></div>
            <div><dt>تعذّر الوصول للمصدر</dt><dd>{count(pauses.unreachable)}</dd></div>
          </dl>
        </article>
      </div>
    </section>
  );
}
