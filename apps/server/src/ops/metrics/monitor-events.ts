import type { MonitorDeliveryChannel, MonitorPauseReason } from '@mohassan/contracts';
import type { Kysely, Transaction } from 'kysely';

export type MonitorMetricEvent =
  | { kind: 'check'; latenessMs: number; succeeded: boolean }
  | { kind: 'delivery'; channel: MonitorDeliveryChannel }
  | { kind: 'pause'; reason: MonitorPauseReason };

type Observe = (event: MonitorMetricEvent) => void;
const observers = new WeakMap<Kysely<any>, Observe>();
const ignore: Observe = () => {};

export function registerMonitorMetrics(db: Kysely<any>, observe: Observe) {
  observers.set(db, event => {
    try { observe(event); } catch { /* Metrics must leave application behavior intact. */ }
  });
  return () => observers.delete(db);
}

export function observeMonitorCheck(db: Kysely<any>, dueAt: Date | null, startedAt: number,
  result: 'value' | 'unchanged' | 'missing' | 'unreachable' | 'deferred') {
  const observe = observers.get(db);
  if (!observe || !dueAt || result === 'deferred') return;
  observe({ kind: 'check', latenessMs: Math.max(0, startedAt - new Date(dueAt).getTime()),
    succeeded: result === 'value' || result === 'unchanged' });
}

/** Only count effects of committed mutations, including after retries. */
export async function monitorMetricTransaction<DB, Result>(db: Kysely<DB>,
  mutate: (tx: Transaction<DB>, observe: Observe) => Promise<Result>): Promise<Result> {
  const observe = observers.get(db);
  if (!observe) return db.transaction().execute(tx => mutate(tx, ignore));
  const committed: MonitorMetricEvent[] = [];
  const result = await db.transaction().execute(tx => mutate(tx, event => { committed.push(event); }));
  committed.forEach(observe);
  return result;
}
