import { createHash, randomUUID } from 'node:crypto';
import { MonitorSpecSchema, type MonitorCard, type MonitorSpec } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';
import { roleOf, type WorkspaceRole } from '../members.js';
import { backgroundAccountCanReceive } from '../notifications-store.js';
import { evaluateMonitor, type MonitorEvaluationState, type MonitorObservation } from './evaluation.js';
import { evaluateMonitorV2 } from './evaluation-v2.js';
import { smartMonitorsV2Enabled } from './flag.js';
import { learnMonitorSchedule, nextPredictiveMonitorCheck } from './schedule-v2.js';
import type { MonitorV2Preview, MonitorV2State } from './v2-runtime-types.js';
import { initialMonitorCheck, MONITOR_LIMITS, monitorExpiry, monitorTiming } from './schedule.js';
import type { MonitorSourceCache } from './sources.js';

const liveStatuses = ['proposed', 'active', 'paused'] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const monitorSpecKey = (spec: MonitorSpec) => hash(JSON.stringify([spec.source, spec.read, spec.condition, ...(spec.v2 ? [spec.v2] : [])]));
const hostKey = (host: string) => hash(host.toLowerCase().replace(/\.$/u, ''));

export class MonitorError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'MonitorError';
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
  v2_state?: MonitorV2State | null;
  v2_digest_due_at?: Date | null;
}

export type MonitorAccessOptions = {
  now?: () => Date;
  v2?: boolean;
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
  v2Preview?: MonitorV2Preview;
};

