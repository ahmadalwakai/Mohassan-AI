"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Megaphone, Play, Plus, Power, RefreshCw, ShieldCheck, X } from "lucide-react";
import styles from "./executor-workspace.module.css";

type AdsCapability = "ads.keywords.v1" | "ads.negatives.v1" | "ads.headlines.v1" | "ads.descriptions.v1";
type Choice = AdsCapability | "campaign";
type Status = {
  enabled: boolean; available: boolean; message: string | null; run: string | null; device: string;
  worker: { state: "stopped" | "starting" | "ready" | "failed"; error: string | null; model: { parameters: number; finetune_step: number | null; prompt_hint: string | null; device: string; tokenizer_identity: string } | null };
  trained: { id: string; services: string[]; facts: string[] }[];
  heldOut: { id: string; services: string[] }[];
};
type Candidate = { index: number; sampling: "greedy" | "sampled"; text: string; finished: boolean; passed: boolean; issues: { code: string; message: string }[] };
type AdsRun = {
  capability: AdsCapability; input: Record<string, unknown>; knownBusinessType: string | null;
  decision: { accepted: true; candidate: number; output: Record<string, string[]> } | { accepted: false; reasons: Record<string, number> };
  candidates: Candidate[]; generationMs: number; totalMs: number;
};

const TASK_LABELS: Record<AdsCapability, string> = {
  "ads.keywords.v1": "الكلمات المفتاحية", "ads.negatives.v1": "الكلمات السلبية", "ads.headlines.v1": "العناوين", "ads.descriptions.v1": "الأوصاف",
};
const ISSUE_LABELS: Record<string, string> = {
  UNPARSABLE: "ليست JSON صالحة", BAD_SHAPE: "شكل غير صحيح", KEYWORD_NO_LOCATION: "كلمة لا تذكر المدينة", UNGROUNDED_WORD: "كلمات غير موجودة في الطلب",
  LEAKED_FACT: "معلومة لم تذكرها", BUSINESS_NAME: "اسم النشاط مقطوع أو خاطئ", STRAY_LETTER: "كلمة مكسورة", FRAGMENT: "وصف ليس جملة كاملة",
  TOO_LONG: "أطول من حد Google", TOO_MANY: "عدد أكثر من المسموح", TOO_FEW: "عدد أقل من المطلوب", DUPLICATE: "تكرار", NO_BUSINESS: "لا يذكر اسم النشاط",
  NO_LOCATION: "لا يذكر المدينة", UNSUPPORTED_CLAIM: "ادعاء غير مدعوم", POLICY_CAPITALS: "أحرف كبيرة مخالفة", EMPTY: "فارغ", KEYWORD_SYNTAX: "صيغة كلمة خاطئة",
};
const ORDER: AdsCapability[] = ["ads.keywords.v1", "ads.negatives.v1", "ads.headlines.v1", "ads.descriptions.v1"];

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json", ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error?.message ?? (response.status === 429 ? "طلبات كثيرة متتابعة. انتظر قليلًا." : "تعذر إتمام الطلب."), response.status);
  return body as T;
}

