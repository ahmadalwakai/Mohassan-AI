"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Download, Link2 } from "lucide-react";
import {
  ConversationShareExpirySchema, ConversationShareListSchema, ConversationSharePreviewSchema, CreatedConversationShareSchema,
  type ConversationPrivacyFinding, type ConversationShareExpiry, type ConversationSharePreview, type ConversationShareSummary,
} from "@mohassan/contracts";
import { conversationPath, shareError, shareFetch, shareJson, shareListPath } from "./conversation-share-client";
import styles from "./conversation-actions.module.css";

const findingLabels: Record<ConversationPrivacyFinding["kind"], string> = {
  email: "عنوان بريد إلكتروني",
  phone: "رقم هاتف",
  path: "مسار ملف",
  "google-ads-id": "معرّف عميل Google Ads",
  "token-url": "رابط يتضمّن رمز وصول",
  memory: "محتوى من الذاكرة",
  "tool-output": "محتوى من نتيجة أداة",
};
const locations: Record<ConversationPrivacyFinding["location"], string> = {
  title: "العنوان",
  message: "الرسالة",
  source: "مصدر في الرسالة",
};
const expiryLabels: Record<ConversationShareExpiry, string> = { "1d": "يوم واحد", "7d": "٧ أيام", "30d": "٣٠ يومًا", never: "بلا انتهاء" };
const date = new Intl.DateTimeFormat("ar", { calendar: "gregory", dateStyle: "medium", timeStyle: "short" });
const number = new Intl.NumberFormat("ar");

type ExportFormat = "markdown" | "pdf";
function downloadName(disposition: string | null, format: ExportFormat): string {
  const extension = format === "markdown" ? "md" : "pdf";
  const encoded = disposition?.match(/; filename\*=UTF-8''([\w.% -]+)$/)?.[1];
  if (encoded) {
    try {
      const name = decodeURIComponent(encoded);
      if (name.endsWith(`.${extension}`) && !/[\\/\p{Cc}\p{Cf}]/u.test(name)) return name;
    } catch {
      // An invalid filename falls back to the format's fixed name.
    }
  }
  return `conversation.${extension}`;
}

