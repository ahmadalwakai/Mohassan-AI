import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { roleOf } from './members.js';

const scope = 'member-run';
const prefix = `${scope}:`;
const windowStart = sql<Date>`now() - interval '24 hours'`;

/** Preserve the recent usage of accounts already on the old, run-row-based counter. */
export async function migrateMemberQuota(db: Kysely<any>) {
  await db.transaction().execute(async tx => {
    await sql`SELECT pg_advisory_xact_lock(1846021106)`.execute(tx);
    const version = '003_member_run_quota';
    if (!await tx.selectFrom('auth_schema_migrations').select('version').where('version', '=', version).executeTakeFirst()) {
      await sql`INSERT INTO chat_request_keys (owner_id, request_key, scope, body_hash, status, created_at)
        SELECT r.owner_id, ${prefix} || r.id, ${scope}, encode(sha256(convert_to(r.id, 'UTF8')), 'hex'), 'done', r.created_at
        FROM chat_runs r JOIN workspace_members m ON m.user_id = r.owner_id AND m.role = 'member'
        WHERE r.created_at > ${windowStart}
        ON CONFLICT (owner_id, request_key) DO NOTHING`.execute(tx);
      await tx.insertInto('auth_schema_migrations').values({ version }).execute();
    }
    await tx.deleteFrom('chat_request_keys').where('scope', '=', scope).where('created_at', '<=', windowStart).execute();
  });
}

export async function memberRunsToday(db: Kysely<any>, ownerId: string) {
  const result = await db.selectFrom('chat_request_keys').select(eb => eb.fn.countAll<string>().as('count'))
    .where('scope', '=', scope).where('owner_id', '=', ownerId).where('created_at', '>', windowStart).executeTakeFirst();
  return Number(result?.count ?? 0);
}

/** Reserve usage in the creating transaction, so deleting the run leaves its allowance spent. */
export async function reserveMemberRun(tx: Kysely<any>, ownerId: string, runId: string, limit: number) {
  if (await roleOf(tx, ownerId) !== 'member') return;
  await sql`SELECT pg_advisory_xact_lock(1846021110, hashtext(${ownerId}))`.execute(tx);
  if (await memberRunsToday(tx, ownerId) >= limit) {
    throw Object.assign(new Error(`وصلت إلى حد ${limit} طلبًا خلال 24 ساعة. حاول لاحقًا.`), { statusCode: 429, code: 'MEMBER_DAILY_LIMIT' });
  }
  await tx.deleteFrom('chat_request_keys').where('scope', '=', scope).where('owner_id', '=', ownerId).where('created_at', '<=', windowStart).execute();
  await tx.insertInto('chat_request_keys').values({
    owner_id: ownerId, request_key: prefix + runId, scope, body_hash: createHash('sha256').update(runId).digest('hex'), status: 'done',
  }).execute();
}
