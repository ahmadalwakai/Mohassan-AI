import { isAPIError } from 'better-auth/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { ChangeMemberPasswordSchema } from '@mohassan/contracts';
import { withAuthDatabaseTransaction, type createAuth } from './auth.js';
import { recordMemberAudit } from './member-audit.js';
import { memberAuthClientIp } from './member-sessions.js';

export function registerMemberPasswordChange(app: FastifyInstance, { db, auth, owner, production }: {
  db: Kysely<any>;
  auth: ReturnType<typeof createAuth>;
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
  production: boolean;
}) {
  // Match Better Auth's password attempt limit (1.7.17, retrieved 2026-11-27).
  // https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz
  app.post('/api/member-data/password', { config: { rateLimit: { max: 3, timeWindow: '10 seconds' } } }, async (request, reply) => {
    const { id } = await owner(request);
    const input = ChangeMemberPasswordSchema.parse(request.body);
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'user-agent']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const clientIp = memberAuthClientIp(request, production);
    if (clientIp) headers.set('x-forwarded-for', clientIp);

    try {
      const cookies = await db.transaction().execute(async tx => {
        // Serialize credential changes and session revocation for this account.
        await tx.selectFrom('user').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
        const result = await withAuthDatabaseTransaction(auth, tx, () => auth.api.changePassword({
          body: { ...input, revokeOtherSessions: true }, headers, returnHeaders: true,
        }));
        await recordMemberAudit(tx, { actorId: id, targetId: id, action: 'password_changed' });
        return result.headers.getSetCookie();
      });
      if (cookies.length) reply.header('set-cookie', cookies);
      // Only the cookie carries the new session credential.
      return { ok: true };
    } catch (error) {
      if (isAPIError(error) && error.body?.code === 'INVALID_PASSWORD') {
        return reply.code(403).send({ error: { code: 'PASSWORD_CONFIRMATION_FAILED', message: 'كلمة المرور الحالية غير صحيحة.' } });
      }
      if (isAPIError(error) && error.statusCode === 401) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'سجل الدخول للمتابعة.' } });
      }
      throw error;
    }
  });
}
