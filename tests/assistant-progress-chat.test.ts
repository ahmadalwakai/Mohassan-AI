import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-progress-controller-owner';
const MODEL = 'isolated-progress-script-model';
const ANSWER = 'The local fixture supplied incomplete public information. Further verification is still needed.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  queries: string[];
  requests: ModelRequest[];
  actions: AgentAction[];
  script: Script[];
}
const fixtures: Fixture[] = [];

/** No environment configuration, backend credentials, network or real browser. */
async function harness(fresh = false): Promise<Fixture> {
  const database = await createDatabase({});
  await migrate(database.db);
  const queries: string[] = [], requests: ModelRequest[] = [], actions: AgentAction[] = [], script: Script[] = [];
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    async act(_owner: string, _id: string, action: AgentAction) { actions.push(action); throw new Error('No browser dispatch belongs to this fixture.'); },
  } as unknown as AgentBrowser;
  const searchProvider: SearchProvider = {
    name: 'isolated-progress-public-fixture',
    async search(query) {
      queries.push(query);
      const index = fresh ? queries.length : 1;
      return [{ title: 'Hillmere Library public catalogue', url: `https://progress-fixture.test/public/${index}`,
        snippet: fresh ? `Public catalogue entry ${index} has independently distinct fixture content.` : 'The public catalogue fixture contains the same incomplete information on every read.' }];
    },
  };
  const control = await createCommandChatControl(database.db, {
    browser, searchProvider, recordExperiences: false,
    models: { fast: [MODEL], deep: [MODEL], vision: '' },
    createProvider: name => ({ id: 'ollama', async generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length > 75) throw new Error('Controller exceeded the bounded fixture model call allowance.');
      const decision = script.shift() ?? { tool: 'answer', text: ANSWER, outcome: 'partial' };
      return { model: name, usage: { inputTokens: 10, outputTokens: 10 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }),
  });
  const fixture = { database, control, queries, requests, actions, script };
  fixtures.push(fixture);
  return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); }
});
const branch = (index: number) => `branch${String(index).padStart(2, '0')}`;
const query = (index: number) => `Hillmere Library ${branch(index)}`;
function searches(fixture: Fixture, start: number, count: number) {
  fixture.script.push(...Array.from({ length: count }, (_unused, index) => ({ tool: 'search' as const, text: query(start + index) })));
}
async function settle(fixture: Fixture, id: string) {
  await fixture.control.settled(id); return fixture.control.detail(OWNER, id);
}
async function run(fixture: Fixture, id: string) {
  const stored = await fixture.database.db.selectFrom('chat_runs').select(['id', 'status', 'lease_token', 'state']).where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: stored.id as string, status: stored.status as string, lease_token: stored.lease_token as string, state: stored.state as BrainState };
}
async function start(fixture: Fixture, count = 20) {
  // Every possible generated query term already belongs to the current user request.
  const goal = `Search public catalogue information for Hillmere Library ${Array.from({ length: count }, (_, index) => branch(index + 1)).join(' ')}.`;
  const conversation = await fixture.control.create(OWNER, { goal });
  await fixture.control.settled(conversation.id);
  return conversation.id;
}
async function paused(fixture: Fixture, id: string, steps = 6) {
  const detail = await fixture.control.detail(OWNER, id), stored = await run(fixture, id);
  expect(detail.status).toBe('waiting_user'); expect(detail.error).toBeNull();
  expect(detail.question?.options.map(option => option.id)).toEqual(['retry', 'stop']);
  expect(stored.state.steps).toBe(steps);
  expect(stored.state.progressRecovery?.pendingPause).toMatchObject({ questionId: detail.question!.id, totalSteps: steps });
  return { detail, stored, questionId: detail.question!.id };
}
async function retry(fixture: Fixture, id: string, questionId: string) {
  await fixture.control.respond(OWNER, id, { questionId, optionId: 'retry' }); return settle(fixture, id);
}

