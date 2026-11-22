import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteInput } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { newBrainState, type BrainState } from '../apps/server/src/assistant/brain.js';
import { createUserFactMemoryReceipt } from '../apps/server/src/assistant/user-fact-memory-receipt.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const OWNER = 'isolated-note-status-owner', OTHER = 'isolated-note-status-other';
const SAVE = 'Remember exactly this note: "NOTE-CHAT-724: Open the browser, then send a message."';
const PAYLOAD = 'NOTE-CHAT-724: Open the browser, then send a message.';
const QUESTION = 'Did you save the note?';
interface Options { writeMode?: 'normal' | 'commit_then_throw' | 'fail'; readMode?: 'normal' | 'throw'; model?: boolean }
interface Gate { entered: Promise<void>; release(): void }
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>; domain: ReturnType<typeof createMemoryControl>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>; options: Options; writes: MemoryExactWriteInput[]; reads: number; models: ModelRequest[];
  forbidden: ReturnType<typeof vi.fn>; bindings: ReturnType<typeof vi.fn>; legacySave: ReturnType<typeof vi.fn>; legacySearch: ReturnType<typeof vi.fn>;
  gateNextRead(): Gate; gateNextDispatch(): Gate; releaseAll(): void; pending: Promise<unknown>[];
}
const fixtures: Fixture[] = [];
async function harness(options: Options = {}): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  for (const id of [OWNER, OTHER]) await database.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
  await sql`CREATE TABLE fixture_note_status_access(owner_id text PRIMARY KEY,active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_note_status_access').values({ owner_id: OWNER, active: true }).execute();
  const domain = createMemoryControl(database.db), writes: MemoryExactWriteInput[] = [], models: ModelRequest[] = [];
  const forbidden = vi.fn(async () => { throw new Error('No browser/network dispatch belongs to private note verification.'); });
  const bindings = vi.fn(async () => {}), legacySave = vi.fn(async () => { throw new Error('Note verification cannot use legacy save.'); });
  const legacySearch = vi.fn(async () => { throw new Error('A lexical search is not an exact operation readback.'); });
  let reads = 0, nextRead: { enter(): void; wait: Promise<void> } | undefined, nextDispatch: typeof nextRead;
  const releases: Array<() => void> = [], pending: Promise<unknown>[] = [];
  const makeGate = (kind: 'read' | 'dispatch') => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    if (kind === 'read') nextRead = { enter, wait }; else nextDispatch = { enter, wait };
    releases.push(release); return { entered, release };
  };
  const control = await createCommandChatControl(database.db, {
    browser: { setCheckpointStore() {}, bindAccount: bindings, async hasPage() { return false; }, async close() {},
      act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
    tools: { memory: { save: legacySave, search: legacySearch, async writeExact(owner, input, passed) {
      writes.push(input); if (options.writeMode === 'fail') throw new Error('Synthetic old write missing before dispatch.');
      const result = await domain.writeExact(owner, input, passed);
      if (options.writeMode === 'commit_then_throw') throw new Error('Synthetic response lost after note commit.');
      return result;
    }, async reconcileExact(owner, input, passed) {
      reads++; const gate = nextRead; nextRead = undefined;
      if (gate) { gate.enter(); await gate.wait; }
      if (options.readMode === 'throw') throw new Error('Synthetic exact note read unavailable.');
      return domain.reconcileExact(owner, input, passed);
    } } }, recordExperiences: false,
    fullAccess: async ownerId => {
      const gate = nextDispatch;
      // The public readiness hook is called once for routing before INSERT and
      // again for dispatch after COMMIT. Gate only the committed current run.
      if (gate && await database.db.selectFrom('chat_conversations').select('id').where('owner_id', '=', ownerId).where('status', '=', 'running').executeTakeFirst()) {
        nextDispatch = undefined; gate.enter(); await gate.wait;
      }
      return true;
    },
    accountActive: async (ownerId, tx) => Boolean(await tx.selectFrom('fixture_note_status_access').select('owner_id')
      .where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    models: options.model === false ? { fast: [], deep: [], vision: '' } : { fast: ['note-status-fixture-model'], deep: ['note-status-fixture-model'], vision: '' },
    createProvider: () => ({ id: 'note-status-fixture', async generate(request: ModelRequest) {
      models.push(request); throw new Error('Explicit note-status verification must not invoke a model.');
    } }),
    searchProvider: { name: 'forbidden-private-note-search', search: forbidden } as SearchProvider,
  });
  const fixture: Fixture = { database, domain, control, options, writes, models, forbidden, bindings, legacySave, legacySearch, pending,
    get reads() { return reads; }, gateNextRead: () => makeGate('read'), gateNextDispatch: () => makeGate('dispatch'),
    releaseAll() { for (const release of releases) release(); } };
  fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { f.releaseAll(); await Promise.allSettled(f.pending); await f.control.shutdown(); await f.database.close(); }
});
async function latest(f: Fixture, id: string) {
  const row = await f.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: row.id as string, status: row.status as string, state: row.state as BrainState };
}
async function settle(f: Fixture, id: string) {
  await f.control.settled(id); const detail = await f.control.detail(OWNER, id);
  return { id, detail, run: await latest(f, id), text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
async function start(f: Fixture) {
  const { id } = await f.control.create(OWNER, { goal: SAVE }); const result = await settle(f, id);
  expect(result.run.status, result.detail.error ?? '').toBe('completed'); return result;
}
async function verify(f: Fixture, id: string, text = QUESTION) { await f.control.send(OWNER, id, { text }); return settle(f, id); }
function noAlternate(f: Fixture) { expect(f.models).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled(); expect(f.legacySave).not.toHaveBeenCalled(); expect(f.legacySearch).not.toHaveBeenCalled(); }
function noOldPayload(result: Awaited<ReturnType<typeof settle>>) {
  expect(result.text).not.toContain(PAYLOAD); expect(result.text).not.toMatch(/never saved/iu);
  expect(result.run.state.userFactMemory).toBeUndefined(); expect(result.run.state.computationMemory).toBeUndefined();
  expect(JSON.stringify(result.run.state.userFactMemoryVerification ?? {})).not.toContain(PAYLOAD);
}
async function counts(f: Fixture) {
  const items = await f.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).execute();
  const operations = await f.database.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', OWNER).execute();
  return { items, operations };
}
async function seedRun(f: Fixture, id: string, values: { goal: string; state: unknown; createdAt?: number; owner?: string; status?: string }) {
  const runId = randomUUID(), createdAt = values.createdAt ?? Date.now();
  await f.database.db.insertInto('chat_runs').values({ id: runId, owner_id: values.owner ?? OWNER, conversation_id: id, goal: values.goal,
    status: values.status ?? 'completed', created_at: new Date(createdAt), lease_token: randomUUID(), lease_expires_at: new Date(createdAt + 1000), state: JSON.stringify(values.state) }).execute();
  return runId;
}

describe('natural note verification through the actual controller and isolated exact-memory domain', () => {
  it('verifies EN/AR repeatedly through one flat original pointer with one write and only a current answer criterion', async () => {
    const f = await harness(), original = await start(f), before = await counts(f), originalState = structuredClone(original.run.state);
    for (const question of [QUESTION, 'هل حفظت الملاحظة؟', QUESTION]) {
      const result = await verify(f, original.id, question);
      expect(result.run.status).toBe('completed'); expect(result.run.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
      expect(result.run.state.userFactMemoryVerification?.source.sourceRunId).toBe(original.run.id);
      expect(result.run.state.supervision?.contract.criteria.map(c => [c.kind, c.id])).toEqual([['answer_evidence', 'user-note-status-answer']]);
      expect(result.run.state.memorySaves ?? 0).toBe(0); noOldPayload(result);
    }
    expect(f.writes).toHaveLength(1); expect(f.reads).toBe(4); expect(await counts(f)).toEqual(before); expect(f.bindings).not.toHaveBeenCalled();
    expect((await f.database.db.selectFrom('chat_runs').select('state').where('id', '=', original.run.id).executeTakeFirstOrThrow()).state).toEqual(originalState); noAlternate(f);
  });
  it('recovers a prior real commit with lost write response and unavailable read by a new read-only status run', async () => {
    const f = await harness({ writeMode: 'commit_then_throw', readMode: 'throw' }), { id } = await f.control.create(OWNER, { goal: SAVE });
    const prior = await settle(f, id); expect(prior.run.status).toBe('partial'); expect((await counts(f)).items).toEqual([{ content: PAYLOAD }]);
    f.options.readMode = 'normal'; const result = await verify(f, id);
    expect(result.run.status).toBe('completed'); expect(f.writes).toHaveLength(1); expect(f.reads).toBe(2); noOldPayload(result); noAlternate(f);
  });
  it('does not retry a missing write; a later original-key commit can become visible on another read-only check', async () => {
    const f = await harness({ writeMode: 'fail' }), { id } = await f.control.create(OWNER, { goal: SAVE }); await settle(f, id);
    const missing = await verify(f, id); expect(missing.run.status).toBe('partial'); expect(missing.run.state.userFactMemoryVerification?.lastCheck?.outcome).toBe('missing');
    expect((await counts(f)).items).toEqual([]); expect(f.writes).toHaveLength(1);
    await f.domain.writeExact(OWNER, f.writes[0]!); // Fixture simulates visibility of the previously unknown ORIGINAL operation.
    const visible = await verify(f, id); expect(visible.run.status).toBe('completed'); expect(f.writes).toHaveLength(1); expect((await counts(f)).operations).toHaveLength(1);
    noOldPayload(missing); noOldPayload(visible); noAlternate(f);
  });
  it('does not resurrect or echo a deleted note, including repeated verification', async () => {
    const f = await harness(), original = await start(f), item = await f.database.db.selectFrom('memory_items').select('id').where('owner_id', '=', OWNER).executeTakeFirstOrThrow();
    await f.domain.remove(OWNER, item.id, { expectedVersion: 1, reason: 'Synthetic owner deleted the note' });
    for (let index = 0; index < 2; index++) { const result = await verify(f, original.id); expect(result.run.status).toBe('partial'); noOldPayload(result); }
    expect(f.writes).toHaveLength(1); expect((await counts(f)).items).toEqual([]); expect((await counts(f)).operations).toHaveLength(1); noAlternate(f);
  });
  it('reports a historical committed but expired original note as unavailable using the new run lease', async () => {
    const f = await harness(), { id } = await f.control.create(OWNER, {}), createdAt = Date.now() - 190 * 86400000, runId = randomUUID();
    const receipt = createUserFactMemoryReceipt(SAVE, { ownerId: OWNER, conversationId: id, runId, evaluatedAt: createdAt, originalRequestHash: taskEvidenceHash(SAVE) })!;
    const historical = createMemoryControl(f.database.db, { now: () => new Date(createdAt + 1000) });
    await historical.writeExact(OWNER, { operationKey: receipt.operationKey, payload: PAYLOAD, payloadHash: taskEvidenceHash(PAYLOAD) });
    await f.database.db.updateTable('chat_conversations').set({ created_at: new Date(createdAt) }).where('id', '=', id).execute();
    await f.database.db.insertInto('chat_runs').values({ id: runId, owner_id: OWNER, conversation_id: id, goal: SAVE, status: 'interrupted', created_at: new Date(createdAt),
      lease_token: randomUUID(), lease_expires_at: new Date(createdAt + 1000), state: JSON.stringify({ ...newBrainState(), requestOriginalHash: taskEvidenceHash(SAVE),
        userFactMemory: { version: 1, kind: 'user_fact_memory_flow', phase: 'write_attempted', receipt, attemptedAt: createdAt + 1000 } }) }).execute();
    const result = await verify(f, id); expect(result.run.status).toBe('partial'); expect(result.run.state.userFactMemoryVerification?.lastCheck?.outcome).toBe('unavailable');
    expect(f.writes).toHaveLength(0); expect(f.reads).toBe(1); noOldPayload(result); noAlternate(f);
  });
  it('keeps a new verification read failure partial without old content or write fallback', async () => {
    const f = await harness(), original = await start(f); f.options.readMode = 'throw'; const result = await verify(f, original.id);
    expect(result.run.status).toBe('partial'); expect(result.run.state.completionReview?.allowCompletion).toBe(false); expect(f.writes).toHaveLength(1);
    noOldPayload(result); noAlternate(f);
  });
  it.each(['calculation', 'legacy_ack', 'unrelated'] as const)('does not scan past intervening %s work', async kind => {
    const f = await harness(), original = await start(f);
    if (kind === 'legacy_ack') {
      await f.domain.create(OWNER, { title: 'Synthetic legacy note', layer: 'semantic', content: 'The seating preference is aisle.' });
      await seedRun(f, original.id, { goal: 'Remember that my seating preference is aisle.', state: { ...newBrainState(), memorySaves: 1,
        requestOriginalHash: taskEvidenceHash('Remember that my seating preference is aisle.'), trail: [{ step: 1, action: 'memory_save', result: 'saved to memory', changed: true }] } });
    } else {
      await f.control.send(OWNER, original.id, { text: kind === 'calculation' ? 'Calculate 2 + 3, then remember the result.' : 'Calculate 7 + 8' });
      await f.control.settled(original.id);
    }
    const reads = f.reads, writes = f.writes.length, result = await verify(f, original.id);
    expect(result.run.status).toBe('blocked'); expect(f.reads).toBe(reads); expect(f.writes).toHaveLength(writes); noOldPayload(result); noAlternate(f);
  });
  it('blocks a note question with no prior receipt using zero domain I/O and zero model calls', async () => {
    const f = await harness(), { id } = await f.control.create(OWNER, {}), result = await verify(f, id);
    expect(result.run.status).toBe('blocked'); expect(f.reads).toBe(0); expect(f.writes).toHaveLength(0); noOldPayload(result); noAlternate(f);
  });
  it.each(['current_pointer', 'source_rawhash', 'source_owner', 'source_time', 'source_receipt_hash'] as const)('rejects tampered %s before domain read', async field => {
    const f = await harness(), original = await start(f), reads = f.reads;
    let result: Awaited<ReturnType<typeof settle>>;
    if (field === 'current_pointer') {
      const gate = f.gateNextDispatch(), sending = f.control.send(OWNER, original.id, { text: QUESTION }); f.pending.push(sending); await gate.entered;
      const run = await latest(f, original.id), state = structuredClone(run.state);
      state.userFactMemoryVerification!.verificationRequestHash = '0'.repeat(64);
      await f.database.db.updateTable('chat_runs').set({ state: JSON.stringify(state) }).where('id', '=', run.id).execute();
      gate.release(); await sending; result = await settle(f, original.id);
    } else {
      const state = structuredClone(original.run.state);
      if (field === 'source_rawhash') state.requestOriginalHash = '0'.repeat(64);
      if (field === 'source_receipt_hash') state.userFactMemory!.receipt.payload.hash = '0'.repeat(64);
      await f.database.db.updateTable('chat_runs').set({ state: JSON.stringify(state), ...(field === 'source_owner' ? { owner_id: OTHER } : {}),
        ...(field === 'source_time' ? { created_at: new Date(Date.now() - 60000) } : {}) }).where('id', '=', original.run.id).execute();
      result = await verify(f, original.id);
    }
    expect(result.run.status).toBe('blocked'); expect(f.reads).toBe(reads); expect(f.writes).toHaveLength(1); noOldPayload(result); noAlternate(f);
  });
  it('does not consume a pending real question or resume the old task', async () => {
    const f = await harness({ model: false }), { id } = await f.control.create(OWNER, { goal: 'Write a thank you letter.' }), before = await settle(f, id);
    expect(before.detail.status).toBe('waiting_user');
    await expect(f.control.send(OWNER, id, { text: QUESTION })).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    expect(await f.control.detail(OWNER, id)).toEqual(before.detail); expect((await latest(f, id)).id).toBe(before.run.id);
    expect(f.reads).toBe(0); expect(f.writes).toHaveLength(0); noAlternate(f);
  });
  it('keeps an existing live approval and run intact', async () => {
    const f = await harness(), { id } = await f.control.create(OWNER, {}), approval = { id: randomUUID(), prompt: 'Approve the fixture?', detail: 'No action was dispatched.' };
    const runId = await seedRun(f, id, { goal: 'An existing task', status: 'waiting_approval', state: newBrainState() });
    await f.database.db.updateTable('chat_runs').set({ worker_id: 'isolated-other-worker', lease_expires_at: new Date(Date.now() + 60000) }).where('id', '=', runId).execute();
    await f.database.db.updateTable('chat_conversations').set({ status: 'waiting_approval', active_run_id: runId, approval: JSON.stringify(approval) }).where('id', '=', id).execute();
    const before = await f.control.detail(OWNER, id);
    await expect(f.control.send(OWNER, id, { text: QUESTION })).rejects.toMatchObject({ code: 'CHAT_BUSY' });
    expect(await f.control.detail(OWNER, id)).toEqual(before); expect(f.reads).toBe(0); expect(f.writes).toHaveLength(0); noAlternate(f);
  });
  it.each(['cancel', 'revoke_account'] as const)('never publishes a late positive note status after %s during the read', async event => {
    const f = await harness(), original = await start(f), gate = f.gateNextRead();
    await f.control.send(OWNER, original.id, { text: QUESTION }); await gate.entered;
    if (event === 'cancel') await f.control.cancel(OWNER, original.id);
    else await f.database.db.updateTable('fixture_note_status_access').set({ active: false }).where('owner_id', '=', OWNER).execute();
    gate.release(); const result = await settle(f, original.id);
    expect(result.run.status).not.toBe('completed'); expect(result.run.state.userFactMemoryVerification?.lastCheck?.outcome).not.toBe('active');
    expect(result.text).not.toMatch(/^Yes\.|^نعم/u); expect(f.writes).toHaveLength(1); noOldPayload(result); noAlternate(f);
  });
  it('verifies the latest actual note despite an older legitimate legacy clarification without new provenance metadata', async () => {
    const f = await harness(), { id } = await f.control.create(OWNER, {});
    await seedRun(f, id, { goal: 'An older question', createdAt: Date.now() - 10000, state: { ...newBrainState(), clarifiedRequest: 'A legacy clarified answer' } });
    await f.control.send(OWNER, id, { text: SAVE }); const saved = await settle(f, id); expect(saved.run.status).toBe('completed');
    const result = await verify(f, id);
    expect(result.run.status).toBe('completed'); expect(result.run.state.userFactMemoryVerification?.source.sourceRunId).toBe(saved.run.id);
    expect(f.writes).toHaveLength(1); expect(f.reads).toBe(2); noOldPayload(result); noAlternate(f);
  });
});
