import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseHandle } from '@mohassan/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeMonitorExclusionText } from '../apps/server/src/monitors/decision/exclusion.js';
import { monitorDecisionFeatures, monitorProposalDecisionSnapshot } from '../apps/server/src/monitors/decision/features.js';
import { buildMonitorContextFrame } from '../apps/server/src/monitors/decision/frame.js';
import { MONITOR_DECISION_MIGRATION } from '../apps/server/src/monitors/decision/migration.js';
import { reasonMonitorContext } from '../apps/server/src/monitors/decision/reasoner.js';
import {
  monitorRecordingSetting, readPriorMonitorDecisions, recordMonitorAlertFeedback, setMonitorRecordingSetting,
} from '../apps/server/src/monitors/decision/records.js';
import { migrateMonitors } from '../apps/server/src/monitors/migration.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';
import { createMonitorRecordingFixture, monitorRecordingFixtureSpec } from '../scripts/monitor-decision/check-recording.js';
import { writeMonitorDecisionExport } from '../scripts/monitor-decision/export.js';

const owner = 'monitor-decision-owner';
const member = 'monitor-decision-member';
const url = 'https://monitor.example.test/private-identifier';

describe('monitor decision recording', () => {
  let database: DatabaseHandle;
  let directory: string;
  let store: ReturnType<typeof createMonitorStore>;
  let clock = Date.UTC(2026, 10, 25, 9);
  const now = () => new Date(clock++);
  const rows = (userId: string) => database.db.selectFrom('smart_monitor_decisions').selectAll().where('user_id', '=', userId)
    .orderBy('happened_at').execute();
  async function propose(userId: string) {
    const conversationId = randomUUID();
    await database.db.insertInto('chat_conversations').values({ id: conversationId, owner_id: userId, title: 'Private title', created_at: now(), updated_at: now() }).execute();
    const frame = buildMonitorContextFrame({ text: `Notify me when registration opens at ${url}`, now: now() });
    const decisionFeatures = monitorProposalDecisionSnapshot(frame, reasonMonitorContext(frame), 'propose');
    expect(decisionFeatures).toBeDefined();
    return store.propose(userId, { conversationId, spec: monitorRecordingFixtureSpec(now(), 'en', url), decisionFeatures,
      observation: { value: 'closed', excerpt: 'Private excerpt', url, observedAt: now().toISOString() }, offer: 'explicit' });
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-decision-fixture-'));
    database = await createMonitorRecordingFixture();
    await migrateMonitors(database.db);
    store = createMonitorStore(database.db, { now, v2: true });
    await database.db.insertInto('user').values([owner, member].map(userId => ({ id: userId, name: 'Fixture', email: `${userId}@example.test` }))).execute();
    await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();
    await database.db.insertInto('workspace_members').values({ user_id: member, role: 'member' }).execute();
  });

  afterAll(async () => {
    await database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('records the owner proposal and its approval, a genuine alert rating, and a separate decline', async () => {
    const { db } = database;
    expect(await db.selectFrom('schema_migrations').select('version').where('version', '=', MONITOR_DECISION_MIGRATION).execute()).toHaveLength(1);
    const approved = await propose(owner);
    await store.approve(owner, approved.id);
    await store.approve(owner, approved.id);
    const notice = randomUUID();
    await recordBackgroundRunOutcome(db, { conversationId: approved.conversationId, runId: notice, userId: owner,
      monitorId: approved.id, startedAt: now(), outcome: 'completed', language: 'en' }, now());
    const rate = (userId: string, helpful: boolean, conversationId?: string) => db.transaction().execute(tx =>
      recordMonitorAlertFeedback(tx, userId, notice, helpful, { at: now(), conversationId }));
    expect(await rate(member, true)).toBe(false);
    expect(await rate(owner, true, randomUUID())).toBe(false);
    expect(await rate(owner, true)).toBe(true);
    expect(await rate(owner, false)).toBe(true);
    expect(await rate(owner, false)).toBe(true);
    const declined = await propose(owner);
    await store.change(owner, declined.id, 'stop');
    await store.change(owner, declined.id, 'stop');
    const decisions = await rows(owner);
    expect(decisions.map(row => row.decision)).toEqual(['proposal', 'approved', 'alert_unhelpful', 'proposal', 'declined']);
    expect(decisions.filter(row => row.features !== null)).toHaveLength(2);
    expect(JSON.stringify(decisions)).not.toContain(url);
    expect(await readPriorMonitorDecisions(db, owner, declined.conversationId)).toEqual([{ decision: 'declined', sourceUrl: url, topic: 'Registration' }]);
    expect(await readPriorMonitorDecisions(db, member, declined.conversationId)).toEqual([]);

    const output = join(directory, 'decisions.jsonl');
    await expect(writeMonitorDecisionExport(db, member, output, 'pipeline-check')).rejects.toThrow('primary owner');
    const manifest = await writeMonitorDecisionExport(db, owner, output, 'pipeline-check');
    expect(manifest).toMatchObject({ rows: 3, source: 'pipeline-check' });
    const content = await readFile(output, 'utf8');
    expect(content).not.toMatch(/private-identifier|private title|private excerpt|monitor-decision-owner/iu);
    expect(content.split('\n').filter(Boolean).map(line => JSON.parse(line).decision)).toEqual(['approved', 'alert_unhelpful', 'declined']);
    await expect(writeMonitorDecisionExport(db, owner, output, 'pipeline-check')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe(content);
  });

  it('requires explicit member consent, removes records after withdrawal and cascades on data deletion', async () => {
    const { db } = database;
    const ownerRecords = (await rows(owner)).length;
    expect(await monitorRecordingSetting(db, owner)).toEqual({ included: true, canChange: false });
    expect(await monitorRecordingSetting(db, member)).toEqual({ included: false, canChange: true });
    const unrecorded = await propose(member);
    await store.change(member, unrecorded.id, 'stop');
    expect(await rows(member)).toEqual([]);

    await setMonitorRecordingSetting(db, member, true);
    const approved = await propose(member);
    await store.approve(member, approved.id);
    await store.change(member, approved.id, 'stop');
    expect((await rows(member)).map(row => row.decision)).toEqual(['proposal', 'approved', 'stopped_early']);
    await setMonitorRecordingSetting(db, member, false);
    expect(await rows(member)).toEqual([]);

    await setMonitorRecordingSetting(db, member, true);
    const pending = await propose(member);
    await store.change(member, pending.id, 'stop');
    expect(await rows(member)).toHaveLength(2);
    await db.deleteFrom('user').where('id', '=', member).execute();
    expect(await rows(member)).toEqual([]);
    expect(await rows(owner)).toHaveLength(ownerRecords);
  });

  it('normalizes bilingual exclusion text and hashes scrubbed current and prior assistant turns', () => {
    expect(normalizeMonitorExclusionText('   تَسْجِيل ﻣِـصْرَ ٢٠٢٦\tStraße  '))
      .toBe(normalizeMonitorExclusionText('تسجيل مصر 2026 STRASSE'));
    const first = buildMonitorContextFrame({ text: `Watch ${url} next week.`, history: [{ role: 'assistant', text: 'Contact member1@example.test.' }] });
    const second = buildMonitorContextFrame({ text: 'Watch https://other.example.test/token next week.',
      history: [{ role: 'assistant', text: 'Contact member2@example.test.' }] });
    const third = buildMonitorContextFrame({ text: first.current.text, history: [{ role: 'assistant', text: 'The page has closed.' }] });
    expect(monitorDecisionFeatures(first).textFeatureIds).toEqual(monitorDecisionFeatures(second).textFeatureIds);
    expect(monitorDecisionFeatures(first).textFeatureIds).not.toEqual(monitorDecisionFeatures(third).textFeatureIds);
  });
});
