import { z } from 'zod';

export const ConversationExportQuerySchema = z.object({ format: z.enum(['markdown', 'pdf']) }).strict();
export const ConversationShareExpirySchema = z.enum(['1d', '7d', '30d', 'never']);
const ReviewSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CreateConversationShareSchema = z.object({
  review: ReviewSchema,
  expiry: ConversationShareExpirySchema,
  redact: z.literal(true),
}).strict();
export const ConversationShareSettingsSchema = z.object({ memberSharingEnabled: z.boolean() }).strict();

const ConversationSourceSchema = z.object({ title: z.string(), url: z.url({ protocol: /^https?$/ }) }).strict();
export const ConversationSnapshotSchema = z.object({
  title: z.string(),
  createdAt: z.iso.datetime(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    createdAt: z.iso.datetime(),
    sources: z.array(ConversationSourceSchema),
  }).strict()),
}).strict();
export const ConversationPrivacyFindingSchema = z.object({
  kind: z.enum(['email', 'phone', 'path', 'google-ads-id', 'token-url', 'memory', 'tool-output']),
  location: z.enum(['title', 'message', 'source']),
  messageIndex: z.number().int().nonnegative().optional(),
  preview: z.string(),
}).strict();
export const ConversationSharePreviewSchema = z.object({
  review: ReviewSchema,
  findings: z.array(ConversationPrivacyFindingSchema),
}).strict();
export const ConversationShareSummarySchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  title: z.string(),
  sharedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
}).strict();
export const ConversationShareListSchema = z.object({ shares: z.array(ConversationShareSummarySchema) }).strict();
export const CreatedConversationShareSchema = z.object({ share: ConversationShareSummarySchema, url: z.url() }).strict();
export const PublicConversationShareSchema = z.object({ snapshot: ConversationSnapshotSchema, sharedAt: z.iso.datetime() }).strict();
export const ConversationShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export type ConversationShareExpiry = z.infer<typeof ConversationShareExpirySchema>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotSchema>;
export type ConversationPrivacyFinding = z.infer<typeof ConversationPrivacyFindingSchema>;
export type ConversationSharePreview = z.infer<typeof ConversationSharePreviewSchema>;
export type ConversationShareSummary = z.infer<typeof ConversationShareSummarySchema>;
export type CreatedConversationShare = z.infer<typeof CreatedConversationShareSchema>;
export type PublicConversationShare = z.infer<typeof PublicConversationShareSchema>;
