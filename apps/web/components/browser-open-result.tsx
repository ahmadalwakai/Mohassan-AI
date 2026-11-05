"use client";

import { useState } from "react";
import { BrowserOpenResultSchema } from "@mohassan/contracts";
import { Camera, CheckCheck, ExternalLink, Globe2 } from "lucide-react";
import styles from "./browser-open-result.module.css";

export function BrowserOpenResult({ result, onOpenBrowser }: { result: Record<string, unknown>; onOpenBrowser?: (sessionId: string) => void }) {
  const [failedScreenshot, setFailedScreenshot] = useState<string | null>(null);
  const parsed = BrowserOpenResultSchema.safeParse(result);
  if (!parsed.success) return <section className={styles.result} aria-label="نتيجة فتح الصفحة"><p role="alert">تعذر عرض دليل فتح الصفحة. راجع سجل التنفيذ قبل اعتبار الطلب منجزًا.</p></section>;
  const page = parsed.data;
  const screenshot = page.screenshotAvailable && typeof page.screenshotUrl === "string" && /^\/api\/browser\/tasks\/[a-zA-Z0-9-]+\/screenshot$/.test(page.screenshotUrl) ? page.screenshotUrl : null;
  return <section className={styles.result} aria-label="نتيجة فتح الصفحة">
    <h3><CheckCheck size={18} />فُتحت الصفحة</h3>
    <p>{page.summary}</p>
    <dl className={styles.properties}>
      <div><dt>عنوان الصفحة</dt><dd dir="auto">{page.title || "صفحة بلا عنوان"}</dd></div>
      <div><dt>العنوان الذي تمت مشاهدته</dt><dd><a href={page.url} target="_blank" rel="noopener noreferrer" dir="ltr">{page.url}<ExternalLink size={13} /></a></dd></div>
      <div><dt>وقت المشاهدة</dt><dd><time dateTime={page.observedAt}>{new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(page.observedAt))}</time></dd></div>
    </dl>
    {screenshot && failedScreenshot !== screenshot ? <figure className={styles.figure}><img src={screenshot} alt={`لقطة الصفحة بعد تحميلها: ${page.title || page.url}`} onError={() => setFailedScreenshot(screenshot)} /><figcaption><Camera size={14} />لقطة محفوظة من مشاهدة المتصفح وقت تنفيذ المهمة</figcaption></figure> : <p className={styles.notice} role="status">{screenshot ? "فُتحت الصفحة، لكن تعذر تحميل اللقطة المحفوظة. أعد فتح تفاصيل المهمة للمحاولة مجددًا." : "فُتحت الصفحة ووُثقت قراءتها، لكن لم تتوفر لقطة شاشة. طلب عرض اللقطة لم يكتمل."}</p>}
    {onOpenBrowser ? <button type="button" className="text-button" onClick={() => onOpenBrowser(page.sessionId)}><Globe2 size={16} />عرض جلسة المتصفح</button> : null}
    <details className="evidence-details"><summary>الأدلة التفصيلية</summary><pre dir="ltr">{JSON.stringify(page, null, 2)}</pre></details>
  </section>;
}
