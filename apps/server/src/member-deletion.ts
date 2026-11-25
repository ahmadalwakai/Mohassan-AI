import { rm } from 'node:fs/promises';
import { isAPIError, APIError } from 'better-auth/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CompiledQuery, sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { MemberAccountIdSchema, RequestMemberDeletionSchema, type MemberDeletion } from '@mohassan/contracts';
import type { createAuth } from './auth.js';
import { recordMemberAudit } from './member-audit.js';
import { memberDocumentDirectory } from './member-data-document-path.js';
import { memberDataRegistry } from './member-data-registry.js';
import { roleOf, type WorkspaceRole } from './members.js';

const PENDING_ROUTES = new Set([
  'GET /api/access', 'GET /api/member-data/deletion', 'DELETE /api/member-data/deletion',
]);
const PURGE_BATCH_SIZE = 250;
const PURGE_INTERVAL_MS = 60_000;
const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });
const ownerProtected = () => failure(403, 'OWNER_DELETION_PROTECTED', 'لا يمكن حذف حساب المالك بهذه الطريقة.');
const deletionDue = () => failure(409, 'DELETION_GRACE_ENDED', 'انتهت مهلة التراجع عن حذف الحساب.');

interface DeletionTimes { requested_at: Date; purge_after: Date }
const publicDeletion = (row: DeletionTimes): MemberDeletion => ({
  requestedAt: new Date(row.requested_at).toISOString(),
  purgeAfter: new Date(row.purge_after).toISOString(),
});

function memberDeletionQuery(db: Kysely<any>) {
  return db.selectFrom('member_deletion_requests as d')
    .innerJoin('workspace_members as m', 'm.user_id', 'd.user_id')
    .where('m.role', '=', 'member')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('workspace_owner as o').select('o.id').whereRef('o.owner_id', '=', 'd.user_id'))));
}

async function deletionState(db: Kysely<any>, userId: string) {
  return memberDeletionQuery(db).where('d.user_id', '=', userId)
    .select(['d.requested_at', 'd.purge_after', sql<boolean>`d.started_at IS NULL AND d.purge_after > clock_timestamp()`.as('can_cancel')])
    .executeTakeFirst();
}

export async function getMemberDeletion(db: Kysely<any>, userId: string) {
  const row = await deletionState(db, userId);
  return row ? publicDeletion(row as DeletionTimes) : null;
}

export async function memberDeletionPending(db: Kysely<any>, userId: string) {
  return Boolean(await deletionState(db, userId));
}

export async function memberDeletionAccess(db: Kysely<any>, userId: string, routeKey: string) {
  const row = await deletionState(db, userId);
  if (!row) return null;
  return row.can_cancel && PENDING_ROUTES.has(routeKey) ? 'limited' as const : 'blocked' as const;
}

// Better Auth 1.7.17 runs its session-create hook after email/password verification.
// https://registry.npmjs.org/better-auth/-/better-auth-1.7.17.tgz (retrieved 2026-11-25)
export async function assertDeletionCanSignIn(db: Kysely<any>, userId: string) {
  const row = await deletionState(db, userId);
  if (row && !row.can_cancel) throw new APIError('FORBIDDEN', {
    code: 'DELETION_GRACE_ENDED', message: 'انتهت مهلة التراجع عن حذف الحساب.',
  });
}

/** Use the identity row to serialize requests, cancellation, and each purge transaction. */
async function lockMember(db: Kysely<any>, userId: string) {
  const user = await db.selectFrom('user').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
  if (!user) return null;
  const owner = await db.selectFrom('workspace_owner').select('id').where('owner_id', '=', userId).executeTakeFirst();
  if (owner) return null;
  return db.selectFrom('workspace_members').select('user_id')
    .where('user_id', '=', userId).where('role', '=', 'member').forUpdate().executeTakeFirst();
}

