"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { MemberPasswordResetLinkSchema, MemberPasswordResetTokenSchema, type MemberPasswordResetLink } from "@mohassan/contracts";
import { ArrowRight, Check, Copy, LogOut, MessageCircle, UserPlus } from "lucide-react";
import dynamic from "next/dynamic";
import { AccountPasswordForm, accountFailure } from "./account-password-form";
import { AccountTime, ConfirmAccountAction, accountRequest } from "./member-data-rights";
import { OwnerMemberHistory } from "./member-audit";
import styles from "./members.module.css";
import { ConversationShareSettings } from "./conversation-share-settings";

const GoogleAdsWorkspace = dynamic(() => import("./google-ads-workspace").then(module => module.GoogleAdsWorkspace));
const SitesWorkspace = dynamic(() => import("./sites-workspace").then(module => module.SitesWorkspace));

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

type InviteFailure = Error & { status?: number; retryAfterMs?: number };
/** Only the invitation flow needs abortable requests and the auth retry metadata. */
async function inviteRequest<T>(path: string, body: unknown | undefined, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const retry = response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
    const numeric = retry && /^\d+(?:\.\d+)?$/u.test(retry.trim()) ? Number(retry) * 1000 : NaN;
    const dated = retry ? Date.parse(retry) - Date.now() : NaN;
    const retryAfterMs = Number.isFinite(numeric) ? numeric : Number.isFinite(dated) ? Math.max(0, dated) : 1000;
    throw Object.assign(new Error(parsed?.error?.message ?? parsed?.message ?? "تعذر إتمام الطلب. حاول مجددًا."), { status: response.status, retryAfterMs });
  }
  return parsed as T;
}

function waitForInviteRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); done(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Opened from an invite link. The token lives in the URL fragment and is sent only in a request body. */
export function InviteScreen({ token, onDone, onCancel }: { token: string; onDone: (session: Session) => void; onCancel: () => void }) {
  const [invite, setInvite] = useState<{ name: string; email: string } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  const flow = useRef<{ token: string; controller: AbortController; accepted: boolean; submitting: boolean } | null>(null);
  useEffect(() => {
    const current = { token, controller: new AbortController(), accepted: false, submitting: false };
    flow.current = current;
    setState("loading"); setAccepted(false); setRetryUntil(0); setBusy(false); setError("");
    inviteRequest<{ name: string; email: string }>("/api/invites/inspect", { token }, current.controller.signal)
      .then(value => { if (!current.controller.signal.aborted) { setInvite(value); setState("ready"); } })
      .catch(caught => { if (!current.controller.signal.aborted) { setError(message(caught)); setState("invalid"); } });
    return () => { current.controller.abort(); if (flow.current === current) flow.current = null; };
  }, [token]);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setTimeout(() => setRetryUntil(current => current <= Date.now() ? 0 : current), Math.min(Math.max(0, retryUntil - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryUntil]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = flow.current;
    if (!current || current.token !== token || current.submitting || current.controller.signal.aborted || retryUntil > Date.now() || !invite) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? ""), confirm = String(values.get("confirm") ?? "");
    if (!current.accepted && password !== confirm) { setError("كلمتا المرور غير متطابقتين."); return; }
    current.submitting = true;
    setBusy(true); setError("");
    try {
      if (!current.accepted) {
        await inviteRequest("/api/invites/accept", { token, name: String(values.get("name") ?? ""), password }, current.controller.signal);
        // A successful acceptance consumes the token. Every later attempt is
        // sign-in only, including after a transient auth/network failure.
        current.accepted = true;
        if (!current.controller.signal.aborted) setAccepted(true);
      }
      for (let attempt = 0; ; attempt++) {
        try { await inviteRequest("/api/auth/sign-in/email", { email: invite.email, password }, current.controller.signal); break; }
        catch (caught) {
          const failure = caught as InviteFailure;
          if (current.controller.signal.aborted) throw caught;
          if (failure.status !== 429) throw caught;
          const delay = Math.max(0, failure.retryAfterMs ?? 1000);
          if (attempt >= 2 || delay > 30_000) {
            setRetryUntil(Date.now() + delay);
            throw new Error("أُنشئ حسابك. انتظر انتهاء مهلة تسجيل الدخول، ثم حاول تسجيل الدخول مجددًا.");
          }
          setError("أُنشئ حسابك. ننتظر مهلة تسجيل الدخول ثم نعيد المحاولة تلقائيًا.");
          await waitForInviteRetry(delay, current.controller.signal);
        }
      }
      const session = await inviteRequest<Session | null>("/api/auth/get-session", undefined, current.controller.signal);
      if (!session?.user || session.user.email.toLowerCase() !== invite.email.toLowerCase()) throw new Error("أُنشئ حسابك. سجّل الدخول ببريدك وكلمة المرور.");
      if (!current.controller.signal.aborted && flow.current === current) onDone(session);
    } catch (caught) {
      if (!current.controller.signal.aborted && flow.current === current) setError(current.accepted && !(caught instanceof Error && caught.message.startsWith("أُنشئ حسابك"))
        ? `أُنشئ حسابك. تعذر تسجيل الدخول الآن: ${message(caught)}` : message(caught));
    } finally { current.submitting = false; if (!current.controller.signal.aborted && flow.current === current) setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-form-panel"><div className="auth-form-wrap">
    <h2>انضم إلى موحسن</h2>
    {state === "loading" ? <Spinner size="md" /> : null}
    {state === "invalid" ? <><p className="inline-error" role="alert">{error}</p><Button className={styles.secondary} onClick={onCancel}>الذهاب لتسجيل الدخول</Button></> : null}
    {state === "ready" && invite ? <>
      <p className="muted">{accepted ? "أُنشئ حسابك. أكمل تسجيل الدخول بعنوان" : "أنشئ كلمة مرورك لحساب"} <bdi dir="ltr">{invite.email}</bdi>.</p>
      <form onSubmit={submit} className="stack-form">
        <label>الاسم<input name="name" autoComplete="name" required minLength={2} maxLength={80} defaultValue={invite.name} disabled={busy || accepted} /></label>
        <label>كلمة المرور<input name="password" type="password" dir="ltr" autoComplete={accepted ? "current-password" : "new-password"} required minLength={12} maxLength={128} placeholder="12 حرفًا على الأقل" disabled={busy} /></label>
        {!accepted ? <label>تأكيد كلمة المرور<input name="confirm" type="password" dir="ltr" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} /></label> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <Button type="submit" className="primary-button" disabled={busy || retryUntil > Date.now()}>{busy ? <Spinner size="sm" /> : <Check size={16} />}{accepted ? "تسجيل الدخول" : "إنشاء الحساب"}</Button>
      </form>
    </> : null}
  </div></section></main>;
}

export function PasswordResetScreen({ token, onDone, onCancel }: { token: string; onDone: () => void; onCancel: () => void }) {
  const [inspection, setInspection] = useState<"loading" | "ready" | { error: string }>("loading");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!MemberPasswordResetTokenSchema.safeParse(token).success) {
      setInspection({ error: "رابط إعادة تعيين كلمة المرور غير صالح." });
      return;
    }
    const controller = new AbortController();
    accountRequest("/api/members/password-reset/inspect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), signal: controller.signal,
    }).then(
      () => { if (!controller.signal.aborted) setInspection("ready"); },
      caught => { if (!controller.signal.aborted) setInspection({ error: accountFailure(caught) }); },
    );
    return () => controller.abort();
  }, [token]);

  return <main className="auth-shell"><section className="auth-form-panel"><div className={`auth-form-wrap ${styles.reset}`}>
    <h2>إعادة تعيين كلمة المرور</h2>
    {inspection === "loading" ? <p role="status"><Spinner size="sm" /> جارٍ التحقق من الرابط…</p> : null}
    {typeof inspection === "object" ? <p className="inline-error" role="alert">{inspection.error}</p> : null}
    {inspection === "ready" && !saved ? <AccountPasswordForm submitLabel="تعيين كلمة المرور" onCancel={onCancel} onSave={async ({ newPassword }) => {
      await accountRequest("/api/members/password-reset/accept", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword }),
      });
      setSaved(true);
    }} /> : null}
    {saved ? <>
      <p role="status">عُيّنت كلمة المرور الجديدة وأُنهيت جميع جلسات الحساب.</p>
      <Button className="primary-button" onClick={onDone}>متابعة</Button>
    </> : inspection !== "ready" ? <Button className={styles.secondary} onClick={onCancel}>رجوع</Button> : null}
  </div></section></main>;
}

