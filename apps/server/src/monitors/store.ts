import { createHash, randomUUID } from 'node:crypto';
import { MonitorSpecSchema, type MonitorCard, type MonitorSpec } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { roleOf, type WorkspaceRole } from '../members.js';
import { backgroundAccountCanReceive } from '../notifications-store.js';
import { monitorSourceContainsCredentials } from './credential-privacy.js';
import { evaluateMonitor, type MonitorEvaluationState, type MonitorObservation } from './evaluation.js';
import { initialMonitorCheck, MONITOR_LIMITS, monitorExpiry, monitorTiming } from './schedule.js';
import type { MonitorSourceCache } from './sources.js';

const liveStatuses = ['proposed', 'active', 'paused'] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hostKey = (host: string) => hash(host.toLowerCase().replace(/\.$/u, ''));

export class MonitorError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'MonitorError';
  }
}

function assertPublicSource(source: MonitorSpec['source']) {
  if (monitorSourceContainsCredentials(source)) {
    throw new MonitorError(400, 'MONITOR_SOURCE_DENIED', 'The source contains private access material.');
  }
}

export interface MonitorNotice {
  eventId: string;
  outcome: 'completed' | 'approval';
  message: string;
  happenedAt: string;
}

export interface MonitorRow {
  id: string;
  user_id: string;
  conversation_id: string;
  spec: MonitorSpec;
  spec_key: string;
  status: MonitorCard['status'];
  offer: NonNullable<MonitorCard['offer']> | null;
  note: string | null;
  evaluation: MonitorEvaluationState | null;
  source_cache: MonitorSourceCache | null;
  last_checked_at: Date | null;
  next_check_at: Date | null;
  interval_ms: number;
  expires_at: Date;
  created_at: Date;
  approved_at: Date | null;
  lease_token: string | null;
  lease_until: Date | null;
  checks: number;
  notifications: number;
  failure_kind: 'missing' | 'unreachable' | null;
  consecutive_failures: number;
  pending_notice: MonitorNotice | null;
  notice_due_at: Date | null;
}

export type ReserveMonitorApproval = (tx: Kysely<any>, userId: string, requestId: string) => Promise<void>;

export type MonitorAccessOptions = {
  now?: () => Date;
  accountActive?: (userId: string, db: Kysely<any>) => Promise<boolean>;
  isMember?: (userId: string, db: Kysely<any>) => Promise<boolean>;
};

type Proposal = {
  conversationId: string;
  spec: MonitorSpec;
  observation: MonitorObservation | null;
  cache?: MonitorSourceCache;
  offer?: MonitorCard['offer'];
  note?: string;
};

