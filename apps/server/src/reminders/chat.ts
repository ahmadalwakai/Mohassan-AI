import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ReminderTimeZoneSchema, type ChatQuestion, type ReminderRecurrence, type ReminderSummary } from '@mohassan/contracts';
import { evaluateCapabilityReply, type CapabilityReplyRouting } from '../assistant/capability-reply.js';
import type { BrainState } from '../assistant/brain.js';
import { analyzeCompoundRequest } from '../assistant/compound-request.js';
import { parseStructuredMemoryRequest } from '../assistant/structured-memory-parser.js';
import { ReminderError, type createReminderStore } from './storage.js';
import { parseReminderDuration, parseReminderTime, shiftReminderTime } from './time.js';

export type ChatReminderStore = ReturnType<typeof createReminderStore>;
type Connection = Transaction<any>;
type Language = 'ar' | 'en';
type Selection = Pick<ReminderSummary, 'id' | 'dueAt' | 'updatedAt'>;
type Change = { kind: 'cancel' | 'postpone' | 'edit'; argument: string };
type Schedule = { dueAt: string; recurrence: ReminderRecurrence | null };
type Clarification = Extract<ReturnType<typeof parseReminderTime>, { kind: 'clarify' }>;
type Pending = { kind: 'zone'; body: string }
  | { kind: 'time'; body: string; reason: Clarification['reason']; text: string; timeZone: string; target?: Selection }
  | { kind: 'text'; schedule: Schedule; timeZone: string }
  | { kind: 'selection'; candidates: (Selection & { label: string })[]; change: Change; offset: number };
type State = BrainState & { reminderChat?: { lastId?: string } & ({ pending: Pending; askedOnAttempt: number } | { pending?: never }) };
type Reply = { text: string; status: 'completed' | 'blocked' };
type ReminderChatPublication = (tx: Connection) => Promise<Reply>;
type Handled = { question: ChatQuestion } | { publish: ReminderChatPublication };

const MATCHES_PER_QUESTION = 4;
const ar = (text: string) => /\p{Script=Arabic}/u.test(text);
const copy = (lang: Language, arabic: string, english: string) => lang === 'ar' ? arabic : english;
const fold = (text: string) => text.normalize('NFKC').replace(/[\u0640\u064b-\u065f\u0670]|\p{Cf}/gu, '')
  .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').toLowerCase().trim();
const trim = (text: string) => text.replace(/^[\s,،:؛.?!؟]+|[\s,،:؛.?!؟]+$/gu, '');
const createHead = /^(?:(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:remind me|(?:set|create|schedule) (?:a |me a )?reminder(?: for me)?)\b|(?:من فضلك\s+)?(?:هل يمكنك\s+)?(?:ذك[\u064b-\u065f]*رني|نب[\u064b-\u065f]*هني|تذكيري|[أا]ضف تذكير[ًا]*|جدول تذكير[ًا]*)(?!\p{L}))/iu;
const editHead = /^(?:(?:please\s+)?(?:edit|move|reschedule|change)\s+(?:the\s+)?(?:reminder\s*|it\b\s*)|(?:عد[\u064b-\u065f]*ل|غي[\u064b-\u065f]*ر)\s+(?:موعد\s+)?(?:التذكير|تذكير)\s*|عد[\u064b-\u065f]*له\s*)/iu;
const cancelHead = /^(?:(?:please\s+)?(?:cancel|delete|remove)\s+(?:the\s+|my\s+)?(?:reminder\b|it\b)|[أا]لغ[\u064b-\u065f]*(?:ي|اء)?\s*(?:التذكير|تذكير)|[أا]لغ[\u064b-\u065f]*(?:ه|يه)(?!\p{L}))/iu;
const postponeHead = /^(?:(?:please\s+)?(?:postpone|delay|snooze)\s+(?:the\s+)?(?:reminder\b|it\b)|[أا]ج[\u064b-\u065f]*ل(?:ه|ها)(?!\p{L})|[أا]ج[\u064b-\u065f]*ل\s+(?:التذكير|تذكير))/iu;
const listCommand = /^(?:(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?(?:upcoming\s+)?reminders|what (?:are|(?:are )?all) my reminders|my reminders)|(?:ما (?:هي )?تذكيراتي|ما التذكيرات|تذكيراتي|(?:اعرض|ارني) (?:تذكيراتي|التذكيرات)))$/iu;

