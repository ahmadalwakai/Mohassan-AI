"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { Check, Download, ExternalLink, Globe, ImagePlus, Monitor, Plus, RefreshCw, Smartphone, Tablet, Trash2, Undo2, Upload, X } from "lucide-react";
import type { SiteBrief, SiteDetail, SiteSummary, SiteWant } from "@mohassan/contracts";
import styles from "./sites-workspace.module.css";

/**
 * The sites panel: every site Mohassan built for this account, a live preview at three widths, plain-language
 * edits, the brief's fields, images, checks, ZIP download and publishing. No model anywhere: the server composes
 * the site from the brief, and this panel only shows and edits that brief.
 */
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(parsed?.error?.message ?? parsed?.message ?? "تعذر إتمام الطلب. حاول مجددًا."), { status: response.status, code: parsed?.error?.code });
  return parsed as T;
}
const text = (caught: unknown) => (caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة.");
const DEVICES = [{ id: "phone", width: 375, label: "هاتف", Icon: Smartphone }, { id: "tablet", width: 768, label: "لوحي", Icon: Tablet }, { id: "desktop", width: 1280, label: "حاسوب", Icon: Monitor }] as const;
const KINDS: { id: SiteBrief["kind"]; label: string }[] = [{ id: "services", label: "خدمات" }, { id: "restaurant", label: "مطعم أو كافيه" }, { id: "clinic", label: "عيادة" }, { id: "catalogue", label: "متجر أو منتجات" }, { id: "portfolio", label: "معرض أعمال" }, { id: "landing", label: "صفحة هبوط لعرض واحد" }];
const MOODS: { id: SiteBrief["mood"]; label: string }[] = [{ id: "calm", label: "هادئ" }, { id: "warm", label: "دافئ" }, { id: "bold", label: "جريء" }];
const GOALS: { id: SiteBrief["goal"]; label: string }[] = [{ id: "call", label: "اتصال" }, { id: "whatsapp", label: "واتساب" }, { id: "email", label: "بريد" }, { id: "order", label: "طلب عبر واتساب" }, { id: "book", label: "حجز موعد" }];
const EXAMPLES = ["غيّر اللون إلى أزرق", "أضف خدمة … - 50", "احذف خدمة …", "أضف قسم الفريق", "أضف قسم الأسئلة الشائعة", "أضف صفحة …: …", "ساعات العمل: …", "اجعله صفحة واحدة", "اجعله أجرأ", "اجعله بالإنجليزية", "تراجع"];
const WANT_LABELS: Record<string, string> = { about: "نص «من نحن»", team: "أعضاء الفريق", faq: "الأسئلة وأجوبتها", pricing: "الباقات", projects: "المشاريع", features: "المميزات", steps: "خطوات العمل", facts: "الأرقام", testimonials: "آراء العملاء", posts: "الأخبار", hours: "ساعات العمل", address: "العنوان ورابط الخريطة" };

function Preview({ site, device, page }: { site: SiteDetail; device: (typeof DEVICES)[number]; page: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const node = wrap.current; if (!node) return;
    const measure = () => setScale(Math.min(1, (node.clientWidth - 2) / device.width));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [device.width]);
  const height = 760;
  return <div ref={wrap} className={styles.frameWrap} style={{ height: Math.round(height * scale) + 2 }}>
    <iframe key={`${site.revision}-${page}-${device.id}`} className={styles.frame} title={`معاينة ${site.name}`} src={`${site.previewPath}${page}`} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" style={{ width: device.width, height, transform: `translateX(-50%) scale(${scale})` }} />
  </div>;
}

function BriefForm({ site, offline, onSaved, onError }: { site: SiteDetail; offline: boolean; onSaved: (detail: SiteDetail) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState(site.brief);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(site.brief), [site.brief, site.revision]);
  const set = <K extends keyof SiteBrief>(key: K, value: SiteBrief[K]) => setDraft(current => ({ ...current, [key]: value }));
  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { onSaved(await api<SiteDetail>(`/api/sites/${site.id}/brief`, { body: { brief: draft, revision: site.revision } })); } catch (caught) { onError(text(caught)); } finally { setBusy(false); }
  };
  const field = (label: string, key: "name" | "tagline" | "city" | "address" | "phone" | "whatsapp" | "email" | "mapUrl", placeholder = "") => <label className={styles.field}><span>{label}</span><input value={draft[key] ?? ""} placeholder={placeholder} onChange={event => set(key, (key === "name" ? event.target.value : optional(event.target.value)) as never)} /></label>;
  return <form className={styles.pane} onSubmit={submit}>
    <div className={styles.form}>
      {field("الاسم", "name")}
      {field("جملة تعريفية", "tagline", "اختياري")}
      {field("المدينة", "city")}
      {field("العنوان", "address")}
      {field("الهاتف", "phone", "أرقام فقط")}
      {field("واتساب", "whatsapp", "أرقام فقط")}
      {field("البريد", "email")}
      {field("رابط الخريطة", "mapUrl", "https://maps.app.goo.gl/…")}
      <label className={styles.field}><span>اللون الأساسي</span><input type="color" value={draft.primary} onChange={event => set("primary", event.target.value)} /></label>
      <label className={styles.field}><span>طابع التصميم</span><select value={draft.mood} onChange={event => set("mood", event.target.value as SiteBrief["mood"])}>{MOODS.map(mood => <option key={mood.id} value={mood.id}>{mood.label}</option>)}</select></label>
      <label className={styles.field}><span>الزر الرئيسي</span><select value={draft.goal} onChange={event => set("goal", event.target.value as SiteBrief["goal"])}>{GOALS.map(goal => <option key={goal.id} value={goal.id}>{goal.label}</option>)}</select></label>
      <label className={styles.field}><span>اللغة</span><select value={draft.lang} onChange={event => set("lang", event.target.value as SiteBrief["lang"])}><option value="ar">العربية</option><option value="en">English</option></select></label>
      <label className={`${styles.field} ${styles.wide}`}><span>ساعات العمل (سطر لكل فترة)</span><textarea rows={3} value={(draft.hours ?? []).join("\n")} onChange={event => set("hours", event.target.value.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 7) as never)} /></label>
    </div>
    <p className={styles.help}>الخدمات والأقسام والصفحات تُعدَّل من تبويب «تعديل بالكلام»: «أضف خدمة …»، «أضف قسم الفريق»، «أضف صفحة …».</p>
    <div className={styles.actions}><Button className="primary-button" type="submit" disabled={busy || offline}>{busy ? <Spinner size="sm" /> : <Check size={16} />}حفظ وإعادة التوليد</Button></div>
  </form>;
}

