import { randomUUID } from 'node:crypto';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addEvidence, appendStep, cancelLedger, createRunLedger, decideVerdict, enterPhase, planStep, settleStep, startStep,
} from '../apps/server/src/assistant/agent-run.js';
import { newBrainState } from '../apps/server/src/assistant/brain.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { migrateMembers } from '../apps/server/src/members.js';
import { chatPhaseDurations, readPersistedChatMetrics } from '../apps/server/src/ops/metrics/chat.js';

const start = Date.UTC(2026, 10, 25);
const dayMs = 24 * 60 * 60 * 1000;
const privateMarker = 'fixture-only-email@example.test';
const privateGoal = `A private chat goal for ${privateMarker}`;
const privateUrl = `https://example.test/?privateQuery=${encodeURIComponent(privateMarker)}`;
const ownerId = 'fixture-owner-record';
const memberId = 'fixture-member-record';
const unknownId = 'fixture-unknown-record';

function run(at: number) {
  return createRunLedger({ runId: randomUUID(), at });
}

async function addRun(db: Kysely<any>, fixture: {
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  state?: ReturnType<typeof newBrainState>;
  events?: { kind: string; at: number; data?: Record<string, unknown> }[];
}) {
  const id = fixture.state?.agentRun?.runId ?? randomUUID();
  const conversationId = randomUUID();
  await db.insertInto('chat_conversations').values({ id: conversationId, owner_id: fixture.ownerId, title: privateMarker }).execute();
  await db.insertInto('chat_runs').values({
    id, conversation_id: conversationId, owner_id: fixture.ownerId, status: fixture.status, goal: privateGoal,
    state: fixture.state ? JSON.stringify(fixture.state) : null,
    created_at: new Date(fixture.createdAt), updated_at: new Date(fixture.updatedAt),
    lease_token: randomUUID(), lease_expires_at: new Date(fixture.updatedAt),
  }).execute();
  if (fixture.events?.length) await db.insertInto('chat_events').values(fixture.events.map(event => ({
    id: randomUUID(), conversation_id: conversationId, run_id: id, kind: event.kind, message: privateGoal,
    created_at: new Date(event.at), data: JSON.stringify(event.data ?? {}),
  }))).execute();
  return { id, conversationId };
}

