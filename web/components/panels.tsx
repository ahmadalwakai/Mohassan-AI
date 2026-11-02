"use client";

import { Button, CloseButton, Drawer, Input, Portal, Spinner, Textarea } from "@chakra-ui/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { normalizePairCode, requestJSON, RequestError } from "./client";
import type { Copy } from "./copy";
import { Icon } from "./icons";
import type { Conversation, ConversationDetail, KnowledgeItem, Language, Metrics, Status } from "./types";

export function errorText(error: unknown, c: Copy): string {
  if (error instanceof RequestError && error.code === "timeout") return c.timeout;
  if (error instanceof RequestError && error.status === 401) return c.sessionExpired;
  if (error instanceof Error && error.name === "AbortError") return c.cancelled;
  return error instanceof Error ? error.message : typeof error === "string" ? error : c.error;
}

export function ErrorNotice({ error, c }: { error: unknown; c: Copy }) {
  return error ? <div className="notice notice-error" role="alert">{errorText(error, c)}</div> : null;
}

export function Panel({ title, open, onClose, children, language, c }: { title: string; open: boolean; onClose: () => void; children: ReactNode; language: Language; c: Copy }) {
  return <Drawer.Root open={open} onOpenChange={(event) => { if (!event.open) onClose(); }} placement="end" size="md" lazyMount unmountOnExit>
    <Portal><Drawer.Backdrop /><Drawer.Positioner><Drawer.Content dir={language === "ar" ? "rtl" : "ltr"} className="side-panel">
      <Drawer.Header className="panel-header"><Drawer.Title>{title}</Drawer.Title></Drawer.Header>
      <Drawer.Body className="panel-body">{children}</Drawer.Body>
      <Drawer.CloseTrigger asChild><CloseButton aria-label={c.close} size="sm" /></Drawer.CloseTrigger>
    </Drawer.Content></Drawer.Positioner></Portal>
  </Drawer.Root>;
}

