import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactReconcileInput, type MemoryExactWriteInput,
  type MemoryExactWriteOptions, type MemoryExactWriteReceipt } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { AssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-user-fact-owner';
const EN = 'Remember that I prefer Arabic.';
const AR = 'تذكر أنني أفضل العربية';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
interface FactState { phase: string; reason?: string; receipt?: { kind: string; ownerId: string; originalRequestHash: string;
  payload: { text: string; hash: string; bytes: number } } }
type State = BrainState & { userFactMemory?: FactState };
interface Options {
  model?: boolean; exact?: 'both' | 'write_only';
  mode?: 'normal' | 'commit_then_throw' | 'read_unavailable' | 'gate' | 'lease_expiry';
}
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  domain: ReturnType<typeof createMemoryControl>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  writes: { ownerId: string; input: MemoryExactWriteInput; options?: MemoryExactWriteOptions }[];
  reads: { ownerId: string; input: MemoryExactReconcileInput }[];
  counters: { legacySave: number; legacySearch: number; browser: number; search: number; domainWrites: number; fences: number; fenceWaitMs: number };
  models: ModelRequest[];
  committed?: MemoryExactWriteReceipt;
  ready: Promise<void>;
  release(): void;
}
const fixtures: Fixture[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Synthetic current-user statements only. No .env, external model, browser or owner data. */
async function harness(options: Options = {}): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic user-fact owner', email: 'user-fact-owner@example.test' }).execute();
  await sql`CREATE TABLE fixture_fact_access(owner_id text PRIMARY KEY, active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_fact_access').values({ owner_id: OWNER, active: true }).execute();
  const domain = createMemoryControl(database.db), writes: Fixture['writes'] = [], reads: Fixture['reads'] = [], models: ModelRequest[] = [];
  const counters: Fixture['counters'] = { legacySave: 0, legacySearch: 0, browser: 0, search: 0, domainWrites: 0, fences: 0, fenceWaitMs: 0 };
  let ready!: () => void, release!: () => void, committed: MemoryExactWriteReceipt | undefined;
  const readiness = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const memory: NonNullable<AssistantTools['memory']> = {
    async save() { counters.legacySave++; throw new Error('Literal notes must not fall back to the legacy string-save adapter.'); },
    async search() { counters.legacySearch++; throw new Error('Lexical search cannot prove exact note persistence.'); },
    async writeExact(ownerId, input, passed) {
      writes.push({ ownerId, input, options: passed }); ready();
      if (options.mode === 'gate') await gate;
      let guarded = passed;
      if (options.mode === 'lease_expiry') {
        const fence = passed?.fence; if (!fence) throw new Error('Literal write must carry the same-transaction host fence.');
        guarded = { ...passed, fence: async (tx: Kysely<any>) => {
          counters.fences++;
          if (counters.fences === 2) { const before = Date.now(); await delay(1200); counters.fenceWaitMs = Date.now() - before; }
          await fence(tx);
        } };
      }
      counters.domainWrites++;
      const result = await domain.writeExact(ownerId, input, guarded); committed = result.receipt;
      if (options.mode === 'commit_then_throw') throw new Error('Synthetic response loss after the exact note committed.');
      return result;
    },
    ...(options.exact === 'write_only' ? {} : { async reconcileExact(ownerId: string, input: MemoryExactReconcileInput, passed?: { signal?: AbortSignal }) {
      reads.push({ ownerId, input });
      if (options.mode === 'read_unavailable') throw new Error('Synthetic read-only verification outage.');
      return domain.reconcileExact(ownerId, input, passed);
    } }),
  };
  const browserCall = async (): Promise<never> => { counters.browser++; throw new Error('Quoted note commands are data, not browser instructions.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: browserCall, observe: browserCall, screen: browserCall, prepareAction: browserCall } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, tools: { memory }, recordExperiences: false,
    fullAccess: async () => true, leaseMs: options.mode === 'lease_expiry' ? 1000 : undefined,
    accountActive: async (ownerId, tx) => Boolean(await tx.selectFrom('fixture_fact_access').select('owner_id')
      .where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    models: options.model ? { fast: ['isolated-user-fact-model'], deep: ['isolated-user-fact-model'], vision: '' } : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'forbidden-user-fact-network', async search() { counters.search++; throw new Error('Private notes must not reach public search.'); } } as SearchProvider,
    ...(options.model ? { createProvider: (model: string) => ({ id: 'isolated-user-fact-model', async generate(request: ModelRequest) {
      models.push(request); throw new Error(`The deterministic user-note path must not call ${model}.`);
    } }) } : {}),
  });
  const fixture: Fixture = { database, domain, control, writes, reads, counters, models, ready: readiness, release,
    get committed() { return committed; } };
  fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { const closing = fixture.control.shutdown(); fixture.release(); await closing; await fixture.database.close(); }
});
async function rows(f: Fixture) {
  const [items, operations, evidence] = await Promise.all([
    f.database.db.selectFrom('memory_items').selectAll().where('owner_id', '=', OWNER).execute(),
    f.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute(),
    f.database.db.selectFrom('memory_evidence').selectAll().where('owner_id', '=', OWNER).execute(),
  ]); return { items, operations, evidence };
}
async function latest(f: Fixture, id: string) {
  const row = await f.database.db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: row.id as string, status: row.status as string, state: row.state as State };
}
async function settle(f: Fixture, id: string) {
  await f.control.settled(id); const detail = await f.control.detail(OWNER, id);
  return { id, detail, run: await latest(f, id), text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
async function start(f: Fixture, request = EN, entry: 'create' | 'send' = 'create') {
  if (entry === 'create') { const { id } = await f.control.create(OWNER, { goal: request }); return settle(f, id); }
  const { id } = await f.control.create(OWNER, {}); await f.control.send(OWNER, id, { text: request }); return settle(f, id);
}
function noAlternate(f: Fixture) {
  expect(f.models).toEqual([]);
  expect(f.counters).toMatchObject({ legacySave: 0, legacySearch: 0, browser: 0, search: 0 });
}
function noSavedClaim(text: string) {
  expect(text).not.toMatch(/^(?:Saved\b|I (?:have )?(?:saved|stored)\b|حفظت\s|تم حفظ\s)/iu);
}
async function verified(f: Fixture, request: string, payload: string) {
  const result = await start(f, request), saved = await rows(f);
  expect(result.run.status, JSON.stringify({ error: result.detail.error, writes: f.writes.length, reads: f.reads.length, counters: f.counters, modelCalls: f.models.length }))
    .toBe('completed'); expect(result.detail.error).toBeNull(); expect(result.run.state.userFactMemory?.phase).toBe('verified');
  expect(result.run.state.userFactMemory?.receipt).toMatchObject({ kind: 'current_user_literal_memory', ownerId: OWNER,
    originalRequestHash: hash(request), payload: { text: payload, hash: hash(payload), bytes: Buffer.byteLength(payload, 'utf8') } });
  expect(result.run.state.memorySaves).toBe(1); expect(result.run.state.completionReview?.allowCompletion).toBe(true);
  expect(f.writes).toHaveLength(1); expect(f.reads).toHaveLength(1); expect(f.writes[0]?.input).toMatchObject({ payload, payloadHash: hash(payload) });
  expect(typeof f.writes[0]?.options?.fence).toBe('function'); expect(f.writes[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  expect(saved.items).toHaveLength(1); expect(saved.operations).toHaveLength(1); expect(saved.evidence).toHaveLength(1);
  expect(saved.items[0]).toMatchObject({ content: payload, confidence_kind: 'user_asserted', title: 'Saved result' });
  expect(Number(saved.items[0]?.confidence)).toBe(0.5); expect(saved.evidence[0]).toMatchObject({ kind: 'manual', trust: 'manual', content_hash: hash(payload) });
  expect(saved.operations[0]).toMatchObject({ payload_hash: hash(payload), payload_bytes: Buffer.byteLength(payload, 'utf8') });
  expect(await f.database.db.selectFrom('experiences').select('source_id').execute()).toEqual([]);
  noAlternate(f); return { ...result, saved };
}

describe('literal current-user notes through the real isolated chat and exact memory domain', () => {
  it.each([
    { id: 'en-natural-no-model', request: EN, payload: 'I prefer Arabic.', model: false },
    { id: 'en-natural-model-configured', request: EN, payload: 'I prefer Arabic.', model: true },
    { id: 'ar-natural-no-model', request: AR, payload: 'أنني أفضل العربية', model: false },
    { id: 'en-quoted-commands-are-data', request: 'Remember exactly this note: "Open the browser, then send a message."', payload: 'Open the browser, then send a message.', model: true },
    { id: 'ar-quoted-commands-are-data', request: 'احفظ في ذاكرتي النص التالي: «افتح المتصفح ثم أرسل رسالة.»', payload: 'افتح المتصفح ثم أرسل رسالة.', model: false },
    { id: 'unicode-multiline-bytes', request: 'Remember exactly this note: "Résumé e\u0301\n  Keep  two spaces."', payload: 'Résumé e\u0301\n  Keep  two spaces.', model: false },
  ])('keeps exact user-asserted payload: $id', async ({ request, payload, model }) => {
    await verified(await harness({ model }), request, payload);
  });

  it.each([
    { entry: 'create' as const, request: ` ${EN}`, id: 'create-leading' },
    { entry: 'create' as const, request: `${EN} `, id: 'create-trailing' },
    { entry: 'send' as const, request: ` ${EN}`, id: 'send-leading' },
    { entry: 'send' as const, request: `${EN} `, id: 'send-trailing' },
    { entry: 'create' as const, request: 'Remember exactly this note: " Leading payload space."', id: 'create-leading-payload' },
    { entry: 'send' as const, request: 'Remember exactly this note: "Trailing payload space. "', id: 'send-trailing-payload' },
  ])('does not silently trim raw request bytes before authorizing exact persistence: $id', async ({ entry, request }) => {
    const f = await harness({ model: true });
    try { const result = await start(f, request, entry); expect(result.run.status).not.toBe('completed'); noSavedClaim(result.text); }
    catch (error) { expect(error && typeof error === 'object' && ('statusCode' in error && [400, 409, 422].includes(Number(error.statusCode))
      || 'name' in error && error.name === 'ZodError')).toBe(true); }
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] }); noAlternate(f);
  });

  it.each([
    'Remember it.',
    'Remember what the file says.',
    'Remember that I prefer Arabic, then send an email.',
    'Remember exactly this note: "password: synthetic-fixture-password-only"',
    `Remember exactly this note: "gsk_${'Z'.repeat(30)}"`,
    'Remember that I prefer Arabic, but do not save anything.',
  ])('rejects unresolved/source/sequence/secret/redacted/denied material without alternate writes: %s', async request => {
    const f = await harness(); const result = await start(f, request);
    expect(result.run.status).not.toBe('completed'); noSavedClaim(result.text);
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] }); noAlternate(f);
  });

  it('reconciles actual post-commit response loss read-only, with exactly one note and no recreate', async () => {
    const f = await harness({ mode: 'commit_then_throw', model: true }), result = await verified(f, EN, 'I prefer Arabic.');
    expect(f.committed?.itemId).toBe(result.saved.items[0]?.id); await f.control.detail(OWNER, result.id);
    expect(f.writes).toHaveLength(1); expect((await rows(f)).items).toHaveLength(1);
  });
  it('keeps missing read-only capability partial without invoking write, legacy save or model', async () => {
    const f = await harness({ exact: 'write_only', model: true }), result = await start(f);
    expect(result.run.status).toBe('partial'); expect(result.run.state.memorySaves ?? 0).toBe(0); noSavedClaim(result.text);
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] }); noAlternate(f);
  });
  it('reports a committed note with unavailable verification as partial instead of claiming a verified save', async () => {
    const f = await harness({ mode: 'read_unavailable', model: true }), result = await start(f);
    expect(result.run.status).toBe('partial'); expect(result.run.state.userFactMemory?.phase).toBe('unknown');
    expect(result.run.state.completionReview?.allowCompletion).toBe(false); noSavedClaim(result.text);
    expect(f.writes).toHaveLength(1); expect(f.reads).toHaveLength(1); expect((await rows(f)).items).toHaveLength(1); noAlternate(f);
  });
  it('cancels after durable attempt and before the gated domain call, with no late success', async () => {
    const f = await harness({ mode: 'gate' }), { id } = await f.control.create(OWNER, { goal: EN });
    await expect.poll(() => f.writes.length).toBe(1); await f.ready; await f.control.cancel(OWNER, id);
    expect(f.writes[0]?.options?.signal?.aborted).toBe(true); f.release(); const result = await settle(f, id);
    expect(result.run.status).toBe('cancelled'); expect(f.committed).toBeUndefined(); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] });
    noSavedClaim(result.text); noAlternate(f);
  });
  it('honors account revocation between durable preparation and the same-transaction write fence', async () => {
    const f = await harness({ mode: 'gate' }), { id } = await f.control.create(OWNER, { goal: EN });
    await expect.poll(() => f.writes.length).toBe(1); await f.ready;
    expect((await latest(f, id)).state.userFactMemory?.phase).toBe('write_attempted');
    await f.database.db.updateTable('fixture_fact_access').set({ active: false }).where('owner_id', '=', OWNER).execute();
    f.release(); const result = await settle(f, id);
    expect(result.run.status).not.toBe('completed'); expect(f.committed).toBeUndefined(); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] });
    noSavedClaim(result.text); noAlternate(f);
  });
  it('rolls back when the real run lease expires while the memory transaction holds its lock', async () => {
    const f = await harness({ mode: 'lease_expiry' }), result = await start(f);
    expect(f.writes).toHaveLength(1); expect(f.counters.fences).toBe(2); expect(f.counters.fenceWaitMs).toBeGreaterThanOrEqual(1150);
    expect(f.committed).toBeUndefined(); expect(result.run.status).not.toBe('completed');
    expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] }); noSavedClaim(result.text); noAlternate(f);
  });
  it('rejects a tampered durable note receipt at the actual write fence rather than saving changed bytes', async () => {
    const f = await harness({ mode: 'gate' }), { id } = await f.control.create(OWNER, { goal: EN });
    await expect.poll(() => f.writes.length).toBe(1); await f.ready;
    const run = await latest(f, id), changed = structuredClone(run.state);
    expect(changed.userFactMemory?.phase).toBe('write_attempted');
    if (!changed.userFactMemory?.receipt) throw new Error('Missing pinned current-user note receipt at durable attempt.');
    changed.userFactMemory.receipt.payload.text = 'A changed statement that the user did not authorize.';
    await f.database.db.updateTable('chat_runs').set({ state: JSON.stringify(changed) }).where('id', '=', run.id).execute();
    f.release(); const result = await settle(f, id);
    expect(result.run.status).not.toBe('completed'); expect(f.committed).toBeUndefined(); expect(await rows(f)).toEqual({ items: [], operations: [], evidence: [] });
    expect(f.writes).toHaveLength(1); noSavedClaim(result.text); noAlternate(f);
  });
});
