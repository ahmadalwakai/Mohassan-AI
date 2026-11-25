"use client";

import { useEffect, useState } from "react";
import { ConversationShareSettingsSchema } from "@mohassan/contracts";
import { shareError, shareJson, shareSettingsPath } from "./conversation-share-client";
import styles from "./conversation-actions.module.css";

export function ConversationShareSettings({ offline }: { offline: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    void shareJson(ConversationShareSettingsSchema, shareSettingsPath, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setEnabled(result.memberSharingEnabled); })
      .catch(caught => { if (!controller.signal.aborted) setError(shareError(caught)); });
    return () => controller.abort();
  }, [attempt, offline]);

  async function save(memberSharingEnabled: boolean) {
    if (offline || working) return;
    setWorking(true);
    setSaved(false);
    setError("");
    try {
      const result = await shareJson(ConversationShareSettingsSchema, shareSettingsPath, {
        method: "POST",
        body: JSON.stringify({ memberSharingEnabled }),
      });
      setEnabled(result.memberSharingEnabled);
      setSaved(true);
    } catch (caught) {
      setError(shareError(caught));
    } finally {
      setWorking(false);
    }
  }

  return <section className="panel">
    <div className="panel-heading"><div><h2>مشاركة محادثات الأعضاء</h2><p>يمكن إيقاف إنشاء روابط جديدة للأعضاء. الروابط الحالية تبقى صالحة حتى تنتهي أو يلغيها صاحبها.</p></div></div>
    <div className={styles.settings}>
      <label><input type="checkbox" checked={enabled ?? false} disabled={enabled === null || working || offline} onChange={event => void save(event.target.checked)} />السماح للأعضاء بإنشاء روابط مشاركة</label>
      {working ? <p role="status">جارٍ الحفظ…</p> : null}
      {saved ? <p role="status">حُفظ الإعداد.</p> : null}
      {enabled === null && !error && !offline ? <p role="status">جارٍ تحميل الإعداد…</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {error && enabled === null ? <button type="button" className="text-button" disabled={offline} onClick={() => { setError(""); setAttempt(current => current + 1); }}>إعادة التحميل</button> : null}
    </div>
  </section>;
}
