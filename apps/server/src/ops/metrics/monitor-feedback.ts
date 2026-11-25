import type { MonitorAlertFeedbackMetrics, MonitorMetricWindow } from '@mohassan/contracts';
import { sql, type Kysely } from 'kysely';

type FeedbackWindow = Pick<MonitorMetricWindow, 'startMs' | 'endMs'>;
type FeedbackCounts = Record<'total' | 'helpful' | 'not_helpful' | 'no_meaningful_change' | 'late' | 'wrong_value', string | number | bigint>;

/** Aggregate the current answer to each alert within its publication cohort. */
export async function readMonitorFeedbackMetrics(db: Kysely<any>, windows: FeedbackWindow[]) {
  const bounds = sql.join(windows.map(({ startMs, endMs }, index) =>
    sql`(${index}::integer, ${new Date(startMs)}::timestamptz, ${new Date(endMs)}::timestamptz)`));
  const { rows } = await sql<FeedbackCounts>`
    WITH bounds (window_number, start_at, end_at) AS (VALUES ${bounds})
    SELECT count(n.task_id) AS total,
      count(*) FILTER (WHERE f.rating = 'helpful') AS helpful,
      count(*) FILTER (WHERE f.rating = 'not_helpful') AS not_helpful,
      count(*) FILTER (WHERE f.reason = 'no_meaningful_change') AS no_meaningful_change,
      count(*) FILTER (WHERE f.reason = 'late') AS late,
      count(*) FILTER (WHERE f.reason = 'wrong_value') AS wrong_value
    FROM bounds b
    LEFT JOIN chat_notifications n ON n.monitor_id IS NOT NULL AND n.happened_at >= b.start_at AND n.happened_at < b.end_at
    LEFT JOIN monitor_alert_feedback f ON f.alert_id = n.task_id AND f.user_id = n.user_id
    GROUP BY b.window_number ORDER BY b.window_number`.execute(db);

  return rows.map(row => {
    const total = Number(row.total);
    const helpful = Number(row.helpful);
    const notHelpful = Number(row.not_helpful);
    return {
      total, helpful, notHelpful, unrated: total - helpful - notHelpful,
      reasons: { no_meaningful_change: Number(row.no_meaningful_change), late: Number(row.late), wrong_value: Number(row.wrong_value) },
    } satisfies MonitorAlertFeedbackMetrics;
  });
}
