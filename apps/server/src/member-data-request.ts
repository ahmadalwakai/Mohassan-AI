import type { Kysely } from 'kysely';
import { getMemberDeletion } from './member-deletion.js';
import { sessionIpPrefix } from './member-sessions.js';
import { MEMBER_DATA_ROUTES } from './member-data-routes.js';

const suspendedMemberRoutes = new Set<string>(['GET /api/access', ...MEMBER_DATA_ROUTES]);

export async function suspendedMemberDataAccess(db: Kysely<any>, userId: string, routeKey: string) {
  if (!suspendedMemberRoutes.has(routeKey)) return false;
  return Boolean(await db.selectFrom('workspace_members').select('user_id').where('user_id', '=', userId)
    .where('role', '=', 'member').where('disabled_at', 'is not', null)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner').select('id').where('owner_id', '=', userId))))
    .executeTakeFirst());
}

export async function readLimitedMemberAccess(db: Kysely<any>, user: { id: string; name: string; email: string }) {
  const deletion = await getMemberDeletion(db, user.id);
  if (!deletion && !await suspendedMemberDataAccess(db, user.id, 'GET /api/access')) return null;
  return {
    user: { id: user.id, name: user.name, email: user.email },
    role: 'member' as const,
    services: [],
    dataOnly: true,
    ...(deletion ? { deletion } : {}),
  };
}

export async function memberAuthResponseBody(response: Response, path: string | undefined) {
  if (path !== '/api/auth/get-session' || !response.ok) return response.text();
  const result = await response.json() as { session?: { ipAddress?: string | null } } | null;
  if (result?.session && 'ipAddress' in result.session) {
    result.session.ipAddress = sessionIpPrefix(result.session.ipAddress ?? null);
  }
  return JSON.stringify(result);
}
