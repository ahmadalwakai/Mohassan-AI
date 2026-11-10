"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@chakra-ui/react";
import { RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { AIStatusSchema, type AIStatus } from "@mohassan/contracts";

const statusLabels: Record<AIStatus["status"], string> = {
  unconfigured: "غير مهيأ", configured: "مهيأ ولم يُختبر", verified: "اتصال متحقق", error: "تعذر التحقق",
};

export function AiConnection({ ai, offline, onVerified, onRefresh }: { ai: AIStatus; offline: boolean; onVerified: (status: AIStatus) => void; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function verify() {
    if (busy || pending.current || offline || !ai.configured) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ai/verify", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", signal: controller.signal });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string" ? body.error.message : "تعذر التحقق من النموذج المحلي. تأكد أن Ollama يعمل ثم أعد المحاولة.";
        throw new Error(message);
      }
      const parsed = AIStatusSchema.safeParse(body);
      if (!parsed.success) throw new Error("وصل رد غير صالح من خدمة التحقق. أعد تحديث حالة الاتصال.");
      if (!controller.signal.aborted) onVerified(parsed.data);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error && !(caught instanceof TypeError) ? caught.message : "تعذر الاتصال بالخدمة. أعد الاتصال قبل تكرار الاختبار.");
    } finally {
      if (!controller.signal.aborted) { setBusy(false); onRefresh(); }
      if (pending.current === controller) pending.current = null;
    }
  }

  return <section className="ai-connection-panel" aria-label="النموذج المحلي"><div className="ai-connection-header"><span className="tool-icon tool-active"><Sparkles size={23} /></span><div><h2>نموذج موحسن المحلي</h2><p>{ai.message}</p></div><span className={`subtle-badge ${ai.status === "verified" ? "badge-green" : ""}`}>{statusLabels[ai.status]}</span></div><div className="ai-connection-meta">{ai.model ? <span>النموذج <code dir="ltr">{ai.model}</code></span> : null}{ai.verifiedAt ? <span>آخر تحقق ناجح: <time dateTime={ai.verifiedAt}>{new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ai.verifiedAt))}</time></span> : null}</div><div className="ai-connection-action"><p><ShieldCheck size={16} /><span>{ai.configured ? "الاختبار يرسل طلبًا صغيرًا إلى النموذج المحلي على هذا الكمبيوتر، ولا يغادر أي شيء الجهاز. لا يبدأ أي مهمة ولا يرسل أهدافك المحفوظة." : "اضبط LOCAL_MODEL_NAME في بيئة الخادم على كمبيوتر المالك. لا يوجد نموذج سحابي بديل."}</span></p><Button className="primary-button" disabled={offline || busy || !ai.configured} loading={busy} onClick={() => { void verify(); }}><RefreshCw size={15} />اختبار النموذج المحلي</Button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}</section>;
}
