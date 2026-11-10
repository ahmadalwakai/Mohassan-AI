"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { ArrowRight, Check, Copy, LogOut, MessageCircle, UserPlus } from "lucide-react";
import dynamic from "next/dynamic";
import styles from "./members.module.css";

const GoogleAdsWorkspace = dynamic(() => import("./google-ads-workspace").then(module => module.GoogleAdsWorkspace));

export type Access = { user: { id: string; name: string; email: string }; role: "owner" | "member"; services: string[]; quota?: { dailyRuns: number; used: number } };
type Session = { user: { id: string; name: string; email: string } };
type Member = { id: string; name: string; email: string; joinedAt: string; disabled: boolean; runsToday: number };
type Invite = { id: string; name: string; email: string; createdAt: string; expiresAt: string };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(parsed?.error?.message ?? "تعذر إتمام الطلب. حاول مجددًا."), { status: response.status });
  return parsed as T;
}
const message = (caught: unknown) => caught instanceof Error ? caught.message : "تعذر الاتصال بالخدمة.";
const day = (value: string) => new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(value));

/** Opened from an invite link. The token lives in the URL fragment and is sent only in a request body. */
export function InviteScreen({ token, onDone, onCancel }: { token: string; onDone: (session: Session) => void; onCancel: () => void }) {
  const [invite, setInvite] = useState<{ name: string; email: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ name: string; email: string }>("/api/invites/inspect", { token })
      .then(value => { if (active) { setInvite(value); setState("ready"); } })
      .catch(caught => { if (active) { setError(message(caught)); setState("invalid"); } });
    return () => { active = false; };
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !invite) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? ""), confirm = String(values.get("confirm") ?? "");
    if (password !== confirm) { setError("كلمتا المرور غير متطابقتين."); return; }
    setBusy(true); setError("");
    try {
      await api("/api/invites/accept", { token, name: String(values.get("name") ?? ""), password });
      await api("/api/auth/sign-in/email", { email: invite.email, password });
      const session = await api<Session | null>("/api/auth/get-session");
      if (!session?.user) throw new Error("أُنشئ حسابك. سجّل الدخول ببريدك وكلمة المرور.");
      onDone(session);
    } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-form-panel"><div className="auth-form-wrap">
    <h2>انضم إلى موحسن</h2>
    {state === "loading" ? <Spinner size="md" /> : null}
    {state === "invalid" ? <><p className="inline-error" role="alert">{error}</p><Button className={styles.secondary} onClick={onCancel}>الذهاب لتسجيل الدخول</Button></> : null}
    {state === "ready" && invite ? <>
      <p className="muted">أنشئ كلمة مرورك لحساب <bdi dir="ltr">{invite.email}</bdi>.</p>
      <form onSubmit={submit} className="stack-form">
        <label>الاسم<input name="name" autoComplete="name" required minLength={2} maxLength={80} defaultValue={invite.name} /></label>
        <label>كلمة المرور<input name="password" type="password" dir="ltr" autoComplete="new-password" required minLength={12} maxLength={128} placeholder="12 حرفًا على الأقل" /></label>
        <label>تأكيد كلمة المرور<input name="confirm" type="password" dir="ltr" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <Button type="submit" className="primary-button" disabled={busy}>{busy ? <Spinner size="sm" /> : <Check size={16} />}إنشاء الحساب</Button>
      </form>
    </> : null}
  </div></section></main>;
}

