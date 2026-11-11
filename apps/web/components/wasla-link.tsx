"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { Check, Copy, Smartphone } from "lucide-react";
import styles from "./members.module.css";

type Gateway = { id: string; name: string; revoked: boolean; lastSeenAt: string | null; createdAt: string };
type State = { enabled: boolean; serverUrl?: string; gateways: Gateway[] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw new Error(parsed?.error?.message ?? "تعذر إتمام الطلب. حاول مجددًا.");
  return parsed as T;
}
const when = (value: string | null) => value ? new Intl.DateTimeFormat("ar", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "لم يتصل بعد";

/** Owner-only: links the Wasla service on this PC (and through it the iPhone app) to Mohassan. */
export function WaslaLink({ offline }: { offline: boolean }) {
  const [data, setData] = useState<State | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setData(await api<State>("/api/wasla")); setError(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await run(); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة."); } finally { setBusy(false); }
  }
  const command = code ? `python -m wasla.mohassan pair ${code.code}${data?.serverUrl ? ` --url ${data.serverUrl}` : ""}` : "";
  const live = data?.gateways.filter(gateway => !gateway.revoked) ?? [];
  return <section className="panel">
    <div className="panel-heading"><div><h2>تطبيق Mohassan AI على الآيفون</h2><p>اربط خدمة الهاتف على هذا الكمبيوتر بموحسن، فيعمل موحسن نفسه من الآيفون.</p></div><span className="small-icon"><Smartphone size={18} /></span></div>
    <div className={styles.form}>
      {!data ? <Spinner size="sm" /> : !data.enabled ? <p className="muted">الربط مغلق في هذا الخادم. شغّل موحسن المحلي مع <code dir="ltr">WASLA_BRIDGE_ENABLED=true</code>.</p> : <>
        <Button className="primary-button" disabled={busy || offline} onClick={() => { void act(async () => { setCode(await api("/api/wasla/pairing", {})); setCopied(false); }); }}>{live.length ? "إنشاء رمز ربط جديد" : "ربط الآيفون"}</Button>
        {code ? <div className={styles.link}>
          <p>شغّل هذا الأمر في مجلد خدمة الهاتف (apps/wasla-service) خلال دقيقتين. يعمل الرمز مرة واحدة.</p>
          <div className={styles.copy}><code dir="ltr">{command}</code><Button className={styles.secondary} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "نُسخ" : "نسخ"}</Button></div>
        </div> : null}
      </>}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
    {live.length ? <ul className={styles.list}>{live.map(gateway => <li key={gateway.id}>
      <div><strong>{gateway.name}</strong><small>آخر اتصال: {when(gateway.lastSeenAt)}</small></div>
      <Button className={styles.secondary} disabled={busy || offline} onClick={() => { void act(() => api(`/api/wasla/gateways/${gateway.id}/revoke`, {})); }}>إلغاء الربط</Button>
    </li>)}</ul> : null}
  </section>;
}
