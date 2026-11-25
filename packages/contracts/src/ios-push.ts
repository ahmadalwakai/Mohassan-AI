import { z } from 'zod';

export const IosPushEnvironmentSchema = z.enum(['sandbox', 'production']);
export type IosPushEnvironment = z.infer<typeof IosPushEnvironmentSchema>;

// APNs treats device tokens as variable-length opaque byte strings.
export const IosPushTokenSchema = z.string().max(1024).regex(/^(?:[0-9a-f]{2})+$/iu).toLowerCase();
export const IosPushRegistrationSchema = z.object({
  platform: z.literal('ios'),
  token: IosPushTokenSchema,
  environment: IosPushEnvironmentSchema,
  appVersion: z.string().trim().min(1).max(128),
}).strict();
export type IosPushRegistration = z.infer<typeof IosPushRegistrationSchema>;

export const BackgroundPushKindSchema = z.enum(['run-completed', 'run-blocked', 'run-failed']);
export type BackgroundPushKind = z.infer<typeof BackgroundPushKindSchema>;

export interface IosPushPayload {
  aps: { alert: { title: string; body: string }; sound: 'mohassan-done.caf'; 'thread-id': string };
  conversationId: string;
  runId: string;
  kind: BackgroundPushKind;
}