/** The owner's list of invited people. */
export function MembersPanel({ offline }: { offline: boolean }) {
  const [data, setData] = useState<{ members: Member[]; invites: Invite[]; dailyRuns: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api("/api/members")); setError(""); } catch (caught) { setError(message(caught)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await run(); await load(); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form);
    const email = String(values.get("email") ?? "");
    await act(async () => {
      const created = await api<{ url: string }>("/api/members/invites", { name: values.get("name"), email });
      setLink({ email, url: created.url }); setCopied(false); form.reset();
    });
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); }
  }
  return <div className={styles.stack}>
    <section className="panel"><div className="panel-heading"><div><h2>دعوة شخص جديد</h2><p>يحصل على المحادثة وبحثه وذاكرته وحساب Google Ads الخاص به فقط، ولا يصل إلى جهازك أو مشاريعك.</p></div></div>
      <form className={`stack-form ${styles.form}`} onSubmit={create}>
        <div className={styles.row}>
          <label>الاسم<input name="name" required minLength={2} maxLength={80} placeholder="اسم الشخص" /></label>
          <label>البريد الإلكتروني<input name="email" type="email" dir="ltr" required maxLength={254} placeholder="name@example.com" /></label>
        </div>
        <Button type="submit" className="primary-button" disabled={busy || offline}><UserPlus size={16} />إنشاء رابط دعوة</Button>
      </form>
      {link ? <div className={styles.link}>
        <p>أرسل هذا الرابط إلى <bdi dir="ltr">{link.email}</bdi> بنفسك. يعمل مرة واحدة خلال 7 أيام، ولن يظهر مجددًا.</p>
        <div className={styles.copy}><code dir="ltr">{link.url}</code><Button className={styles.secondary} onClick={() => { void copy(); }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "نُسخ" : "نسخ"}</Button></div>
      </div> : null}
    </section>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <section className="panel"><div className="panel-heading"><div><h2>الأعضاء</h2><p>{data ? `حد كل عضو ${data.dailyRuns} طلبًا في 24 ساعة.` : "…"}</p></div></div>
      {!data ? <div className={styles.empty}><Spinner size="sm" /></div> : data.members.length ? <ul className={styles.list}>{data.members.map(member => <li key={member.id}>
        <div><strong>{member.name}</strong><small dir="ltr">{member.email}</small><small>انضم {day(member.joinedAt)} · {member.runsToday} طلبًا اليوم{member.disabled ? " · موقوف" : ""}</small></div>
        <Button className={styles.secondary} disabled={busy || offline} onClick={() => { void act(() => api(`/api/members/${encodeURIComponent(member.id)}/access`, { enabled: member.disabled })); }}>{member.disabled ? "إعادة التفعيل" : "إيقاف"}</Button>
      </li>)}</ul> : <p className={styles.empty}>لا يوجد أعضاء بعد.</p>}
    </section>
    {data?.invites.length ? <section className="panel"><div className="panel-heading"><div><h2>دعوات لم تُستخدم</h2></div></div>
      <ul className={styles.list}>{data.invites.map(invite => <li key={invite.id}>
        <div><strong>{invite.name}</strong><small dir="ltr">{invite.email}</small><small>تنتهي {day(invite.expiresAt)}</small></div>
        <Button className={styles.secondary} disabled={busy || offline} onClick={() => { void act(() => api(`/api/members/invites/${invite.id}/revoke`, {})); }}>إلغاء</Button>
      </li>)}</ul>
    </section> : null}
  </div>;
}

/** What a member sees behind "advanced": their own Google Ads and their daily allowance. */
export function MemberTools({ access, onChat, onSignOut }: { access: Access; onChat: () => void; onSignOut: () => void }) {
  const ads = access.services.includes("ads");
  return <div className={styles.member}>
    <header className={styles.memberHeader}>
      <Button className={styles.secondary} onClick={onChat}><ArrowRight size={15} /><MessageCircle size={15} />العودة إلى المحادثة</Button>
      <div className={styles.memberMeta}>
        {access.quota ? <span>استخدمت {access.quota.used} من {access.quota.dailyRuns} طلبًا خلال 24 ساعة</span> : null}
        <Button className={styles.secondary} onClick={onSignOut}><LogOut size={15} />خروج</Button>
      </div>
    </header>
    <main className={styles.memberMain}>
      <h1>Google Ads</h1>
      {ads ? <GoogleAdsWorkspace offline={false} /> : <p className={styles.empty}>ربط Google Ads غير متاح بعد. سيظهر هنا عندما يفعّله صاحب الحساب.</p>}
    </main>
  </div>;
}