export function ExportConversationAction({ conversationId }: { conversationId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function download(format: ExportFormat) {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const response = await shareFetch(`${conversationPath(conversationId)}/export?format=${format}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = downloadName(response.headers.get("Content-Disposition"), format);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      dialog.current?.close();
    } catch (caught) {
      setError(shareError(caught));
    } finally {
      setWorking(false);
    }
  }
  return <>
    <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={() => { setError(""); dialog.current?.showModal(); }}>
      <Download size={15} aria-hidden="true" />تصدير
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} onCancel={event => { if (working) event.preventDefault(); }}>
      <div className={styles.dialogBody}>
        <h2 id={title}>تصدير المحادثة</h2>
        <div className={styles.row}>
          <button type="button" className={styles.button} disabled={working} onClick={() => void download("markdown")}>Markdown</button>
          <button type="button" className={styles.button} disabled={working} onClick={() => void download("pdf")}>PDF</button>
          <button type="button" className={styles.button} disabled={working} onClick={() => dialog.current?.close()}>إلغاء</button>
        </div>
        {working ? <p role="status">جارٍ تجهيز الملف…</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </dialog>
  </>;
}

function SharePanel({ conversationId, onClose, onWorking }: {
  conversationId?: string;
  onClose: () => void;
  onWorking: (value: boolean) => void;
}) {
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [listAttempt, setListAttempt] = useState(0);
  const [preview, setPreview] = useState<ConversationSharePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [shares, setShares] = useState<ConversationShareSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [expiry, setExpiry] = useState<ConversationShareExpiry>("7d");
  const [working, setWorking] = useState(false);
  const [url, setUrl] = useState<{ id: string; value: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const listRequest = useRef<AbortController>(null);
  const listTitle = useId();
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void shareJson(ConversationSharePreviewSchema, `${conversationPath(conversationId)}/share/preview`, { method: "POST", body: "{}", signal })
      .then(result => { if (!signal.aborted) setPreview(result); })
      .catch(caught => { if (!signal.aborted) setPreviewError(shareError(caught)); });
    return () => controller.abort();
  }, [conversationId, previewAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    listRequest.current = controller;
    void shareJson(ConversationShareListSchema, shareListPath, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setShares(result.shares); })
      .catch(caught => { if (!controller.signal.aborted) setListError(shareError(caught)); });
    return () => controller.abort();
  }, [listAttempt]);

  function startAction(active: boolean) {
    setWorking(active);
    onWorking(active);
    if (active) setActionError("");
  }
  function scanAgain() {
    setPreview(null);
    setPreviewError("");
    setPreviewAttempt(attempt => attempt + 1);
  }
  function refreshList() {
    listRequest.current?.abort();
    setListError("");
    setListAttempt(attempt => attempt + 1);
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversationId || !preview || working) return;
    startAction(true);
    try {
      const body = JSON.stringify({ review: preview.review, expiry, redact: true });
      const created = await shareJson(CreatedConversationShareSchema, `${conversationPath(conversationId)}/share`, { method: "POST", body });
      setUrl({ id: created.share.id, value: created.url });
      setCopyStatus("");
      setPreview(null);
      setShares(current => [created.share, ...(current ?? []).filter(share => share.id !== created.share.id)]);
      refreshList();
    } catch (caught) {
      if (caught instanceof Error && "status" in caught && caught.status === 409) {
        setPreview(null);
        setPreviewError(caught.message);
      } else {
        setActionError(shareError(caught));
      }
    } finally {
      startAction(false);
    }
  }
  async function revoke(share: ConversationShareSummary) {
    if (working) return;
    startAction(true);
    try {
      await shareFetch(`${shareListPath}/${encodeURIComponent(share.id)}`, { method: "DELETE" });
      setShares(current => current?.filter(item => item.id !== share.id) ?? []);
      if (url?.id === share.id) {
        setUrl(null);
        scanAgain();
      }
      refreshList();
    } catch (caught) {
      setActionError(shareError(caught));
    } finally {
      startAction(false);
    }
  }
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url.value);
      setCopyStatus("نُسخ الرابط.");
    } catch {
      setCopyStatus("تعذر النسخ التلقائي. حدّد الرابط وانسخه.");
    }
  }

  return <>
    {conversationId && !url && !preview && !previewError ? <p role="status">جارٍ فحص الخصوصية…</p> : null}
    {previewError ? <div className={styles.section}>
      <p className={styles.error} role="alert">{previewError}</p>
      <button type="button" className={styles.button} disabled={working} onClick={scanAgain}>إعادة الفحص</button>
    </div> : null}
    {preview ? <form className={styles.section} onSubmit={event => void create(event)}>
      <p className={styles.hint}>يمكن لأي شخص لديه الرابط قراءة هذه النسخة.</p>
      {preview.findings.length ? <>
        <h3>نتائج فحص الخصوصية</h3>
        <ul className={styles.findings}>{preview.findings.map((finding, index) => <li key={index}>
          <strong>{findingLabels[finding.kind]}</strong> · {locations[finding.location]}{finding.messageIndex === undefined ? "" : ` ${number.format(finding.messageIndex + 1)}`}
          {finding.preview ? <bdi>{finding.preview}</bdi> : null}
        </li>)}</ul>
        <p className={styles.hint}>ستُزال الأجزاء المُشار إليها عند إنشاء الرابط.</p>
      </> : <p className={styles.hint}>لم يرصد الفحص بيانات خاصة.</p>}
      <label className={styles.row}>صلاحية الرابط
        <select value={expiry} disabled={working} onChange={event => setExpiry(ConversationShareExpirySchema.parse(event.target.value))}>
          {ConversationShareExpirySchema.options.map(value => <option key={value} value={value}>{expiryLabels[value]}</option>)}
        </select>
      </label>
      <button type="submit" className={styles.primary} disabled={working}>
        {preview.findings.length ? "إزالة الأجزاء وإنشاء الرابط" : "إنشاء رابط المشاركة"}
      </button>
    </form> : null}
    {url ? <div className={styles.section}>
      <label htmlFor={`${listTitle}-url`}>رابط المشاركة</label>
      <p className={styles.hint}>انسخ الرابط الآن. سيبقى متاحًا للإلغاء من القائمة أدناه.</p>
      <div className={styles.row}>
        <input id={`${listTitle}-url`} type="text" dir="ltr" readOnly autoFocus value={url.value} onFocus={event => event.currentTarget.select()} />
        <button type="button" className={styles.button} onClick={() => void copy()}>نسخ</button>
      </div>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
    </div> : null}
    <section className={styles.section} aria-labelledby={listTitle}>
      <h3 id={listTitle}>روابطي النشطة</h3>
      {listError ? <div className={styles.row}>
        <p className={styles.error} role="alert">{listError}</p>
        <button type="button" className={styles.button} disabled={working} onClick={refreshList}>إعادة التحميل</button>
      </div> : null}
      {!shares && !listError ? <p role="status">جارٍ تحميل الروابط…</p> : null}
      {shares?.length === 0 ? <p className={styles.hint}>لا توجد روابط نشطة.</p> : null}
      {shares?.length ? <ul className={styles.shares}>{shares.map(share => <li className={styles.row} key={share.id}>
        <div><strong><bdi>{share.title}</bdi></strong><small>
          <time dateTime={share.sharedAt}>{date.format(new Date(share.sharedAt))}</time> · {share.expiresAt ? <>ينتهي في <time dateTime={share.expiresAt}>{date.format(new Date(share.expiresAt))}</time></> : "بلا انتهاء"}
        </small></div>
        <button type="button" className={styles.button} disabled={working} onClick={() => void revoke(share)}>إلغاء الرابط</button>
      </li>)}</ul> : null}
    </section>
    {working ? <p role="status">جارٍ إتمام الطلب…</p> : null}
    {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
    <button type="button" className={styles.button} disabled={working} onClick={onClose}>{preview ? "إلغاء" : "إغلاق"}</button>
  </>;
}

export function ShareConversationAction({ conversationId }: { conversationId?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const [open, setOpen] = useState(false);
  const title = useId();
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  return <>
    <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Link2 size={15} aria-hidden="true" />{conversationId ? "مشاركة" : "روابط المشاركة"}
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} onClose={() => setOpen(false)} onCancel={event => { if (working.current) event.preventDefault(); }}>
      <div className={styles.dialogBody}>
        <h2 id={title}>{conversationId ? "مشاركة المحادثة" : "روابط المشاركة"}</h2>
        {open ? <SharePanel conversationId={conversationId} onWorking={value => { working.current = value; }} onClose={() => dialog.current?.close()} /> : null}
      </div>
    </dialog>
  </>;
}

export function ConversationActions({ conversationId }: { conversationId?: string }) {
  return <div className={styles.actions} key={conversationId}>
    <ShareConversationAction conversationId={conversationId} />
    {conversationId ? <ExportConversationAction conversationId={conversationId} /> : null}
  </div>;
}
