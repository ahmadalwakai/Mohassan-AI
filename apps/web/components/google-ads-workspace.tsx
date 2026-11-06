"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, KeyRound, Link2, Megaphone, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import type { GoogleAdsAccountOption, GoogleAdsAuditEntry, GoogleAdsBasis, GoogleAdsBrief, GoogleAdsDraft, GoogleAdsDraftState, GoogleAdsMarket, GoogleAdsRecommendation, GoogleAdsReport, GoogleAdsStatus } from "@mohassan/contracts";
import styles from "./google-ads-workspace.module.css";

class AdsError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: number | null) { super(message); }
}

async function api<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`/api/google-ads/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 429 ? "طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة." : "تعذر إكمال الطلب. حاول مجددًا.";
    throw new AdsError(value?.error?.message ?? fallback, response.status, Number(response.headers.get("retry-after")) || null);
  }
  return value as T;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "تعذر الاتصال بالخدمة.";
const moneyOf = (micros: string, currency: string) => new Intl.NumberFormat("ar", { style: currency ? "currency" : "decimal", ...(currency ? { currency, currencyDisplay: "narrowSymbol" as const } : {}), maximumFractionDigits: 2 }).format(Number(micros) / 1_000_000);
const count = (value: number) => value.toLocaleString("ar");
const percent = (value: number | null) => value === null ? "غير متاح" : `${Math.round(value * 100).toLocaleString("ar")}٪`;
const dateTime = (value: string) => new Date(value).toLocaleString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const basisLabels: Record<GoogleAdsBasis, string> = { observed: "مرصود", estimate: "تقدير", assumption: "افتراض" };
const Basis = ({ value }: { value: GoogleAdsBasis }) => <span className={`${styles.basis} ${styles[value]}`}>{basisLabels[value]}</span>;

const stateLabels: Record<GoogleAdsDraftState, string> = {
  preview: "معاينة", draft: "مسودة محفوظة", rejected: "رفضها الفحص", validated: "اجتازت فحص الجودة", verified: "اجتازت التحقق المستقل", approved: "وافقت على النشر", publishing: "جارٍ النشر",
  published: "منشورة متوقفة", launch_approved: "وافقت على الإطلاق", launching: "جارٍ الإطلاق", live: "مفعّلة", failed: "تعذر النشر", outcome_unknown: "النتيجة غير مؤكدة", discarded: "محذوفة",
};
const gateLabels: Record<string, string> = { server_switch: "مفتاح الخادم", connection: "الاتصال", regression_runs: "20 تشغيلًا متتاليًا", live_read_check: "فحص قراءة حي", production_account: "حساب حقيقي" };
const checkLabels: Record<string, string> = { account_permissions: "صلاحيات الحساب", conversion_tracking: "تتبع التحويلات", draft_correctness: "صحة المسودة", existing_resources_preserved: "الحفاظ على الموجود", google_validate_only: "فحص Google دون تنفيذ" };
const auditLabels: Record<string, string> = {
  oauth_started: "بدأ الربط", oauth_connected: "اكتمل تفويض Google", account_selected: "اختير حساب", booking_map_saved: "حُفظ ربط الحجوزات", report_read: "قُرئ التقرير", draft_created: "أُنشئت معاينة", draft_saved: "حُفظت مسودة", draft_revised: "عُدلت مسودة", draft_discarded: "حُذفت مسودة",
  validation_passed: "نجح فحص الجودة", validation_failed: "رفض فحص الجودة", verification_passed: "نجح التحقق المستقل", verification_failed: "فشل التحقق المستقل", publish_approved: "وافقت على النشر", publish_started: "بدأ النشر", publish_applied: "طبقت Google العمليات", publish_confirmed: "تأكد النشر من الحساب", publish_rejected: "رفضت Google النشر", publish_unknown: "نتيجة النشر غير مؤكدة", publish_confirmed_absent: "تأكد أن الحملة لم تُنشأ", publish_mismatch: "الحملة لا تطابق الموافقة",
  launch_approved: "وافقت على الإطلاق", launch_started: "بدأ الإطلاق", launch_confirmed: "تأكد الإطلاق من الحساب", launch_rejected: "رفضت Google الإطلاق", launch_unconfirmed: "لم يتأكد الإطلاق", launch_unknown: "نتيجة الإطلاق غير مؤكدة", authorization_lost: "فُقد التفويض", disconnected: "أُلغي الربط",
};

const biddingLabels: Record<string, string> = { MANUAL_CPC: "تكلفة نقرة يدوية", MAXIMIZE_CLICKS: "تعظيم النقرات", MAXIMIZE_CONVERSIONS: "تعظيم التحويلات" };
const campaignStatus: Record<string, string> = { ENABLED: "مفعّلة", PAUSED: "متوقفة", REMOVED: "محذوفة" };

const lines = (value: string) => value.split("\n").map(item => item.trim()).filter(Boolean);

interface FormFields { businessName: string; service: string; goal: GoogleAdsBrief["goal"]; landingPageUrl: string; locations: string; countryCode: string; adLanguage: string; dailyBudget: string; ownerFacts: string; headlines: string; descriptions: string; paths: string; keywords: string; negativeKeywords: string }
const emptyForm: FormFields = { businessName: "", service: "", goal: "bookings", landingPageUrl: "", locations: "", countryCode: "GB", adLanguage: "en", dailyBudget: "", ownerFacts: "", headlines: "", descriptions: "", paths: "", keywords: "", negativeKeywords: "" };
const toForm = (brief: GoogleAdsBrief): FormFields => ({ ...brief, locations: brief.locations.join("\n"), ownerFacts: brief.ownerFacts.join("\n"), headlines: brief.headlines.join("\n"), descriptions: brief.descriptions.join("\n"), paths: brief.paths.join("\n"), keywords: brief.keywords.join("\n"), negativeKeywords: brief.negativeKeywords.join("\n") });
const toBrief = (form: FormFields): GoogleAdsBrief => ({ ...form, countryCode: form.countryCode.trim().toUpperCase(), adLanguage: form.adLanguage.trim().toLowerCase(), locations: lines(form.locations), ownerFacts: lines(form.ownerFacts), headlines: lines(form.headlines), descriptions: lines(form.descriptions), paths: lines(form.paths), keywords: lines(form.keywords), negativeKeywords: lines(form.negativeKeywords) });

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className={styles.statePanel}>{icon}<h3>{title}</h3>{children}</div>;
}

function DraftForm({ initial, busy, onSubmit, onCancel }: { initial: FormFields; busy: boolean; onSubmit: (brief: GoogleAdsBrief) => void; onCancel?: () => void }) {
  const [form, setForm] = useState(initial);
  const text = (name: keyof FormFields, label: string, extra: { type?: string; dir?: string; placeholder?: string } = {}) => <label>{label}<input value={form[name]} onChange={event => setForm(current => ({ ...current, [name]: event.target.value }))} {...extra} required /></label>;
  const area = (name: keyof FormFields, label: string, hint: string, required = true) => <label>{label}<textarea value={form[name]} rows={4} aria-describedby={`${name}-hint`} onChange={event => setForm(current => ({ ...current, [name]: event.target.value }))} required={required} /><small id={`${name}-hint`}>{hint}</small></label>;
  return <form className={styles.form} onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(toBrief(form)); }}>
    {text("businessName", "اسم النشاط")}{text("service", "الخدمة")}
    <label>الهدف<select value={form.goal} onChange={event => setForm(current => ({ ...current, goal: event.target.value as GoogleAdsBrief["goal"] }))}><option value="bookings">حجوزات</option><option value="calls">مكالمات</option><option value="leads">طلبات تواصل</option></select></label>
    {text("landingPageUrl", "صفحة الهبوط", { type: "url", dir: "ltr", placeholder: "https://" })}
    {text("dailyBudget", "الميزانية اليومية بعملة الحساب", { dir: "ltr" })}
    {text("countryCode", "رمز البلد", { dir: "ltr" })}{text("adLanguage", "لغة الإعلان", { dir: "ltr" })}
    {area("locations", "المواقع", "موقع في كل سطر، بالاسم الذي تعرفه Google.")}
    {area("ownerFacts", "حقائق تؤكدها أنت", "كل عرض أو رقم يظهر في الإعلان يجب أن يرد هنا أو في صفحة الهبوط.", false)}
    {area("headlines", "العناوين", "من 3 إلى 15، وحتى 30 حرفًا.")}
    {area("descriptions", "الأوصاف", "من 2 إلى 4، وحتى 90 حرفًا.")}
    {area("paths", "مسارات العرض", "حتى مسارين، 15 حرفًا لكل مسار.", false)}
    {area("keywords", "الكلمات المفتاحية", "broad أو \"phrase\" أو [exact]، كلمة في كل سطر.")}
    {area("negativeKeywords", "الكلمات السلبية", "كلمة في كل سطر.", false)}
    <div className={styles.formActions}><button className="primary-button" disabled={busy} type="submit">{onCancel ? "حفظ التعديل كمعاينة" : "إنشاء معاينة"}</button>{onCancel ? <button className="text-button" type="button" onClick={onCancel}>إلغاء</button> : null}</div>
  </form>;
}

function DraftDetail({ draft, status, busy, onStep, onApprove, onEdit, launchHash }: { draft: GoogleAdsDraft; status: GoogleAdsStatus; busy: boolean; onStep: (name: string) => void; onApprove: (action: "publish" | "launch") => void; onEdit: () => void; launchHash: string | null }) {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [draft.revision]);
  const summary = draft.summary, currency = status.account?.currency ?? "";
  const editable = ["preview", "draft", "rejected", "validated", "verified", "approved", "failed"].includes(draft.state);
  const canPublish = status.publishing.available;
  return <article className={styles.detail} aria-label="تفاصيل المسودة">
    <header><div><h3>{summary?.campaignName ?? draft.brief.service}</h3><small dir="ltr">{draft.customerId}</small></div><span className={styles.state}>{stateLabels[draft.state]}</span></header>
    {draft.error ? <p className="inline-error" role="alert">{draft.error}</p> : null}
    {draft.strategy ? <section><h4>الاستراتيجية</h4><ul className={styles.list}>{draft.strategy.recommendations.map(item => <li key={item.title}><Basis value={item.basis} /><div><strong>{item.title}</strong><p>{item.reason}</p><small>{item.source}</small></div></li>)}</ul>{draft.strategy.blockers.map(item => <p className={styles.blocker} key={item}><AlertTriangle size={15} />{item}</p>)}</section> : null}
    {draft.validation ? <section><h4>فحص الجودة: {draft.validation.passed ? "ناجح" : "مرفوض"}</h4>{draft.validation.issues.length ? <ul className={styles.issues}>{draft.validation.issues.map((issue, index) => <li key={index} className={issue.severity === "error" ? styles.error : styles.warning}><strong>{issue.field}</strong><span dir="auto">{issue.message}</span></li>)}</ul> : <p className={styles.note}>لا توجد ملاحظات.</p>}</section> : null}
    {draft.verification ? <section><h4>التحقق المستقل</h4><ul className={styles.checks}>{draft.verification.checks.map(check => <li key={check.id}>{check.passed ? <CheckCircle2 size={16} className={styles.pass} /> : <CircleSlash size={16} className={styles.fail} />}<div><strong>{checkLabels[check.id]}</strong><small dir="auto">{check.detail}</small></div></li>)}</ul></section> : null}
    {summary ? <section className={styles.exact}><h4>التغييرات بالضبط</h4><dl>
      <dt>الحساب</dt><dd dir="ltr">{summary.customerId}</dd><dt>الحالة عند الإنشاء</dt><dd>متوقفة، لا إنفاق</dd>
      <dt>الميزانية اليومية</dt><dd>{moneyOf(summary.dailyBudgetMicros, currency)}</dd>
      <dt>أقصى إنفاق محتمل</dt><dd>{moneyOf(summary.maxDailySpendMicros, currency)} يوميًا، {moneyOf(summary.maxMonthlySpendMicros, currency)} شهريًا</dd>
      <dt>عرض السعر</dt><dd>{biddingLabels[summary.bidding] ?? summary.bidding}</dd><dt>المواقع</dt><dd>{summary.locations.join("، ") || "لم تُحدَّد"}</dd><dt>صفحة الهبوط</dt><dd dir="ltr">{summary.finalUrl}</dd>
      <dt>العناوين</dt><dd dir="auto">{summary.headlines.join(" · ")}</dd><dt>الأوصاف</dt><dd dir="auto">{summary.descriptions.join(" · ")}</dd>
      <dt>الكلمات</dt><dd dir="auto">{summary.keywords.join(" · ")}</dd><dt>السلبية</dt><dd dir="auto">{summary.negativeKeywords.join(" · ") || "لا يوجد"}</dd>
      <dt>عدد العمليات</dt><dd>{count(summary.operationCount)}، كلها إنشاء جديد</dd>
    </dl></section> : null}
    <div className={styles.actions}>
      {draft.state === "preview" ? <button className="primary-button" disabled={busy} onClick={() => onStep("save")}>حفظ كمسودة</button> : null}
      {["draft", "rejected", "validated"].includes(draft.state) ? <button className="primary-button" disabled={busy} onClick={() => onStep("validate")}>فحص الجودة</button> : null}
      {["validated", "verified"].includes(draft.state) ? <button className="secondary-button" disabled={busy} onClick={() => onStep("verify")}>{draft.state === "verified" ? "إعادة التحقق" : "تحقق مستقل"}</button> : null}
      {draft.state === "approved" ? <button className="primary-button" disabled={busy || !canPublish} onClick={() => onStep("publish")}>نشر متوقفة</button> : null}
      {draft.state === "launch_approved" ? <button className="primary-button" disabled={busy || !canPublish} onClick={() => onStep("launch")}>إطلاق الحملة</button> : null}
      {["outcome_unknown", "publishing", "launching"].includes(draft.state) ? <button className="primary-button" disabled={busy} onClick={() => onStep("reconcile")}>قراءة الحالة من الحساب</button> : null}
      {editable ? <button className="secondary-button" disabled={busy} onClick={onEdit}>تعديل</button> : null}
      {editable ? <button className="text-button" disabled={busy} onClick={() => onStep("discard")}>حذف</button> : null}
    </div>
    {(draft.state === "verified" || (draft.state === "published" && launchHash)) ? <div className={styles.approval}>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{draft.state === "verified" ? `راجعت التغييرات أعلاه، وأوافق على إنشائها متوقفة في الحساب ${draft.customerId}.` : `أوافق على تفعيل هذه الحملة في الحساب ${draft.customerId}، وأعلم أن الإنفاق يبدأ بعدها.`}</span></label>
      <button className="primary-button" disabled={busy || !confirmed} onClick={() => onApprove(draft.state === "verified" ? "publish" : "launch")}><ShieldCheck size={15} />{draft.state === "verified" ? "أوافق على النشر" : "أوافق على الإطلاق"}</button>
      <small>الموافقة تخص هذه النسخة وحدها، تُستخدم مرة واحدة وتنتهي خلال 30 دقيقة.</small>
    </div> : null}
    {["approved", "launch_approved"].includes(draft.state) && !canPublish ? <p className={styles.blocker}><AlertTriangle size={15} />النشر مغلق حتى تكتمل البوابات أعلى الصفحة. موافقتك محفوظة ولم يُكتب شيء في الحساب.</p> : null}
  </article>;
}

function Performance({ offline, status, onChange }: { offline: boolean; status: GoogleAdsStatus; onChange: (error: unknown) => void }) {
  const [days, setDays] = useState(30), [report, setReport] = useState<GoogleAdsReport | null>(null), [items, setItems] = useState<GoogleAdsRecommendation[] | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(""), [mapping, setMapping] = useState<Record<string, string>>({}), [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await api<{ report: GoogleAdsReport; items: GoogleAdsRecommendation[] }>(`recommendations?days=${days}`);
      setReport(next.report); setItems(next.items);
    } catch (caught) { setError(errorText(caught)); onChange(caught); } finally { setLoading(false); }
  }, [days, onChange]);
  useEffect(() => { if (!offline) void load(); }, [load, offline]);
  async function saveMapping() {
    if (!report) return;
    const groups = new Map<string, string[]>();
    for (const [action, service] of Object.entries(mapping)) if (service.trim()) groups.set(service.trim(), [...(groups.get(service.trim()) ?? []), action]);
    setError("");
    try { await api("booking-map", { rules: [...groups].map(([service, conversionActions]) => ({ service, conversionActions })) }); setSaved("حُفظ ربط الحجوزات."); await load(); } catch (caught) { setError(errorText(caught)); }
  }
  const currency = report?.currency ?? status.account?.currency ?? "";
  if (!report && loading) return <Panel icon={<RefreshCw size={30} />} title="جارٍ قراءة بيانات الحساب…"><p>نقرأ الأرقام مباشرة من Google Ads.</p></Panel>;
  if (!report) return <Panel icon={<AlertTriangle size={30} />} title="تعذرت قراءة التقرير"><p role="alert">{error || "لا توجد بيانات بعد."}</p><button className="secondary-button" disabled={offline} onClick={() => void load()}>إعادة المحاولة</button></Panel>;
  return <div className={styles.stack}>
    <div className={styles.toolbar}><label>الفترة<select value={days} aria-label="فترة التقرير" onChange={event => setDays(Number(event.target.value))}>{[7, 14, 30, 90].map(value => <option key={value} value={value}>{count(value)} يومًا</option>)}</select></label><span>مرصود من Google من {report.range.start} إلى {report.range.end}</span><button className="secondary-button" disabled={offline || loading} onClick={() => void load()}><RefreshCw size={14} />تحديث</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{saved ? <p className={styles.note} role="status">{saved}</p> : null}
    {report.empty ? <Panel icon={<Megaphone size={30} />} title="لا توجد بيانات حملات في هذه الفترة"><p>لم تُرجع Google أي حملة. لن نعرض أرقامًا غير موجودة.</p></Panel> : <>
      <section className={styles.stats} aria-label="إجماليات الفترة">{[["الظهور", count(report.totals.impressions)], ["النقرات", count(report.totals.clicks)], ["التكلفة", moneyOf(report.totals.costMicros, currency)], ["التحويلات", count(report.totals.conversions)]].map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong><Basis value="observed" /></article>)}</section>
      <section className={styles.card}><h3>الحملات</h3><div className={styles.tableWrap}><table><thead><tr><th>الحملة</th><th>الحالة</th><th>الظهور</th><th>النقرات</th><th>التكلفة</th><th>التحويلات</th><th>نسبة الظهور</th></tr></thead><tbody>{report.campaigns.map(item => <tr key={item.id}><td dir="auto">{item.name}</td><td>{campaignStatus[item.status] ?? item.status}</td><td>{count(item.impressions)}</td><td>{count(item.clicks)}</td><td>{moneyOf(item.costMicros, currency)}</td><td>{count(item.conversions)}</td><td>{percent(item.searchImpressionShare)}</td></tr>)}</tbody></table></div></section>
    </>}
    {report.notes.map(note => <p className={styles.blocker} key={note}><AlertTriangle size={15} />{note}</p>)}
    {report.mismatches.length ? <section className={styles.card}><h3>عدم تطابق اللغة أو الموقع</h3><ul className={styles.list}>{report.mismatches.map(item => <li key={`${item.campaignId}-${item.kind}`}><Basis value={item.basis} /><div><strong dir="auto">{item.campaignName}</strong><p>{item.message}</p></div></li>)}</ul></section> : null}
    <section className={styles.card}><h3>الحجوزات المكتملة حسب الخدمة</h3>
      {report.bookings.services.length ? <ul className={styles.list}>{report.bookings.services.map(item => <li key={item.service}><Basis value="observed" /><div><strong dir="auto">{item.service}</strong><p>{item.status === "measured" ? `${count(item.completedBookings)} حجزًا` : "لم يُسجَّل أي تحويل في هذه الفترة"}</p></div></li>)}</ul> : <p className={styles.note}>لا يعرف Google أي تحويل يعني حجزًا مكتملًا. اربط كل إجراء بخدمته، ولن يُعد غير ذلك حجزًا.</p>}
      {report.conversionActions.length ? <div className={styles.mapping}>{report.conversionActions.filter(action => action.status === "ENABLED").map(action => <label key={action.resourceName}><span dir="auto">{action.name}<small> ({count(action.recordedConversions)})</small></span><input aria-label={`خدمة ${action.name}`} placeholder="اسم الخدمة" value={mapping[action.resourceName] ?? ""} onChange={event => setMapping(current => ({ ...current, [action.resourceName]: event.target.value }))} /></label>)}<button className="secondary-button" disabled={offline} onClick={() => void saveMapping()}>حفظ الربط</button></div> : <p className={styles.note}>لا توجد إجراءات تحويل في الحساب.</p>}
    </section>
    {items?.length ? <section className={styles.card}><h3>مقترحات تحتاج موافقتك</h3><ul className={styles.list}>{items.map(item => <li key={item.id}><Basis value={item.basis} /><div><strong dir="auto">{item.title}</strong><p>{item.reason}</p></div></li>)}</ul><small className={styles.note}>المقترحات لا تُطبَّق تلقائيًا، ولا يتغير أي شيء في الحملات الحالية.</small></section> : null}
  </div>;
}

function Market({ offline, onChange }: { offline: boolean; onChange: (error: unknown) => void }) {
  const [seeds, setSeeds] = useState(""), [locations, setLocations] = useState(""), [country, setCountry] = useState("GB"), [market, setMarket] = useState<GoogleAdsMarket | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function search(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { setMarket(await api<GoogleAdsMarket>("market", { seeds: lines(seeds), locations: lines(locations), countryCode: country.trim().toUpperCase() || null })); } catch (caught) { setError(errorText(caught)); onChange(caught); } finally { setBusy(false); }
  }
  return <div className={styles.stack}>
    <form className={styles.marketForm} onSubmit={search}><label>كلمات البداية<textarea rows={3} value={seeds} onChange={event => setSeeds(event.target.value)} required /></label><label>المواقع<textarea rows={3} value={locations} onChange={event => setLocations(event.target.value)} /></label><label>البلد<input dir="ltr" value={country} onChange={event => setCountry(event.target.value)} /></label><button className="primary-button" disabled={busy || offline} type="submit">قراءة السوق</button></form>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {market ? <>
      <section className={styles.card}><h3>عبارات بحث فعلية <Basis value="observed" /></h3>{market.searchTerms.items.length ? <div className={styles.tableWrap}><table><thead><tr><th>العبارة</th><th>النقرات</th><th>التحويلات</th></tr></thead><tbody>{market.searchTerms.items.slice(0, 25).map(item => <tr key={`${item.campaignId}-${item.term}`}><td dir="auto">{item.term}</td><td>{count(item.clicks)}</td><td>{count(item.conversions)}</td></tr>)}</tbody></table></div> : <p className={styles.note}>لا توجد عبارات بحث في آخر 30 يومًا.</p>}</section>
      <section className={styles.card}><h3>أفكار الكلمات <Basis value="estimate" /></h3>{market.keywordIdeas.status === "unavailable" ? <p className={styles.note}>{market.keywordIdeas.reason}</p> : <div className={styles.tableWrap}><table><thead><tr><th>الكلمة</th><th>بحث شهري تقديري</th><th>المنافسة</th></tr></thead><tbody>{market.keywordIdeas.items.map(item => <tr key={item.text}><td dir="auto">{item.text}</td><td>{item.avgMonthlySearches === null ? "غير متاح" : count(item.avgMonthlySearches)}</td><td dir="ltr">{item.competition ?? "—"}</td></tr>)}</tbody></table></div>}<small className={styles.note}>التقديرات من Keyword Planner وليست نتائج، ولا تعد بأي موضع في البحث.</small></section>
    </> : null}
  </div>;
}

function Drafts({ offline, status, onChange }: { offline: boolean; status: GoogleAdsStatus; onChange: (error: unknown) => void }) {
  const [items, setItems] = useState<GoogleAdsDraft[] | null>(null), [selected, setSelected] = useState(""), [mode, setMode] = useState<"view" | "new" | "edit">("view"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [launchHash, setLaunchHash] = useState<string | null>(null);
  const requestKey = useRef("");
  const load = useCallback(async () => { try { const value = await api<{ items: GoogleAdsDraft[] }>("drafts"); setItems(value.items); } catch (caught) { setError(errorText(caught)); onChange(caught); } }, [onChange]);
  useEffect(() => { if (!offline) void load(); }, [load, offline]);
  const draft = items?.find(item => item.id === selected) ?? null;
  useEffect(() => {
    setLaunchHash(null);
    if (draft?.state === "published") void api<{ hash: string | null }>(`drafts/${draft.id}/launch-hash`).then(value => setLaunchHash(value.hash)).catch(() => undefined);
  }, [draft?.id, draft?.state]);
  async function run(work: () => Promise<GoogleAdsDraft>) {
    setBusy(true); setError("");
    try { const next = await work(); setSelected(next.id); setMode("view"); await load(); } catch (caught) { setError(errorText(caught)); onChange(caught); await load(); } finally { setBusy(false); }
  }
  const create = (brief: GoogleAdsBrief) => {
    requestKey.current ||= crypto.randomUUID();
    return run(async () => { const created = await api<GoogleAdsDraft>("drafts", brief, { "idempotency-key": requestKey.current }); requestKey.current = ""; return created; });
  };
  const step = (name: string) => { if (draft) void run(() => api<GoogleAdsDraft>(`drafts/${draft.id}/${name}`, { expectedRevision: draft.revision })); };
  const approve = (action: "publish" | "launch") => {
    if (!draft) return;
    const hash = action === "publish" ? draft.draftHash : launchHash;
    if (hash) void run(() => api<GoogleAdsDraft>(`drafts/${draft.id}/approve-${action}`, { expectedRevision: draft.revision, draftHash: hash, customerId: draft.customerId }));
  };
  const revise = (brief: GoogleAdsBrief) => { if (draft) void run(() => api<GoogleAdsDraft>(`drafts/${draft.id}/revise`, { expectedRevision: draft.revision, brief })); };
  if (!items) return <Panel icon={<RefreshCw size={30} />} title="جارٍ تحميل المسودات…"><p>{error}</p></Panel>;
  return <div className={styles.stack}>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <div className={styles.toolbar}><button className="primary-button" disabled={offline || busy} onClick={() => { setMode("new"); setSelected(""); }}>حملة جديدة</button><span>المعاينة والمسودة والتحقق لا تكتب شيئًا في الحساب.</span></div>
    {mode === "new" ? <DraftForm initial={emptyForm} busy={busy || offline} onSubmit={create} onCancel={() => setMode("view")} /> : null}
    {items.length ? <div className={styles.draftList}>{items.map(item => <button key={item.id} className={item.id === selected ? styles.draftSelected : styles.draftItem} onClick={() => { setSelected(item.id); setMode("view"); }}><strong dir="auto">{item.summary?.campaignName ?? item.brief.service}</strong><small>{stateLabels[item.state]} · {dateTime(item.updatedAt)}</small></button>)}</div> : mode === "view" ? <Panel icon={<Megaphone size={30} />} title="لا توجد مسودات بعد"><p>أنشئ حملة من هنا، أو اطلبها في المحادثة وستصل معاينتها إلى هذه القائمة.</p></Panel> : null}
    {draft && mode === "edit" ? <DraftForm key={draft.revision} initial={toForm(draft.brief)} busy={busy || offline} onSubmit={revise} onCancel={() => setMode("view")} /> : null}
    {draft && mode === "view" ? <DraftDetail draft={draft} status={status} busy={busy || offline} launchHash={launchHash} onStep={step} onApprove={approve} onEdit={() => setMode("edit")} /> : null}
  </div>;
}

function History({ offline }: { offline: boolean }) {
  const [items, setItems] = useState<GoogleAdsAuditEntry[] | null>(null), [error, setError] = useState("");
  useEffect(() => { if (!offline) void api<{ items: GoogleAdsAuditEntry[] }>("audit").then(value => setItems(value.items)).catch(caught => setError(errorText(caught))); }, [offline]);
  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (!items) return <Panel icon={<RefreshCw size={30} />} title="جارٍ تحميل السجل…"><p /></Panel>;
  return <section className={styles.card}><h3>سجل التدقيق</h3>{items.length ? <ol className={styles.audit}>{items.map(item => <li key={item.id}><span>{auditLabels[item.type] ?? item.type}</span><time>{dateTime(item.createdAt)}</time></li>)}</ol> : <p className={styles.note}>لا توجد أحداث بعد.</p>}</section>;
}

const tabs = [["performance", "الأداء"], ["market", "السوق"], ["drafts", "الحملات"], ["history", "السجل"]] as const;
type Tab = (typeof tabs)[number][0];
const oauthMessages: Record<string, string> = { connected: "اكتمل تفويض Google.", denied: "لم تكتمل الموافقة في Google.", failed: "تعذر إكمال الربط. حاول مجددًا.", signin: "سجل الدخول ثم أعد الربط." };

export function GoogleAdsWorkspace({ offline }: { offline: boolean }) {
  const [status, setStatus] = useState<GoogleAdsStatus | null>(null), [accounts, setAccounts] = useState<GoogleAdsAccountOption[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [tab, setTab] = useState<Tab>("performance"), [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try { setStatus(await api<GoogleAdsStatus>("status")); setFailed(false); } catch (caught) { setError(errorText(caught)); setFailed(true); }
  }, []);
  useEffect(() => {
    const result = new URLSearchParams(location.search).get("googleAds");
    if (result) { setNotice(oauthMessages[result] ?? ""); history.replaceState(null, "", location.pathname + location.hash); }
    if (!offline) void load();
  }, [load, offline]);
  useEffect(() => {
    if (status?.state !== "needs_account") return;
    void api<{ items: GoogleAdsAccountOption[] }>("accounts").then(value => setAccounts(value.items)).catch(caught => { setError(errorText(caught)); void load(); });
  }, [status?.state, load]);
  const onChange = useCallback((caught: unknown) => { if (caught instanceof AdsError && [401, 429].includes(caught.status)) void load(); }, [load]);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  }
  const connect = () => act(async () => { location.assign((await api<{ authorizationUrl: string }>("connect", {})).authorizationUrl); });
  const select = (account: GoogleAdsAccountOption) => act(async () => { setStatus(await api<GoogleAdsStatus>("accounts/select", { customerId: account.customerId, loginCustomerId: account.loginCustomerId })); });
  const disconnect = () => act(async () => { setStatus(await api<GoogleAdsStatus>("disconnect", {})); setAccounts(null); });

  return <section className={styles.workspace} aria-label="Google Ads">
    <div className={styles.intro}><div><span>GOOGLE ADS API</span><h2>قرارات إعلانية بأدلة.</h2><p>نقرأ الأرقام من Google مباشرة، ونفصلها عن التقديرات والافتراضات. لا شيء يُكتب في حسابك قبل موافقتك على تغييرات محددة.</p></div><ShieldCheck size={30} /></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}{notice ? <p className={styles.note} role="status">{notice}</p> : null}
    {offline ? <Panel icon={<Unplug size={30} />} title="الخدمة غير متصلة"><p>أعد الاتصال ثم حدّث الصفحة.</p></Panel>
      : failed ? <Panel icon={<AlertTriangle size={30} />} title="تعذرت قراءة حالة الربط"><button className="secondary-button" onClick={() => void load()}>إعادة المحاولة</button></Panel>
      : !status ? <Panel icon={<RefreshCw size={30} />} title="جارٍ قراءة حالة الربط…"><p>لحظة من فضلك.</p></Panel>
      : status.state === "not_configured" ? <Panel icon={<KeyRound size={30} />} title="يحتاج الخادم إعداد Google Cloud"><p>{status.message} أضف هذه الإعدادات إلى ملف البيئة ثم أعد تشغيل الخدمة:</p><ul className={styles.settings}>{status.missingSettings.map(name => <li key={name}><code dir="ltr">{name}</code></li>)}</ul><small>الخطوات في <code dir="ltr">docs/GOOGLE-ADS.md</code>.</small></Panel>
      : status.state === "disconnected" ? <Panel icon={<Link2 size={30} />} title="اربط حساب Google Ads"><p>ستنتقل إلى صفحة Google الرسمية للموافقة. لا نرى كلمة مرورك، ويبقى التفويض مشفرًا على الخادم.</p><button className="primary-button" disabled={busy} onClick={() => void connect()}>الربط مع Google</button></Panel>
      : status.state === "unauthorized" ? <Panel icon={<KeyRound size={30} />} title="انتهى تفويض Google"><p>{status.message}</p><button className="primary-button" disabled={busy} onClick={() => void connect()}>إعادة الربط</button></Panel>
      : status.state === "needs_account" ? <Panel icon={<Megaphone size={30} />} title="اختر حساب الإعلانات"><p>{status.message}</p>{accounts ? accounts.length ? <div className={styles.accounts}>{accounts.map(account => <button key={account.customerId} disabled={busy || account.manager} onClick={() => void select(account)}><strong dir="auto">{account.name}</strong><small dir="ltr">{account.customerId} · {account.currency}</small><small>{account.manager ? "حساب مدير، لا يحمل حملات" : account.testAccount ? "حساب تجريبي" : "حساب حقيقي"}</small></button>)}</div> : <p>لا يصل حساب Google هذا إلى أي حساب إعلانات.</p> : <p>جارٍ قراءة الحسابات…</p>}<button className="text-button" disabled={busy} onClick={() => void disconnect()}>إلغاء الربط</button></Panel>
      : <>
        {status.state === "rate_limited" ? <p className={styles.blocker} role="status"><Clock size={15} />{status.message}{status.retryAfterSeconds ? ` أعد المحاولة بعد ${count(status.retryAfterSeconds)} ثانية.` : ""}</p> : null}
        <div className={styles.account}><div><strong dir="auto">{status.account?.name}</strong><small dir="ltr">{status.account?.customerId} · {status.account?.currency}</small></div><button className="text-button" disabled={busy} onClick={() => void disconnect()}>إلغاء الربط</button></div>
        <section className={styles.gates} aria-label="بوابات النشر"><h3>{status.publishing.available ? "النشر متاح بموافقتك" : "النشر مغلق"}</h3><ul>{status.publishing.gates.map(gate => <li key={gate.id}>{gate.passed ? <CheckCircle2 size={15} className={styles.pass} /> : <CircleSlash size={15} className={styles.fail} />}<div><strong>{gateLabels[gate.id] ?? gate.id}</strong><small>{gate.detail}</small></div></li>)}</ul></section>
        <div className={styles.tabs} role="tablist" aria-label="أقسام Google Ads">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? styles.tabActive : styles.tab} onClick={() => setTab(id)}>{label}</button>)}</div>
        {tab === "performance" ? <Performance offline={offline} status={status} onChange={onChange} /> : null}
        {tab === "market" ? <Market offline={offline} onChange={onChange} /> : null}
        {tab === "drafts" ? <Drafts offline={offline} status={status} onChange={onChange} /> : null}
        {tab === "history" ? <History offline={offline} /> : null}
      </>}
  </section>;
}
