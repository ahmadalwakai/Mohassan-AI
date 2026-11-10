import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { createAuth } from './auth.js';
import { WASLA_GATEWAY_ROUTES } from './wasla.js';

/**
 * Members are people the owner invites. They use cloud services only (chat,
 * search, their own memory, their own Google Ads); they never reach a computer,
 * the owner's projects, skills, providers or tasks.
 *
 * Access is default-deny: a route a member may call must be listed in
 * MEMBER_ROUTES. A route added later stays owner-only until someone lists it.
 */
export type WorkspaceRole = 'owner' | 'member';

/** Reached without a session. Each handler does its own checks. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /api/setup', 'POST /api/setup',
  'GET /api/auth/*', 'POST /api/auth/*',
  'POST /api/windows/companion/pair', 'POST /api/windows/companion/poll',
  'POST /api/invites/inspect', 'POST /api/invites/accept',
  // The Wasla service on the owner's computer: loopback and its own gateway key.
  ...WASLA_GATEWAY_ROUTES,
]);

const chat = '/api/chat/conversations';
const files = '/api/browser/files/:conversationId';
const ads = '/api/google-ads';
export const MEMBER_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/access',
  // The chat, including its own cloud browser (a profile per account).
  `GET ${chat}`, `POST ${chat}`, `GET ${chat}/:id`, `DELETE ${chat}/:id`, `GET ${chat}/:id/screen`, `GET ${chat}/:id/decision-events`,
  `POST ${chat}/:id/messages`, `POST ${chat}/:id/respond`, `POST ${chat}/:id/approve`, `POST ${chat}/:id/secure`, `POST ${chat}/:id/cancel`,
  `POST ${chat}/:id/browser/keyboard`, `POST ${chat}/:id/browser/pointer`, `POST ${chat}/:id/browser/restore`, `POST ${chat}/:id/browser/review`,
  `GET ${files}`, `GET ${files}/targets`, `POST ${files}/grants`, `DELETE ${files}/grants/:id`, `POST ${files}/grants/:id/execute`, `POST ${files}/grants/:id/release`, `GET ${files}/grants/:id/content`,
  // The member's own memory. Memory skills run tasks and stay owner-only.
  'GET /api/memory', 'GET /api/memory/items/:id', 'POST /api/memory/items', 'POST /api/memory/search', 'POST /api/memory/feedback',
  'POST /api/memory/items/:id/correct', 'POST /api/memory/items/:id/delete', 'POST /api/memory/items/:id/revoke',
  // The member's own Google Ads account: every step, publishing included, acts on their account only.
  `GET ${ads}/status`, `GET ${ads}/accounts`, `POST ${ads}/accounts/select`, `POST ${ads}/connect`, `POST ${ads}/disconnect`, `GET ${ads}/oauth/callback`,
  `GET ${ads}/report`, `GET ${ads}/audit`, `GET ${ads}/recommendations`, `GET ${ads}/experiences`, `POST ${ads}/market`, `POST ${ads}/booking-map`,
  `GET ${ads}/drafts`, `POST ${ads}/drafts`, `GET ${ads}/drafts/:id`, `GET ${ads}/drafts/:id/launch-hash`, `POST ${ads}/drafts/:id/revise`,
  ...['save', 'validate', 'verify', 'publish', 'launch', 'reconcile', 'discard', 'approve-publish', 'approve-launch'].map(step => `POST ${ads}/drafts/:id/${step}`),
]);

/** Requests that start chat work, counted against a member's daily allowance. */
export const MEMBER_QUOTA_ROUTES: ReadonlySet<string> = new Set([`POST ${chat}`, `POST ${chat}/:id/messages`]);

export function routeKey(method: string, url: string | undefined) {
  return url ? `${method === 'HEAD' ? 'GET' : method} ${url}` : null;
}

const INVITE_DAYS = 7;
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const InviteInput = z.object({ name: z.string().trim().min(2).max(80), email: z.email().max(254).transform(value => value.trim().toLowerCase()) }).strict();
const AcceptInput = z.object({ token: Token, name: z.string().trim().min(2).max(80), password: z.string().min(12).max(128) }).strict();
const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });

export async function migrateMembers(database: Kysely<any>) {
  await database.transaction().execute(async (db) => {
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(db);
    const applied = await db.selectFrom('auth_schema_migrations').select('version').where('version', '=', '002_members').executeTakeFirst();
    if (applied) return;
    // 'owner' rows give another account full access; only the database can add one.
    await sql`CREATE TABLE IF NOT EXISTS workspace_members (
      user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'member')),
      invite_id text, created_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
    )`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS workspace_invites (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, email text NOT NULL, name text NOT NULL,
      created_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      claimed_at timestamptz, consumed_by text REFERENCES "user"(id) ON DELETE SET NULL, revoked_at timestamptz
    )`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS workspace_invites_email_idx ON workspace_invites(email)`.execute(db);
    await db.insertInto('auth_schema_migrations').values({ version: '002_members' }).execute();
  });
}

/** Null means no access at all: an account that is neither the owner nor an active member. */
export async function roleOf(db: Kysely<any>, userId: string): Promise<WorkspaceRole | null> {
  const row = await sql<{ owner: boolean; role: string | null; disabled: boolean }>`
    SELECT EXISTS (SELECT 1 FROM workspace_owner WHERE id = 1 AND owner_id = ${userId}) AS owner,
           m.role, (m.disabled_at IS NOT NULL) AS disabled
    FROM (SELECT 1) AS one LEFT JOIN workspace_members m ON m.user_id = ${userId}`.execute(db);
  const found = row.rows[0];
  if (found?.owner) return 'owner';
  if (!found?.role || found.disabled) return null;
  return found.role === 'owner' ? 'owner' : 'member';
}

/** Chat work a member started in the last 24 hours. */
export async function memberRunsToday(db: Kysely<any>, userId: string) {
  const row = await db.selectFrom('chat_runs').select(eb => eb.fn.countAll<string>().as('count'))
    .where('owner_id', '=', userId).where('created_at', '>', sql<Date>`now() - interval '24 hours'`).executeTakeFirst();
  return Number(row?.count ?? 0);
}

type User = { id: string; name: string; email: string };
interface MemberRouteOptions {
  db: Kysely<any>;
  auth: ReturnType<typeof createAuth>;
  webOrigin: string;
  owner: (request: { headers: Record<string, unknown> }) => Promise<User>;
  role: (request: { headers: Record<string, unknown> }) => Promise<WorkspaceRole>;
  dailyRuns: number;
  imagesAvailable: () => boolean;
  adsAvailable: () => boolean;
}

