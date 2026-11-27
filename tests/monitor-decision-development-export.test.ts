import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { saveMonitorAlertFeedback } from '../apps/server/src/monitors-phase1/feedback.js';
import { MONITOR_EXCLUSION_SHA256 } from '../apps/server/src/monitors/decision/exclusion.js';
import { monitorProposalDecisionSnapshot } from '../apps/server/src/monitors/decision/features.js';
import { buildMonitorContextFrame } from '../apps/server/src/monitors/decision/frame.js';
import { reasonMonitorContext } from '../apps/server/src/monitors/decision/reasoner.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';
import { createMonitorRecordingFixture, monitorRecordingFixtureSpec } from '../scripts/monitor-decision/check-recording.js';
import { parseDevelopmentExportWindow, writeDevelopmentDecisionExport } from '../scripts/monitor-decision/export-development.js';

const owner = 'monitor-development-export-fixture-owner';
const from = '2026-01-01T00:00:00.000Z';
const until = '2026-02-01T00:00:00.000Z';
const url = 'https://monitor.example.test/bounded-export';

it('requires a strictly increasing, canonical UTC export window', () => {
  expect(parseDevelopmentExportWindow(from, until)).toEqual({ start: from, end: until });
  expect(() => parseDevelopmentExportWindow('2026-01-01', until)).toThrow('UTC window');
  expect(() => parseDevelopmentExportWindow('invalid', until)).toThrow('UTC window');
  expect(() => parseDevelopmentExportWindow(until, until)).toThrow('UTC window');
  expect(() => parseDevelopmentExportWindow(until, from)).toThrow('UTC window');
});

it('exports only decisions and alert feedback with in-window proposals and outcomes', async () => {
  const database = await createMonitorRecordingFixture();
  const directory = await mkdtemp(join(tmpdir(), 'mohassan-monitor-development-'));
  const { db } = database;
  let clock = Date.parse(from);
  const now = () => new Date(clock);
  const store = createMonitorStore(db, { now, v2: true });
  try {
    await db.insertInto('user').values({ id: owner, name: 'Fixture', email: `${owner}@example.test` }).execute();
    await db.insertInto('workspace_owner').values({ id: 1, owner_id: owner }).execute();

    async function propose(at: number) {
      clock = at;
      const conversationId = randomUUID();
      await db.insertInto('chat_conversations').values({
        id: conversationId, owner_id: owner, title: 'Fixture', created_at: now(), updated_at: now(),
      }).execute();
      const frame = buildMonitorContextFrame({ text: `Notify me when registration opens at ${url}`, now: now() });
      const decisionFeatures = monitorProposalDecisionSnapshot(frame, reasonMonitorContext(frame), 'propose');
      expect(decisionFeatures).toBeDefined();
      return store.propose(owner, {
        conversationId, spec: monitorRecordingFixtureSpec(now(), 'en', url), decisionFeatures,
        observation: { value: 'closed', excerpt: 'Registration closed.', url, observedAt: now().toISOString() }, offer: 'explicit',
      });
    }

    async function helpful(monitor: Awaited<ReturnType<typeof propose>>, at: number) {
      clock = at;
      const notice = randomUUID();
      await recordBackgroundRunOutcome(db, {
        conversationId: monitor.conversationId, runId: notice, userId: owner,
        monitorId: monitor.id, startedAt: now(), outcome: 'completed', language: 'en',
      }, now());
      await saveMonitorAlertFeedback(db, owner, notice, { rating: 'helpful' }, now());
    }

    const early = await propose(Date.parse(from) - 1);
    // A malformed out-of-window snapshot must not reach the export parser.
    await db.updateTable('smart_monitor_decisions').set({ features: '{}' }).where('monitor_id', '=', early.id)
      .where('event_key', '=', 'proposal').execute();
    clock = Date.parse(from);
    await store.approve(owner, early.id);
    await helpful(early, Date.parse(from) + 1);

    const included = await propose(Date.parse(from));
    await store.approve(owner, included.id);
    await helpful(included, Date.parse(from) + 2);
    await helpful(included, Date.parse(until));
    await store.change(owner, included.id, 'stop');

    const late = await propose(Date.parse(until));
    await store.change(owner, late.id, 'stop');

    const output = join(directory, 'development.jsonl');
    await expect(writeDevelopmentDecisionExport(db, 'other-owner', output, from, until)).rejects.toThrow('primary owner');
    const manifest = await writeDevelopmentDecisionExport(db, owner, output, from, until);
    const content = await readFile(output, 'utf8');
    expect(manifest).toEqual({
      version: 1, source: 'human', rows: 2, sha256: createHash('sha256').update(content).digest('hex'),
      v2ExclusionSha256: MONITOR_EXCLUSION_SHA256, trialWindow: { start: from, end: until },
    });
    expect(JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'))).toEqual(manifest);
    expect(content).not.toContain(included.conversationId);
    expect(content).not.toContain(included.id);
    expect(content).not.toContain(owner);
    expect(content).not.toContain(url);
    expect(content.trimEnd().split('\n').map(line => JSON.parse(line))).toMatchObject([
      { decision: 'approved', proposedAt: from, decisionAt: from },
      { decision: 'alert_helpful', proposedAt: from, decisionAt: new Date(Date.parse(from) + 2).toISOString() },
    ]);
    await expect(writeDevelopmentDecisionExport(db, owner, output, from, until)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(output, 'utf8')).toBe(content);

    const collision = join(directory, 'collision.jsonl');
    const existing = `${collision}.manifest.json`;
    await writeFile(existing, 'existing manifest');
    await expect(writeDevelopmentDecisionExport(db, owner, collision, from, until)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(collision)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(existing, 'utf8')).toBe('existing manifest');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
