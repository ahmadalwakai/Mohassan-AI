"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ChatQuestionField } from "@mohassan/contracts";
import styles from "./assistant-app.module.css";

/**
 * The brain's questions in a small panel above the input, one question at a time (owner's
 * direction, 2026-11-20: "like Claude"). Each question lists the brain's suggestions from the
 * owner's own site as numbered options, the confident one chosen in advance, with a box for another
 * answer. Several questions end on a short review; one button sends every answer together as one
 * numbered reply, which the brain reads in the order it asked.
 *
 * Keys: a number picks that option, Enter goes on, the arrows move between options.
 */
export function QuestionPanel({ fields, busy, onSubmit, onStop }: { fields: ChatQuestionField[]; busy: boolean; onSubmit: (text: string) => void; onStop?: () => void }) {
  const [chosen, setChosen] = useState<Set<number>[]>(() => fields.map(field => new Set(field.selected ?? [])));
  const [other, setOther] = useState<string[]>(() => fields.map(() => ""));
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const several = fields.length > 1;
  const reviewing = several && step === fields.length;

  const answerOf = (index: number, sets = chosen, typedAnswers = other) => {
    const field = fields[index]!;
    const picked = [...sets[index]!].sort((a, b) => a - b).map(item => field.suggestions[item]?.label).filter(Boolean) as string[];
    const typed = typedAnswers[index]!.trim();
    // In a single-answer question a typed answer replaces the chosen suggestion.
    return (field.multiple ? [...picked, ...(typed ? [typed] : [])] : typed ? [typed] : picked).join(", ");
  };
  const answers = fields.map((_, index) => answerOf(index));
  const ready = answers.every(Boolean);
  const reply = (list = answers) => list.map((answer, index) => several ? `${index + 1}. ${answer}` : answer).join("\n");

  // Each new step starts at its first option, or at the box when there is nothing to choose.
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>("[data-option][aria-checked='true'], [data-option], [data-other], [data-send]");
    target?.focus({ preventScroll: true });
  }, [step]);

  const next = (sets = chosen, typedAnswers = other) => {
    if (busy) return;
    if (!several) {
      const answer = answerOf(0, sets, typedAnswers);
      if (answer) onSubmit(answer);
      return;
    }
    if (!answerOf(step, sets, typedAnswers)) return;
    // Go to the first question still unanswered, or to the review once all are.
    const missing = fields.findIndex((_, index) => index > step && !answerOf(index, sets, typedAnswers));
    setStep(missing >= 0 ? missing : fields.length);
  };

  const pick = (fieldIndex: number, suggestion: number) => {
    const field = fields[fieldIndex]!;
    const sets = chosen.map((set, index) => {
      if (index !== fieldIndex) return set;
      if (field.multiple) { const copy = new Set(set); if (copy.has(suggestion)) copy.delete(suggestion); else copy.add(suggestion); return copy; }
      return new Set([suggestion]);
    });
    setChosen(sets);
    if (field.multiple) return;
    // A single choice replaces a typed answer and goes on by itself, as in Claude.
    const typedAnswers = other.map((value, index) => index === fieldIndex ? "" : value);
    setOther(typedAnswers);
    window.setTimeout(() => next(sets, typedAnswers), 140);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    const target = event.target as HTMLElement;
    const inBox = target.tagName === "INPUT";
    if (event.key === "Escape" && onStop) { event.preventDefault(); onStop(); return; }
    if (reviewing) return;
    const field = fields[step]!;
    if (!inBox && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < field.suggestions.length) { event.preventDefault(); pick(step, index); }
      else if (index === field.suggestions.length) { event.preventDefault(); panel.current?.querySelector<HTMLElement>("[data-other]")?.focus(); }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = [...(panel.current?.querySelectorAll<HTMLElement>("[data-option], [data-other]") ?? [])];
      const at = items.indexOf(target);
      if (at < 0) return;
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    if (event.key === "Enter" && (inBox || field.multiple)) { event.preventDefault(); next(); }
  };

  const field = reviewing ? null : fields[step]!;
  const typedHere = field ? other[step]!.trim() : "";

  return <div ref={panel} className={styles.ask} role="dialog" aria-label="أسئلة موحسن" onKeyDown={onKey}>
    <div className={styles.askHead}>
      {several ? <div className={styles.askTabs} role="tablist" aria-label="الأسئلة">
        {fields.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={step === index} disabled={busy}
          className={`${styles.askTab} ${step === index ? styles.askTabOn : ""}`} onClick={() => setStep(index)} title={item.prompt}>
          {answers[index] ? <Check size={12} aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}
          <span className={styles.hidden}>{`السؤال ${index + 1}${answers[index] ? "، أُجيب" : ""}`}</span>
        </button>)}
        <button type="button" role="tab" aria-selected={reviewing} disabled={busy || !ready} className={`${styles.askTab} ${styles.askTabSend} ${reviewing ? styles.askTabOn : ""}`} onClick={() => setStep(fields.length)}>إرسال</button>
      </div> : <span />}
      <span className={styles.askCount}>{reviewing ? "راجع إجاباتك" : several ? `${step + 1} من ${fields.length}` : "سؤال واحد"}</span>
      {onStop ? <button type="button" className={styles.askClose} aria-label="توقف هنا" title="توقف هنا (Esc)" disabled={busy} onClick={onStop}><X size={16} /></button> : null}
    </div>

    {field ? <div key={field.id} className={styles.askBody}>
      <p className={styles.askPrompt} dir="auto">{field.prompt}</p>
      {field.multiple ? <p className={styles.askNote}>يمكنك اختيار أكثر من واحد، ثم اضغط «التالي».</p> : null}
      <div className={styles.askOptions} role={field.multiple ? "group" : "radiogroup"} aria-label={field.prompt}>
        {field.suggestions.map((suggestion, index) => {
          const on = chosen[step]!.has(index) && !(typedHere && !field.multiple);
          return <button key={`${suggestion.label}-${index}`} type="button" data-option role={field.multiple ? "checkbox" : "radio"} aria-checked={on} disabled={busy}
            className={`${styles.askOption} ${on ? styles.askOptionOn : ""}`} onClick={() => pick(step, index)}>
            <kbd aria-hidden="true">{index + 1}</kbd>
            <span className={styles.askLabel}><span dir="auto">{suggestion.label}</span>{suggestion.reason ? <small dir="auto">{suggestion.reason}</small> : null}</span>
            {on ? <Check size={15} className={styles.askCheck} aria-hidden="true" /> : null}
          </button>;
        })}
        <label className={`${styles.askOption} ${styles.askOther} ${typedHere ? styles.askOptionOn : ""}`}>
          <kbd aria-hidden="true">{field.suggestions.length + 1}</kbd>
          <input data-other dir="auto" value={other[step]} disabled={busy} placeholder={field.placeholder ?? (field.suggestions.length ? "إجابة أخرى…" : "اكتب إجابتك…")} aria-label={`${field.prompt}: ${field.suggestions.length ? "إجابة أخرى" : "إجابتك"}`}
            onChange={event => { const value = event.target.value; setOther(current => current.map((item, i) => i === step ? value : item)); }} />
        </label>
      </div>
    </div> : <div className={styles.askBody}>
      <ol className={styles.askReview}>
        {fields.map((item, index) => <li key={item.id}>
          <button type="button" disabled={busy} onClick={() => setStep(index)}>
            <span className={styles.askReviewQ} dir="auto">{item.prompt}</span>
            <span className={styles.askReviewA} dir="auto">{answers[index] || "—"}</span>
          </button>
        </li>)}
      </ol>
    </div>}

    <div className={styles.askFoot}>
      <span className={styles.askKeys}>{reviewing ? <>اضغط سؤالاً لتعديل إجابته</> : <><kbd>1</kbd>–<kbd>{Math.min(9, (field?.suggestions.length ?? 0) + 1)}</kbd> للاختيار · <kbd>Enter</kbd> للتالي{onStop ? <> · <kbd>Esc</kbd> للتوقف</> : null}</>}</span>
      <div className={styles.askActions}>
        {several && step > 0 ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => setStep(step - 1)}><ChevronRight size={15} aria-hidden="true" />رجوع</button> : null}
        {reviewing
          ? <button type="button" data-send className={styles.primary} disabled={busy || !ready} onClick={() => onSubmit(reply())}>أرسل الإجابات</button>
          : <button type="button" className={styles.primary} disabled={busy || !answers[step]} onClick={() => next()}>{several ? <>التالي<ChevronLeft size={15} aria-hidden="true" /></> : "أرسل"}</button>}
      </div>
    </div>
  </div>;
}

/**
 * While the panel is open it holds the questions, so the message above it need not list them
 * again: drops the block a line ending in ":" opens (the questions) up to the next blank line.
 * A "- " list after the colon is a summary, not questions, and stays. Text clients (the phone)
 * still receive the whole message.
 */
export function withoutQuestionList(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line, index) => line.trim().endsWith(":") && lines[index + 1]?.trim() && !lines[index + 1]!.trim().startsWith("- "));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim()) end++;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n").trim();
}
