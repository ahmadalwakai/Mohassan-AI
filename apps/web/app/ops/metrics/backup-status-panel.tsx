import { BackupLocalTime } from "./backup-local-time";
import { copyLimitHours, drillLimitHours, dumpLimitHours, type BackupStatusState } from "./backup-status-data";
import styles from "./backup-status.module.css";

const relative = new Intl.RelativeTimeFormat("ar", { numeric: "always" });
const numbers = new Intl.NumberFormat("ar");

function age(hours: number) {
  if (hours >= 2 * 24) return relative.format(-Math.floor(hours / 24), "day");
  if (hours >= 1) return relative.format(-Math.floor(hours), "hour");
  const minutes = Math.floor(hours * 60);
  return minutes > 0 ? relative.format(-minutes, "minute") : "منذ أقل من دقيقة";
}

const accessMessages = {
  signin: "سجّل الدخول بحساب المالك لعرض حالة النسخ الاحتياطي.",
  forbidden: "حالة النسخ الاحتياطي متاحة لحساب المالك فقط.",
  error: "تعذّر تحميل حالة النسخ الاحتياطي.",
};

function BackupDetails({ state }: { state: Extract<BackupStatusState, { kind: "ready" }> }) {
  const { newestDump, lastDrill, offServerCopy } = state.report;
  const dumpStale = newestDump !== null && newestDump.ageHours > dumpLimitHours;
  const drillStale = lastDrill !== null && lastDrill.ageHours > drillLimitHours;
  const drillFailed = lastDrill?.verdict === "failed";
  const copyStale = state.copyAgeHours !== null && state.copyAgeHours > copyLimitHours;
  const healthy = newestDump && !dumpStale && lastDrill && !drillStale && !drillFailed && offServerCopy && !copyStale;

  return (
    <>
      <p className={healthy ? styles.healthy : styles.warning}>
        {healthy ? "النسخ الاحتياطي واختبار الاستعادة بحالة سليمة" : "تحتاج حالة النسخ الاحتياطي إلى الانتباه"}
      </p>
      <div className={styles.cards}>
        <article className={styles.card}>
          <h3>آخر نسخة من قاعدة البيانات</h3>
          {newestDump ? (
            <>
              {dumpStale && <p className={styles.warning}>النسخة الاحتياطية قديمة</p>}
              <dl>
                <div><dt>وقت أخذ النسخة</dt><dd><BackupLocalTime value={newestDump.snapshotAt} /></dd></div>
                <div><dt>عمر النسخة</dt><dd>{age(newestDump.ageHours)}</dd></div>
                <div><dt>حجم النسخة</dt><dd>{newestDump.sizeBytes === undefined ? "غير متاح" : <>{numbers.format(newestDump.sizeBytes)} بايت</>}</dd></div>
              </dl>
            </>
          ) : <p className={styles.warning}>لم يُسجَّل أي نسخ احتياطي بعد</p>}
        </article>
        <article className={styles.card}>
          <h3>آخر اختبار استعادة</h3>
          {lastDrill ? (
            <>
              {drillStale && <p className={styles.warning}>اختبار الاستعادة قديم</p>}
              <dl>
                <div><dt>وقت انتهاء الاختبار</dt><dd><BackupLocalTime value={lastDrill.finishedAt} /></dd></div>
                <div><dt>العمر</dt><dd>{age(lastDrill.ageHours)}</dd></div>
                <div><dt>النتيجة</dt><dd className={drillFailed ? styles.warning : styles.healthy}>{drillFailed ? "فشل" : "نجح"}</dd></div>
              </dl>
            </>
          ) : <p className={styles.warning}>لم يُجرَ اختبار استعادة بعد</p>}
        </article>
        <article className={styles.card}>
          <h3>النسخة خارج الخادم</h3>
          {offServerCopy && state.copyAgeHours !== null ? (
            <>
              {copyStale && <p className={styles.warning}>النسخة خارج الخادم قديمة</p>}
              <dl>
                <div><dt>آخر تنزيل مؤكّد</dt><dd><BackupLocalTime value={offServerCopy.downloadedAt} /></dd></div>
                <div><dt>عمر التنزيل</dt><dd>{age(state.copyAgeHours)}</dd></div>
              </dl>
            </>
          ) : <p className={styles.warning}>لم تُسجَّل نسخة خارج الخادم</p>}
          <p className={styles.note}>تعتمد هذه الحالة على إيصال التنزيل المسجّل.</p>
        </article>
      </div>
    </>
  );
}

export function BackupStatusPanel({ state }: { state: BackupStatusState }) {
  return (
    <section className={styles.panel} id="backup-status" aria-labelledby="backup-status-heading">
      <header className={styles.header}>
        <h2 id="backup-status-heading">النسخ الاحتياطي واختبار الاستعادة</h2>
        {state.kind === "ready" && <a href="/ops/metrics">تحديث حالة النسخ</a>}
        {state.kind === "error" && <a href="/ops/metrics">إعادة المحاولة</a>}
      </header>
      {state.kind === "ready" ? <BackupDetails state={state} /> : <p role="alert">{accessMessages[state.kind]}</p>}
    </section>
  );
}
