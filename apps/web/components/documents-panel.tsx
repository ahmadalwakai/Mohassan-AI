"use client";
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import styles from './documents-panel.module.css';

/**
 * The PDF files of one conversation: made by Mohassan from the owner's words, edited copies, or files
 * uploaded here so the chat can edit them («أضف علامة مائية على آخر ملف»). Download links go through
 * the same-origin API; nothing in a file is shown inline.
 */
type StoredDocument = { id: string; name: string; pages: number; size: number; source: 'created' | 'edited' | 'uploaded'; theme: string | null; createdAt: string; url: string };
const SOURCE: Record<StoredDocument['source'], string> = { created: 'أنشأه موحسن', edited: 'نسخة معدّلة', uploaded: 'مرفوع من جهازك' };
const MAX_UPLOAD_BYTES = 10_000_000;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? 'تعذر الوصول إلى ملفات PDF.');
  return body as T;
}
const formatSize = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} ميغابايت` : `${Math.max(1, Math.round(bytes / 1000))} كيلوبايت`;
const formatPages = (pages: number) => pages === 1 ? 'صفحة واحدة' : pages === 2 ? 'صفحتان' : pages <= 10 ? `${pages} صفحات` : `${pages} صفحة`;

export function DocumentsPanel({ conversationId, version, busy }: { conversationId: string; version: number; busy: boolean }) {
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  const mounted = useRef(true), sequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);

  async function refresh() {
    const current = ++sequence.current;
    try {
      const result = await api<{ documents: StoredDocument[] }>(`/api/documents?conversationId=${encodeURIComponent(conversationId)}`);
      if (mounted.current && current === sequence.current) setDocuments(result.documents);
    } catch (caught) { if (mounted.current && current === sequence.current) setError(caught instanceof Error ? caught.message : 'تعذر تحميل قائمة الملفات.'); }
  }
  // A new message may have created a file: re-read the list whenever the thread grows.
  useEffect(() => { void refresh(); }, [conversationId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: () => Promise<unknown>, failure: string) {
    setWorking(true); setError('');
    try { await action(); await refresh(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : failure); }
    finally { if (mounted.current) setWorking(false); }
  }
  function upload(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    if (!/\.pdf$/iu.test(chosen.name) || chosen.size === 0 || chosen.size > MAX_UPLOAD_BYTES) { setError('اختر ملف PDF بحجم لا يتجاوز 10 ميغابايت.'); return; }
    void act(async () => {
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      let binary = '';
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      const name = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.()-]{0,119}$/u.test(chosen.name) && !chosen.name.includes('..') ? chosen.name : 'uploaded.pdf';
      await api('/api/documents/upload', { method: 'POST', body: JSON.stringify({ conversationId, name, base64: btoa(binary) }) });
    }, 'تعذر رفع الملف.');
  }

  return <details className={styles.panel} data-documents-panel>
    <summary>ملفات PDF في هذه المحادثة{documents.length ? ` (${documents.length})` : ''}</summary>
    <p className={styles.hint}>ينشئ موحسن ملفات PDF من نصك كما كتبته، ويعدّل ما تطلبه: دمج، وحذف صفحات، وتدوير، وعلامة مائية، وترقيم. ارفع ملف PDF غير مشفر (حتى 10 ميغابايت) ثم اطلب مثلًا: «أضف علامة مائية سري على آخر ملف».</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <label className={styles.upload}>رفع ملف PDF<input type="file" accept="application/pdf,.pdf" disabled={busy || working} onChange={upload} /></label>
    {documents.length ? <ul className={styles.list}>{documents.map(row => <li key={row.id} className={styles.row}>
      <bdi className={styles.name}>{row.name}</bdi>
      <span className={styles.meta}>{formatPages(row.pages)} · {formatSize(row.size)} · {SOURCE[row.source]}</span>
      <span className={styles.actions}>
        <a href={`/api/documents/${row.id}/content`} download={row.name}>تنزيل</a>
        <button type="button" disabled={busy || working} onClick={() => void act(() => api(`/api/documents/${row.id}`, { method: 'DELETE' }), 'تعذر حذف الملف.')}>حذف</button>
      </span>
    </li>)}</ul> : <p className={styles.hint}>لا ملفات بعد. قل مثلًا: «اصنع لي ملف PDF بعنوان …».</p>}
  </details>;
}