function PasswordResetLink({ link, email }: { link: MemberPasswordResetLink; email: string }) {
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.resetLink);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return <div className={styles.link}>
    <p role="status">أُنشئ رابط إعادة التعيين. أرسله إلى <bdi dir="ltr">{email}</bdi>. يُستخدم مرة واحدة وينتهي في <AccountTime value={link.expiresAt} />.</p>
    <div className={styles.copy}>
      <code dir="ltr">{link.resetLink}</code>
      <Button className={styles.secondary} onClick={() => { void copy(); }}>{copyStatus === "copied" ? <Check size={15} /> : <Copy size={15} />}{copyStatus === "copied" ? "نُسخ" : "نسخ الرابط"}</Button>
    </div>
    {copyStatus === "failed" ? <p className="inline-error" role="alert">تعذر النسخ. حدّد الرابط وانسخه يدويًا.</p> : null}
  </div>;
}

/** The owner's list of invited people. */
export function MembersPanel({ offline }: { offline: boolean }) {
  const [data, setData] = useState<{ members: Member[]; invites: Invite[]; dailyRuns: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetMember, setResetMember] = useState<Member | null>(null);
  const [resetLink, setResetLink] = useState<{ email: string; link: MemberPasswordResetLink } | null>(null);
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
    <ConversationShareSettings offline={offline} />
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
      {!data ? <div className={styles.empty}><Spinner size="sm" /></div> : data.members.length ? <ul className={styles.list}>{data.members.map(member => <li key={member.id} className={styles.memberRow}>
        <div><strong>{member.name}</strong><small dir="ltr">{member.email}</small><small>انضم {day(member.joinedAt)} · {member.runsToday} طلبًا اليوم{member.disabled ? " · موقوف" : ""}</small></div>
        <div className={styles.actions}>
          <Button className={styles.secondary} disabled={busy || offline} onClick={() => setResetMember(member)}>إصدار رابط إعادة تعيين كلمة المرور</Button>
          <Button className={styles.secondary} disabled={busy || offline} onClick={() => { void act(() => api(`/api/members/${encodeURIComponent(member.id)}/access`, { enabled: member.disabled })); }}>{member.disabled ? "إعادة التفعيل" : "إيقاف"}</Button>
        </div>
      </li>)}</ul> : <p className={styles.empty}>لا يوجد أعضاء بعد.</p>}
      {resetLink ? <PasswordResetLink key={resetLink.link.resetLink} link={resetLink.link} email={resetLink.email} /> : null}
      {resetMember ? <ConfirmAccountAction title="إصدار رابط إعادة تعيين كلمة المرور"
        instruction={`سيُلغى أي رابط سابق لحساب ${resetMember.name} عند إصدار الرابط الجديد.`}
        label="إصدار الرابط" close={() => setResetMember(null)} run={async () => {
          const result = MemberPasswordResetLinkSchema.safeParse(await api(`/api/members/${encodeURIComponent(resetMember.id)}/password-reset`, {}));
          if (!result.success) throw new Error("تعذر عرض رابط إعادة تعيين كلمة المرور.");
          const link = { ...result.data, resetLink: new URL(result.data.resetLink, location.origin).href };
          setResetLink({ email: resetMember.email, link });
        }} /> : null}
    </section>
    {data?.invites.length ? <section className="panel"><div className="panel-heading"><div><h2>دعوات لم تُستخدم</h2></div></div>
      <ul className={styles.list}>{data.invites.map(invite => <li key={invite.id}>
        <div><strong>{invite.name}</strong><small dir="ltr">{invite.email}</small><small>تنتهي {day(invite.expiresAt)}</small></div>
        <Button className={styles.secondary} disabled={busy || offline} onClick={() => { void act(() => api(`/api/members/invites/${invite.id}/revoke`, {})); }}>إلغاء</Button>
      </li>)}</ul>
    </section> : null}
    <OwnerMemberHistory members={data?.members} offline={offline} />
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
      {access.services.includes("sites") ? <><h1>المواقع</h1><SitesWorkspace offline={false} /></> : null}
      <h1>Google Ads</h1>
      {ads ? <GoogleAdsWorkspace offline={false} /> : <p className={styles.empty}>ربط Google Ads غير متاح بعد. سيظهر هنا عندما يفعّله صاحب الحساب.</p>}
    </main>
  </div>;
}
