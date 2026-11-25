import { z } from 'zod';

const fields = {
  rating: z.enum(['helpful', 'not_helpful']),
  reason: z.enum(['no_meaningful_change', 'late', 'wrong_value']).optional(),
};
const validReason = ({ rating, reason }: { rating: string; reason?: string }) => !reason || rating === 'not_helpful';

export const MonitorAlertFeedbackSchema = z.object(fields).strict().refine(validReason);
export const MonitorAlertFeedbackStateSchema = z.object({ ...fields, updatedAt: z.iso.datetime() }).strict().refine(validReason);
export const MonitorAlertSchema = z.object({
  id: z.uuid(),
  happenedAt: z.iso.datetime(),
  feedback: MonitorAlertFeedbackStateSchema.optional(),
}).strict();

export type MonitorAlertFeedback = z.infer<typeof MonitorAlertFeedbackSchema>;
export type MonitorAlertFeedbackState = z.infer<typeof MonitorAlertFeedbackStateSchema>;
export type MonitorAlert = z.infer<typeof MonitorAlertSchema>;
