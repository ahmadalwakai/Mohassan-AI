import { randomUUID } from 'node:crypto';
import type { ChatFeedback, ModelCouncil, ModelCouncilMember } from '@mohassan/contracts';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import type { Kysely } from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateBackgroundResults } from '../apps/server/src/background-results-migration.js';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { migrateMemberDataRights } from '../apps/server/src/member-data-migration.js';
import { migrateMembers } from '../apps/server/src/members.js';
import { migrateMonitors } from '../apps/server/src/monitors/migration.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';
import { recordBackgroundRunOutcome } from '../apps/server/src/notifications-store.js';
import { readReplyQualityMetrics } from '../apps/server/src/ops/metrics/reply-quality.js';
import { migrateRemindersInTransaction } from '../apps/server/src/reminders/migration.js';

const start = Date.UTC(2026, 10, 27);
const windows = [
  { startMs: start, endMs: start + 100 },
  { startMs: start - 100, endMs: start + 100 },
  { startMs: start + 150, endMs: start + 200 },
];
const privateText = 'Fixture-only reply, model output or feedback note';
type FixtureRole = 'owner' | 'member' | 'unassigned';
let database: DatabaseHandle | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

async function fixture(v5Enabled = false, councilEnabled = false) {
  database = await createDatabase({});
  const { db } = database;
  await migrateAuth(db);
  await migrateMembers(db);
  await migrate(db);
  await commandChatMigration(db, migrateRemindersInTransaction, v5Enabled, councilEnabled);
  await migrateMemberDataRights(db);
  await migrateBackgroundResults(db);
  await migrateMonitors(db);

  const roleIds = { owner: randomUUID(), member: randomUUID(), unassigned: randomUUID() };
  await db.insertInto('user').values(Object.entries(roleIds).map(([role, id]) => ({
    id, name: role, email: `${role}@example.test`,
  }))).execute();
  await db.insertInto('workspace_owner').values({ id: 1, owner_id: roleIds.owner }).execute();
  await db.insertInto('workspace_members').values({ user_id: roleIds.member, role: 'member' }).execute();

  const conversations = { owner: randomUUID(), member: randomUUID(), unassigned: randomUUID() };
  await db.insertInto('chat_conversations').values(Object.entries(conversations).map(([role, id]) => ({
    id, owner_id: roleIds[role as FixtureRole], title: privateText,
  }))).execute();
  return { db, conversations, roleIds };
}

async function insertReply(db: Kysely<any>, conversationId: string, at: number, metadata: {
  experiment?: 'v5'; council?: ModelCouncil;
} = {}, role: 'assistant' | 'user' = 'assistant') {
  const id = randomUUID();
  await db.insertInto('chat_messages').values({
    id, conversation_id: conversationId, role, text: privateText, created_at: new Date(at),
    ...(metadata.council ? { council: JSON.stringify(metadata.council) } : {}),
    ...(metadata.experiment ? { experiment: metadata.experiment } : {}),
  }).execute();
  return id;
}

async function rate(db: Kysely<any>, conversationId: string, messageId: string, verdict: ChatFeedback['verdict'], at: number, kind = 'feedback') {
  await db.insertInto('chat_events').values({
    id: randomUUID(), conversation_id: conversationId, run_id: null, kind, message: verdict,
    data: JSON.stringify({ messageId, verdict, note: privateText }), created_at: new Date(at),
  }).execute();
}

function member(model: string, outcome: ModelCouncilMember['outcome']): ModelCouncilMember {
  return { model, label: model, round: 'answer', outcome, elapsedMs: 0, output: privateText, note: privateText };
}

