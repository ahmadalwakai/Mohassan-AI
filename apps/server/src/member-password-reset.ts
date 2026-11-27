import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { MemberAccountIdSchema, ResetMemberPasswordAcceptSchema, ResetMemberPasswordInspectSchema } from '@mohassan/contracts';
import { recordMemberAudit } from './member-audit.js';
import { lockMember, memberDeletionPending } from './member-deletion.js';
import type { registerMemberRoutes } from './members.js';

const resetPath = '/api/members/password-reset';
const inspectPath = `${resetPath}/inspect`;
const acceptPath = `${resetPath}/accept`;
export const MEMBER_PASSWORD_RESET_PUBLIC_ROUTES = [`POST ${inspectPath}`, `POST ${acceptPath}`] as const;

const empty = z.object({}).strict();
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });
const invalidReset = () => failure(404, 'PASSWORD_RESET_INVALID', 'رابط إعادة تعيين كلمة المرور غير صالح أو انتهت مدته. اطلب رابطًا جديدًا.');

async function findValidReset(db: Kysely<any>, tokenHash: string) {
  const row = await db.selectFrom('workspace_member_password_resets as r')
    .innerJoin('workspace_members as m', 'm.user_id', 'r.user_id').select('r.user_id')
    .where('r.token_hash', '=', tokenHash).where('r.expires_at', '>', sql<Date>`clock_timestamp()`)
    .where('m.role', '=', 'member')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner').select('id').whereRef('owner_id', '=', 'r.user_id'))))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('member_deletion_requests').select('user_id').whereRef('user_id', '=', 'r.user_id'))))
    .executeTakeFirst();
  if (!row) throw invalidReset();
  return row.user_id as string;
}

type ResetRouteOptions = Pick<Parameters<typeof registerMemberRoutes>[1], 'db' | 'auth' | 'owner' | 'role'>;

export function registerMemberPasswordResetRoutes(app: FastifyInstance, { db, auth, owner, role }: ResetRouteOptions) {
  // Use the invite routes' rate limits and random token size.
  // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/members.ts (retrieved 2026-11-27)
  const inspectLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const acceptLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

  app.post<{ Params: { id: string } }>('/api/members/:id/password-reset', inspectLimit, async request => {
    const actor = await owner(request);
    if (await role(request) !== 'owner') throw failure(403, 'MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    const userId = MemberAccountIdSchema.parse(request.params.id);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = await db.transaction().execute(async tx => {
      if (!await lockMember(tx, userId)) throw failure(404, 'MEMBER_NOT_FOUND', 'العضو غير موجود.');
      if (await memberDeletionPending(tx, userId)) {
        throw failure(409, 'MEMBER_DELETION_PENDING', 'لا يمكن إعادة تعيين كلمة المرور لحساب بانتظار الحذف.');
      }
      // Match Better Auth's default one-hour reset lifetime.
      // https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz (retrieved 2026-11-27)
      const expiry = sql<Date>`clock_timestamp() + interval '1 hour'`;
      const reset = await tx.insertInto('workspace_member_password_resets')
        .values({ user_id: userId, token_hash: tokenHash, expires_at: expiry })
        .onConflict(conflict => conflict.column('user_id').doUpdateSet({ token_hash: tokenHash, expires_at: expiry }))
        .returning('expires_at').executeTakeFirstOrThrow();
      await recordMemberAudit(tx, { actorId: actor.id, targetId: userId, action: 'password_reset_issued' });
      return new Date(reset.expires_at).toISOString();
    });
    return { resetLink: `/#reset=${token}`, expiresAt };
  });

  app.post(inspectPath, inspectLimit, async request => {
    empty.parse(request.query);
    const { token } = ResetMemberPasswordInspectSchema.parse(request.body);
    await findValidReset(db, hashToken(token));
    return { ok: true };
  });

  app.post(acceptPath, acceptLimit, async request => {
    empty.parse(request.query);
    const { token, newPassword } = ResetMemberPasswordAcceptSchema.parse(request.body);
    const tokenHash = hashToken(token);
    const userId = await findValidReset(db, tokenHash);
    const password = await (await auth.$context).password.hash(newPassword);
    await db.transaction().execute(async tx => {
      if (!await lockMember(tx, userId) || await memberDeletionPending(tx, userId)) throw invalidReset();
      const reset = await tx.deleteFrom('workspace_member_password_resets')
        .where('user_id', '=', userId).where('token_hash', '=', tokenHash)
        .where('expires_at', '>', sql<Date>`clock_timestamp()`).returning('user_id').executeTakeFirst();
      if (!reset) throw invalidReset();
      // These identify the same credential row used by Better Auth's email sign-in.
      // https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz (retrieved 2026-11-27)
      const account = await tx.updateTable('account').set({ password, updatedAt: sql<Date>`clock_timestamp()` })
        .where('userId', '=', userId).where('providerId', '=', 'credential').where('accountId', '=', userId)
        .returning('id').executeTakeFirst();
      if (!account) throw invalidReset();
      await tx.deleteFrom('session').where('userId', '=', userId).execute();
      await recordMemberAudit(tx, { actorId: null, targetId: userId, action: 'password_reset_used' });
    });
    return { ok: true };
  });
}
