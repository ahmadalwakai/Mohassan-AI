import { useEffect, useState } from "react";
import { BookOpen, Brain, Clock, Globe, MousePointerClick, PenLine, Search, Sparkles, type LucideIcon } from "lucide-react";
import { activityKind, elapsedLabel, type ActivityKind } from "./activity-phase";
import styles from "./agent-activity.module.css";

/** Decorative activity shapes; the surrounding text supplies the status. */
export function AgentActivity({ variant = "dots" }: { variant?: "dots" | "spinner" }) {
  return <span className={styles[variant]} aria-hidden="true">
    {variant === "dots" ? <><span /><span /><span /><span /></> : null}
  </span>;
}

const ICONS: Record<ActivityKind, LucideIcon> = { think: Sparkles, wait: Clock, memory: Brain, search: Search, open: Globe, read: BookOpen, write: PenLine, act: MousePointerClick };

/** Time since the request, ticking once a second; nothing for the first five seconds. */
function useElapsed(since: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const start = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(start) ? elapsedLabel(now - start) : null;
}

/**
 * The live line: an icon for the kind of work, the server's own words for what is happening now,
 * and how long the request has taken so far. Only the server names the phase; the icon and its
 * motion follow the words.
 */
export function ActivityLine({ text, since }: { text: string; since?: string | null }) {
  const kind = activityKind(text);
  const Icon = ICONS[kind];
  const elapsed = useElapsed(since);
  return <span className={styles.line} data-kind={kind}>
    <span className={`${styles.icon} ${styles[kind]}`} aria-hidden="true"><Icon size={14} strokeWidth={2.1} /></span>
    <span role="status" className={styles.words} dir="auto"><span key={text} className={styles.enter}>{text}</span></span>
    {elapsed ? <span className={styles.elapsed} aria-hidden="true">{elapsed}</span> : null}
  </span>;
}
