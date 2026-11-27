import { z } from 'zod';

// The workspace uses these bounds in createAuth's emailAndPassword options.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/auth.ts (retrieved 2026-11-27)
export const NewMemberPasswordSchema = z.string().min(12).max(128);

// A reset link uses the same unpadded base64url encoding of 32 random bytes as an invite.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts (retrieved 2026-11-27)
export const MemberPasswordResetTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ResetMemberPasswordInspectSchema = z.object({ token: MemberPasswordResetTokenSchema }).strict();
export const ResetMemberPasswordAcceptSchema = ResetMemberPasswordInspectSchema.extend({ newPassword: NewMemberPasswordSchema });
export const MemberPasswordResetLinkSchema = z.object({
  resetLink: z.string().startsWith('/#reset='),
  expiresAt: z.iso.datetime(),
}).strict();
export type MemberPasswordResetLink = z.infer<typeof MemberPasswordResetLinkSchema>;