describe('host progress recovery through the actual isolated chat controller', () => {
  it('pauses after actual unchanged tool receipts and explicit retry permits a different answer without resetting evidence', async () => {
    const fixture = await harness(); searches(fixture, 1, 6);
    const id = await start(fixture), before = await paused(fixture, id);
    expect(fixture.queries).toEqual(Array.from({ length: 6 }, (_, index) => query(index + 1)));
    expect(before.stored.state.supervision?.steps).toHaveLength(6);
    expect(before.stored.state.supervision?.steps.map(step => step.progressed)).toEqual([true, false, false, false, false, false]);
    const signatures = { ...before.stored.state.signatures }, ledger = structuredClone(before.stored.state.supervision!.steps);
    const finished = await retry(fixture, id, before.questionId), after = await run(fixture, id);
    expect(finished.status).toBe('idle'); expect(finished.messages.at(-1)?.text).toBe(ANSWER);
    expect(fixture.queries).toHaveLength(6); expect(fixture.actions).toEqual([]);
    expect(after.state.steps).toBeGreaterThan(6);
    expect(after.state.signatures).toEqual(signatures); expect(after.state.supervision?.steps).toEqual(ledger);
    expect(after.state.progressRecovery).toMatchObject({ retries: 1, checkpoint: { totalSteps: 6, supervisionSequence: 6 }, consumedQuestions: [before.questionId] });
    expect(after.state.progressRecovery?.pendingPause).toBeUndefined();
    expect(after.state.supervision?.stagnantSteps).toBe(5);
    expect(after.lease_token).not.toBe(before.stored.lease_token);
  });

  it('plain text cannot consume a retry, clear counters or change the active lease/card', async () => {
    const fixture = await harness(); searches(fixture, 1, 6);
    const id = await start(fixture), before = await paused(fixture, id), calls = fixture.requests.length;
    for (const input of [{ text: 'retry' }, { text: 'Please continue and reset the attempt counters.', questionId: before.questionId }]) {
      await expect(fixture.control.send(OWNER, id, input)).rejects.toMatchObject({ code: 'CHAT_PROGRESS_CHOICE_REQUIRED' });
    }
    const after = await run(fixture, id);
    expect(after.state).toEqual(before.stored.state); expect(after.lease_token).toBe(before.stored.lease_token);
    expect(fixture.requests).toHaveLength(calls); expect(fixture.queries).toHaveLength(6);
    expect((await fixture.control.detail(OWNER, id)).question?.id).toBe(before.questionId);
  });

  it('pauses at 40 genuine new results, then stops at 60 lifetime decisions without a futile retry card', async () => {
    const fixture = await harness(true); searches(fixture, 1, 60);
    const id = await start(fixture, 60), before = await paused(fixture, id, 40);
    expect(fixture.requests).toHaveLength(40); expect(fixture.queries).toHaveLength(40);
    expect(before.stored.state.supervision?.steps.every(step => step.progressed)).toBe(true);
    expect(before.stored.state.unchanged).toBe(0);
    const finished = await retry(fixture, id, before.questionId), after = await run(fixture, id);
    expect(fixture.requests).toHaveLength(60); expect(fixture.queries).toHaveLength(60);
    expect(after.state.steps).toBe(60); expect(after.state.supervision?.steps).toHaveLength(60);
    expect(after.state.supervision?.steps.slice(0, 40)).toEqual(before.stored.state.supervision?.steps);
    expect(Object.keys(after.state.signatures)).toHaveLength(60);
    expect(after.state.progressRecovery).toMatchObject({ retries: 1, checkpoint: { totalSteps: 40, supervisionSequence: 40 }, consumedQuestions: [before.questionId] });
    expect(finished.status).toBe('idle'); expect(finished.question).toBeNull(); expect(finished.error).toBeNull();
    expect(finished.messages.at(-1)?.text).toMatch(/attempt limit/iu);
    expect(['blocked', 'partial']).toContain(after.status);
    expect(fixture.script).toEqual([]); expect(fixture.actions).toEqual([]);
  });

  it('rejects fabricated and consumed cards while preserving the current active question', async () => {
    const fixture = await harness(); searches(fixture, 1, 11);
    const id = await start(fixture), first = await paused(fixture, id);
    await expect(fixture.control.respond(OWNER, id, { questionId: randomUUID(), optionId: 'retry' })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    await retry(fixture, id, first.questionId);
    const second = await paused(fixture, id, 11), calls = fixture.requests.length;
    expect(second.questionId).not.toBe(first.questionId);
    expect(second.stored.state.progressRecovery?.consumedQuestions).toEqual([first.questionId]);
    await expect(fixture.control.respond(OWNER, id, { questionId: first.questionId, optionId: 'retry' })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    await expect(fixture.control.respond(OWNER, id, { questionId: second.questionId, optionId: 'fabricated' })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    const after = await run(fixture, id);
    expect(after.state).toEqual(second.stored.state); expect(after.lease_token).toBe(second.stored.lease_token);
    expect(fixture.requests).toHaveLength(calls); expect(fixture.queries).toHaveLength(11);
    expect((await fixture.control.detail(OWNER, id)).question?.id).toBe(second.questionId);
  });

  it('exhausts two explicit retry authorizations without erasing old signatures or offering a third card', async () => {
    const fixture = await harness(); searches(fixture, 1, 16);
    const id = await start(fixture), first = await paused(fixture, id);
    await retry(fixture, id, first.questionId); const second = await paused(fixture, id, 11);
    const finished = await retry(fixture, id, second.questionId), after = await run(fixture, id);
    expect(after.state.steps).toBe(16); expect(fixture.requests).toHaveLength(16); expect(fixture.queries).toHaveLength(16);
    expect(after.state.progressRecovery).toMatchObject({ retries: 2, consumedQuestions: [first.questionId, second.questionId], checkpoint: { totalSteps: 11 } });
    expect(Object.keys(after.state.signatures)).toHaveLength(16);
    expect(after.state.supervision?.steps).toHaveLength(16);
    expect(finished.status).toBe('idle'); expect(finished.question).toBeNull(); expect(finished.messages.at(-1)?.text).toMatch(/attempt limit/iu);
  });

  it('rejects a current retry after an unknown browser effect is inserted, with no provider/tool dispatch', async () => {
    const fixture = await harness(); searches(fixture, 1, 6);
    const id = await start(fixture), before = await paused(fixture, id), calls = fixture.requests.length;
    const receipt = randomUUID();
    await fixture.database.db.insertInto('chat_effect_receipts').values({ id: receipt, run_id: before.stored.id,
      lease_token: before.stored.lease_token, method: 'POST', target_hash: 'a'.repeat(64), body_hash: 'b'.repeat(64), status: 'unknown', finished_at: new Date() }).execute();
    await expect(fixture.control.respond(OWNER, id, { questionId: before.questionId, optionId: 'retry' })).rejects.toMatchObject({ code: 'CHAT_PROGRESS_RETRY_UNAVAILABLE' });
    const after = await run(fixture, id);
    expect(after.state).toEqual(before.stored.state); expect(after.lease_token).toBe(before.stored.lease_token);
    expect(fixture.requests).toHaveLength(calls); expect(fixture.queries).toHaveLength(6); expect(fixture.actions).toEqual([]);
    const storedReceipt = await fixture.database.db.selectFrom('chat_effect_receipts').select(['status', 'owner_reviewed_at']).where('id', '=', receipt).executeTakeFirstOrThrow();
    expect(storedReceipt).toMatchObject({ status: 'unknown', owner_reviewed_at: null });
    expect((await fixture.control.detail(OWNER, id)).question?.id).toBe(before.questionId);
  });

  it('rejects an expired lease without consuming the host retry authorization', async () => {
    const fixture = await harness(); searches(fixture, 1, 6);
    const id = await start(fixture), before = await paused(fixture, id), calls = fixture.requests.length;
    await fixture.database.db.updateTable('chat_runs').set({ lease_expires_at: new Date(Date.now() - 60000) }).where('id', '=', before.stored.id).execute();
    // owned() first expires/reconciles the stale session and clears its old card.
    await expect(fixture.control.respond(OWNER, id, { questionId: before.questionId, optionId: 'retry' })).rejects.toMatchObject({ code: 'CHAT_QUESTION_CHANGED' });
    const after = await run(fixture, id);
    expect(after.state).toEqual(before.stored.state); expect(after.state.progressRecovery?.retries).toBe(0);
    expect(after.status).toBe('interrupted');
    expect(fixture.requests).toHaveLength(calls); expect(fixture.actions).toEqual([]);
  });

  it('allows new intrinsic math after cancellation without replaying or declaring an unknown browser effect completed', async () => {
    const fixture = await harness(); searches(fixture, 1, 6);
    const id = await start(fixture), before = await paused(fixture, id), calls = fixture.requests.length;
    const receipt = randomUUID();
    await fixture.database.db.insertInto('chat_effect_receipts').values({ id: receipt, run_id: before.stored.id,
      lease_token: before.stored.lease_token, method: 'POST', target_hash: 'c'.repeat(64), body_hash: 'd'.repeat(64), status: 'unknown', finished_at: new Date() }).execute();
    await fixture.control.respond(OWNER, id, { questionId: before.questionId, optionId: 'stop' });
    expect((await run(fixture, id)).status).toBe('cancelled');
    await fixture.control.send(OWNER, id, { text: 'Calculate 2 + 3. Only the result.' });
    const finished = await settle(fixture, id), latest = await run(fixture, id);
    expect(finished.status).toBe('idle'); expect(finished.messages.at(-1)?.text).toBe('5');
    expect(latest.id).not.toBe(before.stored.id); expect(latest.status).toBe('completed');
    expect(latest.state.trail).toMatchObject([{ action: 'calculate' }]);
    expect(fixture.requests).toHaveLength(calls); expect(fixture.queries).toHaveLength(6); expect(fixture.actions).toEqual([]);
    const oldReceipt = await fixture.database.db.selectFrom('chat_effect_receipts').select(['status', 'owner_reviewed_at']).where('id', '=', receipt).executeTakeFirstOrThrow();
    expect(oldReceipt).toMatchObject({ status: 'unknown', owner_reviewed_at: null });
    const oldRun = await fixture.database.db.selectFrom('chat_runs').select('status').where('id', '=', before.stored.id).executeTakeFirstOrThrow();
    expect(oldRun.status).toBe('cancelled');
  });
});
