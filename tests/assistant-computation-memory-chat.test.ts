import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactReconciliation, type MemoryExactReconcileInput,
  type MemoryExactWriteInput, type MemoryExactWriteOptions, type MemoryExactWriteReceipt } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { AssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-computation-memory-owner', OTHER = 'isolated-computation-memory-other';
const EN = 'Calculate 2 + 3, then remember the result in my memory.';
const AR = 'احسب ٢ + ٣ ثم تذكر الناتج في ذاكرتي.';
const VALUE = 'Calculate 2 + 3. Only the result. Then remember the result in my memory.';
const PAYLOAD = '2 + 3 = 5';
interface HarnessOptions {
  modelReady?: boolean;
  exact?: 'both' | 'none' | 'write_only' | 'read_only';
  writeMode?: 'normal' | 'commit_then_throw' | 'fail_before_domain' | 'lease_expiry' | 'gate_before_domain';
  readMode?: 'normal' | 'throw' | 'malformed' | 'wrong_owner' | 'wrong_payload';
  leaseMs?: number;
  limitedAccess?: boolean;
}
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  domain: ReturnType<typeof createMemoryControl>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  options: HarnessOptions;
  modelCalls: ModelRequest[];
  writeCalls: { ownerId: string; input: MemoryExactWriteInput; options?: MemoryExactWriteOptions }[];
  readCalls: { ownerId: string; input: MemoryExactReconcileInput }[];
  domainWrites: number;
  domainReads: number;
  fenceCalls: number;
  fenceWaitMs: number;
  committed?: MemoryExactWriteReceipt;
  ready: Promise<void>;
  release(): void;
  legacySave: ReturnType<typeof vi.fn>;
  legacySearch: ReturnType<typeof vi.fn>;
  browserAction: ReturnType<typeof vi.fn>;
  publicSearch: ReturnType<typeof vi.fn>;
}
const fixtures: Fixture[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Only an ephemeral PGlite database, local memory domain and bounded model stub. */
async function harness(options: HarnessOptions = {}): Promise<Fixture> {
  const database = await createDatabase({});
  expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  for (const id of [OWNER, OTHER]) await database.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
  await sql`CREATE TABLE fixture_account_access(owner_id text PRIMARY KEY, active boolean NOT NULL)`.execute(database.db);
  for (const owner_id of [OWNER, OTHER]) await database.db.insertInto('fixture_account_access').values({ owner_id, active: true }).execute();
  const domain = createMemoryControl(database.db);
  const browserAction = vi.fn(async () => { throw new Error('No browser action belongs to this isolated computation/memory fixture.'); });
  const publicSearch = vi.fn(async () => { throw new Error('No public search belongs to this private memory fixture.'); });
  const legacySave = vi.fn(async () => { throw new Error('The legacy string-save adapter must not be used.'); });
  const legacySearch = vi.fn(async () => { throw new Error('Lexical memory search is not exact write reconciliation.'); });
  let ready!: () => void, release!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { domainWrites: 0, domainReads: 0, fenceCalls: 0, fenceWaitMs: 0, committed: undefined as MemoryExactWriteReceipt | undefined };
  const writeCalls: Fixture['writeCalls'] = [], readCalls: Fixture['readCalls'] = [], modelCalls: ModelRequest[] = [];
  const memory: NonNullable<AssistantTools['memory']> = { save: legacySave, search: legacySearch };
  const exact = options.exact ?? 'both';
  if (exact === 'both' || exact === 'write_only') memory.writeExact = async (ownerId, input, passedOptions) => {
    writeCalls.push({ ownerId, input, options: passedOptions }); ready();
    if (options.writeMode === 'gate_before_domain') await gate;
    if (options.writeMode === 'fail_before_domain') throw new Error('Isolated write transport failure before domain dispatch.');
    let domainOptions = passedOptions;
    if (options.writeMode === 'lease_expiry') {
      const originalFence = passedOptions?.fence;
      if (!originalFence) throw new Error('Controller did not supply the required transaction fence.');
      domainOptions = { ...passedOptions, fence: async (tx: Kysely<any>) => {
        state.fenceCalls++;
        if (state.fenceCalls === 2) {
          const before = Date.now();
          // The first real controller fence holds the run lock. Heartbeats are
          // blocked by this transaction while the real lease expires.
          await delay(1200); state.fenceWaitMs = Date.now() - before;
        }
        await originalFence(tx);
      } };
    }
    state.domainWrites++;
    const result = await domain.writeExact(ownerId, input, domainOptions);
    state.committed = result.receipt;
    if (options.writeMode === 'commit_then_throw') throw new Error('Isolated response loss after the exact write committed.');
    return result;
  };
  if (exact === 'both' || exact === 'read_only') memory.reconcileExact = async (ownerId, input, passedOptions) => {
    readCalls.push({ ownerId, input });
    if (options.readMode === 'throw') throw new Error('Isolated readback is temporarily unavailable.');
    state.domainReads++;
    const result = await domain.reconcileExact(ownerId, input, passedOptions);
    if (result.status !== 'verified') return result;
    if (options.readMode === 'malformed') return { ...result, scope: 'invented_scope', extra: 'not an accepted readback' } as unknown as MemoryExactReconciliation;
    if (options.readMode === 'wrong_owner') return { ...result, receipt: { ...result.receipt, ownerId: OTHER } };
    if (options.readMode === 'wrong_payload') return { ...result, item: { ...result.item, content: '2 + 3 = 6' } };
    return result;
  };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: browserAction, observe: browserAction, screen: browserAction, prepareAction: browserAction } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, tools: { memory }, recordExperiences: false, leaseMs: options.leaseMs,
    fullAccess: async () => !options.limitedAccess,
    accountActive: async (ownerId, tx) => Boolean(await tx.selectFrom('fixture_account_access').select('owner_id')
      .where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    models: options.modelReady ? { fast: ['computation-memory-fixture-model'], deep: ['computation-memory-fixture-model'], vision: '' }
      : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'computation-memory-search-must-not-run', search: publicSearch } as SearchProvider,
    ...(options.modelReady ? { createProvider: (name: string) => ({ id: 'ollama', async generate(request: ModelRequest) {
      modelCalls.push(request);
      throw new Error(`Deterministic calculation/memory must not invoke fixture model ${name}.`);
    } }) } : {}),
  });
  const fixture: Fixture = { database, domain, control, options, modelCalls, writeCalls, readCalls,
    get domainWrites() { return state.domainWrites; }, get domainReads() { return state.domainReads; },
    get fenceCalls() { return state.fenceCalls; }, get fenceWaitMs() { return state.fenceWaitMs; }, get committed() { return state.committed; },
    ready: readiness, release, legacySave, legacySearch, browserAction, publicSearch };
  fixtures.push(fixture); return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const closing = fixture.control.shutdown(); // Abort before releasing any delayed fixture call.
    fixture.release(); await closing; await fixture.database.close();
  }
});

