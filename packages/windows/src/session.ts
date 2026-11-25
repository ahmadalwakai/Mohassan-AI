import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

export interface WindowsSession { id: string; sessionId: string }

const prefix = 'session:';
export const binding = (sessionId: string) => `${prefix}${createHash('sha256').update(sessionId).digest('hex')}`;
export const hasSessionBinding = (value: string) => value.startsWith(prefix);

export function createWindowsSessionScope() {
  const context = new AsyncLocalStorage<{ ownerId: string; binding: string } | undefined>();
  return {
    current: () => context.getStore(),
    run<T>(ownerId: string, sessionId: string | undefined, run: () => T): T {
      return context.run(sessionId ? { ownerId, binding: binding(sessionId) } : undefined, run);
    },
  };
}

export async function requireLiveSession(connection: Kysely<any>, user: WindowsSession) {
  const session = await connection.selectFrom('session').select('id').where('id', '=', user.sessionId)
    .where('userId', '=', user.id).where('expiresAt', '>', new Date()).forShare().executeTakeFirst();
  if (!session) throw Object.assign(new Error('سجل الدخول للمتابعة.'), { code: 'UNAUTHORIZED', statusCode: 401 });
}

/** Serialize companion use with deletion of the authenticated session. */
export async function boundSessionIsLive(connection: Kysely<any>, ownerId: string, sessionBinding: string) {
  return Boolean(await connection.selectFrom('session').select('id').where('userId', '=', ownerId)
    .where('expiresAt', '>', new Date())
    .where(sql<string>`(${prefix}::text || encode(sha256(convert_to(id, 'UTF8')), 'hex'))`, '=', sessionBinding)
    .forShare().executeTakeFirst());
}