export async function registerMemberRoutes(app: FastifyInstance, options: MemberRouteOptions) {
  const { db, auth } = options;
  const requireOwner = async (request: { headers: Record<string, unknown> }) => {
    const user = await options.owner(request);
    if (await options.role(request) !== 'owner') throw failure(403, 'MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
    return user;
  };

  app.get('/api/access', async (request) => {
    const user = await options.owner(request), role = await options.role(request);
    const services = role === 'owner' ? ['all'] : ['chat', 'memory', ...(options.adsAvailable() ? ['ads'] : []), ...(options.imagesAvailable() ? ['images'] : [])];
    const used = role === 'member' ? await memberRunsToday(db, user.id) : 0;
    return { user: { id: user.id, name: user.name, email: user.email }, role, services, ...(role === 'member' ? { quota: { dailyRuns: options.dailyRuns, used } } : {}) };
  });

  app.get('/api/members', async (request) => {
    await requireOwner(request);
    const members = await db.selectFrom('workspace_members as m').innerJoin('user as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.name', 'u.email', 'm.created_at', 'm.disabled_at']).where('m.role', '=', 'member').orderBy('m.created_at', 'desc').execute();
    const invites = await db.selectFrom('workspace_invites').select(['id', 'name', 'email', 'created_at', 'expires_at'])
      .where('claimed_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', new Date()).orderBy('created_at', 'desc').execute();
    const runs = new Map<string, number>();
    for (const member of members) runs.set(member.id, await memberRunsToday(db, member.id));
    return {
      members: members.map(member => ({ id: member.id, name: member.name, email: member.email, joinedAt: new Date(member.created_at).toISOString(), disabled: member.disabled_at !== null, runsToday: runs.get(member.id) ?? 0 })),
      invites: invites.map(invite => ({ id: invite.id, name: invite.name, email: invite.email, createdAt: new Date(invite.created_at).toISOString(), expiresAt: new Date(invite.expires_at).toISOString() })),
      dailyRuns: options.dailyRuns,
    };
  });

  app.post('/api/members/invites', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const owner = await requireOwner(request);
    const input = InviteInput.parse(request.body);
    if (await db.selectFrom('user').select('id').where(sql`lower(email)`, '=', input.email).executeTakeFirst()) throw failure(409, 'MEMBER_EXISTS', 'يوجد حساب بهذا البريد بالفعل.');
    const token = randomBytes(32).toString('base64url'), id = randomBytes(16).toString('hex');
    await db.transaction().execute(async (tx) => {
      // One open invite per address: a new link replaces the old one.
      await tx.updateTable('workspace_invites').set({ revoked_at: new Date() }).where('email', '=', input.email).where('claimed_at', 'is', null).where('revoked_at', 'is', null).execute();
      await tx.insertInto('workspace_invites').values({ id, token_hash: hashToken(token), email: input.email, name: input.name, created_by: owner.id, expires_at: new Date(Date.now() + INVITE_DAYS * 86400000) }).execute();
    });
    // The token is shown once. Only its hash is stored. The fragment never reaches a server log.
    return { id, url: `${new URL(options.webOrigin).origin}/#invite=${token}`, expiresInDays: INVITE_DAYS };
  });

  app.post<{ Params: { id: string } }>('/api/members/invites/:id/revoke', async (request) => {
    await requireOwner(request);
    const id = z.string().regex(/^[a-f0-9]{32}$/).parse(request.params.id);
    z.object({}).strict().parse(request.body ?? {});
    const result = await db.updateTable('workspace_invites').set({ revoked_at: new Date() }).where('id', '=', id).where('claimed_at', 'is', null).where('revoked_at', 'is', null).executeTakeFirst();
    if (!Number(result.numUpdatedRows)) throw failure(404, 'INVITE_NOT_FOUND', 'الدعوة غير موجودة أو استُخدمت.');
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/members/:id/access', async (request) => {
    await requireOwner(request);
    const userId = z.string().min(1).max(64).parse(request.params.id);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    await db.transaction().execute(async (tx) => {
      const result = await tx.updateTable('workspace_members').set({ disabled_at: enabled ? null : new Date() }).where('user_id', '=', userId).where('role', '=', 'member').executeTakeFirst();
      if (!Number(result.numUpdatedRows)) throw failure(404, 'MEMBER_NOT_FOUND', 'العضو غير موجود.');
      // A disabled member is signed out everywhere at once.
      if (!enabled) await tx.deleteFrom('session').where('userId', '=', userId).execute();
    });
    return { ok: true };
  });

  const openInvite = async (token: string) => {
    const invite = await db.selectFrom('workspace_invites').select(['id', 'name', 'email', 'expires_at', 'claimed_at', 'revoked_at']).where('token_hash', '=', hashToken(token)).executeTakeFirst();
    if (!invite || invite.claimed_at || invite.revoked_at || new Date(invite.expires_at) <= new Date()) throw failure(404, 'INVITE_INVALID', 'رابط الدعوة غير صالح أو انتهت مدته. اطلب رابطًا جديدًا.');
    return invite;
  };

  app.post('/api/invites/inspect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const { token } = z.object({ token: Token }).strict().parse(request.body);
    const invite = await openInvite(token);
    return { name: invite.name, email: invite.email };
  });

  app.post('/api/invites/accept', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const input = AcceptInput.parse(request.body);
    const invite = await openInvite(input.token);
    // Claim first so two tabs cannot both create an account from one link.
    const claimed = await db.updateTable('workspace_invites').set({ claimed_at: new Date() }).where('id', '=', invite.id).where('claimed_at', 'is', null).where('revoked_at', 'is', null).executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) throw failure(409, 'INVITE_IN_USE', 'تُستخدم هذه الدعوة الآن.');
    let userId: string;
    try {
      const result = await auth.api.signUpEmail({ body: { name: input.name, email: invite.email, password: input.password } });
      userId = result.user.id;
    } catch (error) {
      await db.updateTable('workspace_invites').set({ claimed_at: null }).where('id', '=', invite.id).where('consumed_by', 'is', null).execute();
      const status = (error as { statusCode?: number; status?: string }).statusCode;
      if (status === 422 || (error as { status?: string }).status === 'UNPROCESSABLE_ENTITY') throw failure(409, 'MEMBER_EXISTS', 'يوجد حساب بهذا البريد بالفعل.');
      throw error;
    }
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('workspace_invites').set({ consumed_by: userId }).where('id', '=', invite.id).execute();
      await tx.insertInto('workspace_members').values({ user_id: userId, role: 'member', invite_id: invite.id }).execute();
    });
    return { ok: true, email: invite.email };
  });
}