function Images({ site, offline, onChanged, onError }: { site: SiteDetail; offline: boolean; onChanged: (detail: SiteDetail) => void; onError: (message: string) => void }) {
  const [alt, setAlt] = useState("");
  const [role, setRole] = useState<"hero" | "gallery" | "about" | "team">("gallery");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!alt.trim()) { onError("اكتب وصف الصورة (النص البديل) قبل رفعها."); event.target.value = ""; return; }
    if (!["image/png", "image/jpeg"].includes(file.type)) { onError("يُقبل PNG أو JPEG فقط."); event.target.value = ""; return; }
    if (file.size > 1_048_576) { onError("حجم الصورة الأقصى 1MB."); event.target.value = ""; return; }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolveValue, reject) => { const reader = new FileReader(); reader.onload = () => resolveValue(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      onChanged(await api<SiteDetail>(`/api/sites/${site.id}/images`, { body: { mimeType: file.type, data, alt: alt.trim(), role } }));
      setAlt("");
    } catch (caught) { onError(text(caught)); } finally { setBusy(false); event.target.value = ""; }
  };
  const remove = async (imageId: string) => { setBusy(true); try { onChanged(await api<SiteDetail>(`/api/sites/${site.id}/images/${imageId}`, { method: "DELETE" })); } catch (caught) { onError(text(caught)); } finally { setBusy(false); } };
  return <div className={styles.pane}>
    <div className={styles.upload}>
      <label className={styles.field}><span>وصف الصورة</span><input value={alt} onChange={event => setAlt(event.target.value)} placeholder="مثلاً: واجهة المطعم من الخارج" /></label>
      <label className={styles.field}><span>مكانها</span><select value={role} onChange={event => setRole(event.target.value as typeof role)}><option value="gallery">المعرض</option><option value="hero">الواجهة</option><option value="about">من نحن</option><option value="team">الفريق</option></select></label>
      <input ref={input} type="file" accept="image/png,image/jpeg" hidden onChange={upload} />
      <Button className="primary-button" disabled={busy || offline} onClick={() => input.current?.click()}>{busy ? <Spinner size="sm" /> : <ImagePlus size={16} />}رفع صورة</Button>
    </div>
    <p className={styles.help}>PNG أو JPEG حتى 1MB، وحتى 12 صورة للموقع. الصور تظهر فقط حيث اخترت مكانها؛ لا صور من مصادر خارجية.</p>
    {site.images.length ? <div className={styles.images}>{site.images.map(image => <figure key={image.id} className={styles.image}><img src={`${site.previewPath}assets/${image.id}.${image.ext}`} alt={image.alt} /><figcaption>{image.alt} · {image.role}</figcaption><Button size="xs" variant="outline" disabled={busy || offline} onClick={() => remove(image.id)}><Trash2 size={13} />حذف</Button></figure>)}</div> : <p className={styles.help}>لا صور بعد.</p>}
  </div>;
}