export function PairingCard({ status, c, onPaired }: { status: Status; c: Copy; onPaired: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePairCode(code);
    if (busy || !/^\d{8}$/.test(normalized)) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      await requestJSON("/api/pair", { method: "POST", body: JSON.stringify({ code: normalized }), signal: controller.signal }, 18_000);
      setCode("");
      await onPaired();
    } catch (caught) { setError(caught); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  if (!status.configured) return <section className="pair-card"><div className="pair-icon"><Icon name="computer" size={26} /></div><h2>{c.notConfigured}</h2><p>{c.notConfiguredNote}</p></section>;
  return <section className="pair-card">
    <div className="pair-icon"><Icon name="link" size={26} /></div>
    <div><h2>{c.pairingTitle}</h2><p>{c.pairingNote}</p></div>
    <form onSubmit={submit} className="pair-form">
      <label htmlFor="pair-code">{c.pairingCode}</label>
      <div className="pair-input-row"><Input id="pair-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" dir="ltr" placeholder="00000000" disabled={busy} className="pair-code" /><Button type="submit" className="primary-button" disabled={busy || !/^\d{8}$/.test(normalizePairCode(code))}>{busy ? <Spinner size="sm" /> : <Icon name="link" />}{busy ? c.pairing : c.pair}</Button></div>
      {busy && <Button type="button" variant="ghost" onClick={() => request.current?.abort()}>{c.cancel}</Button>}
    </form>
    <ErrorNotice error={error} c={c} />
    <p className="small-note">{c.networkNote}</p>
  </section>;
}

export function KnowledgePanel({ c, available }: { c: Copy; available: boolean }) {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [deleteID, setDeleteID] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    requestJSON<{ items: KnowledgeItem[] }>("/api/knowledge", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setItems(data.items ?? []); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); active.current?.abort(); };
  }, [available]);
  async function mutate(method: "POST" | "DELETE", id?: string) {
    if (busy || (method === "POST" && (!title.trim() || !content.trim()))) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(null); setNotice("");
    try {
      await requestJSON(`/api/knowledge${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method, body: method === "POST" ? JSON.stringify({ title: title.trim(), content: content.trim() }) : undefined, signal: controller.signal });
      if (method === "POST") { setTitle(""); setContent(""); }
      setDeleteID(null); setNotice(method === "POST" ? c.knowledgeSaved : c.knowledgeDeleted);
      const data = await requestJSON<{ items: KnowledgeItem[] }>("/api/knowledge", { signal: controller.signal });
      setItems(data.items ?? []);
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (!available) return <p className="empty-note">{c.featureUnavailable}</p>;
  return <div className="panel-stack">
    <div><h3>{c.knowledgeTitle}</h3><p className="muted">{c.knowledgeNote}</p></div>
    <form onSubmit={(event) => { event.preventDefault(); void mutate("POST"); }} className="knowledge-form">
      <label htmlFor="knowledge-title">{c.itemTitle}</label><Input id="knowledge-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} disabled={busy} />
      <label htmlFor="knowledge-content">{c.itemContent}</label><Textarea id="knowledge-content" value={content} onChange={(event) => setContent(event.target.value)} minHeight="130px" maxLength={20_000} disabled={busy} />
      <Button type="submit" className="primary-button" disabled={busy || !title.trim() || !content.trim()}>{busy ? <Spinner size="sm" /> : <Icon name="plus" />}{c.knowledgeAdd}</Button>
    </form>
    <ErrorNotice error={error} c={c} />{notice && <div role="status" className="notice notice-success">{notice}</div>}
    {loading ? <div role="status" className="loading-row"><Spinner size="sm" />{c.loading}</div> : items.length === 0 ? <p className="empty-note">{c.knowledgeEmpty}</p> : <ul className="knowledge-list">{items.map((item) => <li key={item.id} className="knowledge-item"><h4>{item.title}</h4>{item.content && <p dir="auto">{item.content}</p>}{deleteID === item.id ? <div className="inline-actions"><Button size="sm" colorPalette="red" onClick={() => void mutate("DELETE", item.id)} disabled={busy}>{c.confirmDelete}</Button><Button size="sm" variant="ghost" onClick={() => setDeleteID(null)} disabled={busy}>{c.back}</Button></div> : <Button size="sm" variant="ghost" onClick={() => setDeleteID(item.id)} disabled={busy}><Icon name="trash" size={16} />{c.delete}</Button>}</li>)}</ul>}
  </div>;
}

export function HistoryPanel({ c, onOpen }: { c: Copy; onOpen: (detail: ConversationDetail) => void }) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteID, setDeleteID] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestJSON<{ items: Conversation[] }>("/api/conversations", { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setItems(data.items ?? []); }).catch((caught) => { if (!controller.signal.aborted) setError(caught); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); active.current?.abort(); };
  }, []);
  async function act(id: string, remove: boolean) {
    if (busy) return;
    const controller = new AbortController(); active.current = controller; setBusy(id); setError(null);
    try {
      if (remove) {
        await requestJSON(`/api/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE", signal: controller.signal });
        setItems((current) => current.filter((item) => item.id !== id)); setDeleteID(null);
      } else {
        const detail = await requestJSON<ConversationDetail>(`/api/conversations?id=${encodeURIComponent(id)}`, { signal: controller.signal });
        onOpen(detail);
      }
    } catch (caught) { if (!controller.signal.aborted) setError(caught); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  return <div className="panel-stack"><p className="muted">{c.conversationsNote}</p><ErrorNotice error={error} c={c} />{loading ? <div className="loading-row"><Spinner size="sm" />{c.loading}</div> : items.length === 0 ? <p className="empty-note">{c.noConversations}</p> : <ul className="knowledge-list">{items.map((item) => <li className="history-item" key={item.id}><Button variant="ghost" className="history-open" disabled={busy !== null} onClick={() => void act(item.id, false)}><Icon name="chat" /><span>{item.title}</span>{busy === item.id && <Spinner size="xs" />}</Button>{deleteID === item.id ? <div className="inline-actions"><Button size="sm" colorPalette="red" disabled={busy !== null} onClick={() => void act(item.id, true)}>{c.confirmDelete}</Button><Button size="sm" variant="ghost" onClick={() => setDeleteID(null)}>{c.back}</Button></div> : <Button size="sm" variant="ghost" aria-label={`${c.delete}: ${item.title}`} onClick={() => setDeleteID(item.id)}><Icon name="trash" size={16} /></Button>}</li>)}</ul>}</div>;
}

export function StatusPanel({ c, status, language, onRefresh }: { c: Copy; status: Status | null; language: Language; onRefresh: () => Promise<void> }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!status?.paired) return;
    const controller = new AbortController();
    Promise.allSettled([
      requestJSON<Metrics>("/api/metrics", { signal: controller.signal }),
      requestJSON<Record<string, unknown>>("/api/settings", { signal: controller.signal }),
    ]).then(([metricResult, settingResult]) => {
      if (controller.signal.aborted) return;
      if (metricResult.status === "fulfilled") setMetrics(metricResult.value); else setError(metricResult.reason);
      if (settingResult.status === "fulfilled") setSettings(settingResult.value); else setError(settingResult.reason);
      setLoading(false);
    });
    return () => controller.abort();
  }, [status?.paired]);
  const formatter = new Intl.NumberFormat(language === "ar" ? "ar" : "en", { maximumFractionDigits: 2 });
  const value = (item: unknown) => typeof item === "number" && Number.isFinite(item) ? formatter.format(item) : c.unknown;
  return <div className="panel-stack">
    <div className="status-summary"><span className={`status-dot ${status?.paired ? "is-online" : ""}`} /><strong>{status?.paired ? c.connected : status?.configured ? c.pairNeeded : c.notConfigured}</strong><Button variant="ghost" size="sm" onClick={() => void onRefresh()} aria-label={c.refresh}><Icon name="refresh" size={18} /></Button></div>
    <dl className="status-list"><div><dt>{c.engine}</dt><dd dir="auto">{status?.model || c.unknown}</dd></div><div><dt>{c.status}</dt><dd>{status?.busy ? c.busy : status?.paired ? c.ready : c.unknown}</dd></div><div><dt>{c.liveWeb}</dt><dd>{status?.capabilities?.live_web ? c.available : c.unavailable}</dd></div><div><dt>{c.cloud}</dt><dd>{status?.cloud_configured ? c.enabled : c.disabled}</dd></div><div><dt>{c.storage}</dt><dd>{status?.storage || c.unknown}</dd></div></dl>
    {!status?.cloud_configured && <p className="small-note">{c.noCloud}</p>}
    <h3>{c.metrics}</h3><ErrorNotice error={error} c={c} />
    {loading && status?.paired ? <div className="loading-row"><Spinner size="sm" />{c.loading}</div> : <div className="metric-grid">{([[c.requests, metrics?.requests], [c.localRequests, metrics?.local_requests], [c.webRequests, metrics?.web_requests], [c.latency, metrics?.latency_ms], [c.memoryItems, metrics?.memory_items]] as const).map(([label, item]) => <div className="metric" key={label}><span>{label}</span><strong>{value(item)}{label === c.latency && typeof item === "number" ? " ms" : ""}</strong></div>)}</div>}
    {status?.cloud_configured && settings && <div className="metric"><span>{c.budgets}</span><strong>{value(settings.cloud_daily_budget_usd)} USD / {language === "ar" ? "يوم" : "day"}</strong></div>}
    <p className="small-note">{c.networkNote}</p>
  </div>;
}
