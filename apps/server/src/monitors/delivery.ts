import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { WorkspaceRole } from '../members.js';
import { recordBackgroundRunOutcome } from '../notifications-store.js';
import type { MonitorMetricEvent } from '../ops/metrics/monitor-events.js';
import type { MonitorObservation } from './evaluation.js';
import { nextMonitorBudgetDay } from './schedule.js';
import { spendMonitorBudget, type MonitorNotice, type MonitorRow } from './store.js';

const escapeMarkdown = (text: string) => text.replace(/[\\[\]<>*_#`!|]/gu, '\\$&');
const say = (row: MonitorRow, en: string, ar: string) => row.spec.language === 'ar' ? ar : en;

function noticeId(row: MonitorRow) {
  const key = createHash('sha256').update(`${row.id}/monitor-notification/${row.notifications}`).digest('hex');
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

export function monitorTrigger(row: MonitorRow, observation: MonitorObservation, at: Date): MonitorNotice {
  const evidence = escapeMarkdown(observation.excerpt.replace(/\s+/gu, ' ').trim());
  const source = observation.url && /^https:\/\/[^\s<>]+$/u.test(observation.url)
    ? `\n\n[${say(row, 'Public source', 'المصدر العام')}](<${observation.url}>)` : '';
  const message = `${escapeMarkdown(row.spec.message)}\n\n${say(row, 'Observed', 'القيمة المرصودة')}: ${evidence}${source}`;
  return { eventId: noticeId(row), outcome: 'completed', message, happenedAt: at.toISOString() };
}

export function monitorHealth(row: MonitorRow, failure: 'unreachable' | 'missing', at: Date): MonitorNotice {
  const detail = failure === 'missing'
    ? say(row, 'I lost track of the watched part. It disappeared from the source.', 'فقدتُ أثر الجزء المُراقَب. لم أعد أجده في المصدر.')
    : say(row, 'The source repeatedly failed to respond.', 'تعذّر الوصول إلى المصدر في عدة محاولات.');
  const message = `${say(row, 'Monitor paused', 'توقفت المراقبة مؤقتًا')} — ${escapeMarkdown(row.spec.title)}\n\n${detail}`;
  return { eventId: noticeId(row), outcome: 'approval', message, happenedAt: at.toISOString() };
}

/** Commit the conversation evidence and PR #92 outbox together or keep the receipt for the next budget day. */
export async function publishMonitorNotice(tx: Kysely<any>, row: MonitorRow, role: WorkspaceRole, notice: MonitorNotice, at: Date,
  observe: (event: MonitorMetricEvent) => void) {
  if (!await spendMonitorBudget(tx, row.user_id, role, 'notifications', at)) {
    return { pending_notice: JSON.stringify(notice), notice_due_at: nextMonitorBudgetDay(at) };
  }
  const message = await tx.insertInto('chat_messages').values({ id: notice.eventId, conversation_id: row.conversation_id,
    role: 'assistant', text: notice.message, created_at: at }).onConflict(conflict => conflict.column('id').doNothing()).returning('id').executeTakeFirst();
  if (message) observe({ kind: 'delivery', channel: 'conversation' });
  await tx.updateTable('chat_conversations').set({ updated_at: sql`greatest(updated_at, ${at}::timestamptz)` })
    .where('id', '=', row.conversation_id).where('owner_id', '=', row.user_id).execute();
  await recordBackgroundRunOutcome(tx, { runId: notice.eventId, monitorId: row.id, userId: row.user_id,
    conversationId: row.conversation_id, startedAt: new Date(row.approved_at ?? row.created_at), outcome: notice.outcome,
    language: row.spec.language, preview: notice.message.split('\n\n').at(1) }, at);
  return { pending_notice: null, notice_due_at: null };
}