export function monitorCard(row: MonitorRow, at: Date, v2 = false): MonitorCard {
  const observed = (v2 ? row.v2_state?.evaluation?.sources[0]?.confirmed : undefined) ?? row.evaluation?.observation;
  const clarification = v2 && (row.status === 'proposed' || row.status === 'paused') ? row.v2_state?.clarification : undefined;
  const live = liveStatuses.some(status => status === row.status);
  const status = live && new Date(row.expires_at) <= at ? 'expired' : row.status;
  return {
    id: row.id, conversationId: row.conversation_id, spec: row.spec, status,
    current: observed ? { value: observed.value, excerpt: observed.excerpt, observedAt: observed.observedAt } : null,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    nextCheckAt: status === 'active' && row.next_check_at ? new Date(row.next_check_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    ...(clarification && status !== 'expired' && { clarification: {
      question: row.spec.language === 'ar' ? 'أيّ قيمة تريد أن أراقب؟' : 'Which value should I watch?',
      choices: clarification.candidates.map(({ id, label, observation }) => ({ id, label, value: observation.value })),
    } }),
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
  now = () => new Date(), v2 = smartMonitorsV2Enabled(), accountActive = (userId, tx) => backgroundAccountCanReceive(tx, userId), isMember,
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
    let query = tx.selectFrom('smart_monitors').selectAll().where('id', '=', id).where('user_id', '=', userId);
    if (!v2) query = query.where(sql<boolean>`spec->'v2' IS NULL`);
    const row = await query.forUpdate().executeTakeFirst() as MonitorRow | undefined;
    if (!row) throw new MonitorError(404, 'MONITOR_NOT_FOUND', 'This monitor could not be found.');
    return row;
  }

  async function updateMonitor(tx: Kysely<any>, id: string, values: object, at: Date) {
    const updated = await tx.updateTable('smart_monitors').set(values).where('id', '=', id)
      .returningAll().executeTakeFirstOrThrow() as MonitorRow;
    return monitorCard(updated, at, v2);
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
      if (!v2 && (candidate.v2 || input.v2Preview)) throw new MonitorError(409, 'MONITOR_V2_DISABLED', 'Smart monitor v2 is unavailable.');
      const timing = monitorTiming(candidate.source.kind, candidate.timing.urgency, { now: at,
        ...candidate.timing, requestedIntervalMs: candidate.timing.initialIntervalMs });
      const spec = MonitorSpecSchema.parse({ ...candidate, timing });
      if (candidate.timing.deadline && !timing.deadline) {
        throw new MonitorError(400, 'MONITOR_DEADLINE_PASSED', 'Choose a future deadline.');
      }
      const key = monitorSpecKey(spec);
      const preview = input.v2Preview;
      const v2State: MonitorV2State | undefined = preview && {
        cursor: 0, caches: preview.caches,
        schedule: learnMonitorSchedule(undefined, at, { changed: false, publicationTimes: preview.publicationTimes }),
        ...(preview.samples.length && { evaluation: evaluateMonitorV2(spec, undefined, preview.samples, at, { canDeliver: false }).state }),
        ...(preview.clarification && { clarification: { ...preview.clarification, resume: 'proposed' } }),
        ...(preview.additionalClarifications?.length && { additionalClarifications: preview.additionalClarifications }),
      };
      const execute = async (trx: Kysely<any>) => {
        await requireConversation(trx, userId, input.conversationId);
        const role = await requireRole(userId, trx);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`smart-monitor:${userId}`}, 0))`.execute(trx);
        const live = trx.selectFrom('smart_monitors').where('user_id', '=', userId).where('status', 'in', liveStatuses)
          .where('expires_at', '>', at);
        const existing = await live.selectAll().where('conversation_id', '=', input.conversationId).where('spec_key', '=', key)
          .executeTakeFirst() as MonitorRow | undefined;
        if (existing) {
          if (existing.status === 'proposed' && !existing.evaluation && !existing.v2_state && (input.observation || v2State)) {
            return updateMonitor(trx, existing.id, {
              evaluation: input.observation ? JSON.stringify(evaluateMonitor(existing.spec, undefined, input.observation).state) : null,
              source_cache: input.cache ? JSON.stringify(input.cache) : null,
              ...(v2State && { v2_state: JSON.stringify(v2State) }),
              note: input.note ?? null, last_checked_at: input.observation ? new Date(input.observation.observedAt) : at,
            }, at);
          }
          return monitorCard(existing, at, v2);
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
          ...(v2State && { v2_state: JSON.stringify(v2State) }),
          last_checked_at: input.observation ? new Date(input.observation.observedAt) : at, interval_ms: spec.timing.initialIntervalMs,
          expires_at: new Date(Math.min(at.getTime() + MONITOR_LIMITS.proposalLifetimeMs, monitorExpiry(spec.timing, at).getTime())), created_at: at,
        }).returningAll().executeTakeFirstOrThrow() as MonitorRow;
        return monitorCard(row, at, v2);
      };
      return tx ? execute(tx) : db.transaction().execute(execute);
    },

    async approve(userId: string, id: string): Promise<MonitorCard> {
      return db.transaction().execute(async tx => {
        await requireRole(userId, tx);
        const row = await lockMonitor(tx, userId, id);
        const at = now();
        const status = monitorCard(row, at, v2).status;
        if (status === 'active') return monitorCard(row, at, v2);
        if (status !== 'proposed') throw new MonitorError(409, 'MONITOR_NOT_PROPOSED', 'This monitor is no longer awaiting approval.');
        if ((v2 && row.v2_state?.clarification) || (!row.evaluation && !(v2 && row.v2_state?.evaluation))) {
          throw new MonitorError(409, 'MONITOR_PREVIEW_REQUIRED', v2 ? 'Confirm the current value before approval.' : 'The current value is unavailable. Request another preview before approval.');
        }
        const expiry = monitorExpiry(row.spec.timing, at);
        const { dueAt, intervalMs } = v2 && row.spec.v2 ? nextPredictiveMonitorCheck(row.spec, at, {
          state: row.v2_state?.schedule, expiry, checksUsed: 0,
        }) : initialMonitorCheck(row.spec, at, expiry);
        return updateMonitor(tx, row.id, { status: 'active', approved_at: at, expires_at: expiry, next_check_at: dueAt,
          interval_ms: intervalMs }, at);
      });
    },

    async list(userId: string, conversationId?: string): Promise<MonitorCard[]> {
      const at = now();
      let query = db.selectFrom('smart_monitors').selectAll().where('user_id', '=', userId);
      if (!v2) query = query.where(sql<boolean>`spec->'v2' IS NULL`);
      if (conversationId) query = query.where('conversation_id', '=', conversationId);
      const rows = await query.orderBy(sql`(status IN ('proposed', 'active', 'paused') AND expires_at > ${at})`, 'desc')
        .orderBy('created_at', 'desc').orderBy('id').limit(MONITOR_LIMITS.listLimit).execute() as MonitorRow[];
      return rows.map(row => monitorCard(row, at, v2));
    },

    async choose(userId: string, id: string, candidateId: string): Promise<MonitorCard> {
      return db.transaction().execute(async tx => {
        await requireRole(userId, tx);
        const row = await lockMonitor(tx, userId, id);
        const at = now();
        const state = row.v2_state;
        const clarification = v2 && state?.clarification;
        const candidate = clarification && clarification.candidates.find(item => item.id === candidateId);
        if (!state || !clarification || !candidate ||
            !['proposed', 'paused'].includes(monitorCard(row, at, v2).status)) {
          throw new MonitorError(409, 'MONITOR_CHOICE_STALE', 'This monitor choice is no longer available.');
        }
        const { index, resume } = clarification;
        if (resume === 'active' && row.checks >= row.spec.timing.maxChecks) {
          throw new MonitorError(409, 'MONITOR_RESUME_LIMIT', 'This monitor has used its check budget.');
        }
        const previous = state.evaluation && { ...state.evaluation, sources: [...state.evaluation.sources] };
        const observation = candidate.observation;
        const seeded = evaluateMonitorV2(row.spec, undefined, [{ index, observation }], new Date(observation.observedAt), { canDeliver: false }).state;
        if (previous) {
          previous.sources[index] = seeded.sources[index];
          previous.matched = false;
          if (index === 0) delete previous.sequenceStart;
        }
        state.evaluation = previous ?? seeded;
        state.caches[index] = { ...(clarification.cache ?? state.caches[index]), url: observation.url ?? (row.spec.source.kind === 'page' ? row.spec.source.url : ''),
          anchor: candidate.anchor };
        state.cursor = 0;
        if (state.failures) state.failures[index] = 0;
        state.schedule ??= learnMonitorSchedule(undefined, at, { changed: false });
        const following = state.additionalClarifications?.shift();
        if (following) state.clarification = { ...following, resume: 'proposed' };
        else {
          delete state.clarification;
          delete state.additionalClarifications;
        }
        const expiry = new Date(row.expires_at);
        const { dueAt, intervalMs } = nextPredictiveMonitorCheck(row.spec, at, { state: state.schedule, expiry, checksUsed: row.checks });
        return updateMonitor(tx, id, {
          status: resume, note: null, v2_state: JSON.stringify(state), interval_ms: intervalMs,
          next_check_at: resume === 'active' ? dueAt : null, failure_kind: null, consecutive_failures: 0,
        }, at);
      });
    },

    async change(userId: string, id: string, action: 'pause' | 'resume' | 'stop', transaction?: Kysely<any>): Promise<MonitorCard> {
      const execute = async (tx: Kysely<any>) => {
        await requireRole(userId, tx);
        const row = await lockMonitor(tx, userId, id);
        const at = now();
        const card = monitorCard(row, at, v2);
        if (action === 'stop') {
          if (!liveStatuses.some(status => status === card.status)) return card;
          return updateMonitor(tx, id, { status: 'stopped', next_check_at: null, ...(v2 && { v2_digest_due_at: null }) }, at);
        }
        if (action === 'pause' && card.status === 'active') {
          return updateMonitor(tx, id, { status: 'paused', next_check_at: null, note: null }, at);
        }
        if (action === 'resume' && card.status === 'paused') {
          if (v2 && row.v2_state?.clarification) {
            throw new MonitorError(409, 'MONITOR_PREVIEW_REQUIRED', 'Confirm the watched value before resuming.');
          }
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
      };
      return transaction ? execute(transaction) : db.transaction().execute(execute);
    },
  };
}

export type MonitorStore = ReturnType<typeof createMonitorStore>;
