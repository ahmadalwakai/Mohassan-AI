import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { monitorMetricTransaction, observeMonitorCheck } from '../ops/metrics/monitor-events.js';
import { monitorOwnerIds, type EnabledMonitorRollout } from '../monitors-phase1/rollout.js';
import { monitorHealth, monitorTrigger, monitorV2Trigger, publishMonitorNotice } from './delivery.js';
import { evaluateMonitor } from './evaluation.js';
import { evaluateMonitorV2, monitorV2DigestDueAt } from './evaluation-v2.js';
import { smartMonitorsV2Enabled } from './flag.js';
import { finishV2Check, monitorSourceSpec, v2ReadState } from './v2-runtime.js';
import { MONITOR_LIMITS, nextMonitorBudgetDay, nextMonitorCheck } from './schedule.js';
import { createMonitorStore, spendMonitorBudget, type MonitorRow, type MonitorStore } from './store.js';
import type { createMonitorReader } from './sources.js';

type ReadMonitor = ReturnType<typeof createMonitorReader>['read'];
type ReadResult = Awaited<ReturnType<ReadMonitor>>;
type Candidate = { id: string; conversation_id: string; user_id: string };
type Claim = { row: MonitorRow; token: string };
const clearLease = { lease_token: null, lease_until: null };
const expire = { status: 'expired', next_check_at: null, ...clearLease };

