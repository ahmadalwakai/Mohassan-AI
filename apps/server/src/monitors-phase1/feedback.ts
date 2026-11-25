import {
  MonitorAlertFeedbackSchema, MonitorAlertFeedbackStateSchema,
  type MonitorAlert, type MonitorAlertFeedback, type MonitorCard,
} from '@mohassan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { monitorPaths } from '../monitors/route-keys.js';

type FeedbackRow = {
  rating: MonitorAlertFeedback['rating'];
  reason: MonitorAlertFeedback['reason'] | null;
  updated_at: Date;
};

function feedbackState({ rating, reason, updated_at }: FeedbackRow) {
  return MonitorAlertFeedbackStateSchema.parse({ rating, ...(reason && { reason }), updatedAt: new Date(updated_at).toISOString() });
}

async function saveFeedback(db: Kysely<any>, userId: string, alertId: string, input: MonitorAlertFeedback) {
  const result = await sql<FeedbackRow>`
    INSERT INTO monitor_alert_feedback (user_id, alert_id, rating, reason)
    SELECT n.user_id, n.task_id, ${input.rating}, ${input.reason ?? null}
    FROM chat_notifications n JOIN smart_monitors m
      ON m.id = n.monitor_id AND m.user_id = n.user_id AND m.conversation_id = n.conversation_id
    WHERE n.user_id = ${userId} AND n.task_id = ${alertId}
    ON CONFLICT (user_id, alert_id) DO UPDATE SET
      rating = excluded.rating, reason = excluded.reason, updated_at = clock_timestamp()
    RETURNING rating, reason, updated_at`.execute(db);
  const saved = result.rows[0];
  if (!saved) throw Object.assign(new Error('لم يتم العثور على تنبيه المراقبة.'), { statusCode: 404, code: 'MONITOR_ALERT_NOT_FOUND' });
  return feedbackState(saved);
}

export function registerMonitorAlertFeedbackRoute(app: FastifyInstance, db: Kysely<any>,
  owner: (request: FastifyRequest) => Promise<{ id: string }>,
  options: { onRequest: (request: FastifyRequest) => Promise<void>; config: { rateLimit: { max: number; timeWindow: string } } }) {
  app.post<{ Params: { alertId: string } }>(monitorPaths.feedback, options, async request => {
    const { id } = await owner(request);
    return saveFeedback(db, id, z.uuid().parse(request.params.alertId), MonitorAlertFeedbackSchema.parse(request.body));
  });
}

async function listAlerts(db: Kysely<any>, userId: string, filter: { conversationId: string } | { monitorIds: string[] }) {
  let query = db.selectFrom('chat_notifications as n')
    .leftJoin('monitor_alert_feedback as f', join => join.onRef('f.user_id', '=', 'n.user_id').onRef('f.alert_id', '=', 'n.task_id'))
    .select(['n.monitor_id', 'n.task_id', 'n.happened_at', 'f.rating', 'f.reason', 'f.updated_at'])
    .where('n.user_id', '=', userId).where('n.monitor_id', 'is not', null);
  if ('conversationId' in filter) query = query.where('n.conversation_id', '=', filter.conversationId);
  else if (filter.monitorIds.length) query = query.where('n.monitor_id', 'in', filter.monitorIds);
  else return [];
  const rows = await query.orderBy('n.happened_at').orderBy('n.task_id').execute();
  return rows.map(row => {
    const alert: MonitorAlert = { id: row.task_id, happenedAt: new Date(row.happened_at).toISOString(),
      ...(row.rating && { feedback: feedbackState({ rating: row.rating, reason: row.reason, updated_at: row.updated_at }) }) };
    return { monitorId: row.monitor_id as string, alert };
  });
}

export async function conversationMonitorAlerts(db: Kysely<any>, userId: string, conversationId: string) {
  return listAlerts(db, userId, { conversationId });
}

export function addMonitorCardAlerts(cards: MonitorCard[], rows: Awaited<ReturnType<typeof listAlerts>>) {
  const byMonitor = new Map<string, MonitorAlert[]>();
  for (const { monitorId, alert } of rows) {
    const list = byMonitor.get(monitorId) ?? [];
    list.push(alert);
    byMonitor.set(monitorId, list);
  }
  return cards.map(card => {
    const alerts = byMonitor.get(card.id);
    return alerts ? { ...card, alerts } : card;
  });
}

export async function withMonitorCardAlerts(db: Kysely<any>, userId: string, cards: MonitorCard[]) {
  return addMonitorCardAlerts(cards, await listAlerts(db, userId, { monitorIds: cards.map(card => card.id) }));
}