async function stored(fixture: Fixture, id: string) {
  const run = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: run.id as string, status: run.status as string, state: run.state as BrainState };
}
async function rows(fixture: Fixture) {
  const [items, operations, evidence] = await Promise.all([
    fixture.database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', OWNER).execute(),
    fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute(),
    fixture.database.db.selectFrom('memory_evidence').selectAll().where('owner_id', '=', OWNER).execute(),
  ]);
  return { items, operations, evidence };
}
async function settle(fixture: Fixture, id: string) {
  await fixture.control.settled(id);
  const detail = await fixture.control.detail(OWNER, id), run = await stored(fixture, id);
  return { id, detail, run };
}
async function start(fixture: Fixture, request = EN) {
  const conversation = await fixture.control.create(OWNER, { goal: request });
  return settle(fixture, conversation.id);
}
function noAlternateDispatch(fixture: Fixture) {
  expect(fixture.legacySave).not.toHaveBeenCalled(); expect(fixture.legacySearch).not.toHaveBeenCalled();
  expect(fixture.browserAction).not.toHaveBeenCalled(); expect(fixture.publicSearch).not.toHaveBeenCalled();
  expect(fixture.modelCalls).toEqual([]);
}
function noAffirmativeSavedReply(text: string) {
  expect(text).not.toMatch(/(?:^|\n|[.!?]\s+)(?:Saved the verified result|I (?:have )?(?:saved|stored)|حفظت النتيجة|تم حفظ النتيجة)/iu);
}
async function expectVerified(fixture: Fixture, request = EN) {
  const result = await start(fixture, request), saved = await rows(fixture);
  expect(result.detail.status, result.detail.error ?? '').toBe('idle'); expect(result.detail.error).toBeNull();
  expect(result.run.status).toBe('completed');
  expect(result.run.state.computationMemory?.phase).toBe('verified'); expect(result.run.state.memorySaves).toBe(1);
  expect(result.run.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true, missingCriteria: [] });
  expect(result.run.state.supervision?.contract.criteria.map(item => item.id)).toEqual(['computed-answer', 'computed-memory-save']);
  expect(result.run.state.completionReview?.criteria.map(item => item.status)).toEqual(['verified', 'verified']);
  expect(fixture.writeCalls).toHaveLength(1); expect(fixture.readCalls).toHaveLength(1); expect(fixture.domainWrites).toBe(1);
  expect(fixture.writeCalls[0]).toMatchObject({ ownerId: OWNER, input: { payload: PAYLOAD } });
  expect(fixture.writeCalls[0].options?.signal).toBeInstanceOf(AbortSignal); expect(typeof fixture.writeCalls[0].options?.fence).toBe('function');
  expect(saved.items).toHaveLength(1); expect(saved.operations).toHaveLength(1); expect(saved.evidence).toHaveLength(1);
  expect(saved.items[0].content).toBe(PAYLOAD); expect(saved.items[0].content).not.toContain(request);
  const effect = result.run.state.supervision?.steps.flatMap(step => step.observations).find(item => item.kind === 'effect');
  expect(effect).toMatchObject({ source: 'authoritative-readback', independentlyVerified: true, outcome: 'confirmed',
    actionRef: fixture.writeCalls[0].input.operationKey, reference: `memory:${saved.items[0].id}:1` });
  noAlternateDispatch(fixture);
  expect(await fixture.database.db.selectFrom('experiences').select('source_id').where('owner_id', '=', OWNER).execute()).toEqual([]);
  expect(await fixture.database.db.selectFrom('chat_model_receipts').select('id').execute()).toEqual([]);
  return { ...result, saved };
}

