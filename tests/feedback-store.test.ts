import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate, sql } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { feedbackPageKey, feedbackSourceUrls, redactFeedbackUrls } from '../apps/server/src/feedback-page-key.js';
import {
  captureFeedback, clearFeedbackPolicy, exportFeedbackRegression, feedbackCaseSha256, feedbackEvidencePolicy,
  feedbackMetrics, feedbackQuestionKey, listFeedback, recordFeedbackAnswer, reviewFeedback, setFeedbackTraining,
  type FeedbackRegressionExport,
} from '../apps/server/src/feedback-store.js';

const owner = { id: 'feedback-owner', role: 'owner' } as const;
const member = { id: 'feedback-member', role: 'member' } as const;
const neighbor = { id: 'feedback-neighbor', role: 'member' } as const;
const page = 'https://rail.example.test/Stations?edition=regional';
let database: Awaited<ReturnType<typeof createDatabase>>;

beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  await migrate(database.db);
  await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser: { setCheckpointStore() {} } as unknown as AgentBrowser,
  });
});

afterAll(async () => { await database?.close(); });

async function publish(userId: string, question: string, reply: string, options: { previousQuestion?: string; historical?: boolean } = {}) {
  const conversationId = randomUUID(), messageId = randomUUID();
  await database.db.transaction().execute(async tx => {
    await tx.insertInto('chat_conversations').values({ id: conversationId, owner_id: userId, title: 'Feedback fixture' }).execute();
    await tx.insertInto('chat_messages').values([
      { id: randomUUID(), conversation_id: conversationId, role: 'user', text: question, created_at: new Date(1000) },
      { id: messageId, conversation_id: conversationId, role: 'assistant', text: reply, created_at: new Date(2000) },
    ]).execute();
    if (options.historical) return;
    await recordFeedbackAnswer(tx, {
      userId, conversationId, messageId, question, reply, previousQuestion: options.previousQuestion,
      status: 'completed', evidenceUrls: [page + '&utm_source=chat#hour', page], route: 'web', judgeDecision: 'send',
    });
  });
  return { userId, conversationId, messageId };
}

async function report(target: Awaited<ReturnType<typeof publish>>, verdict: 'wrong' | 'useful' | 'incomplete', note: string | null = null) {
  return database.db.transaction().execute(tx => captureFeedback(tx, { ...target, verdict, note }));
}

async function itemFor(messageId: string) {
  return (await listFeedback(database.db, owner)).find(item => item.messageId === messageId)!;
}