export function AdsLabPanel({ offline }: { offline: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  const [brief, setBrief] = useState({ business: "Kerbside Tyres", service: "Mobile Tyre Fitting", city: "Wigan", goal: "calls" });
  const [factsText, setFactsText] = useState("Card, contactless and Apple Pay accepted at the kerb.\nOpen 24/7 with a real fitter on the phone.");
  const [choice, setChoice] = useState<Choice>("campaign");
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<AdsRun[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { setStatus(await api<Status>("/api/executor/ads/status", { signal })); setLoadError(""); }
    catch (caught) { if (!(caught instanceof DOMException && caught.name === "AbortError")) setLoadError(caught instanceof ApiError ? caught.message : "تعذر الاتصال بالخدمة."); }
  }, []);
  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [offline, refresh]);

  const services = useMemo(() => status?.trained.flatMap(vertical => vertical.services) ?? [], [status]);
  const vertical = status?.trained.find(item => item.services.some(service => service.toLowerCase() === brief.service.trim().toLowerCase()));
  const heldOut = status?.heldOut.some(item => item.services.some(service => service.toLowerCase() === brief.service.trim().toLowerCase()));
  const facts = factsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const ready = Boolean(status?.enabled && status.available) && !offline;

  async function runOne(capability: AdsCapability, keywords: string[]): Promise<AdsRun> {
    setBusy(TASK_LABELS[capability]);
    return api<AdsRun>("/api/executor/ads/runs", { method: "POST", body: JSON.stringify({ capability, brief: { ...brief, facts, keywords } }) });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setError(""); setResults([]);
    try {
      if (choice !== "campaign") {
        if (choice === "ads.negatives.v1") {
          const first = await runOne("ads.keywords.v1", []);
          setResults([first]);
          if (!first.decision.accepted) { setError("رُفضت الكلمات المفتاحية، فلا يمكن توليد الكلمات السلبية."); return; }
          setResults([first, await runOne(choice, first.decision.output.keywords)]);
        } else setResults([await runOne(choice, [])]);
        return;
      }
      const collected: AdsRun[] = [];
      let keywords: string[] = [];
      for (const capability of ORDER) {
        if (capability === "ads.negatives.v1" && !keywords.length) continue;
        const result = await runOne(capability, keywords);
        if (capability === "ads.keywords.v1" && result.decision.accepted) keywords = result.decision.output.keywords ?? [];
        collected.push(result);
        setResults([...collected]);
      }
    } catch (caught) { setError(caught instanceof ApiError ? caught.message : "تعذر تشغيل النموذج."); }
    finally { setBusy(null); void refresh(); }
  }

  async function stopWorker() {
    try { await api("/api/executor/ads/stop", { method: "POST", body: "{}" }); } catch { /* status below shows the truth */ }
    await refresh();
  }

  const worker = status?.worker;
  return <section className={styles.form} aria-label="نموذج الإعلانات المحلي">
    <div className={styles.resultHead}>
      <h3><Megaphone size={17} /> نموذج الإعلانات المحلي (مبني من الصفر)</h3>
      <span className={!status ? styles.badgeWarn : !ready ? styles.badgeBad : worker?.state === "ready" ? styles.badgeOk : styles.badgeWarn}>
        {!status ? "…" : !status.enabled ? "غير مفعّل" : !status.available ? "النموذج غير موجود" : worker?.state === "ready" ? "محمّل في الذاكرة" : worker?.state === "starting" ? "يُحمَّل…" : worker?.state === "failed" ? "فشل التحميل" : "جاهز، يُحمَّل عند أول طلب"}
      </span>
    </div>
    <p className={styles.cardNote}>
      34 مليون معامل، تدرّب على هذا الجهاز. يكتب 8 إجابات لكل طلب، ولا يظهر منها إلا ما يجتاز بوابة المدقق؛ وإلا فالجواب «لا إجابة».
      القياس على مدن لم يرها: 186 من 300. على نوع نشاط لم يتدرب عليه: 0 من 300. لا يُنشر شيء في Google Ads.
    </p>
    {status?.message ? <p className="inline-error" role="alert">{status.message}</p> : null}
    {worker?.error ? <p className="inline-error" role="alert">{worker.error}</p> : null}
    {loadError ? <p className="inline-error" role="alert">{loadError}</p> : null}
    {worker?.model ? <p className={styles.meta}>الجهاز {worker.model.device} · {worker.model.parameters.toLocaleString("en")} معامل · خطوة التعليم {worker.model.finetune_step} · التلميح {worker.model.prompt_hint ?? "—"}</p> : null}
    <div className={styles.toolbar}>
      <button type="button" className="secondary-button" disabled={offline || Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={15} />تحديث الحالة</button>
      <button type="button" className="secondary-button" disabled={offline || Boolean(busy) || worker?.state !== "ready"} onClick={() => void stopWorker()}><Power size={15} />إيقاف النموذج وتحرير كرت الشاشة</button>
    </div>

    <form onSubmit={submit} className={styles.form}>
      <div className={styles.row}>
        <label className={styles.field}>اسم النشاط<input dir="ltr" maxLength={60} value={brief.business} disabled={Boolean(busy)} onChange={event => setBrief(current => ({ ...current, business: event.target.value }))} /></label>
        <label className={styles.field}>الخدمة<input dir="ltr" list="ads-lab-services" maxLength={60} value={brief.service} disabled={Boolean(busy)} onChange={event => setBrief(current => ({ ...current, service: event.target.value }))} />
          <small>{vertical ? `نوع نشاط تدرب عليه: ${vertical.id}` : heldOut ? "نوع نشاط محجوب عن التدريب: توقّع الرفض." : "خدمة غير معروفة للنموذج: توقّع الرفض."}</small></label>
        <datalist id="ads-lab-services">{services.map(service => <option key={service} value={service} />)}</datalist>
        <label className={styles.field}>المدينة<input dir="ltr" maxLength={40} value={brief.city} disabled={Boolean(busy)} onChange={event => setBrief(current => ({ ...current, city: event.target.value }))} /></label>
        <label className={styles.field}>الهدف<select value={brief.goal} disabled={Boolean(busy)} onChange={event => setBrief(current => ({ ...current, goal: event.target.value }))}>
          <option value="calls">اتصالات</option><option value="leads">طلبات عروض</option><option value="bookings">حجوزات</option></select></label>
      </div>
      <label className={styles.field}>معلومات عن النشاط (سطر لكل معلومة، بالإنجليزية)
        <textarea dir="ltr" rows={4} value={factsText} disabled={Boolean(busy)} onChange={event => setFactsText(event.target.value)} />
        <small>العناوين والأوصاف لا تذكر إلا ما تكتبه هنا. أقصى عدد 12.</small>
      </label>
      {vertical ? <div className={styles.toolbar}>{vertical.facts.filter(fact => !facts.includes(fact)).slice(0, 8).map(fact =>
        <button type="button" key={fact} dir="ltr" className="secondary-button" disabled={Boolean(busy) || facts.length >= 12} onClick={() => setFactsText(current => `${current.trim()}\n${fact}`.trim())}><Plus size={13} />{fact}</button>)}</div> : null}
      <label className={styles.field}>المهمة
        <select value={choice} disabled={Boolean(busy)} onChange={event => setChoice(event.target.value as Choice)}>
          <option value="campaign">حملة كاملة: الكلمات ← السلبية ← العناوين ← الأوصاف</option>
          {ORDER.map(capability => <option key={capability} value={capability}>{TASK_LABELS[capability]}</option>)}
        </select>
      </label>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button type="submit" className="primary-button" disabled={!ready || Boolean(busy) || !brief.business.trim() || !brief.service.trim() || !brief.city.trim()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{busy ? `يكتب ${busy}…` : "شغّل النموذج"}</button>
      </div>
    </form>

    {results.map(result => <AdsResult key={result.capability} result={result} />)}
  </section>;
}

function AdsResult({ result }: { result: AdsRun }) {
  const decision = result.decision;
  const values = decision.accepted ? Object.values(decision.output).flat() : [];
  return <article className={styles.result} aria-live="polite">
    <div className={styles.resultHead}>
      <h3>{TASK_LABELS[result.capability]}</h3>
      <span className={decision.accepted ? styles.badgeOk : styles.badgeBad}>{decision.accepted
        ? <><Check size={13} />اجتاز البوابة · الإجابة {decision.candidate + 1} من {result.candidates.length}{decision.candidate === 0 ? " (الأولى المباشرة)" : ""}</>
        : <><X size={13} />لا إجابة: رُفضت الإجابات الثماني</>}</span>
    </div>
    {decision.accepted
      ? <ol dir="ltr" className={styles.output}>{values.map((value, index) => <li key={index}>{value}</li>)}</ol>
      : <p className={styles.cardNote}>أسباب الرفض: {Object.entries(decision.reasons).map(([code, count]) => `${ISSUE_LABELS[code] ?? code} (${count})`).join("، ")}</p>}
    <p className={styles.meta}>التوليد {(result.generationMs / 1000).toFixed(1)} ث · الإجمالي {(result.totalMs / 1000).toFixed(1)} ث{result.knownBusinessType ? ` · نوع النشاط: ${result.knownBusinessType}` : " · نوع نشاط غير معروف للنموذج"}</p>
    <details>
      <summary>الإجابات الثماني كما كتبها النموذج</summary>
      {result.candidates.map(candidate => <div key={candidate.index}>
        <p className={styles.meta}>{candidate.index + 1}. {candidate.sampling === "greedy" ? "مباشرة" : "عيّنة"} · {candidate.passed ? "اجتازت" : candidate.issues.map(issue => ISSUE_LABELS[issue.code] ?? issue.code).join("، ")}</p>
        <pre dir="ltr" className={styles.output}>{candidate.text || "(فارغة)"}</pre>
      </div>)}
    </details>
    <p className={styles.warning}><ShieldCheck size={14} />تجربة محلية: لم يُرسل أي شيء إلى نموذج خارجي أو إلى حساب Google Ads.</p>
  </article>;
}