function NewSiteForm({ offline, onCreated, onCancel }: { offline: boolean; onCreated: (detail: SiteDetail) => void; onCancel: () => void }) {
  const [lang, setLang] = useState<"ar" | "en">("ar");
  const [kind, setKind] = useState<SiteBrief["kind"]>("services");
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [answers, setAnswers] = useState<Partial<Record<SiteWant, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = (want: SiteWant) => (value: string) => setAnswers(current => ({ ...current, [want]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<SiteDetail | { missing: SiteWant[] }>("/api/sites/draft", { body: { lang, kind, name: name.trim(), request: request.trim() || undefined, answers: Object.fromEntries(Object.entries(answers).filter(([, value]) => value && value.trim())) } });
      if ("missing" in result) { setError(`ينقص: ${result.missing.map(want => ({ name: "الاسم", kind: "النوع", contact: "وسيلة تواصل" })[want as string] ?? want).join("، ")}.`); return; }
      onCreated(result);
    } catch (caught) { setError(text(caught)); } finally { setBusy(false); }
  };
  return <form className={styles.newForm} onSubmit={submit}>
    <div className={styles.form}>
      <label className={styles.field}><span>اللغة</span><select value={lang} onChange={event => setLang(event.target.value as "ar" | "en")}><option value="ar">العربية</option><option value="en">English</option></select></label>
      <label className={styles.field}><span>نوع الموقع</span><select value={kind} onChange={event => setKind(event.target.value as SiteBrief["kind"])}>{KINDS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className={`${styles.field} ${styles.wide}`}><span>الاسم كما يظهر في الموقع</span><input required value={name} onChange={event => setName(event.target.value)} /></label>
      <label className={`${styles.field} ${styles.wide}`}><span>ماذا تقدّم؟ خدمة أو صنف أو منتج في كل سطر، والسعر بعد شرطة إن أردت</span><textarea rows={4} value={answers.items ?? ""} onChange={event => answer("items")(event.target.value)} placeholder={"تنظيف السجاد - 50\nنقل أثاث"} /></label>
      <label className={`${styles.field} ${styles.wide}`}><span>التواصل: رقم الهاتف، وكلمة «واتساب» بجانبه إن كان عليه، وبريدك إن أردت</span><textarea rows={2} required value={answers.contact ?? ""} onChange={event => answer("contact")(event.target.value)} placeholder={"0501234567 واتساب\ninfo@example.com"} /></label>
      <label className={styles.field}><span>المدينة (اختياري)</span><input value={answers.city ?? ""} onChange={event => answer("city")(event.target.value)} /></label>
      <label className={styles.field}><span>اللون (اسم أو رمز، اختياري)</span><input value={answers.colour ?? ""} onChange={event => answer("colour")(event.target.value)} placeholder="أزرق أو #1d4ed8" /></label>
      <label className={`${styles.field} ${styles.wide}`}><span>أقسام إضافية تريدها (اختياري): اكتبها كما تقولها، مثل «فريق، أسئلة شائعة، أسعار، معرض، نموذج تواصل، خريطة، صفحة واحدة»</span><input value={request} onChange={event => setRequest(event.target.value)} /></label>
    </div>
    <p className={styles.help}>بعد الإنشاء يمكنك إضافة محتوى الأقسام (الفريق، الأسئلة، الباقات…) من «تعديل بالكلام»، وسيسألك موحسن عمّا يحتاجه بدل أن يخترعه.</p>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <div className={styles.actions}><Button className="primary-button" type="submit" disabled={busy || offline}>{busy ? <Spinner size="sm" /> : <Plus size={16} />}إنشاء الموقع</Button><Button variant="outline" onClick={onCancel}><X size={16} />إلغاء</Button></div>
  </form>;
}

export function SitesWorkspace({ offline, initialSiteId }: { offline: boolean; initialSiteId?: string | null }) {
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [publish, setPublish] = useState<{ available: boolean; provider: string }>({ available: false, provider: "none" });
  const [selected, setSelected] = useState<string | null>(initialSiteId ?? null);
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [device, setDevice] = useState<(typeof DEVICES)[number]>(DEVICES[2]);
  const [page, setPage] = useState("index.html");
  const [tab, setTab] = useState<"talk" | "brief" | "images" | "checks">("talk");
  const [command, setCommand] = useState("");
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<{ want: SiteWant; title?: string; summary: string; answer: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ sites: SiteSummary[]; publish: { available: boolean; provider: string } }>("/api/sites")
      .then(result => { if (!active) return; setSites(result.sites); setPublish(result.publish); setSelected(current => current ?? result.sites[0]?.id ?? null); })
      .catch(caught => { if (active) setError(text(caught)); });
    return () => { active = false; };
  }, []);
  // A site link from the chat while this view is open switches to that site.
  useEffect(() => { if (initialSiteId) { setCreating(false); setSelected(initialSiteId); } }, [initialSiteId]);
  useEffect(() => {
    if (!selected) { setSite(null); return; }
    let active = true;
    api<SiteDetail>(`/api/sites/${selected}`).then(detail => { if (active) { setSite(detail); setPage("index.html"); setAsk(null); setNote(""); } }).catch(caught => { if (active) setError(text(caught)); });
    return () => { active = false; };
  }, [selected]);
  const apply = useCallback((detail: SiteDetail) => { setSite(detail); setError(""); setSites(current => current ? [detail, ...current.filter(item => item.id !== detail.id)].map(item => item.id === detail.id ? { id: detail.id, name: detail.name, slug: detail.slug, kind: detail.kind, lang: detail.lang, status: detail.status, revision: detail.revision, publishedUrl: detail.publishedUrl, createdAt: detail.createdAt, updatedAt: detail.updatedAt } : item) : current); }, []);

  const run = async (textValue: string, want?: SiteWant) => {
    if (!site || !textValue.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ kind: "patch" | "undo" | "ask" | "unknown"; summary: string; want?: SiteWant; title?: string; detail: SiteDetail }>(`/api/sites/${site.id}/commands`, { body: { text: textValue.trim(), ...(want ? { want } : {}) } });
      if (result.kind === "ask" && result.want) { setAsk({ want: result.want, title: result.title, summary: result.summary, answer: "" }); setNote(""); }
      else if (result.kind === "unknown") { setNote(result.summary || "لم أفهم هذا الأمر. جرّب أحد الأمثلة أدناه."); }
      else { apply(result.detail); setNote(result.summary); setAsk(null); setCommand(""); }
    } catch (caught) { setError(text(caught)); } finally { setBusy(false); }
  };
  const download = async () => {
    if (!site) return; setBusy(true);
    try { const response = await fetch(`/api/sites/${site.id}/export`, { credentials: "same-origin", cache: "no-store" }); if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "تعذر التحميل."); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${site.slug}.zip`; anchor.click(); URL.revokeObjectURL(url); } catch (caught) { setError(text(caught)); } finally { setBusy(false); }
  };
  const doPublish = async () => {
    if (!site) return;
    if (!window.confirm(`سيصبح موقع «${site.name}» عامًا على الإنترنت عبر ${publish.provider === "vercel" ? "Vercel" : "المزود المهيأ"}. هل تريد النشر الآن؟`)) return;
    setBusy(true); setError("");
    try { apply(await api<SiteDetail>(`/api/sites/${site.id}/publish`, { body: {} })); setNote("نُشر الموقع."); } catch (caught) { setError(text(caught)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!site || !window.confirm(`حذف موقع «${site.name}» نهائيًا من هذه القائمة؟ النسخة المنشورة (إن وُجدت) تبقى على المزود.`)) return;
    setBusy(true);
    try { await api(`/api/sites/${site.id}`, { method: "DELETE" }); setSites(current => current ? current.filter(item => item.id !== site.id) : current); setSelected(null); setSite(null); } catch (caught) { setError(text(caught)); } finally { setBusy(false); }
  };
  const undo = async () => { if (!site) return; setBusy(true); try { apply(await api<SiteDetail>(`/api/sites/${site.id}/undo`, { body: {} })); setNote("تراجعت عن آخر تعديل."); } catch (caught) { setError(text(caught)); } finally { setBusy(false); } };
  const failing = useMemo(() => site?.checks.checks.filter(check => !check.passed) ?? [], [site]);

  return <div className={styles.shell}>
    <aside className={styles.list}>
      <Button className="primary-button" disabled={offline} onClick={() => { setCreating(true); setSelected(null); }}><Plus size={16} />موقع جديد</Button>
      {sites === null ? <Spinner size="sm" /> : sites.length === 0 && !creating ? <p className={styles.help}>لا مواقع بعد. اكتب في المحادثة «ابنِ لي موقعاً لـ…» أو أنشئ واحداً من هنا.</p> : sites.map(item => <button key={item.id} type="button" className={`${styles.siteButton} ${item.id === selected ? styles.siteActive : ""}`} onClick={() => { setCreating(false); setSelected(item.id); }}><strong>{item.name}</strong><small>{KINDS.find(kind => kind.id === item.kind)?.label} · {item.lang === "ar" ? "عربي" : "English"} · نسخة {item.revision}{item.publishedUrl ? " · منشور" : ""}</small></button>)}
    </aside>
    <section className={styles.main}>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {creating ? <NewSiteForm offline={offline} onCreated={detail => { setCreating(false); apply(detail); setSelected(detail.id); setSites(current => [detail, ...(current ?? []).filter(item => item.id !== detail.id)]); }} onCancel={() => setCreating(false)} /> : null}
      {!creating && !site ? <div className={styles.empty}>{sites?.length ? <Spinner size="sm" /> : <><Globe size={28} /><p>اختر موقعاً أو أنشئ موقعاً جديداً.</p></>}</div> : null}
      {!creating && site ? <>
        <div className={styles.toolbar}>
          <div className={styles.group}>
            <div className={styles.seg}>{DEVICES.map(item => <button key={item.id} type="button" className={item.id === device.id ? styles.on : ""} onClick={() => setDevice(item)}><item.Icon size={15} />{item.label}</button>)}</div>
            <div className={styles.pages}>{site.pages.map(item => <button key={item.path} type="button" className={item.path === page ? styles.on : ""} onClick={() => setPage(item.path)}>{item.title}</button>)}</div>
          </div>
          <div className={styles.group}>
            <Button size="sm" variant="outline" disabled={busy || offline} onClick={download}><Download size={15} />تنزيل ZIP</Button>
            <Button size="sm" variant="outline" disabled={busy || offline || !site.canUndo} onClick={undo}><Undo2 size={15} />تراجع</Button>
            <Button size="sm" variant="outline" disabled={busy || offline} onClick={async () => { setBusy(true); try { apply(await api<SiteDetail>(`/api/sites/${site.id}/regenerate`, { body: {} })); } catch (caught) { setError(text(caught)); } finally { setBusy(false); } }}><RefreshCw size={15} />إعادة التوليد</Button>
            {publish.available ? <Button size="sm" className="primary-button" disabled={busy || offline} onClick={doPublish}><Upload size={15} />{site.publishedUrl ? "إعادة النشر" : "نشر"}</Button> : null}
            <Button size="sm" variant="ghost" disabled={busy || offline} onClick={remove} aria-label="حذف الموقع"><Trash2 size={15} /></Button>
          </div>
        </div>
        {site.publishedUrl ? <a className={styles.published} href={site.publishedUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />{site.publishedUrl}</a> : null}
        <Preview site={site} device={device} page={page} />
        <nav className={styles.tabs} aria-label="أقسام الموقع">
          {([["talk", "تعديل بالكلام"], ["brief", "البيانات"], ["images", "الصور"], ["checks", `الفحوص${failing.length ? ` (${failing.length})` : ""}`]] as const).map(([id, label]) => <button key={id} type="button" className={tab === id ? styles.on : ""} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        {tab === "talk" ? <div className={styles.pane}>
          <form className={styles.commandRow} onSubmit={event => { event.preventDefault(); void run(command); }}>
            <input value={command} onChange={event => setCommand(event.target.value)} placeholder="اكتب التعديل بكلماتك: غيّر اللون إلى أزرق…" aria-label="أمر التعديل" />
            <Button className="primary-button" type="submit" disabled={busy || offline || !command.trim()}>{busy ? <Spinner size="sm" /> : <Check size={16} />}نفّذ</Button>
          </form>
          <div className={styles.examples}>{EXAMPLES.map(example => <button key={example} type="button" onClick={() => setCommand(example)}>{example}</button>)}</div>
          {note ? <p className={styles.note}>{note}</p> : null}
          {ask ? <div className={styles.ask}>
            <strong>{WANT_LABELS[ask.want] ?? ask.want}{ask.title ? ` — ${ask.title}` : ""}</strong>
            <p className={styles.help}>{ask.summary}</p>
            <textarea aria-label={`محتوى ${WANT_LABELS[ask.want] ?? ask.want}`} value={ask.answer} onChange={event => setAsk({ ...ask, answer: event.target.value })} />
            <div className={styles.actions}><Button className="primary-button" disabled={busy || offline || !ask.answer.trim()} onClick={() => void run(ask.answer, ask.want)}><Check size={16} />أضف</Button><Button variant="outline" onClick={() => setAsk(null)}>إلغاء</Button></div>
          </div> : null}
        </div> : null}
        {tab === "brief" ? <BriefForm site={site} offline={offline} onSaved={detail => { apply(detail); setNote("حُفظت البيانات وأُعيد توليد الموقع."); }} onError={setError} /> : null}
        {tab === "images" ? <Images site={site} offline={offline} onChanged={apply} onError={setError} /> : null}
        {tab === "checks" ? <div className={styles.pane}>
          <p className={styles.help}>{site.checks.passed ? "اجتاز الموقع كل الفحوص الآلية." : "بعض الفحوص لم تجتز؛ راجعها أدناه."} الحجم {Math.round(site.checks.bytes / 1024)} كيلوبايت في {site.checks.pages} صفحات.</p>
          <ul className={styles.checks}>{site.checks.checks.map(check => <li key={check.id}>{check.passed ? <Check className={styles.pass} size={16} /> : <X className={styles.fail} size={16} />}<span>{check.message}</span></li>)}</ul>
        </div> : null}
      </> : null}
    </section>
  </div>;
}
