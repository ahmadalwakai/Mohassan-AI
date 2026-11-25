import { z } from 'zod';
import { ChatCreateSchema } from './command-chat';

const ReminderTextSchema = ChatCreateSchema.shape.goal.unwrap();
const Instant = z.iso.datetime();

// ECMA-402 delegates named time zone validation to the runtime's IANA database.
// https://tc39.es/ecma402/#sec-initializedatetimeformat (retrieved 2026-11-25).
export const ReminderTimeZoneSchema = z.string().trim().refine((value) => {
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'حدد اسم منطقة زمنية صالحًا مثل Asia/Riyadh.');

// 24-hour clock ranges: https://www.rfc-editor.org/rfc/rfc3339.html#section-5.6
// Gregorian month lengths and ISO weekdays: https://tc39.es/proposal-temporal/#sec-temporal-isodaysinmonth
// and https://tc39.es/proposal-temporal/#sec-temporal-isodayofweek (both retrieved 2026-11-25).
const clock = { hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) };
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7)
  .refine(days => new Set(days).size === days.length, 'حدد كل يوم مرة واحدة.');
export const ReminderRecurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), ...clock }).strict(),
  z.object({ kind: z.literal('weekly'), weekdays, ...clock }).strict(),
  z.object({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31), ...clock }).strict(),
]);
export type ReminderRecurrence = z.infer<typeof ReminderRecurrenceSchema>;
export const ReminderStatusSchema = z.enum(['scheduled', 'sent', 'cancelled', 'failed']);

const schedule = {
  text: ReminderTextSchema,
  dueAt: Instant,
  timeZone: ReminderTimeZoneSchema,
  recurrence: ReminderRecurrenceSchema.nullable(),
};
export const ReminderSummarySchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  ...schedule,
  status: ReminderStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: Instant,
  updatedAt: Instant,
}).strict();
export type ReminderSummary = z.infer<typeof ReminderSummarySchema>;

export const ReminderDeliverySummarySchema = z.object({
  id: z.uuid(),
  reminderId: z.uuid(),
  conversationId: z.uuid(),
  text: ReminderTextSchema,
  dueAt: Instant,
  timeZone: ReminderTimeZoneSchema,
  deliveredAt: Instant,
  late: z.boolean(),
}).strict();
export type ReminderDeliverySummary = z.infer<typeof ReminderDeliverySummarySchema>;

export const CreateReminderInputSchema = z.object({
  conversationId: z.uuid(),
  ...schedule,
  recurrence: schedule.recurrence.optional(),
}).strict();
export type CreateReminderInput = z.infer<typeof CreateReminderInputSchema>;

const ReminderChanges = z.object(schedule).partial().strict();
export type UpdateReminderInput = z.infer<typeof ReminderChanges>;
export const EditReminderInputSchema = ReminderChanges.extend({
  localDueAt: z.iso.datetime({ local: true, precision: -1 }).refine(value => !value.endsWith('Z')).optional(),
  overlap: z.enum(['earlier', 'later']).optional(),
  expected: z.object({ dueAt: Instant, updatedAt: Instant }).strict().optional(),
}).strict().superRefine(({ localDueAt, overlap, expected: _expected, ...changes }, context) => {
  if (localDueAt && (!changes.timeZone || changes.dueAt)) {
    context.addIssue({ code: 'custom', path: ['localDueAt'], message: 'حدد الوقت المحلي ومنطقته، أو حدد توقيت UTC.' });
  }
  if (overlap && !localDueAt) {
    context.addIssue({ code: 'custom', path: ['overlap'], message: 'اختيار الموعد المكرر يتطلب وقتًا محليًا.' });
  }
  if (!localDueAt && Object.values(changes).every(value => value === undefined)) {
    context.addIssue({ code: 'custom', message: 'حدد حقلًا لتعديله.' });
  }
});
export type EditReminderInput = z.infer<typeof EditReminderInputSchema>;

export const ReminderListSchema = z.object({ reminders: z.array(ReminderSummarySchema) }).strict();
export const ReminderDueListSchema = z.object({ deliveries: z.array(ReminderDeliverySummarySchema) }).strict();
export const ReminderMutationResultSchema = z.object({ reminder: ReminderSummarySchema }).strict();
