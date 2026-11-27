import type { MemberCouncilMetrics } from '@mohassan/contracts';
import type { FastifyInstance } from 'fastify';

/** Each attempt contributes to one process-wide bucket. The recorder accepts no turn data. */
export function createMemberCouncilMetrics() {
  const counts: MemberCouncilMetrics = { completed: 0, changed: 0, skippedLoad: 0, skippedDeadline: 0, failed: 0 };
  return {
    record(outcome: keyof MemberCouncilMetrics) { counts[outcome]++; },
    snapshot: (): MemberCouncilMetrics => ({ ...counts }),
  };
}

const metricsByApp = new WeakMap<FastifyInstance, ReturnType<typeof createMemberCouncilMetrics>>();

export function attachMemberCouncilMetrics(app: FastifyInstance, metrics: ReturnType<typeof createMemberCouncilMetrics>): void {
  metricsByApp.set(app, metrics);
}

export function readMemberCouncilMetrics(app: FastifyInstance): MemberCouncilMetrics | undefined {
  return metricsByApp.get(app)?.snapshot();
}
