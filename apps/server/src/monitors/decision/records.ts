import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { assertMemberFeatureAccess, memberReminderDeliveryAllowed } from '../../member-deletion.js';
import { roleOf } from '../../members.js';
import { smartMonitorsV2Enabled } from '../flag.js';
import { MONITOR_LIMITS } from '../schedule.js';
import type { MonitorRow } from '../store.js';
import { MonitorDecisionSnapshotSchema, type MonitorDecisionSnapshot } from './features.js';

type Target = Pick<MonitorRow, 'id' | 'user_id'>;
type ProposalDecision = 'approved' | 'declined' | 'stopped_early';
type AlertDecision = 'alert_helpful' | 'alert_unhelpful';

async function primaryOwner(tx: Kysely<any>, userId: string) {
  return Boolean(await tx.selectFrom('workspace_owner').select('id').where('id', '=', 1).where('owner_id', '=', userId).executeTakeFirst());
}

async function recordingPreference(tx: Kysely<any>, userId: string, lock = false) {
  const query = tx.selectFrom('smart_monitor_v2_preferences').select('decision_recording').where('user_id', '=', userId);
  return Boolean((await (lock ? query.forShare() : query).executeTakeFirst())?.decision_recording);
}

async function mayRecord(tx: Kysely<any>, userId: string) {
  return await primaryOwner(tx, userId) || await recordingPreference(tx, userId, true);
}

export async function monitorRecordingSetting(db: Kysely<any>, userId: string) {
  const canChange = await roleOf(db, userId) === 'member';
  return { included: canChange ? await recordingPreference(db, userId) : await primaryOwner(db, userId), canChange };
}

export function setMonitorRecordingSetting(db: Kysely<any>, userId: string, included: boolean) {
  return db.transaction().execute(async tx => {
    await assertMemberFeatureAccess(tx, userId);
    if (await roleOf(tx, userId) !== 'member') {
      throw Object.assign(new Error('هذا الإعداد متاح للأعضاء.'), { code: 'MONITOR_RECORDING_FORBIDDEN', statusCode: 403 });
    }
    // The existing control defaults proactive offers to true when a preference row is missing.
    await tx.insertInto('smart_monitor_v2_preferences').values({ user_id: userId, proactive_offers: true, decision_recording: included })
      .onConflict(conflict => conflict.column('user_id').doUpdateSet({ decision_recording: included })).execute();
    if (!included) await tx.deleteFrom('smart_monitor_decisions').where('user_id', '=', userId).execute();
    return { included, canChange: true };
  });
}

/** The proposal stores the input known at decision time. Outcomes never rewrite it. */
export async function captureMonitorProposal(tx: Kysely<any>, row: Target, features: MonitorDecisionSnapshot, at: Date) {
  const parsed = MonitorDecisionSnapshotSchema.safeParse(features);
  if (!parsed.success || !await mayRecord(tx, row.user_id)) return;
  await tx.insertInto('smart_monitor_decisions').values({
    user_id: row.user_id, monitor_id: row.id, event_key: 'proposal', decision: 'proposal', features: JSON.stringify(parsed.data), happened_at: at,
  }).onConflict(conflict => conflict.columns(['monitor_id', 'event_key']).doNothing()).execute();
}

async function recordDecision(tx: Kysely<any>, row: Target, decision: ProposalDecision | AlertDecision, key: string, at: Date) {
  const proposal = await tx.selectFrom('smart_monitor_decisions').select('event_key').where('monitor_id', '=', row.id)
    .where('user_id', '=', row.user_id).where('event_key', '=', 'proposal').executeTakeFirst();
  if (!proposal || !await mayRecord(tx, row.user_id)) return false;
  await tx.insertInto('smart_monitor_decisions').values({
    user_id: row.user_id, monitor_id: row.id, event_key: key, decision, happened_at: at,
  }).onConflict(conflict => conflict.columns(['monitor_id', 'event_key']).doUpdateSet({ decision, happened_at: at })
    .where('smart_monitor_decisions.decision', '!=', decision)).execute();
  return true;
}

export async function recordMonitorProposalDecision(tx: Kysely<any>, row: Target, decision: ProposalDecision, at: Date) {
  await recordDecision(tx, row, decision, decision, at);
}

/** A recorded answer must be attached to an actual, successful alert in this account. */
export async function recordMonitorAlertFeedback(tx: Kysely<any>, userId: string, noticeId: string, helpful: boolean,
  options: { conversationId?: string; at?: Date } = {}) {
  let query = tx.selectFrom('chat_notifications').select('monitor_id')
    .where('task_id', '=', noticeId).where('user_id', '=', userId).where('monitor_id', 'is not', null)
    .where('background_outcome', '=', 'completed');
  if (options.conversationId) query = query.where('conversation_id', '=', options.conversationId);
  const notice = await query.executeTakeFirst();
  if (!notice || !await memberReminderDeliveryAllowed(tx, userId) || !await roleOf(tx, userId)) return false;
  return recordDecision(tx, { id: notice.monitor_id as string, user_id: userId }, helpful ? 'alert_helpful' : 'alert_unhelpful',
    `alert:${noticeId}`, options.at ?? new Date());
}

export async function recordMonitorChatFeedback(tx: Kysely<any>, userId: string, conversationId: string, input: {
  messageId: string; verdict: 'useful' | 'wrong' | 'incomplete';
}) {
  if (smartMonitorsV2Enabled()) await recordMonitorAlertFeedback(tx, userId, input.messageId, input.verdict === 'useful', { conversationId });
}

export async function readPriorMonitorDecisions(db: Kysely<any>, userId: string, conversationId: string) {
  const rows = await db.selectFrom('smart_monitors').select(['approved_at', 'spec']).where('user_id', '=', userId)
    .where('conversation_id', '=', conversationId).where(sql<boolean>`(approved_at IS NOT NULL OR status = 'stopped')`)
    .orderBy('created_at', 'desc').orderBy('id').limit(MONITOR_LIMITS.listLimit).execute() as Pick<MonitorRow, 'approved_at' | 'spec'>[];
  return rows.map(({ approved_at, spec }) => ({
    decision: approved_at ? 'accepted' as const : 'declined' as const,
    topic: spec.title, ...(spec.source.kind === 'page' && { sourceUrl: spec.source.url }),
  }));
}
