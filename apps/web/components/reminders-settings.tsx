"use client";

import { Bell, X } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import type { ChatConversation as Conversation, EditReminderInput, ReminderDeliverySummary, ReminderSummary } from "@mohassan/contracts";
import { reminderErrorMessage, reminderLocalInput, reminderRecurrenceLabel, ReminderRequestError, reminderRequest, reminderTimeLabel } from "./reminders-client";
import { isNewerSnapshot } from "./run-view";
import styles from "./reminders-settings.module.css";

const POLL_MS = 30_000;

interface FollowConversation {
  conversation: Conversation | null;
  selection: RefObject<string | null>;
  setConversation: Dispatch<SetStateAction<Conversation | null>>;
  refreshHistory: () => Promise<unknown>;
}

function useReminderDeliveries({ conversation, selection, setConversation, refreshHistory }: FollowConversation) {
  const [deliveries, setDeliveries] = useState<ReminderDeliverySummary[] | null>(null);
  const [error, setError] = useState("");
  const historyDelivery = useRef<string | null>(null);
  const followDelivery = useEffectEvent(async (items: ReminderDeliverySummary[], signal: AbortSignal) => {
    const latest = items[0]?.id;
    if (latest && historyDelivery.current !== latest) {
      void refreshHistory().then(() => { historyDelivery.current = latest; }).catch(() => {});
    }
    const id = selection.current;
    if (!id || conversation?.id !== id) return;
    const delivery = items.find((item) => item.conversationId === id);
    if (!delivery || conversation.messages.some((message) => message.id === delivery.id)) return;
    const earliest = conversation.messages[0]?.createdAt;
    if (conversation.olderMessages && earliest && Date.parse(delivery.deliveredAt) < Date.parse(earliest)) return;
    try {
      const next = await reminderRequest<Conversation>(`/api/chat/conversations/${encodeURIComponent(id)}`, { signal });
      setConversation((current) => selection.current === id && isNewerSnapshot(current, next) ? next : current);
    } catch {
      // The next due-list poll retries the conversation refresh.
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fetching = false;
    async function poll() {
      if (signal.aborted || document.hidden || fetching) return;
      clearTimeout(timer);
      fetching = true;
      try {
        const result = await reminderRequest<{ deliveries: ReminderDeliverySummary[] }>("/api/reminders/due", { signal });
        if (signal.aborted) return;
        setDeliveries(result.deliveries);
        setError("");
        await followDelivery(result.deliveries, signal);
      } catch (caught) {
        if (!signal.aborted) setError(reminderErrorMessage(caught));
      } finally {
        fetching = false;
        if (!signal.aborted && !document.hidden) timer = setTimeout(poll, POLL_MS);
      }
    }
    document.addEventListener("visibilitychange", poll);
    window.addEventListener("online", poll);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
      window.removeEventListener("online", poll);
    };
  }, []);

  return { deliveries, error };
}

interface EditDraft {
  reminder: ReminderSummary;
  localDueAt: string;
  ambiguous: boolean;
  overlap?: EditReminderInput["overlap"];
}

