import { ShieldCheck } from "lucide-react";
import styles from "./assistant-app.module.css";

/** The server offers this card only when it can reconcile a persisted operation without submitting it again. */
export function CampaignRecoveryCard({ busy, onResume }: { busy: boolean; onResume: () => void }) {
  return <section className={styles.card} aria-label="مراجعة العملية المحفوظة">
    <h3 className={styles.cardTitle}><ShieldCheck size={16} aria-hidden="true" />تحقق من نتيجة العملية السابقة</h3>
    <p className={styles.cardHint}>نقرأ حالة العملية المحفوظة من حساب Google Ads ونقارنها بالمطلوب. هذه المراجعة للقراءة فقط؛ لا تعيد إنشاء الحملة أو إرسال طلب كتابة.</p>
    <div className={styles.cardActions}><button type="button" className={styles.secondary} disabled={busy} onClick={onResume}>مراجعة نتيجة العملية المحفوظة</button></div>
  </section>;
}
