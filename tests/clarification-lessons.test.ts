import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate, type DatabaseHandle } from '@mohassan/database';
import { applyAnswer, assessReadiness, interpretGoal, markAsked } from '@mohassan/cognitive';
import { commandChatMigration } from '../apps/server/src/command-chat.js';
import { parseClarifyState, readClarificationLessons, recordClarificationLesson, type ClarifyState } from '../apps/server/src/assistant/clarify.js';

/** The verified-lesson store on an in-memory database: no production connection is possible here. */
describe('verified clarification lessons', () => {
  const open: DatabaseHandle[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(handle => handle.close())); });

  async function database() {
    const handle = await createDatabase();
    open.push(handle);
    await migrate(handle.db);
    await commandChatMigration(handle.db);
    return handle.db;
  }
  function state(): ClarifyState {
    const context = { request: 'Create a paused campaign in my Google Ads account for a bakery', signals: { adsCreateInAccount: true }, capabilities: { models: true, ads: true, adsCreate: true } };
    const frame = interpretGoal(context);
    const question = assessReadiness(frame, context).question!;
    const answered = applyAnswer(markAsked(frame, question), question, { text: 'budget 20 GBP, https://bakery.example.com, Glasgow' }, context).frame;
    return { frame: answered, choices: {}, pending: null, evaluatedVersion: answered.version, outcome: 'REQUEST_APPROVAL', summary: null, portable: false, modelQuestions: [], withheld: 1, noted: 1, draftOnly: false, invalidAssumptions: ['ads_language'] };
  }

  it('stores slot names and counts only for verified runs, never answers', async () => {
    const db = await database();
    expect(await recordClarificationLesson(db, { ownerId: 'owner-a', runId: 'run-unverified', clarify: state(), outcome: 'unverified' })).toBe(false);
    expect(await recordClarificationLesson(db, { ownerId: 'owner-a', runId: 'run-1', clarify: state(), outcome: 'verified_success' })).toBe(true);
    const stats = await readClarificationLessons(db, 'owner-a');
    expect(stats.runs).toBe(1);
    expect(stats.slots.ads_budget).toEqual({ asked: 1, answered: 1, declined: 0, verifiedSuccess: 1 });
    expect(stats.withheldModelQuestions).toBe(1);
    expect(stats.invalidAssumptions).toEqual({ ads_language: 1 });
    const rows = await db.selectFrom('chat_clarification_lessons').selectAll().execute();
    expect(JSON.stringify(rows)).not.toMatch(/bakery|20 GBP|Glasgow/);
    expect((await readClarificationLessons(db, 'owner-b')).runs).toBe(0);
  });

  it('upgrades in place: migrations are idempotent and older run states stay readable', async () => {
    const db = await database();
    await commandChatMigration(db);
    const versions = (await db.selectFrom('schema_migrations').select('version').execute()).map(row => row.version);
    expect(versions).toEqual(expect.arrayContaining(['030_chat_decision_events', '031_chat_clarification_lessons']));
    expect(versions.filter(version => version === '030_chat_decision_events')).toHaveLength(1);
    // A run saved before this change has no clarify field, or a malformed one; neither is trusted.
    expect(parseClarifyState(undefined)).toBeNull();
    expect(parseClarifyState({ frame: { version: 'x' } })).toBeNull();
    const restored = parseClarifyState(JSON.parse(JSON.stringify(state())))!;
    expect(restored.frame.version).toBe(2);
    expect(restored.pending).toBeNull();
  });

  it('keeps the store bounded per owner', async () => {
    const db = await database();
    for (let index = 0; index < 205; index += 1) await recordClarificationLesson(db, { ownerId: 'owner-a', runId: `run-${index}`, clarify: state(), outcome: index % 2 ? 'verified_success' : 'verified_failure' });
    expect((await readClarificationLessons(db, 'owner-a')).runs).toBe(200);
    const count = await db.selectFrom('chat_clarification_lessons').select(eb => eb.fn.countAll<number>().as('count')).where('owner_id', '=', 'owner-a').executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(200);
  }, 60000);
});
