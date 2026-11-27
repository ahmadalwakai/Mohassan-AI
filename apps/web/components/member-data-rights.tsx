import { Button, Spinner } from "@chakra-ui/react";
import type { AccountSessions, CancelMemberDeletionResult, EndAccountSessionsResult, MemberDeletion, MemberDeletionStatus } from "@mohassan/contracts";
import { ChevronDown, Download, ShieldCheck } from "lucide-react";
import { useEffect, useId, useMemo, useReducer, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { Access } from "./members";
import styles from "./member-data-rights.module.css";

const sessionsPath = "/api/member-data/sessions";
const deletionPath = "/api/member-data/deletion";
const genericError = "تعذر الاتصال بالخدمة. حاول مجددًا.";
const dateFormat = new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" });

export function AccountTime({ value }: { value: string }) {
  return <time dateTime={value}>{dateFormat.format(new Date(value))}</time>;
}

class AccountResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function accountResponse(path: string, options: RequestInit = {}) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", mode: "same-origin", ...options });
  if (response.ok) return response;
  const result = await response.json().catch(() => null);
  throw new AccountResponseError(result?.error?.message ?? genericError, response.status);
}

export async function accountRequest<T>(path: string, options?: RequestInit): Promise<T> {
  return (await accountResponse(path, options)).json();
}

function failure(error: unknown) {
  return error instanceof Error && error.name !== "TypeError" ? error.message : genericError;
}

export function useAccountResource<T>(path: string, refresh?: unknown) {
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const request = useMemo(() => ({ path }), [path, revision, refresh]);
  const [outcome, setOutcome] = useState<{ request: typeof request; value?: T; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    accountRequest<T>(request.path, { signal: controller.signal }).then(
      value => { if (!controller.signal.aborted) setOutcome({ request, value }); },
      error => { if (!controller.signal.aborted) setOutcome({ request, error: failure(error) }); },
    );
    return () => controller.abort();
  }, [request]);
  const current = outcome?.request === request ? outcome : undefined;
  return { value: current?.value, error: current?.error, reload };
}

export function AccountLoading({ error, retry }: { error?: string; retry: () => void }) {
  if (error) return <div className={styles.actions}>
    <p className="inline-error" role="alert">{error}</p>
    <Button size="sm" variant="outline" onClick={retry}>إعادة المحاولة</Button>
  </div>;
  return <p className={styles.loading} role="status"><Spinner size="sm" />جارٍ التحميل…</p>;
}

