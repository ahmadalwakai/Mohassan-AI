import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactReconciliation, type MemoryExactWriteReceipt } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { newBrainState, type BrainState } from '../apps/server/src/assistant/brain.js';
import { createComputationMemoryReceipt } from '../apps/server/src/assistant/computation-memory-receipt.js';
import type { AssistantTools } from '../apps/server/src/assistant/tools.js';

const OWNER = 'isolated-memory-verification-owner', OTHER = 'isolated-memory-verification-other';
const CALCULATE = 'Calculate 271 + 314, then remember the result in my memory.';
const QUESTION = 'Did you save the result?', AR_QUESTION = 'هل حفظت النتيجة؟';
const PAYLOAD = '271 + 314 = 585';
interface Options {
  modelReady?: boolean;
  exact?: boolean;
  writeMode?: 'normal' | 'commit_then_throw' | 'fail';
  readMode?: 'normal' | 'throw' | 'wrong_owner' | 'wrong_payload';
}
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  domain: ReturnType<typeof createMemoryControl>;
  options: Options;
  writes: number;
  reads: number;
  modelCalls: ModelRequest[];
  legacySave: ReturnType<typeof vi.fn>;
  legacySearch: ReturnType<typeof vi.fn>;
  browserBind: ReturnType<typeof vi.fn>;
  browserCalls: ReturnType<typeof vi.fn>;
  publicSearch: ReturnType<typeof vi.fn>;
  gateNextRead(): { entered: Promise<void>; release(): void };
  releaseAll(): void;
}
const fixtures: Fixture[] = [];
async function harness(options: Options = {}): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  for (const id of [OWNER, OTHER]) await database.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
  await sql`CREATE TABLE fixture_verification_access(owner_id text PRIMARY KEY,active boolean NOT NULL)`.execute(database.db);
  for (const owner_id of [OWNER, OTHER]) await database.db.insertInto('fixture_verification_access').values({ owner_id, active: true }).execute();
  const domain = createMemoryControl(database.db), counters = { writes: 0, reads: 0 }, modelCalls: ModelRequest[] = [];
  const legacySave = vi.fn(async () => { throw new Error('Verification must not use legacy memory save.'); });
  const legacySearch = vi.fn(async () => { throw new Error('Exact operation verification must not search for similar memories.'); });
  const browserCalls = vi.fn(async () => { throw new Error('No browser belongs to this isolated fixture.'); });
  const browserBind = vi.fn(async () => {});
  const publicSearch = vi.fn(async () => { throw new Error('No public lookup belongs to this private verification fixture.'); });
  const releases: Array<() => void> = [];
  let nextGate: { entered(): void; wait: Promise<void> } | undefined;
  const memory: NonNullable<AssistantTools['memory']> = { save: legacySave, search: legacySearch };
  if (options.exact !== false) {
    memory.writeExact = async (owner, input, passed) => {
      counters.writes++;
      if (options.writeMode === 'fail') throw new Error('Synthetic missing old write.');
      const result = await domain.writeExact(owner, input, passed);
      if (options.writeMode === 'commit_then_throw') throw new Error('Synthetic response lost after old commit.');
      return result;
    };
    memory.reconcileExact = async (owner, input, passed) => {
      counters.reads++;
      const gate = nextGate; nextGate = undefined;
      if (gate) { gate.entered(); await gate.wait; }
      if (options.readMode === 'throw') throw new Error('Synthetic read temporarily unavailable.');
      const result = await domain.reconcileExact(owner, input, passed);
      if (result.status !== 'verified') return result;
      if (options.readMode === 'wrong_owner') return { ...result, receipt: { ...result.receipt, ownerId: OTHER } };
      if (options.readMode === 'wrong_payload') return { ...result, item: { ...result.item, content: 'forged current status' } } as MemoryExactReconciliation;
      return result;
    };
  }
  const control = await createCommandChatControl(database.db, {
    browser: { setCheckpointStore() {}, bindAccount: browserBind, async hasPage() { return false; }, async close() {}, observe: browserCalls,
      screen: browserCalls, act: browserCalls, prepareAction: browserCalls } as unknown as AgentBrowser,
    tools: { memory }, recordExperiences: false,
    models: options.modelReady ? { fast: ['verification-fixture-model'], deep: ['verification-fixture-model'], vision: '' } : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'verification-forbidden-search', search: publicSearch } as SearchProvider,
    accountActive: async (ownerId, tx) => Boolean(await tx.selectFrom('fixture_verification_access').select('owner_id').where('owner_id', '=', ownerId)
      .where('active', '=', true).forShare().executeTakeFirst()),
    ...(options.modelReady ? { createProvider: () => ({ id: 'ollama', async generate(request: ModelRequest) {
      modelCalls.push(request); throw new Error('A deterministic verification must not invoke a model.');
    } }) } : {}),
  });
  const fixture: Fixture = { database, control, domain, options, modelCalls, legacySave, legacySearch, browserBind, browserCalls, publicSearch,
    get writes() { return counters.writes; }, get reads() { return counters.reads; }, releaseAll() { for (const release of releases) release(); },
    gateNextRead() {
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      nextGate = { entered, wait }; releases.push(release); return { entered: enteredPromise, release };
    } };
  fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { const closing = fixture.control.shutdown(); fixture.releaseAll(); await closing; await fixture.database.close(); }
});
async function latest(fixture: Fixture, id: string) {
  const row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: row.id as string, status: row.status as string, state: row.state as BrainState };
}
async function settled(fixture: Fixture, id: string) {
  await fixture.control.settled(id);
  const detail = await fixture.control.detail(OWNER, id), run = await latest(fixture, id);
  return { id, detail, run, text: detail.messages.at(-1)?.text ?? '' };
}
async function start(fixture: Fixture) {
  const conversation = await fixture.control.create(OWNER, { goal: CALCULATE }); return settled(fixture, conversation.id);
}
async function verify(fixture: Fixture, id: string, text = QUESTION) {
  await fixture.control.send(OWNER, id, { text }); return settled(fixture, id);
}
function noAlternates(fixture: Fixture) {
  expect(fixture.modelCalls).toEqual([]); expect(fixture.publicSearch).not.toHaveBeenCalled();
  expect(fixture.legacySave).not.toHaveBeenCalled(); expect(fixture.legacySearch).not.toHaveBeenCalled();
  expect(fixture.browserCalls).not.toHaveBeenCalled();
}
function noPayload(result: Awaited<ReturnType<typeof settled>>) {
  expect(result.text).not.toContain(PAYLOAD); expect(result.text).not.toMatch(/never saved/iu);
  if (result.run.state.memoryVerification) expect(result.run.state.memoryVerification).not.toHaveProperty('receipt');
  expect(result.run.state.computationMemory).toBeUndefined();
}
async function itemCounts(fixture: Fixture) {
  const items = await fixture.database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', OWNER).execute();
  const operations = await fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute();
  return { items, operations };
}
/** A stopped old run with an expired worker lease, using the actual domain for any historical commit. No production state. */
async function seed(fixture: Fixture, options: { createdAt?: number; phase?: 'write_attempted' | 'prepared'; commit?: boolean; malformed?: boolean; ownerId?: string } = {}) {
  const conversation = await fixture.control.create(OWNER, {}), createdAt = options.createdAt ?? Date.now() - 10000, runId = randomUUID();
  const ownerId = options.ownerId ?? OWNER;
  const receipt = createComputationMemoryReceipt(CALCULATE, { ownerId, conversationId: conversation.id, runId, evaluatedAt: createdAt })!;
  let committed: MemoryExactWriteReceipt | undefined;
  if (options.commit) {
    const historical = createMemoryControl(fixture.database.db, { now: () => new Date(createdAt + 1000) });
    committed = (await historical.writeExact(ownerId, { operationKey: receipt.operationKey, payload: receipt.payload.text, payloadHash: receipt.payload.hash })).receipt;
  }
  const flow = options.malformed ? { phase: 'unknown', receipt: 'saved' } : { version: 1, kind: 'calculation_memory_flow',
    phase: options.phase ?? 'write_attempted', receipt, ...(options.phase === 'prepared' ? {} : { attemptedAt: createdAt + 1000 }) };
  await fixture.database.db.insertInto('chat_runs').values({ id: runId, owner_id: ownerId, conversation_id: conversation.id, status: 'interrupted', goal: CALCULATE,
    lease_token: randomUUID(), lease_expires_at: new Date(createdAt + 2000), created_at: new Date(createdAt), state: JSON.stringify({ ...newBrainState(), computationMemory: flow }) }).execute();
  return { id: conversation.id, runId, receipt, committed };
}