async function withinSignal<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([invoke(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function createMonitorRuntime(db: Kysely<any>, ports: {
  read: ReadMonitor;
  store?: MonitorStore;
  rollout?: EnabledMonitorRollout;
}, { now = () => new Date(), v2 = smartMonitorsV2Enabled(), onError = () => console.error('[monitors] Poll failed; retrying.') }: {
  now?: () => Date;
  v2?: boolean;
  onError?: () => void;
} = {}) {
  const store = ports.store ?? createMonitorStore(db, { now, rollout: ports.rollout, v2 });
  const ownersOnly = ports.rollout === 'owner';
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let controller = new AbortController();

  async function claim(): Promise<Claim | 'deferred' | undefined> {
    return db.transaction().execute(async tx => {
      const at = now();
      let due = tx.selectFrom('smart_monitors').selectAll().where('status', '=', 'active')
        .$if(ownersOnly, query => query.where('user_id', 'in', monitorOwnerIds(tx)))
        .where('expires_at', '>', at).where('next_check_at', '<=', at)
        .where(eb => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      if (!v2) due = due.where(sql<boolean>`spec->'v2' IS NULL`);
      const row = await due.orderBy('next_check_at').orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst() as MonitorRow | undefined;
      if (!row) return;
      const update = tx.updateTable('smart_monitors').where('id', '=', row.id);
      if (row.checks >= row.spec.timing.maxChecks) {
        await update.set(expire).execute();
        return 'deferred';
      }
      const role = await store.accountRole(row.user_id, tx);
      if (!role || !await spendMonitorBudget(tx, row.user_id, role, 'checks', at)) {
        const retryAt = role ? nextMonitorBudgetDay(at) : new Date(at.getTime() + MONITOR_LIMITS.maxIntervalMs);
        await update.set({ ...clearLease, next_check_at: retryAt }).execute();
        return 'deferred';
      }
      const token = randomUUID();
      const checks = row.checks + 1;
      // Commit the consumed check and advance its due slot before leaving the transaction.
      // A crashed worker cannot cause a second read of that check, and a stale response cannot publish.
      await update.set({ checks, lease_token: token, lease_until: new Date(at.getTime() + MONITOR_LIMITS.leaseMs),
        next_check_at: new Date(at.getTime() + row.interval_ms) }).execute();
      return { row: { ...row, checks }, token };
    });
  }

  async function lockConversation(tx: Kysely<any>, candidate: Candidate) {
    return tx.selectFrom('chat_conversations').select('id').where('id', '=', candidate.conversation_id)
      .where('owner_id', '=', candidate.user_id).forNoKeyUpdate().executeTakeFirst();
  }

  async function finish({ row: claimed, token }: Claim, result: ReadResult, hostAdmitted: boolean) {
    await monitorMetricTransaction(db, async (tx, observe) => {
      // Chat publication/deletion lock the conversation first. Match that ordering when writing evidence.
      if (!await lockConversation(tx, claimed)) return;
      const row = await tx.selectFrom('smart_monitors').selectAll().where('id', '=', claimed.id)
        .where('lease_token', '=', token).forUpdate().executeTakeFirst() as MonitorRow | undefined;
      if (!row) return;
      const at = now();
      const update = tx.updateTable('smart_monitors').where('id', '=', row.id);
      if (row.status !== 'active' || !row.lease_until || new Date(row.lease_until) <= at) return;
      const expiry = new Date(row.expires_at);
      if (expiry <= at) {
        await update.set(expire).execute();
        return;
      }
      const role = await store.accountRole(row.user_id, tx);
      if (!role) {
        await update.set(clearLease).execute();
        return;
      }
      if (result.kind === 'deferred') {
        // The account paid for admission. Only spend the monitor's check budget if an earlier host was admitted.
        await update.set({ ...clearLease, checks: row.checks - Number(!hostAdmitted),
          next_check_at: new Date(Math.max(result.at, at.getTime() + MONITOR_LIMITS.pollMs)) }).execute();
        return;
      }
      if (v2 && row.spec.v2) {
        await update.set(await finishV2Check(tx, row, role, result, at, expiry, observe)).execute();
        return;
      }
      if (result.kind === 'clarify' || result.kind === 'unsafe-target') throw new Error('Unexpected v2 monitor read result.');
      const last = { ...clearLease, last_checked_at: at };
      const exhausted = row.checks >= row.spec.timing.maxChecks;
      if (result.kind === 'unreachable' || result.kind === 'missing') {
        const consecutiveFailures = row.consecutive_failures + 1;
        const failure = { failure_kind: result.kind, consecutive_failures: consecutiveFailures };
        if (consecutiveFailures >= MONITOR_LIMITS.consecutiveFailures || exhausted) {
          const notice = monitorHealth(row, result.kind, at);
          const receipt = await publishMonitorNotice(tx, row, role, notice, at, observe);
          await update.set({ ...last, ...failure, ...receipt, status: 'paused', note: notice.message,
            notifications: row.notifications + 1, next_check_at: null }).execute();
          observe({ kind: 'pause', reason: result.kind });
          return;
        }
        const { dueAt, intervalMs } = nextMonitorCheck(row.spec, at, row.interval_ms, { changed: true, expiry });
        await update.set({ ...last, ...failure, next_check_at: dueAt, interval_ms: intervalMs }).execute();
        return;
      }
      const observation = result.kind === 'value' ? result.observation : row.evaluation?.observation;
      if (!observation) throw new Error('An active monitor must have a preview.');
      const { state, changed, trigger } = evaluateMonitor(row.spec, row.evaluation ?? undefined, observation,
        { revalidated: result.kind === 'unchanged' });
      const cache = 'cache' in result ? result.cache : undefined;
      const observed = { ...last, evaluation: JSON.stringify(state),
        source_cache: cache ? JSON.stringify(cache) : result.kind === 'unchanged' ? row.source_cache : null,
        failure_kind: null, consecutive_failures: 0 };
      if (trigger) {
        const notice = monitorTrigger(row, trigger, at);
        const receipt = await publishMonitorNotice(tx, row, role, notice, at, observe);
        await update.set({ ...observed, ...receipt, status: 'completed', notifications: row.notifications + 1, next_check_at: null }).execute();
        return;
      }
      const { dueAt, intervalMs } = nextMonitorCheck(row.spec, at, row.interval_ms, { changed, expiry });
      await update.set({ ...observed, ...exhausted ? expire : { next_check_at: dueAt, interval_ms: intervalMs } }).execute();
    });
  }

  async function publishDueNotice(at: Date): Promise<boolean> {
    return monitorMetricTransaction(db, async (tx, observe) => {
      let due = tx.selectFrom('smart_monitors as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.id']).where('m.pending_notice', 'is not', null).where('m.notice_due_at', '<=', at)
        .$if(ownersOnly, query => query.where('m.user_id', 'in', monitorOwnerIds(tx)));
      if (!v2) due = due.where(sql<boolean>`m.spec->'v2' IS NULL`);
      const candidate = await due.orderBy('m.notice_due_at').orderBy('m.id').limit(1).forNoKeyUpdate('c').skipLocked().executeTakeFirst();
      if (!candidate) return false;
      const row = await tx.selectFrom('smart_monitors').selectAll().where('id', '=', candidate.id)
        .where('pending_notice', 'is not', null).where('notice_due_at', '<=', at).forUpdate().skipLocked().executeTakeFirst() as MonitorRow | undefined;
      if (!row?.pending_notice) return false;
      const role = await store.accountRole(row.user_id, tx);
      const receipt = role ? await publishMonitorNotice(tx, row, role, row.pending_notice, at, observe)
        : { notice_due_at: new Date(at.getTime() + MONITOR_LIMITS.maxIntervalMs) };
      await tx.updateTable('smart_monitors').set(receipt).where('id', '=', row.id).execute();
      return true;
    });
  }

  async function publishDueDigest(at: Date): Promise<boolean> {
    return monitorMetricTransaction(db, async (tx, observe) => {
      const candidate = await tx.selectFrom('smart_monitors as m').innerJoin('chat_conversations as c', 'c.id', 'm.conversation_id')
        .select(['m.id']).where('m.v2_digest_due_at', '<=', at)
        .$if(ownersOnly, query => query.where('m.user_id', 'in', monitorOwnerIds(tx)))
        .orderBy('m.v2_digest_due_at').orderBy('m.id')
        .limit(1).forNoKeyUpdate('c').skipLocked().executeTakeFirst();
      if (!candidate) return false;
      const row = await tx.selectFrom('smart_monitors').selectAll().where('id', '=', candidate.id)
        .where('v2_digest_due_at', '<=', at).forUpdate().skipLocked().executeTakeFirst() as MonitorRow | undefined;
      if (!row) return false;
      const update = tx.updateTable('smart_monitors').where('id', '=', row.id);
      const state = row.v2_state;
      if (!state || row.status === 'stopped' || row.notifications >= row.spec.timing.maxNotifications) {
        await update.set({ v2_digest_due_at: null }).execute();
        return true;
      }
      const role = await store.accountRole(row.user_id, tx);
      if (!role || row.pending_notice) {
        const retry = row.notice_due_at ? Math.max(at.getTime() + MONITOR_LIMITS.pollMs, new Date(row.notice_due_at).getTime())
          : nextMonitorBudgetDay(at).getTime();
        await update.set({ v2_digest_due_at: new Date(retry) }).execute();
        return true;
      }
      const result = evaluateMonitorV2(row.spec, state.evaluation, [], at);
      state.evaluation = result.state;
      const receipt = result.notice && await publishMonitorNotice(tx, row, role, monitorV2Trigger(row, result.notice, at), at, observe);
      const notifications = row.notifications + Number(Boolean(receipt));
      const exhausted = notifications >= row.spec.timing.maxNotifications;
      await update.set({ ...receipt, notifications, v2_state: JSON.stringify(state),
        v2_digest_due_at: exhausted ? null : monitorV2DigestDueAt(row.spec, state.evaluation) ?? null,
        ...(exhausted && row.status === 'active' && { status: 'completed', next_check_at: null }),
      }).execute();
      return true;
    });
  }

  async function cleanExpired(at: Date) {
    const pendingExpiry = db.selectFrom('smart_monitors').select('id').where('status', 'in', ['proposed', 'active', 'paused'])
      .$if(ownersOnly, query => query.where('user_id', 'in', monitorOwnerIds(db)))
      .where('expires_at', '<=', at).orderBy('expires_at').limit(MONITOR_LIMITS.workPerPoll).forUpdate().skipLocked();
    await db.updateTable('smart_monitors').set(expire).where('id', 'in', pendingExpiry).execute();
    const staleHosts = db.selectFrom('smart_monitor_hosts').select('host_key').where('eligible_at', '<=', at)
      .orderBy('eligible_at').limit(MONITOR_LIMITS.workPerPoll).forUpdate().skipLocked();
    await db.deleteFrom('smart_monitor_hosts').where('host_key', 'in', staleHosts).execute();
  }

  async function poll(shutdown: AbortSignal) {
    await cleanExpired(now());
    for (let i = 0; i < MONITOR_LIMITS.workPerPoll && !shutdown.aborted; i++) {
      if (!await publishDueNotice(now())) break;
    }
    if (v2) {
      for (let i = 0; i < MONITOR_LIMITS.workPerPoll && !shutdown.aborted; i++) {
        if (!await publishDueDigest(now())) break;
      }
    }
    let claims = 0;
    const worker = async () => {
      while (!shutdown.aborted && claims < MONITOR_LIMITS.workPerPoll) {
        claims++;
        const checked = await claim();
        if (!checked) return;
        if (checked === 'deferred') continue;
        const signal = AbortSignal.any([shutdown, AbortSignal.timeout(MONITOR_LIMITS.readTimeoutMs)]);
        let result: ReadResult;
        let hostAdmitted = false;
        const reserveHost = async (host: string) => {
          const retryAt = await store.reserveHost(host);
          hostAdmitted ||= retryAt === null;
          return retryAt;
        };
        const startedAt = now().getTime();
        try {
          const state = v2 && checked.row.spec.v2 ? v2ReadState(checked.row) : undefined;
          result = await withinSignal(signal, () => ports.read(state ? monitorSourceSpec(checked.row.spec, state.cursor) : checked.row.spec,
            { ownerId: checked.row.user_id, signal, ...(state && { v2: true }),
              cache: (state ? state.caches[state.cursor] : checked.row.source_cache) ?? undefined, reserveHost, extendHost: store.extendHost,
            }));
        } catch {
          result = { kind: 'unreachable' };
        }
        if (shutdown.aborted) continue;
        observeMonitorCheck(db, checked.row.next_check_at, startedAt, result.kind);
        await finish(checked, result, hostAdmitted);
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: MONITOR_LIMITS.concurrentReads }, worker));
    for (const result of workers) if (result.status === 'rejected') throw result.reason;
  }

  function runOnce() {
    if (controller.signal.aborted) return Promise.resolve();
    running ??= poll(controller.signal).finally(() => { running = undefined; });
    return running;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      controller = new AbortController();
      const tick = () => { if (!running) void runOnce().catch(onError); };
      timer = setInterval(tick, MONITOR_LIMITS.pollMs);
      timer.unref();
      tick();
    },
    async stop() {
      controller.abort();
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => {});
    },
  };
}
