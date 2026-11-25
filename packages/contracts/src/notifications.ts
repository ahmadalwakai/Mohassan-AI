import { z } from 'zod';

export const NOTIFICATION_AFTER_MS = 20_000;

export const NotificationKindSchema = z.enum(['task_completed', 'needs_you', 'task_failed', 'task_progress']);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NotificationPayloadSchema = z.object({
  kind: NotificationKindSchema,
  taskId: z.uuid(),
  conversationId: z.uuid().nullable(),
  conversationTitle: z.string().max(100).optional(),
}).strict();
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z.string().min(1).max(100).refine(value => {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
});
export const NotificationPreferencesSchema = z.object({
  quietHours: z.object({ start: localTime, end: localTime, timeZone }).strict().nullable(),
  hideTitle: z.boolean(),
}).strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationQuietHours = NonNullable<NotificationPreferences['quietHours']>;

export const PushSubscribeRequestSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(128), auth: z.string().min(1).max(64) }).strict(),
  label: z.string().trim().min(1).max(80),
}).strict();
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

export interface PushDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
}
export interface NotificationSettingsResponse {
  preferences: NotificationPreferences;
  devices: PushDevice[];
  publicKey: string | null;
}
export interface PushSubscribeResponse { device: PushDevice }
export interface PushUnsubscribeResponse { removed: boolean }
export interface PushTestResponse { delivered: number }

export const NotificationSyncRequestSchema = z.object({
  tabId: z.uuid(),
  state: z.enum(['visible', 'hidden', 'closed']),
}).strict();
export type NotificationSyncRequest = z.infer<typeof NotificationSyncRequestSchema>;
export interface NotificationSyncResponse { backgroundTask: boolean; pending: NotificationPayload[] }

export const NotificationClaimRequestSchema = z.object({ tabId: z.uuid() }).strict();
export type NotificationClaimRequest = z.infer<typeof NotificationClaimRequestSchema>;
export interface NotificationClaimResponse { notification: NotificationPayload | null }