export function RemindersSettings(props: FollowConversation & { onOpenConversation: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [reminders, setReminders] = useState<ReminderSummary[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [seen, setSeen] = useState<string | undefined>();
  const { deliveries, error: dueError } = useReminderDeliveries(props);
  const latest = deliveries?.[0]?.id;
  const hasArrival = !open && Boolean(latest && latest !== seen);

  useEffect(() => {
    if (!open || pending) return;
    const controller = new AbortController();
    const { signal } = controller;
    void reminderRequest<{ reminders: ReminderSummary[] }>("/api/reminders", { signal }).then((result) => {
      if (!signal.aborted) {
        setReminders(result.reminders.filter((item) => item.status === "scheduled"));
        setListError("");
      }
    }).catch((caught) => {
      if (!signal.aborted) setListError(reminderErrorMessage(caught));
    });
    return () => controller.abort();
  }, [latest, open, pending, revision]);

  function show() {
    setReminders(null);
    setListError("");
    setActionError("");
    setNotice("");
    setEdit(null);
    dialog.current?.showModal();
    setOpen(true);
  }

  function close() {
    setSeen(latest);
    setOpen(false);
  }

  function reload() {
    requestAnimationFrame(() => closeButton.current?.focus());
    setReminders(null);
    setListError("");
    setRevision((value) => value + 1);
  }

  function closeEditor() {
    setEdit(null);
    // During a save the invoking button is disabled until the next paint.
    requestAnimationFrame(() => editButton.current?.focus());
  }

  async function mutate(reminder: ReminderSummary, input?: EditReminderInput) {
    if (pending) return;
    setPending(true);
    setActionError("");
    setNotice("");
    try {
      const result = await reminderRequest<{ reminder: ReminderSummary }>(`/api/reminders/${encodeURIComponent(reminder.id)}`, {
        method: input ? "PATCH" : "DELETE",
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      setReminders((items) => items?.flatMap((item) => {
        if (item.id !== reminder.id) return [item];
        return result.reminder.status === "scheduled" ? [result.reminder] : [];
      }).sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt)) ?? null);
      if (input) closeEditor();
      else {
        setEdit(null);
        requestAnimationFrame(() => closeButton.current?.focus());
      }
      setNotice(input ? "حُفظ الموعد الجديد." : "أُلغي التذكير.");
    } catch (caught) {
      if (input && caught instanceof ReminderRequestError && caught.code === "REMINDER_TIME_AMBIGUOUS") {
        setEdit((draft) => draft ? { ...draft, ambiguous: true } : draft);
      }
      if (caught instanceof ReminderRequestError && caught.code === "REMINDER_CHANGED") {
        setEdit(null);
        reload();
      }
      setActionError(reminderErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit) return;
    const { reminder, localDueAt, overlap } = edit;
    void mutate(reminder, {
      localDueAt,
      timeZone: reminder.timeZone,
      expected: { dueAt: reminder.dueAt, updatedAt: reminder.updatedAt },
      ...(overlap ? { overlap } : {}),
    });
  }

  return <>
    <button type="button" className={styles.trigger} aria-label="التذكيرات" aria-haspopup="dialog" title="التذكيرات" onClick={show}>
      <Bell size={17} aria-hidden="true" />
      <span className={styles.triggerText}>التذكيرات</span>
      {hasArrival ? <i className={styles.arrival} aria-hidden="true" /> : null}
    </button>
    <span className={styles.announcement} role="status">{hasArrival ? "وصلت تذكيرات." : ""}</span>
    <dialog
      className={styles.dialog}
      ref={dialog}
      aria-labelledby={titleId}
      onClose={close}
      onCancel={(event) => { if (pending) event.preventDefault(); }}
    >
      <header className={styles.header}>
        <h2 id={titleId}>التذكيرات</h2>
        <button ref={closeButton} type="button" className={styles.close} aria-label="إغلاق التذكيرات" disabled={pending} onClick={() => dialog.current?.close()}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {open ? <div className={styles.content}>
        <section aria-label="التذكيرات المجدولة" aria-busy={!reminders && !listError}>
          <h3>المجدولة</h3>
          {listError ? <div>
            <p className={styles.error} role="alert">{listError}</p>
            <button type="button" className={styles.secondary} onClick={reload}>إعادة المحاولة</button>
          </div> : null}
          {!reminders && !listError ? <p className={styles.muted} role="status">جارٍ تحميل التذكيرات…</p> : null}
          {reminders?.length === 0 ? <p className={styles.muted}>لا توجد تذكيرات مجدولة.</p> : null}
          {reminders?.length ? <ul className={styles.list}>{reminders.map((reminder) => <li key={reminder.id} className={styles.item}>
            <div className={styles.info}>
              <strong dir="auto">{reminder.text}</strong>
              <div className={styles.muted}><time dateTime={reminder.dueAt}>{reminderTimeLabel(reminder)}</time> · <bdi>{reminder.timeZone}</bdi> · {reminderRecurrenceLabel(reminder.recurrence)}</div>
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} disabled={pending} aria-label={`تعديل وقت ${reminder.text}`} onClick={(event) => {
                editButton.current = event.currentTarget;
                setActionError("");
                setNotice("");
                setEdit({ reminder, localDueAt: reminderLocalInput(reminder), ambiguous: false });
              }}>تعديل الوقت</button>
              <button type="button" className={styles.danger} disabled={pending} aria-label={`إلغاء تذكير ${reminder.text}`} onClick={() => void mutate(reminder)}>إلغاء</button>
            </div>
            {edit?.reminder.id === reminder.id ? <form className={styles.editor} onSubmit={save}>
              <label>
                <span>الموعد الجديد (<bdi>{reminder.timeZone}</bdi>)</span>
                <input type="datetime-local" dir="ltr" required autoFocus disabled={pending} value={edit.localDueAt}
                  onChange={(event) => setEdit({ reminder: edit.reminder, localDueAt: event.currentTarget.value, ambiguous: false })} />
              </label>
              {edit.ambiguous ? <fieldset disabled={pending}>
                <legend>يتكرر هذا الوقت بسبب تغيير الساعة. أي وقت تقصد؟</legend>
                <label><input type="radio" name="overlap" required autoFocus checked={edit.overlap === "earlier"} onChange={() => setEdit({ ...edit, overlap: "earlier" })} />المرة الأولى</label>
                <label><input type="radio" name="overlap" required checked={edit.overlap === "later"} onChange={() => setEdit({ ...edit, overlap: "later" })} />المرة الثانية</label>
              </fieldset> : null}
              <div className={styles.actions}>
                <button type="submit" className={styles.primary} disabled={pending}>حفظ الوقت</button>
                <button type="button" className={styles.secondary} disabled={pending} onClick={() => { setActionError(""); closeEditor(); }}>إغلاق التعديل</button>
              </div>
            </form> : null}
          </li>)}</ul> : null}
          {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
          <p className={styles.message} role="status">{pending ? "جارٍ الحفظ…" : notice}</p>
        </section>
        <section aria-label="التذكيرات التي وصلت" aria-busy={!deliveries && !dueError}>
          <h3>وصلت مؤخرًا</h3>
          {dueError ? <p className={styles.error} role="alert">{dueError}</p> : null}
          {!deliveries && !dueError ? <p className={styles.muted} role="status">جارٍ تحميل التذكيرات التي وصلت…</p> : null}
          {deliveries?.length === 0 ? <p className={styles.muted}>لم تصل تذكيرات بعد.</p> : null}
          {deliveries?.length ? <ul className={styles.list}>{deliveries.map((delivery) => <li key={delivery.id} className={styles.item}>
            <div className={styles.info}>
              <strong dir="auto">{delivery.text}</strong>
              <div className={styles.muted}><time dateTime={delivery.dueAt}>{reminderTimeLabel(delivery)}</time> · <bdi>{delivery.timeZone}</bdi>{delivery.late ? " · متأخر" : ""}</div>
            </div>
            <button type="button" className={styles.secondary} disabled={pending} aria-label={`فتح محادثة تذكير ${delivery.text}`} onClick={() => {
              dialog.current?.close();
              props.onOpenConversation(delivery.conversationId);
            }}>فتح المحادثة</button>
          </li>)}</ul> : null}
        </section>
      </div> : null}
    </dialog>
  </>;
}