async function requireLiveSession(db: Kysely<any>, userId: string, sessionId: string) {
  const session = await db.selectFrom('session').select('id').where('id', '=', sessionId).where('userId', '=', userId)
    .where('expiresAt', '>', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
  if (!session) throw failure(401, 'UNAUTHORIZED', 'سجل الدخول للمتابعة.');
}

async function requestMemberDeletion(db: Kysely<any>, userId: string, sessionId: string) {
  return db.transaction().execute(async tx => {
    if (!await lockMember(tx, userId)) throw ownerProtected();
    await requireLiveSession(tx, userId, sessionId);
    const row = await sql<DeletionTimes>`
      WITH requested AS (SELECT clock_timestamp() AS at)
      INSERT INTO member_deletion_requests (user_id, requested_at, purge_after)
      SELECT ${userId}, at, at + interval '168 hours' FROM requested
      ON CONFLICT (user_id) DO NOTHING
      RETURNING requested_at, purge_after`.execute(tx);
    if (!row.rows[0]) throw failure(409, 'DELETION_ALREADY_REQUESTED', 'حذف الحساب مطلوب بالفعل.');
    await tx.deleteFrom('session').where('userId', '=', userId).execute();
    await recordMemberAudit(tx, { actorId: userId, targetId: userId, action: 'deletion_requested' });
    return publicDeletion(row.rows[0]);
  });
}

async function cancelMemberDeletion(db: Kysely<any>, actorId: string, userId: string, sessionId?: string) {
  return db.transaction().execute(async tx => {
    if (!await lockMember(tx, userId)) return false;
    if (sessionId) await requireLiveSession(tx, userId, sessionId);
    const canceled = await tx.deleteFrom('member_deletion_requests')
      .where('user_id', '=', userId).where('started_at', 'is', null)
      .where('purge_after', '>', sql<Date>`clock_timestamp()`).returning('user_id').executeTakeFirst();
    if (canceled) {
      await recordMemberAudit(tx, { actorId, targetId: userId, action: 'deletion_cancelled' });
      return true;
    }
    if (await deletionState(tx, userId)) throw deletionDue();
    return false;
  });
}

interface DeletionRouteOptions {
  db: Kysely<any>;
  auth: ReturnType<typeof createAuth>;
  owner: (request: FastifyRequest) => Promise<{ id: string; sessionId: string }>;
  role: (request: FastifyRequest) => Promise<WorkspaceRole>;
}

export function registerMemberDeletionRoutes(app: FastifyInstance, { db, auth, owner, role }: DeletionRouteOptions) {
  const requireOwner = async (request: FastifyRequest) => {
    const user = await owner(request);
    if (await role(request) !== 'owner') throw failure(403, 'MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
    return user;
  };

  const empty = z.object({}).strict();
  app.get('/api/member-data/deletion', async request => {
    empty.parse(request.query);
    return { deletion: await getMemberDeletion(db, (await owner(request)).id) };
  });
  app.post('/api/member-data/deletion', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const user = await owner(request);
    if (await roleOf(db, user.id) === 'owner') throw ownerProtected();
    empty.parse(request.query);
    const { password } = RequestMemberDeletionSchema.parse(request.body);
    const headers = new Headers();
    if (request.headers.cookie) headers.set('cookie', request.headers.cookie);
    try {
      // The server-only Better Auth endpoint checks the credential for this exact session.
      await auth.api.verifyPassword({ body: { password }, headers });
    } catch (error) {
      if (isAPIError(error) && error.body?.code === 'INVALID_PASSWORD') {
        throw failure(403, 'PASSWORD_CONFIRMATION_FAILED', 'كلمة المرور غير صحيحة.');
      }
      if (isAPIError(error) && error.statusCode === 401) throw failure(401, 'UNAUTHORIZED', 'سجل الدخول للمتابعة.');
      throw error;
    }
    return { deletion: await requestMemberDeletion(db, user.id, user.sessionId) };
  });

  app.delete('/api/member-data/deletion', async request => {
    const user = await owner(request);
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    return { cancelled: await cancelMemberDeletion(db, user.id, user.id, user.sessionId) };
  });

  app.get('/api/members/deletions', async request => {
    await requireOwner(request);
    empty.parse(request.query);
    const rows = await memberDeletionQuery(db).innerJoin('user as u', 'u.id', 'd.user_id')
      .select(['d.user_id', 'd.requested_at', 'd.purge_after', 'u.name', 'u.email'])
      .orderBy('d.purge_after').orderBy('d.user_id').execute();
    return { requests: rows.map(row => ({ userId: row.user_id as string, name: row.name as string, email: row.email as string, ...publicDeletion(row as DeletionTimes) })) };
  });

  app.delete<{ Params: { userId: string } }>('/api/members/deletions/:userId', async request => {
    const user = await requireOwner(request);
    const userId = MemberAccountIdSchema.parse(request.params.userId);
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    return { cancelled: await cancelMemberDeletion(db, user.id, userId) };
  });
}

export interface MemberPurgeOptions {
  documentsDir: string;
  purgeBrowserProfiles: (userId: string, accounts: readonly string[]) => Promise<void>;
}

type RegistryEntry = (typeof memberDataRegistry)[number];

async function applyPolicy(db: Kysely<any>, entry: RegistryEntry, userId: string, batched: boolean) {
  const { table, accountPredicate, deletion } = entry;
  if (deletion.action === 'keep') return 0;
  const relation = `"${table}"`;
  // PostgreSQL's row locator is valid within this statement, including for composite-key tables.
  // https://www.postgresql.org/docs/current/sql-delete.html (retrieved 2026-11-25)
  const withBatch = batched
    ? `WITH selected AS (SELECT data.ctid FROM ${relation} AS data WHERE (${accountPredicate}) LIMIT ${PURGE_BATCH_SIZE}) `
    : '';
  const rows = batched ? 'data.ctid IN (SELECT ctid FROM selected)' : accountPredicate;
  const operation = deletion.action === 'delete'
    ? `DELETE FROM ${relation} AS data`
    : `UPDATE ${relation} AS data SET ${deletion.set}`;
  const query = CompiledQuery.raw(`${withBatch}${operation} WHERE (${rows}) RETURNING 1`, [userId]);
  return (await db.executeQuery(query)).rows.length;
}

async function lockPurge(db: Kysely<any>, userId: string) {
  if (!await lockMember(db, userId)) return null;
  return db.selectFrom('member_deletion_requests').select('started_at')
    .where('user_id', '=', userId).where('purge_after', '<=', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
}

/** Commit the claim before any destructive work so cancellation cannot race a partial purge. */
export async function purgeMemberAccount(db: Kysely<any>, userId: string, options: MemberPurgeOptions) {
  const claimed = await db.transaction().execute(async tx => {
    const row = await lockPurge(tx, userId);
    if (!row) return false;
    if (!row.started_at) {
      await tx.updateTable('member_deletion_requests').set({ started_at: sql<Date>`clock_timestamp()` }).where('user_id', '=', userId).execute();
      await tx.deleteFrom('session').where('userId', '=', userId).execute();
    }
    return true;
  });
  if (!claimed) return false;

  // Clean files first, while the original browser account bindings still exist. Retrying
  // the same owner partition after a crash also removes files left by interrupted writes.
  const cleaned = await db.transaction().execute(async tx => {
    if (!await lockPurge(tx, userId)) return false;
    const accounts = await tx.selectFrom('chat_conversations').select('browser_account').distinct()
      .where('owner_id', '=', userId).where('browser_account', 'is not', null).execute();
    await options.purgeBrowserProfiles(userId, accounts.map(row => String(row.browser_account)));
    await rm(memberDocumentDirectory(options.documentsDir, userId), { recursive: true, force: true });
    return true;
  });
  if (!cleaned) return false;

  for (const entry of memberDataRegistry) {
    if (entry.deletion.action === 'keep' || ('final' in entry.deletion && entry.deletion.final)) continue;
    let changed: number;
    do {
      changed = await db.transaction().execute(async tx =>
        await lockPurge(tx, userId) ? applyPolicy(tx, entry, userId, true) : 0);
    } while (changed === PURGE_BATCH_SIZE);
  }

  return db.transaction().execute(async tx => {
    if (!await lockPurge(tx, userId)) return false;
    for (const entry of memberDataRegistry) {
      if ('final' in entry.deletion && entry.deletion.final) await applyPolicy(tx, entry, userId, false);
    }
    await recordMemberAudit(tx, { actorId: null, targetId: userId, action: 'deletion_purged' });
    return true;
  });
}

export function startMemberDeletionPurge(app: FastifyInstance, db: Kysely<any>, options: MemberPurgeOptions) {
  let running: Promise<void> | undefined, interval: NodeJS.Timeout | undefined;
  const reportError = () => console.error(JSON.stringify({ level: 'error', event: 'member_deletion_purge_failed' }));
  const tick = () => {
    running ??= (async () => {
      const due = await memberDeletionQuery(db).select('d.user_id')
        .where('d.purge_after', '<=', sql<Date>`clock_timestamp()`).orderBy('d.purge_after').limit(20).execute();
      for (const { user_id } of due) {
        try { await purgeMemberAccount(db, user_id as string, options); }
        catch { reportError(); }
      }
    })().catch(reportError).finally(() => { running = undefined; });
  };
  app.addHook('onReady', async () => {
    interval = setInterval(tick, PURGE_INTERVAL_MS);
    interval.unref();
    tick();
  });
  app.addHook('preClose', async () => { clearInterval(interval); await running; });
}