export const reminderRouting = { route: 'reminder', intent: 'reminder', handler: 'reminder', availability: 'ready', missingCapabilities: [], reason: 'explicit_handler' } satisfies CapabilityReplyRouting;

function formatDate(dueAt: string, timeZone: string, lang: Language) {
  return `${new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short', calendar: 'gregory' }).format(new Date(dueAt))} (${timeZone})`;
}

function frequency(recurrence: ReminderRecurrence | null, lang: Language): string {
  if (!recurrence) return copy(lang, 'مرة واحدة', 'once');
  if (recurrence.kind === 'daily') return copy(lang, 'يوميًا', 'daily');
  if (recurrence.kind === 'monthly') return copy(lang, `شهريًا في اليوم ${recurrence.dayOfMonth}`, `monthly on day ${recurrence.dayOfMonth}`);
  const weekday = new Intl.DateTimeFormat(lang, { timeZone: 'UTC', weekday: 'long' });
  // 1970-01-01 was Thursday per the ECMAScript epoch and WeekDay algorithm.
  // https://tc39.es/ecma262/#sec-week-day (retrieved 2026-11-25).
  const names = recurrence.weekdays.map(day => weekday.format(new Date(Date.UTC(1970, 0, day + 4)))).join(copy(lang, '، ', ', '));
  return copy(lang, `أسبوعيًا (${names})`, `weekly (${names})`);
}

function titleFrom(body: string, span?: { start: number; end: number }) {
  const text = span ? `${body.slice(0, span.start).trim()} ${body.slice(span.end).trim()}` : body;
  return trim(trim(text).replace(/^(?:(?:about|to|for)\s+|أن\s+|عن\s+|ب(?=ال))/iu, ''));
}

function describe(reminder: ReminderSummary, lang: Language, short = false) {
  const text = short && reminder.text.length > 68 ? `${reminder.text.slice(0, 68)}…` : reminder.text;
  return `${text} · ${formatDate(reminder.dueAt, reminder.timeZone, lang)} · ${frequency(reminder.recurrence, lang)}`;
}

function asTimeZone(text: string): string | null {
  const name = ReminderTimeZoneSchema.safeParse(trim(text));
  return name.success ? new Intl.DateTimeFormat('en', { timeZone: name.data }).resolvedOptions().timeZone : null;
}

function digits(text: string) {
  // Unicode decimal blocks U+0660 and U+06F0. https://www.unicode.org/charts/PDF/U0600.pdf (retrieved 2026-11-25).
  return text.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 0xf));
}

