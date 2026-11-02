"use client";

import { Button } from "@chakra-ui/react";
import { useState } from "react";
import { safeSourceURL } from "./client";
import type { Copy } from "./copy";
import { Icon } from "./icons";
import type { ChatMessage, Language } from "./types";
import { warningMessage } from "./warning-messages";

export function routeLabel(route: string, c: Copy): string {
  const labels: Record<string, string> = { local: c.local, live_web: c.liveWeb, research: c.research, calculator: c.calculator, unit_conversion: c.unitConversion, knowledge: c.knowledgeRoute, actions: c.actions, cloud: c.cloud };
  return labels[route] ?? route;
}

export function MessageCard({ message, c, language }: { message: ChatMessage; c: Copy; language: Language }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const response = message.response;
  const evidence = response?.evidence;
  const formatter = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const cost = response?.usage?.estimated_cost_usd;
  const costLabel = typeof cost === "number" && Number.isFinite(cost) ? (cost > 0 && cost < 0.000001 ? "<0.000001" : new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(cost)) + " USD" : c.unknown;
  async function copyAnswer() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  function dateLabel(value?: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(date);
  }
  return <article className={`message message-${message.role}`} aria-label={message.role === "user" ? c.you : c.assistant}>
    <div className="message-heading"><span className={`message-avatar ${message.role === "assistant" ? "assistant-avatar" : ""}`}>{message.role === "assistant" ? <Icon name="spark" size={18} /> : c.you.slice(0, 1)}</span><strong>{message.role === "user" ? c.you : c.assistant}</strong>{response?.route && <span className="route-tag">{routeLabel(response.route, c)}</span>}</div>
    <div className="message-content" dir="auto">{message.content}</div>
    {message.delivery === "failed" && <p className="failed-message">{c.failedMessage}</p>}
    {response && <>
      <div className="answer-metadata">
        {evidence ? <span className={`evidence evidence-${evidence.level}`}><Icon name={evidence.level === "grounded" ? "check" : "shield"} size={14} />{evidence.level === "grounded" ? c.grounded : evidence.level === "limited" ? c.limited : c.unverified}</span> : <span>{c.noEvidence}</span>}
        {typeof response.timing_ms === "number" && <span>{formatter.format(response.timing_ms / 1000)} {language === "ar" ? "ث" : "s"}</span>}
        {response.model && <bdi>{response.model}</bdi>}
        {response.cache_hit === true && <span>{c.cached}</span>}
        {response.memory_saved === true && <span>{c.saved}</span>}
      </div>
      {evidence?.note && <p className="evidence-note" dir="auto">{evidence.note}</p>}
      {Array.from(new Set(response.warnings?.map((warning) => warningMessage(warning, language)) ?? [])).map((warning) => <div className="notice notice-warning" key={warning} dir={language === "ar" ? "rtl" : "ltr"}>{warning}</div>)}
      {!!response.sources?.length && <section className="sources"><div className="sources-title"><Icon name="globe" size={16} /><h3>{c.sources}</h3><span>{formatter.format(response.sources.length)}</span></div><div className="source-grid">{response.sources.map((source, index) => {
        const url = safeSourceURL(source.url);
        const published = dateLabel(source.published_at);
        const retrieved = dateLabel(source.retrieved_at);
        const sourceLabel = url?.hostname ?? (!source.url ? (language === "ar" ? "معرفة محفوظة" : "Saved note") : c.sourceUnavailable);
        const contents = <><span className="source-domain"><bdi>{sourceLabel}</bdi>{url && <Icon name="external" size={13} />}</span><strong dir="auto">{source.title}</strong>{source.snippet && <p dir="auto">{source.snippet}</p>}{(published || retrieved) && <span className="source-date">{published ? `${c.published}: ${published}` : `${c.retrieved}: ${retrieved}`}</span>}</>;
        return url ? <a className="source-card" key={`${source.url}-${index}`} href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{contents}</a> : <div className="source-card" key={`invalid-${index}`}>{contents}</div>;
      })}</div></section>}
      <div className="message-footer"><Button variant="ghost" size="xs" onClick={() => void copyAnswer()} aria-label={copied ? c.copied : c.copy}><Icon name={copied ? "check" : "copy"} size={15} />{copied ? c.copied : c.copy}</Button>{copyError && <span role="status">{c.error}</span>}{response.usage?.provider === "openai" && <span>{c.cloudCost}: {costLabel}</span>}</div>
    </>}
  </article>;
}
