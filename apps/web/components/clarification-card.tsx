"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Badge, Spinner } from "@chakra-ui/react";
import { CircleHelp, ListChecks, Send, ShieldAlert } from "lucide-react";
import type { ChatDecisionStream, ChatGoalSummary, ChatQuestion, ReadinessStatus } from "@mohassan/contracts";
import styles from "./clarification-card.module.css";

const STATUS: Record<ReadinessStatus, { text: string; tone: "ok" | "warn" | "bad" | "idle" }> = {
  READY: { text: "جاهز للتنفيذ", tone: "ok" }, NEEDS_CLARIFICATION: { text: "ينتظر إجابتك", tone: "warn" }, NEEDS_RESEARCH: { text: "يحتاج بحثًا أولًا", tone: "idle" },
  NEEDS_APPROVAL: { text: "سيطلب موافقتك قبل التنفيذ", tone: "warn" }, BLOCKED: { text: "متوقف", tone: "bad" },
};
const KIND: Record<string, string> = { USER_CONSTRAINT: "منك", VERIFIED_FACT: "متحقق منه", INFERRED_PREFERENCE: "مستنتج", WORKING_ASSUMPTION: "افتراض", UNKNOWN: "غير معروف" };
const STEP: Record<string, string> = { answer: "الرد", research: "البحث", read: "القراءة", draft: "المسودة", external_write: "التغيير في الحساب أو المشروع", spend: "الصرف", irreversible: "إجراء لا يُسترجع" };

/** What the engine understood, as recorded facts only. No model reasoning is shown. */
export function GoalSummary({ goal, decisions }: { goal: ChatGoalSummary; decisions?: ChatDecisionStream | null }) {
  const status = STATUS[goal.status];
  const relevant = goal.known.length || goal.missing.length || goal.assumptions.length || goal.blockers.length;
  if (!relevant && goal.outcome === "PROCEED") return null;
  return <details className={styles.summary}>
    <summary><ListChecks size={15} aria-hidden="true" /><span>ما فهمته من طلبك</span><Badge className={`${styles.badge} ${styles[status.tone]}`}>{status.text}</Badge></summary>
    <div className={styles.body}>
      {goal.known.length ? <section><h4>معلوم</h4><ul>{goal.known.map(item => <li key={item.slot}><span>{item.label}</span><bdi dir="auto">{item.value}</bdi><em>{KIND[item.kind] ?? item.kind}</em></li>)}</ul></section> : null}
      {goal.assumptions.length ? <section><h4>افتراضات (يمكنك تغييرها)</h4><ul>{goal.assumptions.map(item => <li key={item.slot}><span>{item.label}</span><bdi dir="auto">{item.value}</bdi></li>)}</ul></section> : null}
      {goal.missing.length ? <section><h4>ناقص</h4><ul>{goal.missing.map(item => <li key={item.slot}><span>{item.label}</span></li>)}</ul></section> : null}
      {goal.blockers.length ? <section role="note"><h4><ShieldAlert size={14} aria-hidden="true" /> ما يمنع المتابعة</h4><ul>{goal.blockers.map(item => <li key={`${item.code}${item.slot ?? ""}`} dir="auto">{item.message}</li>)}</ul></section> : null}
      {goal.steps.length > 1 ? <section><h4>الخطوات</h4><ul>{goal.steps.map(step => <li key={step.step}><span>{STEP[step.step] ?? step.step}</span><em>{STATUS[step.status].text}</em></li>)}</ul></section> : null}
      {decisions?.events.length ? <section><h4>سجل القرارات</h4><ol className={styles.log}>{decisions.events.map(event => <li key={event.seq} dir="auto">{event.summary}</li>)}</ol></section> : null}
    </div>
  </details>;
}

/** The summary on its own, for a task that is running, done or blocked. Hidden when there is nothing to show. */
export function GoalPanel({ goal, decisions }: { goal: ChatGoalSummary; decisions?: ChatDecisionStream | null }) {
  const relevant = goal.known.length || goal.missing.length || goal.assumptions.length || goal.blockers.length || goal.outcome !== "PROCEED";
  return relevant ? <section className={styles.standalone} aria-label="ملخص المهمة"><GoalSummary goal={goal} decisions={decisions} /></section> : null;
}

/**
 * A question raised by the clarification engine. The reply goes to the server,
 * which validates it against the pending question; answering is never approval.
 */
export function ClarificationCard({ question, goal, decisions, busy, onChoose, onAnswer }: {
  question: ChatQuestion & { clarification: NonNullable<ChatQuestion["clarification"]> };
  goal?: ChatGoalSummary | null; decisions?: ChatDecisionStream | null; busy: boolean;
  onChoose: (optionId: string) => void; onAnswer: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  const inputId = useId();
  const details = question.clarification;
  const recommended = details.recommendedOptionId;
  const ordered = [...question.options].sort((a, b) => Number(b.id === recommended) - Number(a.id === recommended));
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value) { setProblem("اكتب إجابتك أولًا."); return; }
    setProblem("");
    // The text stays until the server accepts it, so a failed send loses nothing.
    if (await onAnswer(value)) setText("");
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  return <section className={styles.card} aria-labelledby={`${inputId}-title`}>
    <header className={styles.head}>
      <h3 id={`${inputId}-title`}><CircleHelp size={16} aria-hidden="true" />سؤال قبل المتابعة</h3>
      <Badge className={`${styles.badge} ${styles.warn}`}>لن أنفذ ما يعتمد على الإجابة قبل وصولها</Badge>
    </header>
    <p className={styles.prompt} dir="auto">{question.prompt}</p>
    {details.reason ? <p className={styles.reason} dir="auto"><strong>لماذا أسأل؟</strong> {details.reason}</p> : null}
    <div className={styles.options} role="group" aria-label="خيارات الإجابة">
      {ordered.map(option => <button key={option.id} type="button" disabled={busy} className={option.id === recommended ? styles.recommended : option.id === "stop" ? styles.quiet : undefined} onClick={() => onChoose(option.id)}>
        <span dir="auto">{option.label}</span>{option.id === recommended ? <em>مقترح</em> : null}
      </button>)}
    </div>
    {details.allowText ? <form className={styles.answer} onSubmit={submit}>
      <label htmlFor={inputId}>أو اكتب إجابتك</label>
      <div className={styles.row}>
        <textarea id={inputId} dir="auto" rows={2} maxLength={2000} value={text} disabled={busy} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${inputId}-problem` : undefined} onChange={event => setText(event.target.value)} onKeyDown={onKey} />
        <button type="submit" className={styles.send} disabled={busy} aria-label="إرسال الإجابة">{busy ? <Spinner size="xs" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}</button>
      </div>
      {problem ? <p id={`${inputId}-problem`} className={styles.problem} role="alert">{problem}</p> : null}
    </form> : null}
    <p className={styles.sr} role="status" aria-live="polite">{busy ? "يرسل إجابتك…" : "ينتظر إجابتك"}</p>
    {goal ? <GoalSummary goal={goal} decisions={decisions} /> : null}
  </section>;
}