export async function handleReminderChat(input: {
  store: ChatReminderStore; db: Kysely<any>; state: BrainState; userId: string; conversationId: string; runId: string; attempt: number;
  request: string; routing?: CapabilityReplyRouting | null; now: Date; transact: <T>(work: (tx: Connection) => Promise<T>) => Promise<T>;
}): Promise<Handled | null> {
  const { store, db, userId, conversationId, runId, attempt, request, now } = input;
  const state = input.state as State;
  const previous = state.reminderChat;
  const lang: Language = ar(request) ? 'ar' : 'en';
  const reply = (text: string, status: Reply['status'] = 'completed'): Handled => ({ publish: async () => ({ text, status }) });
  const ask = (pending: Pending, prompt: string): Handled => {
    const question = { id: randomUUID(), prompt, options: [] };
    state.reminderChat = { askedOnAttempt: attempt, pending };
    return { question };
  };
  const askSelection = (pending: Extract<Pending, { kind: 'selection' }>) => {
    const { candidates, offset } = pending;
    const shown = candidates.slice(offset, offset + MATCHES_PER_QUESTION);
    const rows = shown.map(({ label }, index) => `${offset + index + 1}. ${label}`).join('\n');
    const more = candidates.length > shown.length ? copy(lang, ' اكتب «التالي» لمزيد من الخيارات.', ' Say “next” to see more matches.') : '';
    return ask(pending, copy(lang, `أي تذكير تقصد؟ أرسل رقمه.${more}\n${rows}`, `Which reminder? Reply with its number.${more}\n${rows}`).slice(0, 1000));
  };
  const apply = (operation: (tx: ChatReminderStore) => Promise<Reply>): Handled => ({ publish: async tx => {
    try { return await operation(store.inTransaction(tx)); }
    catch (error) {
      if (!(error instanceof ReminderError)) throw error;
      const text = error.code === 'REMINDER_LIMIT' ? copy(lang, 'بلغت الحد الأقصى للتذكيرات النشطة. ألغِ تذكيرًا قبل إنشاء تذكير جديد.', 'You reached your active reminder limit. Cancel one before creating another.')
        : error.code === 'REMINDER_TIME_IN_PAST' ? copy(lang, 'مرّ وقت التذكير. حدّد وقتًا جديدًا.', 'That time has passed. Choose a new time.')
        : copy(lang, 'لم أتمكن من حفظ التغيير. اعرض تذكيراتك للتحقق من حالتها.', 'I could not save that change. List your reminders to check their status.');
      return { text, status: 'blocked' };
    }
  } });
  const confirmed = (reminder: ReminderSummary, verb: { ar: string; en: string }) => {
    state.reminderChat = { lastId: reminder.id };
    return { status: 'completed' as const, text: copy(lang,
      `${verb.ar} ${describe(reminder, lang)}\nللإلغاء، قل «ألغِ التذكير ${reminder.id}».`,
      `${verb.en} ${describe(reminder, lang)}\nTo cancel, say “cancel reminder ${reminder.id}”.`) };
  };
  const create = (text: string, schedule: Schedule, timeZone: string): Handled => {
    if (!text) return ask({ kind: 'text', schedule, timeZone }, copy(lang, 'بماذا تريد أن أذكّرك؟', 'What should I remind you about?'));
    return apply(async tx => confirmed(await tx.create(userId, { conversationId, text, timeZone, ...schedule }), { ar: 'تم ضبط التذكير', en: 'Reminder set for' }));
  };
  const targetMissing = () => reply(copy(lang, 'لم أجد تذكيرًا نشطًا مطابقًا.', 'I found no matching active reminder.'), 'blocked');
  const parseTime = (body: string, timeZone: string, options: {
    answer?: string; previous?: Extract<Pending, { kind: 'time' }>; target?: Selection;
  } = {}): Handled => {
    const { answer, previous: pending, target } = options;
    const normal = answer && fold(trim(answer));
    const meridiem = normal && /^(?:am|a\.m|صباح[ا]?|ص)$/iu.test(normal) ? 'am'
      : normal && /^(?:pm|p\.m|مساء[ا]?|م)$/iu.test(normal) ? 'pm' : undefined;
    const disambiguation = normal && /^(?:first|earlier|الاول)$/iu.test(normal) ? 'earlier'
      : normal && /^(?:second|later|الثاني)$/iu.test(normal) ? 'later' : undefined;
    const resolvesPrior = (pending?.reason === 'meridiem' && meridiem) || (pending?.reason === 'dst_overlap' && disambiguation);
    const expression = answer && !resolvesPrior ? answer : body;
    const parsed = parseReminderTime(expression, { now, timeZone, meridiem, disambiguation });
    const text = pending?.text ?? titleFrom(body, parsed.span);
    if (parsed.kind === 'clarify') {
      const prompts: Record<string, [string, string]> = {
        meridiem: ['هل تقصد صباحًا أم مساءً؟', 'Do you mean AM or PM?'],
        past: ['مرّ هذا الوقت. ما التاريخ والوقت الجديدان؟', 'That time has passed. What new date and time should I use?'],
        dst_overlap: ['تتكرر هذه الساعة عند تغيير التوقيت. هل تقصد الموعد الأول أم الثاني؟', 'This clock time occurs twice when the clocks change. Do you mean the first or second occurrence?'],
        dst_gap: ['هذه الساعة غير موجودة في ذلك اليوم بسبب تغيير التوقيت. ما التاريخ والوقت البديلان؟', 'That clock time is skipped on that date. What date and time should I use instead?'],
      };
      const prompt = prompts[parsed.reason] ?? ['متى تريد التذكير؟ اذكر التاريخ والوقت، أو قل «بعد ساعتين».', 'When should I remind you? Give a date and time or say “in 2 hours”.'];
      return ask({ kind: 'time', body: expression, reason: parsed.reason, text, timeZone, target }, copy(lang, ...prompt));
    }
    const schedule = { dueAt: parsed.dueAt.toISOString(), recurrence: parsed.recurrence };
    if (!target) return create(text, schedule, timeZone);
    return apply(async tx => confirmed(await tx.update(userId, target.id,
      { dueAt: schedule.dueAt, ...(schedule.recurrence ? { recurrence: schedule.recurrence } : {}) }, target), { ar: 'تم تعديل التذكير', en: 'Reminder updated to' }));
  };
  const change = async (operation: Change, target: Selection): Promise<Handled> => {
    if (operation.kind === 'cancel') return apply(async tx => {
      const cancelled = await tx.cancel(userId, target.id, target);
      return { status: 'completed', text: copy(lang, `تم إلغاء تذكير «${cancelled.text}».`, `Cancelled the reminder “${cancelled.text}”.`) };
    });
    if (operation.kind === 'postpone') {
      const duration = parseReminderDuration(operation.argument);
      if (!duration) return reply(copy(lang, 'اذكر مدة التأجيل، مثل «أجّله ساعة».', 'Give a delay, such as “postpone it by one hour”.'), 'blocked');
      return apply(async tx => confirmed(await tx.postpone(userId, target.id,
        (base, timeZone) => shiftReminderTime(base, timeZone, duration), target), { ar: 'تم تأجيل التذكير إلى', en: 'Reminder postponed to' }));
    }
    const reminder = (await store.list(userId)).find(item => item.id === target.id);
    return reminder ? parseTime(operation.argument, reminder.timeZone, { target }) : targetMissing();
  };

  if (previous?.pending) {
    const pending = previous.pending;
    // Chat's existing resume transaction validates the question, saves the full reply in
    // requestResolution.original and increments this run's attempt together.
    const answer = attempt === previous.askedOnAttempt + 1 ? state.requestResolution?.original : undefined;
    if (!answer) return reply(copy(lang, 'تعذر التحقق من إجابة التذكير. أرسل أمر التذكير مرة أخرى.', 'I could not verify the reminder answer. Send the reminder command again.'), 'blocked');
    delete state.reminderChat;
    if (pending.kind === 'zone') {
      const timeZone = asTimeZone(answer);
      if (!timeZone) return ask(pending, copy(lang, 'ما منطقتك الزمنية بصيغة IANA؟ مثال Asia/Riyadh أو Europe/London.', 'What is your IANA time zone? For example, Europe/London or America/New_York.'));
      await input.transact(tx => store.inTransaction(tx).setTimeZone(userId, timeZone));
      return parseTime(pending.body, timeZone);
    }
    if (pending.kind === 'time') return parseTime(pending.body, pending.timeZone, { answer, previous: pending, target: pending.target });
    if (pending.kind === 'text') return create(trim(answer), pending.schedule, pending.timeZone);
    const choice = digits(trim(answer));
    if (/^(?:next|التالي)$/iu.test(choice)) {
      const offset = pending.offset + MATCHES_PER_QUESTION;
      return askSelection({ ...pending, offset: offset < pending.candidates.length ? offset : 0 });
    }
    const visible = pending.candidates.slice(pending.offset, pending.offset + MATCHES_PER_QUESTION);
    const selection = /^\d+$/u.test(choice) ? visible[Number(choice) - pending.offset - 1] : visible.find(candidate => candidate.id === choice);
    return selection ? change(pending.change, selection) : askSelection(pending);
  }

  const text = trim(request);
  const head = createHead.exec(text);
  const cancellation = cancelHead.exec(text);
  const postponement = postponeHead.exec(text);
  const edit = editHead.exec(text);
  const listing = listCommand.test(fold(text));
  if (!head && !listing && !cancellation && !postponement && !edit) {
    const fallback = evaluateCapabilityReply(request, reminderRouting, { handlersExhausted: input.routing?.route === 'reminder', purpose: 'capability_question', execution: 'not_started' });
    return fallback && reply(fallback.text, fallback.status === 'completed' ? 'completed' : 'blocked');
  }
  if (analyzeCompoundRequest(text).kind !== 'single') return reply(copy(lang, 'أرسل أمر التذكير في رسالة منفصلة.', 'Send the reminder command in a separate message.'), 'blocked');
  if (head) {
    const body = trim(text.slice(head[0].length));
    const reminderAction = /^(?:to|ان)(?=\s|$)/u.test(fold(body));
    if (!reminderAction && parseStructuredMemoryRequest(text, { requireMemoryReference: true }).kind === 'recall') {
      // Use UTC only to detect an explicit schedule before requesting the user's zone.
      const timing = parseReminderTime(body, { now, timeZone: 'UTC' });
      if (timing.kind === 'clarify' && timing.reason === 'missing' && !timing.span) return null;
    }
    const timeZone = await store.getTimeZone(userId);
    return timeZone ? parseTime(body, timeZone) : ask({ kind: 'zone', body },
      copy(lang, 'ما منطقتك الزمنية؟ اكتب اسم IANA مثل Asia/Riyadh أو Europe/London وسأحفظه للتذكيرات القادمة.', 'What is your time zone? Enter an IANA name such as Europe/London or America/New_York and I’ll save it for future reminders.'));
  }
  const reminders = await store.list(userId);
  if (listing) return reply(reminders.length ? reminders.map((item, index) => `${index + 1}. ${describe(item, lang, true)}`).join('\n')
    : copy(lang, 'ليس لديك تذكيرات نشطة.', 'You have no active reminders.'));
  const tail = trim(text.slice((cancellation ?? postponement ?? edit)![0].length));
  const timing = tail.split(/\s*(?:(?<!\p{L})(?:[إا]لى|[إا]لي)(?!\p{L})|\bto\b)\s*/iu, 2);
  const duration = postponement ? parseReminderDuration(tail) : null;
  const query = fold(trim(postponement && duration ? tail.slice(0, duration.span.start).replace(/(?:\bby|لمده|لمدة)\s*$/iu, '')
    : edit ? timing.length > 1 ? timing[0]! : tail : tail));
  const operation: Change = cancellation ? { kind: 'cancel', argument: '' } : postponement ? { kind: 'postpone', argument: tail }
    : { kind: 'edit', argument: timing[1] ?? '' };
  let matches = query ? reminders.filter(item => item.id === query || fold(item.text).includes(query)) : reminders;
  if (!query && matches.length > 1) {
    const prior = await db.selectFrom('chat_runs').select(sql<string>`state->'reminderChat'->>'lastId'`.as('lastId'))
      .where('owner_id', '=', userId).where('conversation_id', '=', conversationId).where('id', '!=', runId)
      .where('status', '=', 'completed').where(sql`state->'reminderChat'->>'lastId'`, 'is not', null)
      .orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    const pinned = matches.find(item => item.id === prior?.lastId);
    if (pinned) matches = [pinned];
  }
  if (!matches.length) return targetMissing();
  if (matches.length === 1) return change(operation, matches[0]!);
  const candidates = matches.map(item => ({ id: item.id, dueAt: item.dueAt, updatedAt: item.updatedAt, label: describe(item, lang, true) }));
  return askSelection({ kind: 'selection', candidates, change: operation, offset: 0 });
}
