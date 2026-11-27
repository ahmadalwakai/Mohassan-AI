import { sql } from 'kysely';

const secondsPerHour = 60 * 60;

export type BackgroundDeliveryClock = Date | (() => Date);

export function backgroundDeliveryTime(clock: BackgroundDeliveryClock) {
  return typeof clock === 'function' ? clock() : clock;
}

export function backgroundDeliveryExpired(now: Date, lifetimeHours: number) {
  return sql<boolean>`(EXTRACT(EPOCH FROM (${now}::timestamptz - n.happened_at)) >= ${lifetimeHours}::numeric * ${secondsPerHour})`;
}

export function backgroundDeliveryDeadlineReached(happenedAt: Date, now: Date, lifetimeHours: number) {
  return now.getTime() - happenedAt.getTime() >= lifetimeHours * secondsPerHour * 1000;
}