export function ConfirmAccountAction({ title, instruction, label, needsPassword, danger, close, run }: {
  title: string;
  instruction: string;
  label: string;
  needsPassword?: boolean;
  danger?: boolean;
  close: () => void;
  run: (password: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const current = dialog.current;
    if (current && !current.open) current.showModal();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setBusy(true);
    setError("");
    try {
      await run(password);
      dialog.current?.close();
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="app-dialog" aria-labelledby={heading} aria-describedby={description} onClose={close} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="dialog-header"><h2 id={heading}>{title}</h2></div>
    <form className="stack-form" onSubmit={submit}>
      <p id={description}>{instruction}</p>
      {needsPassword ? <label>كلمة المرور الحالية<input name="password" type="password" dir="ltr" autoComplete="current-password" required disabled={busy} /></label> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button type="button" variant="outline" disabled={busy} onClick={() => dialog.current?.close()}>رجوع</Button>
        <Button type="submit" colorPalette={danger ? "red" : "green"} loading={busy} disabled={busy}>{label}</Button>
      </div>
    </form>
  </dialog>;
}

type ExportMode = "full" | "omit";

function ExportSection({ offline, onExported }: { offline: boolean; onExported?: () => void }) {
  const [busy, setBusy] = useState<ExportMode | null>(null);
  const [error, setError] = useState("");
  const [offerDataOnly, setOfferDataOnly] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const activeExport = useRef<AbortController | null>(null);
  useEffect(() => () => activeExport.current?.abort(), []);

  async function download(mode: ExportMode) {
    if (activeExport.current) return;
    const controller = new AbortController();
    activeExport.current = controller;
    setBusy(mode);
    setError("");
    setDownloaded(false);
    try {
      const path = mode === "omit" ? "/api/member-data/export?files=omit" : "/api/member-data/export";
      const response = await accountResponse(path, { signal: controller.signal });
      if (response.headers.get("Content-Type") !== "application/zip") throw new Error("تعذر تنزيل ملف البيانات.");
      const archive = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(archive);
      const link = document.createElement("a");
      link.href = url;
      link.download = "mohassan-data.zip";
      document.body.append(link);
      link.click();
      link.remove();
      // Wait until the browser has processed the download before releasing the object URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (mode === "full") setOfferDataOnly(false);
      setDownloaded(true);
      onExported?.();
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(failure(caught));
        if (mode === "full" && caught instanceof AccountResponseError && caught.status === 413) setOfferDataOnly(true);
      }
    } finally {
      activeExport.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  return <section className={styles.right}>
    <h3>تنزيل بياناتي</h3>
    <p>ملف ZIP يضم بيانات حسابك وملفاته. يمكنك تنزيل نسخة واحدة كل ساعة.</p>
    <Button size="sm" variant="outline" loading={busy === "full"} disabled={busy !== null || offline} onClick={() => { void download("full"); }}><Download size={16} />تنزيل نسخة ZIP</Button>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {offerDataOnly ? <Button size="sm" variant="outline" loading={busy === "omit"} disabled={busy !== null || offline} onClick={() => { void download("omit"); }}>
      <Download size={16} />تنزيل البيانات بدون محتوى الملفات
    </Button> : null}
    {downloaded ? <p role="status">بدأ تنزيل ملف بياناتك.</p> : null}
  </section>;
}

function SessionsSection({ offline }: { offline: boolean }) {
  const { value, error, reload } = useAccountResource<AccountSessions>(sessionsPath);
  const [confirm, setConfirm] = useState(false);
  const [ended, setEnded] = useState(false);
  const hasOthers = value?.sessions.some(session => !session.current);
  return <section className={styles.right}>
    <h3>الجلسات النشطة</h3>
    {value ? value.sessions.length ? <ul className={styles.list}>
      {value.sessions.map(session => <li key={session.id}>
        <div className={styles.record}>
          <strong>{session.deviceLabel} {session.current ? <span className={styles.current}>الجلسة الحالية</span> : null}</strong>
          <div className={styles.metadata}>
            <span>آخر نشاط <AccountTime value={session.lastSeen} /></span>
            <span>بادئة عنوان IP {session.ipPrefix ? <bdi dir="ltr">{session.ipPrefix}</bdi> : "غير متوفرة"}</span>
          </div>
        </div>
      </li>)}
    </ul> : <p>لا توجد جلسات نشطة.</p> : <AccountLoading error={error} retry={reload} />}
    {hasOthers ? <Button size="sm" variant="outline" disabled={offline} onClick={() => setConfirm(true)}>إنهاء الجلسات الأخرى</Button> : null}
    {ended ? <p role="status">أُنهيت الجلسات الأخرى.</p> : null}
    {confirm ? <ConfirmAccountAction title="إنهاء الجلسات الأخرى" instruction="سيُسجَّل خروج حسابك من الأجهزة الأخرى، وستبقى هذه الجلسة مفتوحة."
      label="تأكيد إنهاء الجلسات" close={() => setConfirm(false)} run={async () => {
        await accountRequest<EndAccountSessionsResult>(sessionsPath, { method: "DELETE" });
        reload();
        setEnded(true);
      }} /> : null}
  </section>;
}

type DeletionAction = (deletion: MemberDeletion) => void;

function RequestDeletion({ offline, onScheduled }: { offline: boolean; onScheduled: DeletionAction }) {
  const [confirm, setConfirm] = useState(false);
  return <section className={styles.right}>
    <h3>حذف الحساب</h3>
    <p>سينتهي تسجيل الدخول على كل الأجهزة فورًا. أمامك ٧ أيام لتسجيل الدخول وإلغاء الطلب قبل الحذف الدائم.</p>
    <Button size="sm" colorPalette="red" variant="outline" disabled={offline} onClick={() => setConfirm(true)}>طلب حذف الحساب</Button>
    {confirm ? <ConfirmAccountAction title="تأكيد طلب حذف الحساب" instruction="أدخل كلمة المرور الحالية لتأكيد الطلب وبدء مهلة الإلغاء."
      label="تأكيد طلب الحذف" needsPassword danger close={() => setConfirm(false)} run={async password => {
        const { deletion } = await accountRequest<MemberDeletionStatus>(deletionPath, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
        });
        if (!deletion) throw new Error("تعذر تأكيد موعد حذف الحساب. حاول مجددًا.");
        onScheduled(deletion);
      }} /> : null}
  </section>;
}

export function MemberAccountData({ offline = false, initiallyOpen = false, onDeletionScheduled, onExported }: {
  offline?: boolean;
  initiallyOpen?: boolean;
  onDeletionScheduled?: DeletionAction;
  onExported?: () => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [opened, setOpened] = useState(initiallyOpen);
  return <details open={open} className={`panel ${styles.details}`} onToggle={event => {
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setOpened(true);
  }}>
    <summary className={styles.summary}><h2><ShieldCheck size={19} aria-hidden="true" />بياناتي</h2><ChevronDown size={18} aria-hidden="true" /></summary>
    {opened ? <div className={styles.contents}>
      <ExportSection offline={offline} onExported={onExported} />
      <SessionsSection offline={offline} />
      {onDeletionScheduled ? <RequestDeletion offline={offline} onScheduled={onDeletionScheduled} /> : null}
    </div> : null}
  </details>;
}

function countdown(deadline: string, now: number) {
  // Round the remaining duration up to a minute, then split total minutes into calendar-independent units.
  const total = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 60_000));
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return ([[days, "day"], [hours, "hour"], [minutes, "minute"]] as const)
    .filter(([value]) => value > 0)
    .map(([value, unit]) => new Intl.NumberFormat("ar", { style: "unit", unit, unitDisplay: "long" }).format(value))
    .join("، ");
}

function PendingMemberDeletion({ deletion, signedIn }: { deletion: MemberDeletion; signedIn: boolean }) {
  const [now, setNow] = useState(Date.now);
  const [confirm, setConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  const remaining = countdown(deletion.purgeAfter, now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const returnToApp = () => location.replace(location.pathname);
  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await accountRequest("/api/auth/sign-out", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      returnToApp();
    } catch (caught) {
      setError(failure(caught));
      setSigningOut(false);
    }
  }

  return <main className="auth-shell"><section className="auth-form-panel"><div className={`auth-form-wrap ${styles.pending}`}>
    <ShieldCheck size={30} aria-hidden="true" />
    <h1>طلب حذف الحساب</h1>
    <p>موعد الحذف <AccountTime value={deletion.purgeAfter} />.</p>
    {remaining ? <p>المهلة المتبقية {remaining}.</p> : <p>انتهت مهلة الإلغاء. يجري حذف الحساب.</p>}
    {!signedIn ? <p>سجّل الدخول خلال المهلة لإلغاء الطلب والإبقاء على حسابك.</p> : null}
    <div className={styles.actions}>
      {signedIn && remaining ? <Button className="primary-button" disabled={signingOut} onClick={() => setConfirm(true)}>إلغاء طلب الحذف</Button> : null}
      {signedIn ? <Button variant="outline" loading={signingOut} disabled={signingOut} onClick={() => { void signOut(); }}>تسجيل الخروج</Button>
        : <Button className="primary-button" onClick={returnToApp}>تسجيل الدخول</Button>}
    </div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {confirm ? <ConfirmAccountAction title="إلغاء طلب حذف الحساب" instruction="سيبقى حسابك وبياناتك متاحين عند إلغاء الطلب."
      label="تأكيد الإلغاء" close={() => setConfirm(false)} run={async () => {
        await accountRequest<CancelMemberDeletionResult>(deletionPath, { method: "DELETE" });
        returnToApp();
      }} /> : null}
  </div></section></main>;
}

type MemberDataAccess = Access & { deletion?: MemberDeletion; dataOnly?: boolean };
type MemberToolsProps = { access: Access; onChat: () => void; onSignOut: () => void };

export function shouldMountMemberDataAccess(access: MemberDataAccess | null, advanced: boolean) {
  return !access || Boolean(access.deletion || access.dataOnly) || (access.role === "member" && advanced);
}

export function MemberDataAccessMount({ access, error, tools: Tools, onChat, onSignOut }: {
  access: MemberDataAccess | null;
  error: string;
  tools: ComponentType<MemberToolsProps>;
  onChat: () => void;
  onSignOut: () => void;
}) {
  const [scheduledDeletion, setScheduledDeletion] = useState<MemberDeletion | null>(null);
  const pending = scheduledDeletion ?? access?.deletion;
  if (pending) return <PendingMemberDeletion deletion={pending} signedIn={!scheduledDeletion} />;
  if (!access) return <main className="boot-screen"><AccountLoading error={error} retry={() => location.reload()} /></main>;
  if (access.dataOnly) return <main className={styles.dataOnly}>
    <h1>حسابك موقوف</h1>
    <p>يمكنك إدارة بياناتك وجلساتك هنا.</p>
    <MemberAccountData initiallyOpen onDeletionScheduled={setScheduledDeletion} />
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <Button variant="outline" onClick={onSignOut}>تسجيل الخروج</Button>
  </main>;
  return <div className={styles.memberToolsFrame}>
    <div className={styles.memberToolsData}><MemberAccountData onDeletionScheduled={setScheduledDeletion} /></div>
    <Tools access={access} onChat={onChat} onSignOut={onSignOut} />
  </div>;
}