describe('feedback store', () => {
  it('normalizes Arabic presentation variants and keeps page paths, question constraints and follow-up subjects distinct', () => {
    expect(feedbackQuestionKey(' من فضلك، أَيْنَ المحطة ١؟ ')).toBe(feedbackQuestionKey('اين المحطة 1'));
    expect(feedbackQuestionKey('لا تستخدم المصدر')).not.toBe(feedbackQuestionKey('استخدم المصدر'));
    expect(feedbackQuestionKey('Open https://rail.example.test/Stations')).not.toBe(feedbackQuestionKey('Open https://rail.example.test/stations'));
    expect(feedbackQuestionKey('Open https://rail.example.test/Stations.')).not.toBe(feedbackQuestionKey('Open https://rail.example.test/Stations'));
    expect(feedbackQuestionKey('وكم عدد سكانها؟', 'متى تأسست البصرة؟'))
      .not.toBe(feedbackQuestionKey('وكم عدد سكانها؟', 'متى تأسست بغداد؟'));
    expect(feedbackQuestionKey('What about London?', 'What are the train times?'))
      .toBe(feedbackQuestionKey('Please, what about London?', 'What are the train times?'));
    expect(feedbackPageKey(page + '&utm_source=chat#hour')).toBe(page);
    expect(feedbackPageKey(page + '&q=foo%20bar&utm_source=chat')).toBe(feedbackPageKey(page + '&q=foo%20bar'));
    expect(feedbackPageKey('https://user:password@rail.example.test/')).toBeNull();
    expect(feedbackPageKey('https://rail.example.test/stations?session=placeholder')).toBeNull();
    expect(redactFeedbackUrls('see https://rail.example.test/stations#access_token=placeholder')).toBe('see [محجوب]');
    expect(feedbackQuestionKey('Open https://rail.example.test/stations?session=placeholder')).toBeNull();
    expect(feedbackSourceUrls('**Source:** [Station](https://rail.example.test/X_(Y)#section)\nSee also: https://other.example.test/'))
      .toEqual(['https://rail.example.test/X_(Y)']);
  });

  it('blocks a normalized class for the reporting member immediately and isolates queue reads and writes', async () => {
    const question = 'When does the northern station close?';
    const target = await publish(member.id, question, 'The station closes at 10.');
    const foreign = await publish(neighbor.id, 'What is a station?', 'A place for trains.');
    await report(target, 'wrong', 'الموعد المذكور خطأ');
    await report(foreign, 'incomplete');
    await expect(report({ ...target, userId: neighbor.id }, 'wrong')).rejects.toMatchObject({ statusCode: 404 });
    const item = await itemFor(target.messageId);
    expect(item).toMatchObject({
      userId: member.id, question, reply: 'The station closes at 10.', evidenceUrls: [page],
      route: 'web', judgeDecision: 'send', note: 'الموعد المذكور خطأ', caseSha256: null, trainingAllowed: false,
      policies: [expect.objectContaining({ kind: 'block', scope: 'reporter', active: true })],
    });
    expect(await listFeedback(database.db, member)).toEqual([item]);
    expect((await listFeedback(database.db, neighbor)).map(result => result.messageId)).toEqual([foreign.messageId]);
    await expect(reviewFeedback(database.db, neighbor, item.id, 'correct')).rejects.toMatchObject({ statusCode: 403 });
    await expect(clearFeedbackPolicy(database.db, member, item.policies[0].id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await feedbackEvidencePolicy(database.db, member.id, 'Please, WHEN does the northern station close!')).blocked.has(page)).toBe(true);
    expect((await feedbackEvidencePolicy(database.db, neighbor.id, question)).blocked.size).toBe(0);
    expect((await feedbackEvidencePolicy(database.db, member.id, 'When does the southern station close?')).blocked.size).toBe(0);

    const reviewed = await reviewFeedback(database.db, owner, item.id, 'wrong');
    expect(reviewed.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'reporter', active: false, clearedAt: expect.any(String) }),
      expect.objectContaining({ scope: 'workspace', active: true, kind: 'block' }),
    ]));
    expect((await feedbackEvidencePolicy(database.db, neighbor.id, question)).blocked.has(page)).toBe(true);
    await report(target, 'wrong', 'A repeated vote cannot change the reviewed case');
    expect(await itemFor(target.messageId)).toEqual(reviewed);
  });

  it('gives overlapping blocks precedence over pins and audits verdicts, cleared policies and expiry', async () => {
    const question = 'When does the harbour station open?';
    const blocked = await publish(member.id, question, 'The station opens at 3.');
    const approved = await publish(owner.id, question, 'The station opens at 6.');
    const pending = await publish(neighbor.id, question, 'The station opens at 8.');
    await report(blocked, 'wrong');
    await report(approved, 'useful');
    await report(pending, 'wrong');
    const wrong = await reviewFeedback(database.db, owner, (await itemFor(blocked.messageId)).id, 'wrong');
    const correct = await reviewFeedback(database.db, owner, (await itemFor(approved.messageId)).id, 'correct');
    const workspaceBlock = wrong.policies.find(policy => policy.scope === 'workspace')!;
    const pin = correct.policies[0];
    expect(pin).toMatchObject({ kind: 'pin', scope: 'workspace', active: true });
    expect((await feedbackEvidencePolicy(database.db, owner.id, question)).pinned.size).toBe(0);

    const cleared = await clearFeedbackPolicy(database.db, owner, workspaceBlock.id);
    expect(cleared).toMatchObject({ active: false, clearedAt: expect.any(String) });
    expect((await feedbackEvidencePolicy(database.db, owner.id, question)).pinned.has(page)).toBe(true);
    expect((await feedbackEvidencePolicy(database.db, neighbor.id, question)).blocked.has(page)).toBe(true);
    const unsure = await reviewFeedback(database.db, owner, (await itemFor(pending.messageId)).id, 'unsure');
    expect(unsure.policies[0].active).toBe(true);
    expect((await feedbackEvidencePolicy(database.db, neighbor.id, question)).pinned.size).toBe(0);
    await clearFeedbackPolicy(database.db, owner, unsure.policies[0].id);
    expect((await feedbackEvidencePolicy(database.db, neighbor.id, question)).pinned.has(page)).toBe(true);

    const db = database.db;
    const audit = await db.selectFrom('chat_feedback_audit').selectAll()
      .where('policy_id', 'in', [workspaceBlock.id, pin.id]).execute();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ policy_id: pin.id, actor_id: owner.id, action: 'policy_created', details: expect.objectContaining({ expiresAt: pin.expiresAt }) }),
      expect.objectContaining({ policy_id: workspaceBlock.id, actor_id: owner.id, action: 'policy_cleared', details: { reason: 'owner_clear' } }),
    ]));
    const timeline = await db.selectFrom('chat_feedback_policies').select(['created_at', 'expires_at']).where('id', '=', pin.id).executeTakeFirstOrThrow();
    expect(+timeline.expires_at - +timeline.created_at).toBe(30 * 24 * 60 * 60 * 1000);
    await db.updateTable('chat_feedback_policies').where('id', '=', pin.id).set({
      created_at: sql`clock_timestamp() - interval '2 days'`, expires_at: sql`clock_timestamp() - interval '1 day'`,
    }).execute();
    expect((await itemFor(approved.messageId)).policies[0]).toMatchObject({ active: false, clearedAt: null });
    expect((await feedbackEvidencePolicy(db, owner.id, question)).pinned.size).toBe(0);
  });

  it('exports frozen content deterministically and requires a separate owner action to allow training', async () => {
    const db = database.db;
    const target = await publish(member.id, 'What is a platform?', 'The platform is a seating area.');
    await report(target, 'wrong', 'المعنى غير صحيح');
    const pending = await itemFor(target.messageId);
    await expect(setFeedbackTraining(db, owner, pending.id, true)).rejects.toMatchObject({ statusCode: 409 });
    const reviewed = await reviewFeedback(db, owner, pending.id, 'wrong');
    await expect(reviewFeedback(db, owner, pending.id, 'correct')).rejects.toMatchObject({ statusCode: 409 });
    const first = await exportFeedbackRegression(db, owner);
    expect(await exportFeedbackRegression(db, owner)).toBe(first);
    const regression: FeedbackRegressionExport = JSON.parse(first);
    expect(regression).toMatchObject({ purpose: 'regression', version: 1 });
    expect(regression.cases.map(value => value.sha256)).toEqual(regression.cases.map(value => value.sha256).sort());
    for (const frozen of regression.cases) expect(feedbackCaseSha256(frozen.case)).toBe(frozen.sha256);
    expect(regression.cases.find(value => value.sha256 === reviewed.caseSha256)?.case).toMatchObject({
      question: reviewed.question, reply: reviewed.reply, evidenceUrls: [page], feedbackNote: reviewed.note, decision: 'wrong',
    });
    expect(JSON.parse(await exportFeedbackRegression(db, owner, 'training'))).toEqual({ purpose: 'training', version: 1, cases: [] });
    await expect(setFeedbackTraining(db, member, reviewed.id, true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(exportFeedbackRegression(db, member)).rejects.toMatchObject({ statusCode: 403 });
    await setFeedbackTraining(db, owner, reviewed.id, true);
    expect(JSON.parse(await exportFeedbackRegression(db, owner, 'training')).cases.map((row: { sha256: string }) => row.sha256))
      .toEqual([reviewed.caseSha256]);
    expect(await exportFeedbackRegression(db, owner)).toBe(first);
    await setFeedbackTraining(db, owner, reviewed.id, false);
    expect(JSON.parse(await exportFeedbackRegression(db, owner, 'training')).cases).toEqual([]);
  });

  it('uses historical citations and counts subsequent repeated answers by their displayed meaning', async () => {
    const db = database.db;
    const question = 'When does the train depart?';
    const answer = `At 9 a.m.\n\n**Source:** [Times](${page})`;
    const original = await publish(member.id, question, answer + ' · read 2026-10-24 14:40 UTC', { historical: true });
    const before = await feedbackMetrics(db, owner);
    await report(original, 'wrong');
    expect(await itemFor(original.messageId)).toMatchObject({ evidenceUrls: [page], judgeDecision: null });
    await publish(neighbor.id, question, answer); // Only the reporter's answer history is eligible pending review.
    await publish(member.id, question.toUpperCase(), answer + ' · read 2026-11-24 14:40 UTC');
    await publish(member.id, question, 'At 12 p.m.');
    await publish(member.id, 'What is a freight train?', answer);
    const after = await feedbackMetrics(db, owner);
    expect(after.answerOpportunities - before.answerOpportunities).toBe(2);
    expect(after.repeatedWrongAnswers - before.repeatedWrongAnswers).toBe(1);
    expect(after.repeatErrorRate).toBe(after.repeatedWrongAnswers / after.answerOpportunities);
    expect(after.regressionSize).toBe(JSON.parse(await exportFeedbackRegression(db, owner)).cases.length);
  });

  it('blocks a historical Mind citation and compares repeated replies across read times', async () => {
    const question = 'When does the ticket counter open?';
    const citation = (day: string) => `«The ticket counter opens at noon.» ${page} (Read at ${day}T14:40:00.000Z · Source date 2026-11-20)`;
    const original = await publish(member.id, question, citation('2026-11-24'), { historical: true });
    const before = await feedbackMetrics(database.db, owner);
    await report(original, 'wrong');
    expect((await feedbackEvidencePolicy(database.db, member.id, question)).blocked.has(page)).toBe(true);
    await publish(member.id, question, citation('2026-11-25'));
    const after = await feedbackMetrics(database.db, owner);
    expect(after.answerOpportunities - before.answerOpportunities).toBe(1);
    expect(after.repeatedWrongAnswers - before.repeatedWrongAnswers).toBe(1);
  });
});
