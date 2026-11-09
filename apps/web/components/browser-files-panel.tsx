"use client";
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import styles from './browser-files-panel.module.css';

type Target = { ref: string; label: string; url?: string };
type Transfer = { id: string; direction: 'upload' | 'download'; status: string; target: { url: string; fieldNames: string[] }; filename: string | null; size: number | null; hash: string | null; responseStatus: number | null; errorCode: string | null };
const types: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', png: 'image/png' };
const labels: Record<string, string> = { pending: 'بانتظار موافقتك', dispatching: 'جارٍ النقل', responded: 'وصل رد الموقع؛ راجع النتيجة فيه', unknown: 'النتيجة غير محسومة؛ لا إعادة تلقائية', quarantined: 'في الحجر بعد فحص النوع والحجم', released: 'محرر للتنزيل', revoked: 'ملغى', failed: 'تعذر النقل', expired: 'انتهت الصلاحية' };
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? 'تعذر نقل الملف.');
  return body as T;
}

export function BrowserFilesPanel({ conversationId, disabled }: { conversationId: string; disabled: boolean }) {
  const base = `/api/browser/files/${conversationId}`;
  const [targets, setTargets] = useState<{ uploads: Target[]; downloads: Target[] }>({ uploads: [], downloads: [] });
  const [files, setFiles] = useState<Transfer[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const mounted = useRef(true), refreshSequence = useRef(0), fileSequence = useRef(0), revokingId = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSequence.current++; fileSequence.current++; }; }, []);
  const [uploadRef, setUploadRef] = useState(''), [downloadRef, setDownloadRef] = useState('');
  const [file, setFile] = useState<{ name: string; type: string; base64: string } | null>(null);
  const blocked = disabled || busy;
  async function refreshFiles() {
    const sequence = ++refreshSequence.current, result = await api<{ files: Transfer[] }>(base);
    if (mounted.current && sequence === refreshSequence.current) setFiles(result.files);
  }
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const [nextTargets, nextFiles] = await Promise.all([api<typeof targets>(`${base}/targets`), api<{ files: Transfer[] }>(base)]);
    if (!mounted.current || sequence !== refreshSequence.current) return;
    setTargets(nextTargets); setFiles(nextFiles.files);
    if (!nextTargets.uploads.some(target => target.ref === uploadRef)) setUploadRef('');
    if (!nextTargets.downloads.some(target => target.ref === downloadRef)) setDownloadRef('');
  }
  async function run(action: () => Promise<unknown>) {
    if (busy || disabled) return; setBusy(true); setError('');
    try { await action(); if (mounted.current) await refresh(); } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught.message : 'تعذر نقل الملف.');
      try { await refreshFiles(); } catch { /* Keep the original failure visible. */ }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function revoke(id: string) {
    if (revokingId.current) return;
    revokingId.current = id; setRevoking(id); setError('');
    try { await api(`${base}/grants/${id}`, { method: 'DELETE' }); if (mounted.current) await refreshFiles(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'تعذر سحب المنحة.'); }
    finally { revokingId.current = null; if (mounted.current) setRevoking(null); }
  }
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const sequence = ++fileSequence.current;
    setFile(null); setError(''); const chosen = event.target.files?.[0]; if (!chosen) return;
    const ext = chosen.name.split('.').at(-1)?.toLowerCase() ?? '', type = types[ext];
    if (!type || chosen.size === 0 || chosen.size > 512 * 1024) { setError('اختر نصًا أو PNG بحجم لا يتجاوز 512 كيلوبايت.'); return; }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await chosen.arrayBuffer()); } catch { if (mounted.current && sequence === fileSequence.current) setError('تعذرت قراءة الملف المختار.'); return; }
    if (!mounted.current || sequence !== fileSequence.current) return;
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const name = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._ -]{0,99}$/u.test(chosen.name) && !chosen.name.includes('..') ? chosen.name : `owner-file.${ext}`;
    setFile({ name, type, base64: btoa(binary) });
  }
  return <details data-browser-files className={styles.panel} onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open && !disabled) void run(async () => {}); }}>
    <summary>نقل الملفات بإذنك</summary>
    <p>اختر ملفًا وموضع رفع أو رابط تنزيل من الصفحة. كل منحة تعمل مرة واحدة وتنتهي بعد عشر دقائق.</p>
    <p className={styles.hint}>TXT وMarkdown وCSV وJSON وPNG، حتى 512 كيلوبايت. فحص البنية ليس فحصًا للبرامج الضارة. ملفات PDF الثنائية غير متاحة هنا.</p>
    {disabled ? <p>أكمل المهمة أو أوقفها قبل نقل ملف.</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <button type="button" disabled={blocked} onClick={() => void run(async () => {})}>تحديث مواضع الملفات</button>
    <fieldset disabled={blocked} className={styles.group}><legend>رفع ملف</legend>
      <label>موضع الرفع<select value={uploadRef} onChange={event => setUploadRef(event.target.value)}><option value="">اختر حقل ملف مرصودًا</option>{targets.uploads.map(target => <option key={target.ref} value={target.ref}>{target.label || target.ref}</option>)}</select></label>
      <label>الملف من جهازك<input type="file" accept=".txt,.md,.csv,.json,.png" onChange={event => void selectFile(event)} /></label>
      {file ? <small>سيُرسل باسم <bdi>{file.name}</bdi></small> : null}
      <button type="button" disabled={blocked || !uploadRef || !file} onClick={() => void run(() => api(`${base}/grants`, { method: 'POST', body: JSON.stringify({ direction: 'upload', ref: uploadRef, file }) }))}>مراجعة منحة الرفع</button>
    </fieldset>
    <fieldset disabled={blocked} className={styles.group}><legend>تنزيل إلى الحجر</legend>
      <label>الرابط المرصود<select value={downloadRef} onChange={event => setDownloadRef(event.target.value)}><option value="">اختر رابط ملف</option>{targets.downloads.map(target => <option key={target.ref} value={target.ref}>{target.label || target.url}</option>)}</select></label>
      <button type="button" disabled={blocked || !downloadRef} onClick={() => void run(() => api(`${base}/grants`, { method: 'POST', body: JSON.stringify({ direction: 'download', ref: downloadRef }) }))}>مراجعة منحة التنزيل</button>
    </fieldset>
    <div className={styles.list} aria-live="polite">{files.slice(0, 10).map(row => <article key={row.id} className={styles.transfer}>
      <strong>{row.direction === 'upload' ? 'رفع' : 'تنزيل'}{row.filename ? <>: <bdi dir="ltr">{row.filename}</bdi></> : null}</strong><span>{labels[row.status] ?? row.status}</span>
      <p dir="ltr" className={styles.url}>{row.target.url}</p>
      {row.size !== null ? <small>{row.size.toLocaleString('ar')} بايت</small> : null}
      {row.hash ? <details><summary>بصمة الملف</summary><code className={styles.url}>{row.hash}</code></details> : null}
      {row.direction === 'upload' && row.target.fieldNames.length ? <small>يشمل حقول النموذج الحالية: {row.target.fieldNames.join('، ')}</small> : null}
      {row.responseStatus !== null ? <small>استجابة HTTP {row.responseStatus}؛ لا تثبت اكتمال العملية داخل الموقع.</small> : null}
      <div className={styles.actions}>
        {row.status === 'pending' ? <button type="button" disabled={blocked} onClick={() => void run(() => api(`${base}/grants/${row.id}/execute`, { method: 'POST', body: '{}' }))}>{row.direction === 'upload' ? 'أوافق على إرسال الملف مرة واحدة' : 'أوافق على التنزيل إلى الحجر'}</button> : null}
        {row.status === 'quarantined' ? <button type="button" disabled={blocked} onClick={() => void run(() => api(`${base}/grants/${row.id}/release`, { method: 'POST', body: '{}' }))}>تحرير الملف المفحوص</button> : null}
        {row.status === 'released' ? <a href={`${base}/grants/${row.id}/content`} download={row.filename ?? 'download.txt'}>حفظ على جهازي</a> : null}
        {['pending', 'quarantined', 'released', 'dispatching'].includes(row.status) ? <button type="button" disabled={revoking !== null} onClick={() => void revoke(row.id)}>{revoking === row.id ? 'جارٍ سحب المنحة…' : 'إلغاء وحذف المحتوى'}</button> : null}
      </div>
    </article>)}</div>
  </details>;
}