describe('persisted chat metrics', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createDatabase({});
    await migrateAuth(database.db);
    await migrateMembers(database.db);
    await migrate(database.db);
    await commandChatMigration(database.db);
    await database.db.insertInto('user').values([
      { id: ownerId, name: 'Fixture owner', email: 'fixture-owner@example.test' },
      { id: memberId, name: 'Fixture member', email: 'fixture-member@example.test' },
      { id: unknownId, name: 'Fixture without a role', email: 'fixture-unknown@example.test' },
    ]).execute();
    await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: ownerId }).execute();
    await database.db.insertInto('workspace_members').values({ user_id: memberId, role: 'member' }).execute();
  });

  afterAll(async () => { await database?.close(); });

  it('sums visits to the real ledger phases and measures waits and simultaneous transitions', () => {
    const ledger = run(start);
    enterPhase(ledger, 'understanding', start + 10);
    enterPhase(ledger, 'planning', start + 20);
    enterPhase(ledger, 'executing', start + 35);
    enterPhase(ledger, 'awaiting_approval', start + 70);
    enterPhase(ledger, 'understanding', start + 90);
    enterPhase(ledger, 'executing', start + 110);
    enterPhase(ledger, 'verifying', start + 145);
    enterPhase(ledger, 'completed', start + 145);

    expect(chatPhaseDurations(ledger.history, start)).toEqual({
      received: 10, understanding: 30, planning: 15, executing: 70, awaiting_approval: 20, verifying: 0,
    });
  });

  it('omits intervals when the ledger is old, timestamps reverse, or the next entry was dropped', () => {
    const ledger = run(start);
    enterPhase(ledger, 'understanding', start + 1);
    enterPhase(ledger, 'planning', start);
    enterPhase(ledger, 'executing', start + 2);
    expect(chatPhaseDurations(ledger.history, start - 1)).toEqual({ planning: 2 });

    // Rotate the real ledger enough to evict the immediate successor of the first entry.
    for (let index = 0; index < 60; index++) {
      enterPhase(ledger, 'awaiting_input', start + 3 * index + 3);
      enterPhase(ledger, 'understanding', start + 3 * index + 4);
      enterPhase(ledger, 'executing', start + 3 * index + 5);
    }
    const durations = chatPhaseDurations(ledger.history, start);
    expect(ledger.history[0]?.phase).toBe('received');
    expect(durations.received).toBeUndefined();
    expect(Object.values(durations).reduce((sum, duration) => sum + duration, 0)).toBe(ledger.history.length - 2);
  });

  it('projects only aggregate measurements and observed path labels from persisted rows', async () => {
    const state = newBrainState();
    const ledger = state.agentRun = run(start);
    enterPhase(ledger, 'understanding', start + 10);
    enterPhase(ledger, 'executing', start + 12);
    decideVerdict(ledger, { hostStatus: 'completed', at: start + 40 });
    state.trail = [
      { action: `search ${privateMarker}`, result: `results: ${privateUrl}`, changed: true },
      { action: `read ${privateUrl}`, result: `HTTP 200 ${privateUrl}`, changed: true },
      { action: 'calculate', result: privateGoal, changed: false },
      { action: 'calculation_memory', result: privateGoal, changed: false },
      { action: 'skill_read', result: privateGoal, changed: false },
      { action: 'memory_search', result: privateGoal, changed: true },
      { action: `open ${privateUrl}`, result: `opened ${privateUrl}`, changed: true },
    ].map((entry, step) => ({ ...entry, step }));
    const recorded = await addRun(database.db, {
      ownerId, createdAt: start, updatedAt: start + 42, status: 'completed', state,
      events: [{ kind: 'visibility', at: start - 20, data: { firstProgressAtMs: start + 3, request: privateGoal } },
        { kind: 'step', at: start + 12 }],
    });
    await addRun(database.db, { ownerId: unknownId, createdAt: start, updatedAt: start + 45, status: 'completed' });

    const { samples } = await readPersistedChatMetrics(database.db, { fromMs: start, toMs: start + 100 });
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ role: 'owner', atMs: start, observation: { started: true, firstProgressMs: 3 } });
    expect(samples[1]).toMatchObject({
      role: 'owner', atMs: start + 42,
      observation: {
        finalAnswerMs: 42,
        phases: { received: 10, understanding: 2, executing: 28, verifying: 0 },
        paths: expect.arrayContaining(['web', 'local_computation', 'skill_reader', 'memory', 'browser']),
      },
    });
    expect(samples[1]?.observation.paths).toHaveLength(5);
    const output = JSON.stringify(samples);
    for (const privateValue of [ownerId, unknownId, privateMarker, privateGoal, privateUrl, 'privateQuery', recorded.id, recorded.conversationId]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it('includes old starts that settle in the window and leaves out final latency for unpublished answers', async () => {
    const at = start + dayMs;
    const cancelled = newBrainState();
    cancelled.agentRun = run(at - 20);
    enterPhase(cancelled.agentRun, 'understanding', at - 10);
    enterPhase(cancelled.agentRun, 'awaiting_input', at + 5);
    cancelLedger(cancelled.agentRun, 'owner_cancelled', at + 30);
    await addRun(database.db, { ownerId: memberId, createdAt: at - 20, updatedAt: at + 30, status: 'cancelled', state: cancelled });

    const failed = newBrainState();
    failed.agentRun = run(at + 1);
    enterPhase(failed.agentRun, 'understanding', at + 3);
    await addRun(database.db, { ownerId: memberId, createdAt: at + 1, updatedAt: at + 35, status: 'failed', state: failed });
    await addRun(database.db, { ownerId, createdAt: at + 2, updatedAt: at + 14, status: 'waiting_user', events: [
      { kind: 'visibility', at, data: { firstProgressAtMs: at + 1 } }, { kind: 'step', at: at + 5 },
    ] });
    await addRun(database.db, { ownerId, createdAt: at + 40, updatedAt: at + 45, status: 'completed' });

    const { samples } = await readPersistedChatMetrics(database.db, { fromMs: at, toMs: at + 40 });
    expect(samples).toHaveLength(4);
    expect(samples).toContainEqual(expect.objectContaining({ role: 'member', atMs: at + 1, observation: { started: true } }));
    expect(samples).toContainEqual(expect.objectContaining({ role: 'owner', atMs: at + 2, observation: { started: true } }));
    expect(samples).toContainEqual(expect.objectContaining({ role: 'member', atMs: at + 30, observation: {
      phases: { received: 10, understanding: 15, awaiting_input: 25 },
    } }));
    expect(samples).toContainEqual(expect.objectContaining({ role: 'member', atMs: at + 35, observation: {
      phases: { received: 2, understanding: 32 },
    } }));
  });

  it('counts a published refusal without tagging unsuccessful actions as evidence', async () => {
    const at = start + 2 * dayMs;
    const state = newBrainState();
    state.agentRun = run(at);
    enterPhase(state.agentRun, 'understanding', at + 1);
    decideVerdict(state.agentRun, { hostStatus: 'blocked', at: at + 5 });
    state.trail = [
      { action: `open ${privateUrl}`, result: 'not opened: the address was a guess' },
      { action: `search ${privateMarker}`, result: 'no results; provider failures: unavailable' },
      { action: `read ${privateUrl}`, result: 'robots.txt disallows this page' },
      { action: `click ${privateMarker}`, result: 'the user refused this action; do not try it again' },
      { action: 'permission gate', result: 'not run: owner_refused' },
    ].map((entry, step) => ({ ...entry, step, changed: false }));
    await addRun(database.db, { ownerId: memberId, createdAt: at, updatedAt: at + 6, status: 'blocked', state });

    const { samples } = await readPersistedChatMetrics(database.db, { fromMs: at, toMs: at + 10 });
    expect(samples[1]).toMatchObject({ role: 'member', atMs: at + 6, observation: { finalAnswerMs: 6, paths: ['refusal'] } });
  });

  it('paginates equal timestamps without replaying or dropping observations', async () => {
    const at = start + 3 * dayMs;
    for (const role of [ownerId, memberId, ownerId]) {
      await addRun(database.db, { ownerId: role, createdAt: at, updatedAt: at + 1, status: 'completed' });
    }
    const range = { fromMs: at, toMs: at + 2 };
    const full = await readPersistedChatMetrics(database.db, range);
    expect(full.samples).toHaveLength(6);

    type Batch = Awaited<ReturnType<typeof readPersistedChatMetrics>>;
    const pageSamples: Batch['samples'] = [];
    let cursor: Batch['nextCursor'];
    for (let pageNo = 0; pageNo <= full.samples.length; pageNo++) {
      const page = await readPersistedChatMetrics(database.db, { ...range, cursor, limit: 1 });
      expect(page.samples.length).toBeLessThanOrEqual(1);
      pageSamples.push(...page.samples);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(pageSamples).toEqual(full.samples);
    expect((await readPersistedChatMetrics(database.db, { fromMs: at + 2, toMs: at + 3 })).samples).toEqual([]);
  });

  it('uses verified ledger evidence and does not count a failed required tool as a refusal', async () => {
    const at = start + 4 * dayMs;
    const saved = newBrainState();
    const ledger = saved.agentRun = run(at);
    enterPhase(ledger, 'understanding', at + 1);
    enterPhase(ledger, 'executing', at + 2);
    appendStep(ledger, planStep({ id: 'news', capability: 'news.read', outcome: 'Read news', input: null, acceptance: ['The page was read.'] }), at + 3);
    startStep(ledger, 'news', at + 3);
    settleStep(ledger, 'news', 'verified', at + 4);
    addEvidence(ledger, { kind: 'computation', label: privateGoal, reference: privateUrl, independent: true }, at + 4);
    decideVerdict(ledger, { hostStatus: 'completed', at: at + 5 });
    await addRun(database.db, { ownerId, createdAt: at, updatedAt: at + 6, status: 'completed', state: saved });

    const failure = newBrainState();
    const failedLedger = failure.agentRun = run(at + 10);
    enterPhase(failedLedger, 'understanding', at + 11);
    enterPhase(failedLedger, 'executing', at + 12);
    appendStep(failedLedger, planStep({ id: 'read', capability: 'web.read', outcome: 'Read source', input: null, acceptance: ['The source was read.'] }), at + 13);
    startStep(failedLedger, 'read', at + 13);
    settleStep(failedLedger, 'read', 'failed', at + 14);
    expect(decideVerdict(failedLedger, { hostStatus: 'blocked', at: at + 15 }).verdict.reason).toBe('step_failed');
    await addRun(database.db, { ownerId, createdAt: at + 10, updatedAt: at + 16, status: 'blocked', state: failure });

    const { samples } = await readPersistedChatMetrics(database.db, { fromMs: at, toMs: at + 20 });
    expect(samples[1]?.observation.paths).toEqual(['web', 'local_computation', 'browser']);
    expect(samples[3]?.observation.paths).toEqual([]);
    expect(JSON.stringify(samples)).not.toContain(privateMarker);
  });
});