it('reads feedback from historical schemas with neither optional column and with only the v5 column', async () => {
  const { db, conversations } = await fixture();
  const original = await insertReply(db, conversations.owner, start);
  await rate(db, conversations.owner, original, 'useful', start + 1);
  const [before] = await readReplyQualityMetrics(db, windows);
  expect(before?.council).toBeUndefined();
  expect(before?.feedback?.owner).toEqual({
    pipeline: { replies: 1, useful: 1, wrong: 0, incomplete: 0, unrated: 0 },
    v5: { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 },
    councilChanged: { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 },
  });

  await commandChatMigration(db, undefined, true);
  await insertReply(db, conversations.owner, start + 2, { experiment: 'v5' });
  const [after] = await readReplyQualityMetrics(db, windows);
  expect(after?.council).toBeUndefined();
  expect(after?.feedback?.owner).toEqual({
    ...before?.feedback?.owner,
    v5: { replies: 1, useful: 0, wrong: 0, incomplete: 0, unrated: 1 },
  });
});

it('counts decisions, member outcomes and observed latency by window without exposing council text', async () => {
  const { db, conversations } = await fixture(false, true);
  const councilCases = Array.from({ length: 10 }, (_, index): ModelCouncil => {
    const chosen = index === 1 ? 'chat-v5' : index === 2 ? 'reading-v3-last' : 'pipeline';
    const v5Outcome = index < 3 ? 'ok' : index < 5 ? 'timeout' : index < 8 ? 'abstained' : 'failed';
    return {
      version: 1, chosen, changed: chosen !== 'pipeline', elapsedMs: (index + 1) * 5, reason: privateText,
      members: [member('pipeline', 'ok'), member('chat-v5', v5Outcome), member('reading-v3-last', index === 2 ? 'ok' : 'abstained')],
    };
  });
  for (const [index, council] of councilCases.entries()) await insertReply(db, conversations.owner, start + index, { council });
  const extra = { ...councilCases[0]!, elapsedMs: 100 };
  await insertReply(db, conversations.owner, start - 1, { council: extra });
  await insertReply(db, conversations.owner, start - 2, { council: {
    ...extra, chosen: '=invalid-model', elapsedMs: Number.MAX_SAFE_INTEGER,
    members: [member('constructor', 'ok'), member('=invalid-model', 'failed')],
  } });
  await insertReply(db, conversations.owner, windows[0]!.endMs, { council: extra });
  await insertReply(db, conversations.member, start, { council: extra });
  const unknown = await insertReply(db, conversations.owner, windows[2]!.startMs);
  await db.updateTable('chat_messages').set({ council: JSON.stringify({ ...extra, version: '1', changed: true }) })
    .where('id', '=', unknown).execute();

  function exactPercentiles(cases: ModelCouncil[]) {
    const observed = cases.map(record => record.elapsedMs).sort((a, b) => a - b);
    const observedRank = (fraction: number) => observed[Math.ceil(observed.length * fraction) - 1];
    return { samples: observed.length, p50: observedRank(0.50), p90: observedRank(0.90), p99: observedRank(0.99) };
  }
  const report = await readReplyQualityMetrics(db, windows);
  expect(report[0]?.council).toEqual({
    turns: councilCases.length, changedReplies: councilCases.filter(record => record.changed).length,
    chosenByModel: { pipeline: 8, 'chat-v5': 1, 'reading-v3-last': 1 },
    memberOutcomes: {
      pipeline: { ok: 10, abstained: 0, timeout: 0, failed: 0 },
      'chat-v5': { ok: 3, abstained: 3, timeout: 2, failed: 2 },
      'reading-v3-last': { ok: 1, abstained: 9, timeout: 0, failed: 0 },
    },
    elapsedMs: exactPercentiles(councilCases),
    v5: { attempted: 10, answered: 3, unusedAnswers: 2 },
  });
  expect(report[1]?.council).toMatchObject({
    turns: councilCases.length + 2, elapsedMs: exactPercentiles([...councilCases, extra]),
    v5: { attempted: 11, answered: 4, unusedAnswers: 3 },
  });
  expect(report[2]?.council).toEqual({
    turns: 0, changedReplies: 0, chosenByModel: {}, memberOutcomes: {},
    elapsedMs: { samples: 0, p50: null, p90: null, p99: null },
    v5: { attempted: 0, answered: 0, unusedAnswers: 0 },
  });
  expect(report[2]?.feedback?.owner.councilChanged.replies).toBe(0);
  expect(report[2]?.feedback?.owner.pipeline.replies).toBe(1);
  expect(JSON.stringify(report)).not.toContain(privateText);
  expect(JSON.stringify(report)).not.toContain('=invalid-model');
  expect(JSON.stringify(report)).not.toContain('constructor');

  // An unavailable rating table must not hide measurements from the independent council read.
  await db.schema.alterTable('chat_events').renameTo('unavailable_chat_events').execute();
  const [withoutFeedback] = await readReplyQualityMetrics(db, windows);
  expect(withoutFeedback).toEqual({ council: report[0]?.council });
});