describe('verified calculation and memory through the actual isolated chat controller', () => {
  it.each([EN, AR])('saves the exact explanatory quote and verifies both criteria: %s', async request => {
    const fixture = await harness(), result = await expectVerified(fixture, request);
    expect(result.detail.messages.at(-1)?.text).toContain('5');
  });

  it('uses the same deterministic path with a model configured and makes zero model calls', async () => {
    const fixture = await harness({ modelReady: true }); await expectVerified(fixture);
  });

  it('allows an active limited member to save their own result without requiring full access', async () => {
    const fixture = await harness({ limitedAccess: true, modelReady: true }); await expectVerified(fixture);
  });

  it('keeps a value-only final answer exactly5 while storing the explanatory quote', async () => {
    const fixture = await harness(), result = await expectVerified(fixture, VALUE);
    expect(result.detail.messages.at(-1)?.text).toBe('5'); expect(result.saved.items[0].content).toBe(PAYLOAD);
  });

  it('recovers response loss after commit with read-only confirmation and exactly one write', async () => {
    const fixture = await harness({ writeMode: 'commit_then_throw', modelReady: true });
    const result = await expectVerified(fixture);
    expect(fixture.committed?.itemId).toBe(result.saved.items[0].id);
    await fixture.control.settled(result.id); await fixture.control.detail(OWNER, result.id);
    expect(fixture.writeCalls).toHaveLength(1); expect((await rows(fixture)).items).toHaveLength(1);
  });

  it('reports unresolved readback as partial without claiming a verified save or retrying', async () => {
    const fixture = await harness({ readMode: 'throw', modelReady: true }), result = await start(fixture);
    expect(result.run.status).toBe('partial'); expect(result.detail.status).toBe('idle');
    expect(result.run.state.computationMemory).toMatchObject({ phase: 'unknown', reason: 'readback_unavailable' });
    expect(result.run.state.completionReview?.allowCompletion).toBe(false);
    expect(result.run.state.completionReview?.criteria.find(item => item.id === 'computed-memory-save')?.status).toBe('unverified');
    noAffirmativeSavedReply(result.detail.messages.at(-1)!.text);
    expect(fixture.writeCalls).toHaveLength(1); expect(fixture.readCalls).toHaveLength(1); expect((await rows(fixture)).items).toHaveLength(1);
    await fixture.control.settled(result.id); expect(fixture.writeCalls).toHaveLength(1); noAlternateDispatch(fixture);
  });

  it('reports a missing write as partial and never retries the create call', async () => {
    const fixture = await harness({ writeMode: 'fail_before_domain' }), result = await start(fixture);
    expect(result.run.status).toBe('partial'); expect(result.run.state.computationMemory).toMatchObject({ phase: 'unknown', reason: 'missing' });
    expect(fixture.writeCalls).toHaveLength(1); expect(fixture.domainWrites).toBe(0); expect(fixture.readCalls).toHaveLength(1);
    expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    noAffirmativeSavedReply(result.detail.messages.at(-1)!.text); noAlternateDispatch(fixture);
    await fixture.control.detail(OWNER, result.id); expect(fixture.writeCalls).toHaveLength(1);
  });

  it.each(['none', 'write_only', 'read_only'] as const)('keeps an incomplete %s exact capability partial without legacy or model fallback', async exact => {
    const fixture = await harness({ exact, modelReady: true }), result = await start(fixture);
    expect(result.run.status).toBe('partial'); expect(result.run.state.computationMemory?.phase).toBe('prepared');
    expect(result.run.state.memorySaves ?? 0).toBe(0); expect(result.run.state.completionReview?.allowCompletion).toBe(false);
    expect(fixture.writeCalls).toEqual([]); expect(fixture.readCalls).toEqual([]); expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    noAffirmativeSavedReply(result.detail.messages.at(-1)!.text); noAlternateDispatch(fixture);
  });

  it.each(['malformed', 'wrong_owner', 'wrong_payload'] as const)('rejects a %s readback without claiming completion or overwriting storage', async readMode => {
    const fixture = await harness({ readMode }), result = await start(fixture);
    expect(result.run.status).toBe('partial'); expect(result.run.state.computationMemory).toMatchObject({ phase: 'unknown', reason: 'invalid_readback' });
    expect(result.run.state.completionReview?.allowCompletion).toBe(false); noAffirmativeSavedReply(result.detail.messages.at(-1)!.text);
    expect(fixture.writeCalls).toHaveLength(1); expect(fixture.readCalls).toHaveLength(1);
    expect((await rows(fixture)).items.map(item => item.content)).toEqual([PAYLOAD]); noAlternateDispatch(fixture);
  });

  it.each([
    'Calculate 2 + 3, then remember the result in my memory, but do not save anything.',
    'Calculate 7 / 0, then remember the result in my memory.',
    'احسب ٢ + ٣ ثم لا تحفظ الناتج في الذاكرة.',
  ])('performs no exact write for negative or invalid computation: %s', async request => {
    const fixture = await harness(), result = await start(fixture, request);
    expect(fixture.writeCalls).toEqual([]); expect(fixture.readCalls).toEqual([]);
    expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    noAffirmativeSavedReply(result.detail.messages.at(-1)!.text); noAlternateDispatch(fixture);
  });

  it('rolls every domain row back when the real chat lease expires inside the locked memory transaction', async () => {
    const fixture = await harness({ leaseMs: 1000, writeMode: 'lease_expiry' });
    const result = await start(fixture);
    expect(fixture.writeCalls).toHaveLength(1); expect(fixture.domainWrites).toBe(1); expect(fixture.fenceCalls).toBe(2);
    expect(fixture.fenceWaitMs).toBeGreaterThanOrEqual(1150);
    expect(fixture.committed).toBeUndefined(); expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    expect(result.run.status).not.toBe('completed'); expect(result.run.state.computationMemory?.phase).not.toBe('verified');
    expect(result.detail.messages.filter(message => message.role === 'assistant').some(message => /Saved the verified result|حفظت النتيجة/u.test(message.text))).toBe(false);
    noAlternateDispatch(fixture);
  });

  it('cancels before the delayed domain call and cannot publish a late successful write', async () => {
    const fixture = await harness({ writeMode: 'gate_before_domain' });
    const conversation = await fixture.control.create(OWNER, { goal: EN });
    await expect.poll(() => fixture.writeCalls.length).toBe(1);
    await fixture.ready;
    expect(fixture.domainWrites).toBe(0);
    await fixture.control.cancel(OWNER, conversation.id);
    expect(fixture.writeCalls[0].options?.signal?.aborted).toBe(true);
    fixture.release();
    const result = await settle(fixture, conversation.id);
    expect(result.run.status).toBe('cancelled'); expect(result.detail.status).toBe('idle');
    expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    expect(fixture.committed).toBeUndefined();
    expect(result.detail.messages.filter(message => message.role === 'assistant').some(message => /Saved the verified result|حفظت النتيجة/u.test(message.text))).toBe(false);
    noAlternateDispatch(fixture);
  });

  it('rejects account revocation after durable preparation and before the real domain write', async () => {
    const fixture = await harness({ writeMode: 'gate_before_domain', limitedAccess: true });
    const conversation = await fixture.control.create(OWNER, { goal: EN });
    await expect.poll(() => fixture.writeCalls.length).toBe(1); await fixture.ready;
    const before = await stored(fixture, conversation.id);
    expect(before.state.computationMemory?.phase).toBe('write_attempted'); expect(before.state.memorySaves).toBe(1);
    expect(fixture.domainWrites).toBe(0);
    await fixture.database.db.updateTable('fixture_account_access').set({ active: false }).where('owner_id', '=', OWNER).execute();
    fixture.release();
    const result = await settle(fixture, conversation.id);
    expect(fixture.domainWrites).toBe(1); // Domain entry occurs, but the actual same-TX host fence rejects every insert.
    expect(fixture.committed).toBeUndefined(); expect(await rows(fixture)).toEqual({ items: [], operations: [], evidence: [] });
    expect(result.run.status).not.toBe('completed'); expect(result.run.state.computationMemory?.phase).not.toBe('verified');
    expect(result.detail.messages.filter(message => message.role === 'assistant').some(message => /Saved the verified result|حفظت النتيجة/u.test(message.text))).toBe(false);
    noAlternateDispatch(fixture);
  });
});
