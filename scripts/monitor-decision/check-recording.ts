import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { MonitorSpec } from '@mohassan/contracts';
import { createDatabase, migrate } from '@mohassan/database';
import { migrateAuth } from '../../apps/server/src/auth.js';
import { migrateBackgroundResults } from '../../apps/server/src/background-results-migration.js';
import { commandChatMigration } from '../../apps/server/src/command-chat.js';
import { migrateMemberDataRights } from '../../apps/server/src/member-data-migration.js';
import { migrateMembers } from '../../apps/server/src/members.js';
import { saveMonitorAlertFeedback } from '../../apps/server/src/monitors-phase1/feedback.js';
import { monitorProposalDecisionSnapshot } from '../../apps/server/src/monitors/decision/features.js';
import { buildMonitorContextFrame } from '../../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../../apps/server/src/monitors/decision/reasoner.js';
import { migrateMonitors } from '../../apps/server/src/monitors/migration.js';
import { monitorTiming } from '../../apps/server/src/monitors/schedule.js';
import { createMonitorStore } from '../../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../../apps/server/src/notifications-store.js';
import { migrateRemindersInTransaction } from '../../apps/server/src/reminders/migration.js';
import { writeMonitorDecisionExport } from './export.js';

const owner = 'monitor-pipeline-check-owner';
const baseline = Date.UTC(2026, 10, 25, 9);
const week = 7 * 24 * 60 * 60 * 1_000;
const checkDecisions = ['approved', 'declined', 'stopped_early', 'alert_helpful', 'alert_unhelpful'] as const;

export async function createMonitorRecordingFixture() {
  const database = await createDatabase();
  try {
    await migrateAuth(database.db);
    await migrateMembers(database.db);
    await migrate(database.db);
    await commandChatMigration(database.db, migrateRemindersInTransaction);
    await migrateMemberDataRights(database.db);
    await migrateBackgroundResults(database.db);
    await migrateMonitors(database.db);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export function monitorRecordingFixtureSpec(now: Date, language: MonitorSpec['language'], url: string): MonitorSpec {
  return {
    language, source: { kind: 'page', url }, timing: monitorTiming('page', 'normal', { now }),
    read: { kind: 'status', label: 'registration' }, condition: { kind: 'equals', value: 'open' },
    title: 'Registration', message: 'Registration opened.',
  };
}

async function checkRecording(output: string) {
  const database = await createMonitorRecordingFixture();
  const { db } = database;
  try {
    await db.insertInto('user').values({ id: owner, name: 'Pipeline check owner', email: 'monitor-pipeline@example.test' }).execute();
    await db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();
    let clock = baseline;
    const now = () => new Date(clock);
    const store = createMonitorStore(db, { now, v2: true });
    for (let index = 0; index < 30; index++) {
      // The clock separates proposal groups. The generated labels are only a pipeline check.
      clock = baseline + index * (week + 1_000);
      const language = index % 2 === 0 ? 'ar' : 'en';
      const monitorDecision = index % 4 < 2 ? 'propose' : 'offer';
      const decision = checkDecisions[index % checkDecisions.length]!;
      const url = `https://monitor.example.test/registration/${index}`;
      const conversationId = randomUUID();
      await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: owner, title: 'Pipeline check', created_at: now(), updated_at: now() }).execute();
      const text = language === 'ar' ? `نبّهني عندما يفتح التسجيل في ${url}` : `Notify me when registration opens at ${url}`;
      const frame = buildMonitorContextFrame({ text, now: now() });
      const decisionFeatures = monitorProposalDecisionSnapshot(frame, reasonMonitorContext(frame), monitorDecision);
      if (!decisionFeatures) throw new Error('The pipeline-check proposal did not pass the recording guard.');
      const monitor = await store.propose(owner, { conversationId, spec: monitorRecordingFixtureSpec(now(), language, url),
        observation: { value: 'closed', excerpt: 'Registration closed.', url, observedAt: now().toISOString() }, decisionFeatures,
        offer: monitorDecision === 'offer' ? 'agent-initiated' : 'explicit' });
      clock += 1;
      if (decision === 'declined') {
        await store.change(owner, monitor.id, 'stop');
        continue;
      }
      await store.approve(owner, monitor.id);
      clock += 1;
      if (decision === 'stopped_early') {
        await store.change(owner, monitor.id, 'stop');
      } else if (decision === 'alert_helpful' || decision === 'alert_unhelpful') {
        const notice = randomUUID();
        await recordBackgroundRunOutcome(db, { runId: notice, userId: owner, conversationId,
          startedAt: now(), outcome: 'completed', language, monitorId: monitor.id }, now());
        await saveMonitorAlertFeedback(db, owner, notice, { rating: decision === 'alert_helpful' ? 'helpful' : 'not_helpful' }, now());
      }
    }
    console.log(JSON.stringify(await writeMonitorDecisionExport(db, owner, output, 'pipeline-check')));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) throw new Error('--out is required.');
  await checkRecording(resolve(values.out));
}
