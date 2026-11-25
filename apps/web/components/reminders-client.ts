import type { ReminderSummary } from "@mohassan/contracts";

export class ReminderRequestError extends Error {
  constructor(readonly code: string | undefined, message: string) {
    super(message);
  }
}

export async function reminderRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new ReminderRequestError(body?.error?.code, body?.error?.message ?? "تعذّر تحميل التذكيرات. حاول مجددًا.");
  }
  return body as T;
}

export const reminderErrorMessage = (error: unknown) =>
  error instanceof ReminderRequestError ? error.message : "تعذّر الاتصال بالخدمة. حاول مجددًا.";

interface ReminderTime {
  dueAt: string;
  timeZone: string;
}

export function reminderTimeLabel({ dueAt, timeZone }: ReminderTime): string {
  return new Intl.DateTimeFormat("ar", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(dueAt));
}

export function reminderLocalInput({ dueAt, timeZone }: ReminderTime): string {
  const date = new Intl.DateTimeFormat("en", {
    calendar: "iso8601",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(date.formatToParts(new Date(dueAt)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function reminderRecurrenceLabel(recurrence: ReminderSummary["recurrence"]): string {
  if (!recurrence) return "مرة واحدة";
  if (recurrence.kind === "daily") return "يوميًا";
  if (recurrence.kind === "monthly") {
    return `شهريًا، يوم ${new Intl.NumberFormat("ar").format(recurrence.dayOfMonth)}`;
  }
  const weekday = new Intl.DateTimeFormat("ar", { weekday: "long", timeZone: "UTC" });
  const first = new Date(0);
  const monday = first.getUTCDate() - ((first.getUTCDay() + 6) % 7);
  const days = recurrence.weekdays.map((day) => weekday.format(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), monday + day - 1)));
  return `أسبوعيًا، ${new Intl.ListFormat("ar").format(days)}`;
}