export function monitorCard(row: MonitorRow, at: Date): MonitorCard {
  const observed = row.evaluation?.observation;
  const live = liveStatuses.some(status => status === row.status);
  const status = live && new Date(row.expires_at) <= at ? 'expired' : row.status;
  return {
    id: row.id, conversationId: row.conversation_id, spec: row.spec, status,
    current: observed ? { value: observed.value, excerpt: observed.excerpt, observedAt: observed.observedAt } : null,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    nextCheckAt: status === 'active' && row.next_check_at ? new Date(row.next_check_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(row.offer && { offer: row.offer }), ...(row.note && { note: row.note }),
  };
}

export async function spendMonitorBudget(db: Kysely<any>, userId: string, role: WorkspaceRole,
  column: 'checks' | 'previews' | 'notifications', at: Date): Promise<boolean> {
  const day = at.toISOString().slice(0, 10);
  const count = (field: typeof column) => field === column ? 1 : 0;
  const update = (field: typeof column) => sql`
    CASE WHEN smart_monitor_budgets.budget_day < EXCLUDED.budget_day THEN EXCLUDED.${sql.ref(field)}
         ELSE smart_monitor_budgets.${sql.ref(field)} + EXCLUDED.${sql.ref(field)} END`;
  const result = await sql`INSERT INTO smart_monitor_budgets (user_id, budget_day, checks, previews, notifications)
    VALUES (${userId}, ${day}::date, ${count('checks')}, ${count('previews')}, ${count('notifications')})
    ON CONFLICT (user_id) DO UPDATE SET budget_day = EXCLUDED.budget_day,
      checks = ${update('checks')}, previews = ${update('previews')}, notifications = ${update('notifications')}
    WHERE smart_monitor_budgets.budget_day < EXCLUDED.budget_day OR (smart_monitor_budgets.budget_day = EXCLUDED.budget_day
      AND smart_monitor_budgets.${sql.ref(column)} < ${MONITOR_LIMITS.account[role][column]})
    RETURNING user_id`.execute(db);
  return result.rows.length > 0;
}

export function createMonitorStore(db: Kysely<any>, {
  now = () => new Date(), accountActive = (userId, tx) => backgroundAccountCanReceive(tx, userId), isMember,
}: MonitorAccessOptions = {}) {
  async function accountRole(userId: string, tx: Kysely<any>): Promise<WorkspaceRole | null> {
    if (!await accountActive(userId, tx)) return null;
    return isMember ? await isMember(userId, tx) ? 'member' : 'owner' : roleOf(tx, userId);
  }

  async function requireRole(userId: string, tx: Kysely<any>) {
    const role = await accountRole(userId, tx);
    if (!role) throw new MonitorError(403, 'MONITOR_FORBIDDEN', 'Monitoring is unavailable for this account.');
    return role;
  }

  async function requireConversation(tx: Kysely<any>, userId: string, conversationId: string) {
    const conversation = await tx.selectFrom('chat_conversations').select('id').where('id', '=', conversationId)
      .where('owner_id', '=', userId).forKeyShare().executeTakeFirst();
    if (!conversation) throw new MonitorError(404, 'MONITOR_CONVERSATION_NOT_FOUND', 'This conversation could not be found.');
  }

  async function lockMonitor(tx: Kysely<any>, userId: string, id: string) {
    const row = await tx.selectFrom('smart_monitors').selectAll().where('id', '=', id).where('user_id', '=', userId)
      .forUpdate().executeTakeFirst() as MonitorRow | undefined;
    if (!row) throw new MonitorError(404, 'MONITOR_NOT_FOUND', 'This monitor could not be found.');
    return row;
  }

  async function updateMonitor(tx: Kysely<any>, id: string, values: object, at: Date) {
    const updated = await tx.updateTable('smart_monitors').set(values).where('id', '=', id)
      .returningAll().executeTakeFirstOrThrow() as MonitorRow;
    return monitorCard(updated, at);
  }

  return {
    accountRole,

    async reservePreview(userId: string, conversationId: string): Promise<void> {
      await db.transaction().execute(async tx => {
        await requireConversation(tx, userId, conversationId);
        const role = await requireRole(userId, tx);
        if (!await spendMonitorBudget(tx, userId, role, 'previews', now())) {
          throw new MonitorError(429, 'MONITOR_PREVIEW_LIMIT', 'Daily monitor preview limit reached.');
        }
      });
    },

    async reserveHost(host: string, minimumMs?: number): Promise<number | null> {
      const key = hostKey(host);
      const at = now();
      const eligibleAt = new Date(at.getTime() + Math.max(MONITOR_LIMITS.hostIntervalMs, minimumMs ?? 0));
      const { rows } = await sql`INSERT INTO smart_monitor_hosts (host_key, eligible_at) VALUES (${key}, ${eligibleAt})
        ON CONFLICT (host_key) DO UPDATE SET eligible_at = EXCLUDED.eligible_at
        WHERE smart_monitor_hosts.eligible_at <= ${at} RETURNING host_key`.execute(db);
      if (rows.length) return null;
      const row = await db.selectFrom('smart_monitor_hosts').select('eligible_at').where('host_key', '=', key).executeTakeFirst();
      return row ? new Date(row.eligible_at).getTime() : at.getTime() + MONITOR_LIMITS.hostIntervalMs;
    },

    async extendHost(host: string, minimumMs: number): Promise<void> {
      const eligibleAt = new Date(now().getTime() + minimumMs);
      await db.updateTable('smart_monitor_hosts').set({ eligible_at: sql`greatest(eligible_at, ${eligibleAt}::timestamptz)` })
        .where('host_key', '=', hostKey(host)).execute();
    },

    async propose(userId: string, input: Proposal, tx?: Kysely<any>): Promise<MonitorCard> {
      const at = now();
      const candidate = MonitorSpecSchema.parse(input.spec);
      assertPublicSource(candidate.source);
      const timing = monitorTiming(candidate.source.kind, candidate.timing.urgency, { now: at,
        ...candidate.timing, requestedIntervalMs: candidate.timing.initialIntervalMs });
      const spec = MonitorSpecSchema.parse({ ...candidate, timing });
      if (candidate.timing.deadline && !timing.deadline) {
        throw new MonitorError(400, 'MONITOR_DEADLINE_PASSED', 'Choose a future deadline.');
      }
      const key = hash(JSON.stringify([spec.source, spec.read, spec.condition]));
      const execute = async (trx: Kysely<any>) => {
        await requireConversation(trx, userId, input.conversationId);
        const role = await requireRole(userId, trx);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`smart-monitor:${userId}`}, 0))`.execute(trx);
        const live = trx.selectFrom('smart_monitors').where('user_id', '=', userId).where('status', 'in', liveStatuses)
          .where('expires_at', '>', at);
        const existing = await live.selectAll().where('conversation_id', '=', input.conversationId).where('spec_key', '=', key)
          .executeTakeFirst() as MonitorRow | undefined;
        if (existing) {
          if (existing.status === 'proposed' && !existing.evaluation && input.observation) {
            return updateMonitor(trx, existing.id, {
              evaluation: JSON.stringify(evaluateMonitor(existing.spec, undefined, input.observation).state),
              source_cache: input.cache ? JSON.stringify(input.cache) : null,
              note: input.note ?? null, last_checked_at: new Date(input.observation.observedAt),
            }, at);
          }
          return monitorCard(existing, at);
        }
        const count = await live.select(eb => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
        if (Number(count.count) >= MONITOR_LIMITS.account[role].monitors) {
          throw new MonitorError(409, 'MONITOR_LIMIT', 'Monitor limit reached. Stop one to make room for another.');
        }
        const row = await trx.insertInto('smart_monitors').values({
          id: randomUUID(), user_id: userId, conversation_id: input.conversationId, spec: JSON.stringify(spec), spec_key: key,
          status: 'proposed', offer: input.offer ?? null, note: input.note ?? null,
          evaluation: input.observation ? JSON.stringify(evaluateMonitor(spec, undefined, input.observation).state) : null,
          source_cache: input.cache ? JSON.stringify(input.cache) : null,
          last_checked_at: input.observation ? new Date(input.observation.observedAt) : at, interval_ms: spec.timing.initialIntervalMs,
          expires_at: new Date(Math.min(at.getTime() + MONITOR_LIMITS.proposalLifetimeMs, monitorExpiry(spec.timing, at).getTime())), created_at: at,
        }).returningAll().executeTakeFirstOrThrow() as MonitorRow;
        return monitorCard(row, at);
      };
      return tx ? execute(tx) : db.transaction().execute(execute);
    },

    async approve(userId: string, id: string, reserveApproval?: ReserveMonitorApproval): Promise<MonitorCard> {
      return db.transaction().execute(async tx => {
        await requireRole(userId, tx);
        const row = await lockMonitor(tx, userId, id);
        const at = now();
        const status = monitorCard(row, at).status;
        if (status === 'active') return monitorCard(row, at);
        if (status !== 'proposed') throw new MonitorError(409, 'MONITOR_NOT_PROPOSED', 'This monitor is no longer awaiting approval.');
        if (!row.evaluation) throw new MonitorError(409, 'MONITOR_PREVIEW_REQUIRED', 'The current value is unavailable. Request another preview before approval.');
        assertPublicSource(row.spec.source);
        await reserveApproval?.(tx, userId, `monitor:${id}`);
        const expiry = monitorExpiry(row.spec.timing, at);
        const { dueAt, intervalMs } = initialMonitorCheck(row.spec, at, expiry);
        return updateMonitor(tx, row.id, { status: 'active', approved_at: at, expires_at: expiry, next_check_at: dueAt,
          interval_ms: intervalMs }, at);
      });
    },

    async list(userId: string, conversationId?: string): Promise<MonitorCard[]> {
      const at = now();
      let query = db.selectFrom('smart_monitors').selectAll().where('user_id', '=', userId);
      if (conversationId) query = query.where('conversation_id', '=', conversationId);
      const rows = await query.orderBy(sql`(status IN ('proposed', 'active', 'paused') AND expires_at > ${at})`, 'desc')
        .orderBy('created_at', 'desc').orderBy('id').limit(MONITOR_LIMITS.listLimit).execute() as MonitorRow[];
      return rows.map(row => monitorCard(row, at));
    },

    async change(userId: string, id: string, action: 'pause' | 'resume' | 'stop'): Promise<MonitorCard> {
      return db.transaction().execute(async tx => {
        await requireRole(userId, tx);
        const row = await lockMonitor(tx, userId, id);
        const at = now();
        const card = monitorCard(row, at);
        if (action === 'stop') {
          if (!liveStatuses.some(status => status === card.status)) return card;
          return updateMonitor(tx, id, { status: 'stopped', next_check_at: null }, at);
        }
        if (action === 'pause' && card.status === 'active') {
          return updateMonitor(tx, id, { status: 'paused', next_check_at: null, note: null }, at);
        }
        if (action === 'resume' && card.status === 'paused') {
          if (row.pending_notice || row.notifications >= row.spec.timing.maxNotifications - 1 || row.checks >= row.spec.timing.maxChecks) {
            throw new MonitorError(409, 'MONITOR_RESUME_LIMIT', 'This monitor has a pending notice or has used its budget.');
          }
          const { dueAt, intervalMs } = initialMonitorCheck(row.spec, at, new Date(row.expires_at));
          const safeDueAt = new Date(Math.max(dueAt.getTime(), row.lease_until ? new Date(row.lease_until).getTime() : 0));
          return updateMonitor(tx, id, { status: 'active', note: null, next_check_at: safeDueAt, interval_ms: intervalMs,
            consecutive_failures: 0, failure_kind: null }, at);
        }
        if ((action === 'pause' && card.status === 'paused') || (action === 'resume' && card.status === 'active')) return card;
        throw new MonitorError(409, 'MONITOR_STATUS_CONFLICT', 'This monitor cannot change to that state.');
      });
    },
  };
}

export type MonitorStore = ReturnType<typeof createMonitorStore>;