describe('read-only save verification through the actual chat controller', () => {
  it.each([QUESTION, AR_QUESTION])('verifies a completed original operation without a new write or model call: %s', async text => {
    const fixture = await harness({ modelReady: true }), original = await start(fixture), before = await itemCounts(fixture);
    expect(original.run.status).toBe('completed'); const originalState = structuredClone(original.run.state), bindings = fixture.browserBind.mock.calls.length;
    const result = await verify(fixture, original.id, text);
    expect(result.run.status).toBe('completed'); expect(result.detail.status).toBe('idle'); expect(result.detail.error).toBeNull();
    expect(result.run.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
    expect(result.run.state.supervision?.contract.criteria.map(value => [value.kind, value.id])).toEqual([['answer_evidence', 'memory-status-answer']]);
    expect(result.run.state.memoryVerification?.source.sourceRunId).toBe(original.run.id); expect(result.run.state.memorySaves ?? 0).toBe(0);
    expect(fixture.writes).toBe(1); expect(fixture.reads).toBe(2); expect(await itemCounts(fixture)).toEqual(before);
    expect(fixture.browserBind).toHaveBeenCalledTimes(bindings);
    expect((await fixture.database.db.selectFrom('chat_runs').select('state').where('id', '=', original.run.id).executeTakeFirstOrThrow()).state).toEqual(originalState);
    const observations = result.run.state.supervision?.steps.flatMap(value => value.observations);
    expect(observations).toHaveLength(1); expect(observations?.[0]).toMatchObject({ kind: 'answer_evidence', source: 'memory-read', independentlyVerified: true });
    noPayload(result); noAlternates(fixture);
  });

  it('repeated questions flatten to the original operation and re-read it each time', async () => {
    const fixture = await harness(), original = await start(fixture), first = await verify(fixture, original.id), second = await verify(fixture, original.id, AR_QUESTION);
    expect(first.run.status).toBe('completed'); expect(second.run.status).toBe('completed');
    expect(second.run.state.memoryVerification?.source).toEqual(first.run.state.memoryVerification?.source);
    expect(second.run.state.memoryVerification?.source.sourceRunId).toBe(original.run.id);
    expect(second.run.state.memoryVerification?.verificationRunId).toBe(second.run.id);
    expect(fixture.reads).toBe(3); expect(fixture.writes).toBe(1); noPayload(second); noAlternates(fixture);
  });

  it('recovers a prior commit plus lost response/read failure only by reading the original operation', async () => {
    const fixture = await harness({ writeMode: 'commit_then_throw', readMode: 'throw', modelReady: true }), original = await start(fixture);
    expect(original.run.status).toBe('partial'); expect(original.run.state.computationMemory?.phase).toBe('unknown');
    fixture.options.readMode = 'normal'; const result = await verify(fixture, original.id);
    expect(result.run.status).toBe('completed'); expect(fixture.writes).toBe(1); expect(fixture.reads).toBe(2);
    expect((await itemCounts(fixture)).items).toHaveLength(1); noPayload(result); noAlternates(fixture);
  });

  it('reports missing attempts as partial and never retries the failed old create', async () => {
    const fixture = await harness({ writeMode: 'fail' }), original = await start(fixture), result = await verify(fixture, original.id);
    expect(result.run.status).toBe('partial'); expect(result.run.state.memoryVerification?.lastCheck?.outcome).toBe('missing');
    expect(fixture.writes).toBe(1); expect(fixture.reads).toBe(2); expect((await itemCounts(fixture)).items).toEqual([]); noPayload(result); noAlternates(fixture);
  });

  it('does not turn an earlier missing snapshot into never-saved certainty when the original commit becomes visible later', async () => {
    const fixture = await harness(), old = await seed(fixture), missing = await verify(fixture, old.id);
    expect(missing.run.status).toBe('partial'); expect(missing.run.state.memoryVerification?.lastCheck?.outcome).toBe('missing');
    // Simulate the previously unknown original operation becoming committed.
    // This is fixture setup, not a verifier retry or a newly minted key.
    await fixture.domain.writeExact(OWNER, { operationKey: old.receipt.operationKey, payload: old.receipt.payload.text, payloadHash: old.receipt.payload.hash });
    const visible = await verify(fixture, old.id);
    expect(visible.run.status).toBe('completed'); expect(visible.run.state.memoryVerification?.source.sourceRunId).toBe(old.runId);
    expect(fixture.writes).toBe(0); expect(fixture.reads).toBe(2); expect((await itemCounts(fixture)).operations).toHaveLength(1);
    noPayload(missing); noPayload(visible); noAlternates(fixture);
  });

  it.each(['revoke', 'remove'] as const)('does not resurrect or disclose an old result after %s', async action => {
    const fixture = await harness(), original = await start(fixture), item = (await itemCounts(fixture)).items[0]!;
    await fixture.domain[action](OWNER, item.id, { expectedVersion: 1, reason: 'Synthetic owner removal' });
    const result = await verify(fixture, original.id), again = await verify(fixture, original.id);
    expect(result.run.status).toBe('partial'); expect(result.run.state.memoryVerification?.lastCheck?.outcome).toBe('unavailable');
    expect(again.run.status).toBe('partial'); expect(fixture.writes).toBe(1); expect((await itemCounts(fixture)).operations).toHaveLength(1);
    noPayload(result); noPayload(again); noAlternates(fixture);
  });

  it('checks an old expired lease with the new lease, but expired memory remains unavailable', async () => {
    const fixture = await harness(), old = await seed(fixture, { createdAt: Date.now() - 190 * 86400000, commit: true });
    const result = await verify(fixture, old.id);
    expect(result.run.status).toBe('partial'); expect(result.run.state.memoryVerification?.lastCheck?.outcome).toBe('unavailable');
    expect(fixture.writes).toBe(0); expect(fixture.reads).toBe(1); noPayload(result); noAlternates(fixture);
  });

  it('uses the new lease to verify an active old commit without any old side-effect resumption', async () => {
    const fixture = await harness(), old = await seed(fixture, { commit: true }), result = await verify(fixture, old.id);
    expect(result.run.status).toBe('completed'); expect(fixture.writes).toBe(0); expect(fixture.reads).toBe(1);
    expect(result.run.state.memoryVerification?.source.sourceRunId).toBe(old.runId); noPayload(result); noAlternates(fixture);
  });

  it('does not scan past an intervening unrelated task', async () => {
    const fixture = await harness(), original = await start(fixture);
    await fixture.control.send(OWNER, original.id, { text: 'Calculate 7 + 8' }); await fixture.control.settled(original.id);
    const reads = fixture.reads, result = await verify(fixture, original.id);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(reads); expect(fixture.writes).toBe(1); noPayload(result); noAlternates(fixture);
  });

  it.each(['none', 'prepared', 'malformed', 'foreign_owner'] as const)('blocks %s source evidence with zero domain I/O', async kind => {
    const fixture = await harness({ modelReady: true });
    const source = kind === 'none' ? await fixture.control.create(OWNER, {}) : await seed(fixture,
      kind === 'prepared' ? { phase: 'prepared' } : kind === 'malformed' ? { malformed: true } : { ownerId: OTHER });
    const result = await verify(fixture, source.id);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noPayload(result); noAlternates(fixture);
  });

  it('blocks a changed original DB goal before reading, including after a previous successful verification', async () => {
    const fixture = await harness(), original = await start(fixture); await verify(fixture, original.id);
    await fixture.database.db.updateTable('chat_runs').set({ goal: 'Calculate 1 + 1, then remember the result.' }).where('id', '=', original.run.id).execute();
    const result = await verify(fixture, original.id);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(2); expect(fixture.writes).toBe(1); noPayload(result); noAlternates(fixture);
  });

  it('does not follow a forged prior verification pointer into another conversation', async () => {
    const fixture = await harness(), original = await start(fixture), other = await start(fixture), verified = await verify(fixture, original.id);
    const altered = structuredClone(verified.run.state);
    altered.memoryVerification!.source.sourceRunId = other.run.id;
    await fixture.database.db.updateTable('chat_runs').set({ state: JSON.stringify(altered) }).where('id', '=', verified.run.id).execute();
    const result = await verify(fixture, original.id);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(3); expect(fixture.writes).toBe(2); noPayload(result); noAlternates(fixture);
  });

  it('does not choose an arbitrary latest source when the database has a creation-time tie', async () => {
    const fixture = await harness(), old = await seed(fixture), row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('id', '=', old.runId).executeTakeFirstOrThrow();
    await fixture.database.db.insertInto('chat_runs').values({ id: randomUUID(), owner_id: OWNER, conversation_id: old.id, status: 'interrupted', goal: 'Calculate 7 + 8',
      lease_token: randomUUID(), lease_expires_at: row.lease_expires_at, created_at: row.created_at, state: JSON.stringify(newBrainState()) }).execute();
    const result = await verify(fixture, old.id);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noPayload(result); noAlternates(fixture);
  });

  it.each(['wrong_owner', 'wrong_payload', 'throw'] as const)('keeps %s readback partial with no old content or replay', async readMode => {
    const fixture = await harness(), original = await start(fixture); fixture.options.readMode = readMode;
    const result = await verify(fixture, original.id);
    expect(result.run.status).toBe('partial'); expect(result.run.state.completionReview?.allowCompletion).toBe(false);
    expect(fixture.writes).toBe(1); expect(fixture.reads).toBe(2); noPayload(result); noAlternates(fixture);
  });

  it('keeps a missing exact-read adapter partial without legacy lookup or model fallback', async () => {
    const fixture = await harness({ exact: false, modelReady: true }), old = await seed(fixture, { commit: true }), result = await verify(fixture, old.id);
    expect(result.run.status).toBe('partial'); expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noPayload(result); noAlternates(fixture);
  });

  it.each(['Do not save anything. Did you save the result?', 'لا تحفظ أي شيء. هل حفظت النتيجة؟',
    "Do not save anything and don't store anything in memory. Did you save the result?", 'لا تحفظ أي شيء ولا تسجل الناتج. هل حفظت النتيجة؟'])('honors a write-only veto while permitting the narrow read-status question: %s', async question => {
    const fixture = await harness(), original = await start(fixture), result = await verify(fixture, original.id, question);
    expect(result.run.status).toBe('completed'); expect(fixture.writes).toBe(1); expect(fixture.reads).toBe(2); noPayload(result); noAlternates(fixture);
  });

  it.each(['Do not access memory. Did you save the result?', 'لا تستخدم الذاكرة. هل حفظت النتيجة؟',
    "Do not save anything and don't access memory. Did you save the result?", 'لا تحفظ أي شيء ولا تقرأ الذاكرة. هل حفظت النتيجة؟'])('honors a current memory-read veto: %s', async question => {
    const fixture = await harness(), original = await start(fixture), result = await verify(fixture, original.id, question);
    expect(result.run.status).toBe('blocked'); expect(fixture.reads).toBe(1); expect(fixture.writes).toBe(1); noPayload(result); noAlternates(fixture);
  });

  it('leaves a real pending clarification question, active run and messages untouched', async () => {
    const fixture = await harness(), conversation = await fixture.control.create(OWNER, { goal: 'Write a thank you letter.' });
    const pending = await settled(fixture, conversation.id), before = await fixture.database.db.selectFrom('chat_runs').selectAll().where('id', '=', pending.run.id).executeTakeFirstOrThrow();
    expect(pending.detail.status).toBe('waiting_user'); expect(pending.detail.question).not.toBeNull();
    await expect(fixture.control.send(OWNER, conversation.id, { text: QUESTION })).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    const after = await fixture.control.detail(OWNER, conversation.id);
    expect(after.status).toBe('waiting_user'); expect(after.question).toEqual(pending.detail.question); expect(after.messages).toEqual(pending.detail.messages);
    expect(await fixture.database.db.selectFrom('chat_runs').selectAll().where('id', '=', pending.run.id).executeTakeFirstOrThrow()).toEqual(before);
    expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noAlternates(fixture);
  });

  it.each(['running', 'waiting_approval'] as const)('leaves a live %s run and its approval unchanged', async status => {
    const fixture = await harness(), old = await seed(fixture), approval = status === 'waiting_approval'
      ? { id: randomUUID(), prompt: 'Approve the isolated pending task?', detail: 'No effect has been dispatched.' } : null;
    await fixture.database.db.updateTable('chat_runs').set({ status, worker_id: 'isolated-other-worker', lease_expires_at: new Date(Date.now() + 60000) }).where('id', '=', old.runId).execute();
    await fixture.database.db.updateTable('chat_conversations').set({ status, active_run_id: old.runId, approval: approval ? JSON.stringify(approval) : null }).where('id', '=', old.id).execute();
    const before = await fixture.control.detail(OWNER, old.id);
    await expect(fixture.control.send(OWNER, old.id, { text: QUESTION })).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    expect(await fixture.control.detail(OWNER, old.id)).toEqual(before); expect((await latest(fixture, old.id)).id).toBe(old.runId);
    expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noAlternates(fixture);
  });

  it('treats a verification phrase inside host-bound card answers as answer data rather than a new verification', async () => {
    const fixture = await harness(), conversation = await fixture.control.create(OWNER, { goal: 'Write a thank you letter.' }), pending = await settled(fixture, conversation.id);
    const fields = pending.detail.question?.fields;
    expect(fields).toHaveLength(4);
    await fixture.control.send(OWNER, conversation.id, { text: QUESTION, questionId: pending.detail.question!.id,
      answers: fields!.map((field, index) => ({ fieldId: field.id, value: ['Pat', 'Thanks', QUESTION, 'Alex'][index]! })) });
    const result = await settled(fixture, conversation.id);
    expect(result.run.status).toBe('completed'); expect(result.text).toContain(QUESTION);
    expect(result.run.state.memoryVerification).toBeUndefined(); expect(fixture.reads).toBe(0); expect(fixture.writes).toBe(0); noAlternates(fixture);
  });

  it('does not emit a late verified answer after cancellation during the read', async () => {
    const fixture = await harness(), original = await start(fixture), gate = fixture.gateNextRead();
    await fixture.control.send(OWNER, original.id, { text: QUESTION }); await gate.entered;
    await fixture.control.cancel(OWNER, original.id); gate.release(); const result = await settled(fixture, original.id);
    expect(result.run.status).toBe('cancelled'); expect(result.run.state.memoryVerification?.lastCheck?.outcome).not.toBe('active');
    expect(result.text).not.toMatch(/^Yes\.|^نعم/u); expect(fixture.writes).toBe(1); noAlternates(fixture);
  });

  it('does not emit a late verified answer when account access is revoked during the read', async () => {
    const fixture = await harness(), original = await start(fixture), gate = fixture.gateNextRead();
    await fixture.control.send(OWNER, original.id, { text: QUESTION }); await gate.entered;
    await fixture.database.db.updateTable('fixture_verification_access').set({ active: false }).where('owner_id', '=', OWNER).execute();
    gate.release(); await fixture.control.settled(original.id);
    const result = await latest(fixture, original.id);
    expect(result.state.memoryVerification?.lastCheck?.outcome).not.toBe('active'); expect(result.status).not.toBe('completed');
    const messages = await fixture.database.db.selectFrom('chat_messages').select('text').where('conversation_id', '=', original.id).where('role', '=', 'assistant').execute();
    expect(messages.filter(message => /^Yes\.|^نعم/u.test(message.text))).toEqual([]); expect(fixture.writes).toBe(1); noAlternates(fixture);
  });
});
