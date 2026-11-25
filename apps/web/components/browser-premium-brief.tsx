"use client";

import type { BrowserPremiumBriefData } from "@mohassan/contracts";
import { ArrowLeft, ClipboardList, Globe2, Shield } from "lucide-react";
import { useId } from "react";
import theme from "./browser-premium-tokens.module.css";
import styles from "./browser-premium-view.module.css";

type Props = {
  brief: BrowserPremiumBriefData;
  onStart: () => void;
  onCancel?: () => void;
  busy?: boolean;
  error?: string | null;
};

const labels = {
  login: "تسجيل الدخول",
  code: "رمز تحقق",
  approval: "موافقتك",
} as const;

export function BrowserPremiumBrief({ brief, onStart, onCancel, busy, error }: Props) {
  const title = useId();
  return <section className={`${theme.theme} ${styles.brief}`} lang="ar" aria-labelledby={title} data-testid="browser-premium-brief">
    <div className={styles.briefBody}>
      <span className={styles.cardIcon}><ClipboardList aria-hidden="true" size={17} /></span>
      <div className={styles.briefText}>
        <h2 id={title}>خطة التصفح</h2>
        <p className={styles.summary} dir="auto">{brief.summary}</p>
        <dl className={styles.briefMeta}>
          <div>
            <dt><Globe2 aria-hidden="true" size={13} /> المواقع</dt>
            <dd>{brief.sites.length > 0 ? <ul className={styles.briefList} role="list">
              {brief.sites.map(site => <li key={site}><bdi dir="ltr" className={styles.domain}>{site}</bdi></li>)}
            </ul> : "تُحدّد أثناء البحث"}</dd>
          </div>
          <div>
            <dt><Shield aria-hidden="true" size={13} /> قد أحتاج</dt>
            <dd>{brief.needs.length > 0 ? <ul className={styles.briefList} role="list">
              {brief.needs.map(need => <li key={need}>{labels[need]}</li>)}
            </ul> : "لا يوجد إجراء مطلوب الآن"}</dd>
          </div>
        </dl>
      </div>
    </div>
    {error ? <p role="alert" className={styles.failure}>{error}</p> : null}
    <div className={styles.actions}>
      {onCancel ? <button type="button" className={styles.button} onClick={onCancel} disabled={busy}>إلغاء</button> : null}
      <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onStart} disabled={busy}>
        {busy ? "جارٍ البدء…" : brief.requiresStart ? "ابدأ" : "متابعة"}
        <ArrowLeft className={styles.directionIcon} aria-hidden="true" size={15} />
      </button>
    </div>
  </section>;
}