it('uses the current feedback for each reply, with exclusive source and role splits', async () => {
  const { db, conversations, roleIds } = await fixture(true, true);
  const kept: ModelCouncil = {
    version: 1, chosen: 'pipeline', changed: false, elapsedMs: 5, reason: privateText, members: [],
  };
  const pipeline = await insertReply(db, conversations.owner, start, { council: kept });
  const v5 = await insertReply(db, conversations.owner, start + 1, { experiment: 'v5' });
  const changed = await insertReply(db, conversations.owner, start + 2, {
    experiment: 'v5', council: { ...kept, chosen: 'chat-v5', changed: true },
  });
  const member = await insertReply(db, conversations.member, start + 3);
  await insertReply(db, conversations.member, start + 4);
  await insertReply(db, conversations.owner, start - 1);
  await insertReply(db, conversations.unassigned, start);
  await insertReply(db, conversations.owner, start, {}, 'user');
  const alertAt = new Date(start + 4);
  const { id: monitorId } = await createMonitorStore(db).propose(roleIds.owner, {
    conversationId: conversations.owner,
    observation: { excerpt: privateText, value: privateText, observedAt: alertAt.toISOString() },
    spec: { source: { kind: 'page', url: 'https://example.test' }, read: { kind: 'main' }, condition: { kind: 'change' },
      timing: monitorTiming('page', 'normal', { now: alertAt }), language: 'en', title: privateText, message: privateText },
  });
  const alert = await insertReply(db, conversations.owner, alertAt.getTime());
  await recordBackgroundRunOutcome(db, {
    runId: alert, userId: roleIds.owner, conversationId: conversations.owner, startedAt: alertAt,
    outcome: 'completed', language: 'en', monitorId,
  }, alertAt);

  await rate(db, conversations.owner, pipeline, 'wrong', start + 5);
  await rate(db, conversations.owner, pipeline, 'useful', start + 101);
  await rate(db, conversations.member, pipeline, 'wrong', start + 102);
  await rate(db, conversations.owner, pipeline, 'wrong', start + 103, 'step');
  await rate(db, conversations.owner, v5, 'wrong', start + 6);
  await rate(db, conversations.owner, changed, 'incomplete', start + 7);
  await rate(db, conversations.member, member, 'useful', start + 8);

  const [narrow, wide] = await readReplyQualityMetrics(db, windows);
  expect(narrow?.feedback?.owner).toEqual({
    pipeline: { replies: 1, useful: 1, wrong: 0, incomplete: 0, unrated: 0 },
    v5: { replies: 1, useful: 0, wrong: 1, incomplete: 0, unrated: 0 },
    councilChanged: { replies: 1, useful: 0, wrong: 0, incomplete: 1, unrated: 0 },
  });
  expect(narrow?.feedback?.member).toEqual({
    pipeline: { replies: 2, useful: 1, wrong: 0, incomplete: 0, unrated: 1 },
    v5: { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 },
    councilChanged: { replies: 0, useful: 0, wrong: 0, incomplete: 0, unrated: 0 },
  });
  expect(wide?.feedback?.owner.pipeline).toEqual({ replies: 2, useful: 1, wrong: 0, incomplete: 0, unrated: 1 });
});
