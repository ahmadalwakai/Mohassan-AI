import { z } from 'zod';

export const MemberAccountIdSchema = z.string().min(1).max(64);
export const RequestMemberDeletionSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export const MemberDeletionSchema = z.object({
  requestedAt: z.iso.datetime(),
  purgeAfter: z.iso.datetime(),
}).strict();
export const MemberDeletionStatusSchema = z.object({ deletion: MemberDeletionSchema.nullable() }).strict();
export const CancelMemberDeletionResultSchema = z.object({ cancelled: z.boolean() }).strict();
export const PendingMemberDeletionsSchema = z.object({
  requests: z.array(MemberDeletionSchema.extend({ userId: MemberAccountIdSchema, name: z.string(), email: z.email() })),
}).strict();

export const AccountSessionSchema = z.object({
  id: z.string(),
  deviceLabel: z.string(),
  ipPrefix: z.string().nullable(),
  lastSeen: z.iso.datetime(),
  current: z.boolean(),
}).strict();
export const AccountSessionsSchema = z.object({ sessions: z.array(AccountSessionSchema) }).strict();
export const EndAccountSessionsResultSchema = z.object({ ended: z.number().int().nonnegative() }).strict();

export const MemberAuditActionSchema = z.enum([
  'invite_created', 'invite_used', 'invite_revoked', 'member_suspended', 'member_unsuspended',
  'deletion_requested', 'deletion_cancelled', 'deletion_purged', 'export_downloaded',
]);
// Cursor IDs are PostgreSQL bigint values. https://www.postgresql.org/docs/current/datatype-numeric.html (retrieved 2026-11-25).
const MemberAuditIdSchema = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => {
  return value.length < 19 || value <= '9223372036854775807';
});
export const MemberAuditQuerySchema = z.object({ beforeId: MemberAuditIdSchema.optional() }).strict();
export const MemberAuditEntrySchema = z.object({
  id: MemberAuditIdSchema,
  actorId: z.string().nullable(),
  targetId: z.string(),
  action: MemberAuditActionSchema,
  occurredAt: z.iso.datetime(),
}).strict();
export const MemberAuditPageSchema = z.object({ entries: z.array(MemberAuditEntrySchema), nextBeforeId: MemberAuditIdSchema.nullable() }).strict();

export type MemberDeletion = z.infer<typeof MemberDeletionSchema>;
export type MemberDeletionStatus = z.infer<typeof MemberDeletionStatusSchema>;
export type CancelMemberDeletionResult = z.infer<typeof CancelMemberDeletionResultSchema>;
export type PendingMemberDeletions = z.infer<typeof PendingMemberDeletionsSchema>;
export type AccountSession = z.infer<typeof AccountSessionSchema>;
export type AccountSessions = z.infer<typeof AccountSessionsSchema>;
export type EndAccountSessionsResult = z.infer<typeof EndAccountSessionsResultSchema>;
export type MemberAuditAction = z.infer<typeof MemberAuditActionSchema>;
export type MemberAuditEntry = z.infer<typeof MemberAuditEntrySchema>;
export type MemberAuditPage = z.infer<typeof MemberAuditPageSchema>;
