"use client";

import { Button, Checkbox, LocaleProvider, Spinner, Textarea } from "@chakra-ui/react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { requestJSON, RequestError } from "./client";
import { copy } from "./copy";
import { Icon } from "./icons";
import { MessageCard } from "./message-card";
import { ErrorNotice, HistoryPanel, KnowledgePanel, PairingCard, Panel, StatusPanel } from "./panels";
import type { ChatMessage, ChatMode, ChatRequest, ChatResponse, ConversationDetail, Language, Status } from "./types";

type PanelName = "knowledge" | "history" | "status" | null;
type FailedRequest = { body: ChatRequest; userID: string };

function conversationContext(messages: ChatMessage[]): { messages: ChatRequest["messages"]; trimmed: boolean } {
  const eligible = messages.filter((message) => message.delivery !== "failed");
  const selected: ChatRequest["messages"] = [];
  let characters = 0;
  for (let index = eligible.length - 1; index >= 0 && selected.length < 16; index--) {
    const message = eligible[index];
    const count = Array.from(message.content).length;
    if (characters + count > 24_000) break;
    selected.unshift({ role: message.role, content: message.content }); characters += count;
  }
  return { messages: selected, trimmed: selected.length < eligible.length };
}

export function WaslaApp() {
  const [language, setLanguage] = useState<Language>("ar");
  const c = copy[language];
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [panel, setPanel] = useState<PanelName>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>("auto");
  const [remember, setRemember] = useState(false);
  const [useMemory, setUseMemory] = useState(false);
  const [allowCloud, setAllowCloud] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failed, setFailed] = useState<FailedRequest | null>(null);
  const [conversationID, setConversationID] = useState<string | undefined>();
  const [contextTrimmed, setContextTrimmed] = useState(false);
  const epoch = useRef(0);
  const active = useRef<AbortController | null>(null);
  const statusInFlight = useRef<{ signal?: AbortSignal } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const characterCount = Array.from(draft).length;
  const ready = status?.configured === true && status.paired && !statusError;
  const modeAvailable = mode !== "live_web" || status?.capabilities?.live_web === true;

  const refreshStatus = useCallback(async (signal?: AbortSignal, force = false) => {
    if (statusInFlight.current && !force && !statusInFlight.current.signal?.aborted) return;
    const marker = { signal }; statusInFlight.current = marker;
    try {
      const fresh = await requestJSON<Status>("/api/status", { signal }, 12_000);
      if (statusInFlight.current === marker && !signal?.aborted) { setStatus(fresh); setStatusError(null); }
    } catch (caught) { if (statusInFlight.current === marker && !signal?.aborted) setStatusError(caught); }
    finally { if (statusInFlight.current === marker) statusInFlight.current = null; }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initial = setTimeout(() => { if (!controller.signal.aborted) void refreshStatus(controller.signal); }, 0);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refreshStatus(controller.signal); }, 20_000);
    return () => { clearTimeout(initial); clearInterval(timer); controller.abort(); active.current?.abort(); };
  }, [refreshStatus]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "auto" }); }, [messages.length, busy]);

  function changeLanguage() {
    const next: Language = language === "ar" ? "en" : "ar";
    setLanguage(next); document.documentElement.lang = next; document.documentElement.dir = next === "ar" ? "rtl" : "ltr";
  }

  function newConversation() {
    epoch.current += 1; active.current?.abort(); active.current = null;
    setMessages([]); setDraft(""); setBusy(false); setError(null); setFailed(null); setConversationID(undefined); setContextTrimmed(false); setRemember(false); setUseMemory(false); setAllowCloud(false);
    composer.current?.focus();
  }

  function openConversation(detail: ConversationDetail) {
    newConversation();
    setConversationID(detail.id);
    setMessages(detail.messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ id: crypto.randomUUID(), role: message.role as "user" | "assistant", content: message.content, delivery: "sent" })));
    setPanel(null);
  }

  async function sendRequest(body: ChatRequest, userID: string) {
    if (active.current || !ready) return;
    const controller = new AbortController(); active.current = controller;
    const requestEpoch = epoch.current;
    setBusy(true); setError(null); setFailed(null);
    setMessages((current) => current.map((message) => message.id === userID ? { ...message, delivery: "pending" } : message));
    try {
      const reply = await requestJSON<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify(body), signal: controller.signal }, 230_000);
      if (requestEpoch !== epoch.current || controller.signal.aborted) return;
      if (typeof reply.content !== "string" || !reply.content.trim()) throw new RequestError(c.emptyReply, 502, "empty_reply");
      setMessages((current) => [...current.map((message) => message.id === userID ? { ...message, delivery: "sent" as const } : message), { id: crypto.randomUUID(), role: "assistant", content: reply.content, response: reply }]);
      if (reply.conversation_id) setConversationID(reply.conversation_id);
    } catch (caught) {
      if (requestEpoch !== epoch.current) return;
      setError(caught); setFailed({ body, userID });
      setMessages((current) => current.map((message) => message.id === userID ? { ...message, delivery: "failed" } : message));
      if (caught instanceof RequestError && caught.status === 401) setStatus((current) => current ? { ...current, paired: false } : current);
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); void refreshStatus(); }
    }
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || !ready || busy || active.current || characterCount > 8000 || !modeAvailable) return;
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", content: draft.trim(), delivery: "pending" };
    const context = conversationContext([...messages, user]);
    const body: ChatRequest = { messages: context.messages, mode, remember: remember && status?.capabilities?.memory === true, use_memory: useMemory && status?.capabilities?.knowledge === true, allow_cloud: allowCloud && status?.cloud_configured === true, request_id: crypto.randomUUID(), ...(conversationID ? { conversation_id: conversationID } : {}) };
    setContextTrimmed(context.trimmed); setMessages((current) => [...current, user]); setDraft("");
    void sendRequest(body, user.id);
  }

  const connectionLabel = statusError ? c.disconnected : !status ? c.checking : !status.configured ? c.notConfigured : !status.paired ? c.pairNeeded : status.busy ? c.busy : c.connected;
  const panelTitle = panel === "knowledge" ? c.knowledge : panel === "history" ? c.conversations : c.status;
  const modes = [{ value: "auto" as const, label: c.auto, icon: "spark" as const, note: c.autoNote }, { value: "live_web" as const, label: c.liveWeb, icon: "globe" as const, note: c.webNote }, { value: "local" as const, label: c.local, icon: "computer" as const, note: c.localNote }];
  const suggestions = [{ label: c.promptPlanLabel, prompt: c.promptPlan, icon: "spark" as const }, { label: c.promptExplainLabel, prompt: c.promptExplain, icon: "book" as const }, { label: c.promptResearchLabel, prompt: c.promptResearch, icon: "globe" as const }];

  return <LocaleProvider locale={language === "ar" ? "ar" : "en-US"}>
    <div className="app-shell" dir={language === "ar" ? "rtl" : "ltr"}>
      <a className="skip-link" href="#conversation">{c.chat}</a>
      <aside className="sidebar">
        <div className="brand"><Image src="/connect.png" alt="CONNECT" width={46} height={46} priority /><div><strong>{c.appName}</strong><span>HYBRID AI</span></div></div>
        <Button className="new-chat-button" onClick={newConversation}><Icon name="plus" />{c.newChat}</Button>
        <nav aria-label={c.appName} className="side-nav"><button className="nav-item is-active" onClick={() => composer.current?.focus()}><Icon name="chat" />{c.chat}<span className="nav-dot" /></button><button className="nav-item" onClick={() => setPanel("knowledge")}><Icon name="book" />{c.knowledge}</button><button className="nav-item" onClick={() => setPanel("history")} disabled={!status?.paired}><Icon name="history" />{c.conversations}</button></nav>
        <div className="sidebar-bottom"><div className="privacy-card"><Icon name="shield" size={23} /><strong>{c.privacyNote}</strong><p>{c.supportNote}</p></div><button className="nav-item" onClick={() => setPanel("status")}><Icon name="activity" />{c.status}</button><div className="sidebar-caption">CONNECT <span>·</span> {c.subtitle}</div></div>
      </aside>

      <main className="workspace" id="conversation">
        <header className="topbar"><div className="mobile-brand"><Image src="/connect.png" alt="CONNECT" width={34} height={34} /><strong>{c.appName}</strong></div><div className="desktop-page-title"><span>{c.chat}</span><span className="topbar-divider">/</span><span>{c.currentSession}</span></div><div className="topbar-actions"><button className="connection-pill" onClick={() => setPanel("status")} aria-label={`${c.status}: ${connectionLabel}`}><span className={`status-dot ${ready ? "is-online" : ""}`} /><span>{connectionLabel}</span></button><Button variant="ghost" className="language-button" onClick={changeLanguage} lang={language === "ar" ? "en" : "ar"}>{c.language}</Button><Button variant="ghost" className="mobile-icon" onClick={newConversation} aria-label={c.newChat}><Icon name="plus" /></Button></div></header>
        <div className="mobile-tools"><Button variant="ghost" size="sm" onClick={() => setPanel("knowledge")}><Icon name="book" size={16} />{c.knowledge}</Button><Button variant="ghost" size="sm" onClick={() => setPanel("history")} disabled={!status?.paired}><Icon name="history" size={16} />{c.conversations}</Button><Button variant="ghost" size="sm" onClick={() => setPanel("status")} aria-label={c.status}><Icon name="activity" size={16} /></Button></div>
        <div className="conversation-scroll">
          <div className="conversation-inner">
            <ErrorNotice error={statusError} c={c} />
            {!!statusError && <Button variant="outline" size="sm" onClick={() => void refreshStatus(undefined, true)}><Icon name="refresh" size={15} />{c.refresh}</Button>}
            {status && !status.paired && <PairingCard status={status} c={c} onPaired={() => refreshStatus(undefined, true)} />}
            {messages.length === 0 && <section className="welcome"><div className="welcome-mark"><Icon name="spark" size={36} /></div><span className="eyebrow">CONNECT / HYBRID AI</span><h1>{c.welcome}</h1><p>{c.welcomeNote}</p><div className="suggestions">{suggestions.map((suggestion) => <button key={suggestion.label} onClick={() => { setDraft(suggestion.prompt); composer.current?.focus(); }}><Icon name={suggestion.icon} size={21} /><span>{suggestion.label}</span><span className="suggestion-arrow">↗</span></button>)}</div><span className="welcome-footnote">{c.draftsNote}</span></section>}
            <div className="message-list" aria-live="polite" aria-relevant="additions">{messages.map((message) => <MessageCard key={message.id} message={message} c={c} language={language} />)}</div>
            {busy && <div className="working-indicator" role="status"><span className="working-symbol"><Icon name="spark" size={18} /></span><Spinner size="sm" /><span>{c.working}</span></div>}
            <ErrorNotice error={error} c={c} />
            {failed && !busy && <div className="retry-row"><Button variant="outline" onClick={() => void sendRequest(failed.body, failed.userID)} disabled={!ready}><Icon name="refresh" size={16} />{c.retry}</Button><Button variant="ghost" onClick={() => { setDraft(failed.body.messages.at(-1)?.content ?? ""); setFailed(null); setError(null); composer.current?.focus(); }}>{language === "ar" ? "تعديل الرسالة" : "Edit message"}</Button><span>{c.safePending}</span></div>}
            <div ref={end} />
          </div>
        </div>
        <div className="composer-area"><div className="composer-inner">
          <div className="mode-row" role="group" aria-label={c.modeLabel}>{modes.map((item) => <button type="button" key={item.value} aria-pressed={mode === item.value} title={item.note} className={`mode-button ${mode === item.value ? "is-selected" : ""}`} disabled={busy || failed !== null || (item.value === "live_web" && status?.capabilities?.live_web !== true)} onClick={() => setMode(item.value)}><Icon name={item.icon} size={16} />{item.label}</button>)}<span className="engine-name"><span className="status-dot" />{status?.model || c.unknown}</span></div>
          <form onSubmit={send} className={`composer ${busy ? "composer-busy" : ""}`}><label className="sr-only" htmlFor="chat-draft">{c.composer}</label><Textarea ref={composer} id="chat-draft" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder={ready ? c.composer : c.offlineNote} rows={2} resize="none" border="0" boxShadow="none" className="composer-input" dir="auto" disabled={busy} />
            <div className="composer-toolbar"><span className={`character-count ${characterCount > 8000 ? "is-over" : ""}`}>{characterCount > 0 ? `${new Intl.NumberFormat(language).format(characterCount)} / 8,000` : c.shortcut}</span>{busy ? <Button type="button" className="send-button" onClick={() => active.current?.abort()} aria-label={c.stop}><Icon name="stop" /></Button> : <Button type="submit" className="send-button" disabled={!ready || !draft.trim() || characterCount > 8000 || !modeAvailable} aria-label={c.send}><Icon name="arrow" /></Button>}</div>
          </form>
          {characterCount > 8000 && <p className="limit-note" role="alert">{c.limit}</p>}
          {contextTrimmed && <p className="small-note">{c.contextTrimmed}</p>}
          <div className="memory-options"><Checkbox.Root checked={remember} onCheckedChange={(event) => setRemember(event.checked === true)} disabled={busy || failed !== null || status?.capabilities?.memory !== true} colorPalette="green" size="sm" title={c.memorySaveNote}><Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>{c.memorySave}</Checkbox.Label></Checkbox.Root><Checkbox.Root checked={useMemory} onCheckedChange={(event) => setUseMemory(event.checked === true)} disabled={busy || failed !== null || status?.capabilities?.knowledge !== true} colorPalette="green" size="sm" title={c.useKnowledgeNote}><Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>{c.useKnowledge}</Checkbox.Label></Checkbox.Root>{status?.cloud_configured === true && <Checkbox.Root checked={allowCloud} onCheckedChange={(event) => setAllowCloud(event.checked === true)} disabled={busy || failed !== null} colorPalette="green" size="sm"><Checkbox.HiddenInput /><Checkbox.Control /><Checkbox.Label>{language === "ar" ? "اسمح بالمحرك السحابي" : "Allow cloud engine"}</Checkbox.Label></Checkbox.Root>}</div>
        </div></div>
      </main>
      <Panel title={panelTitle} open={panel !== null} onClose={() => setPanel(null)} language={language} c={c}>{panel === "knowledge" && <KnowledgePanel c={c} available={status?.paired === true && status.capabilities?.knowledge === true} />}{panel === "history" && status?.paired && <HistoryPanel c={c} onOpen={openConversation} />}{panel === "status" && <StatusPanel c={c} status={status} language={language} onRefresh={() => refreshStatus(undefined, true)} />}</Panel>
    </div>
  </LocaleProvider>;
}
