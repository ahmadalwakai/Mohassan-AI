import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactWriteInput } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';
import { taskEvidenceHash } from '../apps/server/src/assistant/task-supervisor.js';

const OWNER = 'isolated-current-declaration-owner';
const EN = 'Remember that my home city is Bristol.', AR = 'تذكر أن مدينتي المفضلة هي مسقط';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
type Options = { model?: boolean; allowSearch?: boolean; failRead?: boolean; loseWriteResponse?: boolean; gateDispatch?: boolean };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  domain: ReturnType<typeof createMemoryControl>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  options: Options; requests: ModelRequest[]; script: Script[]; writes: MemoryExactWriteInput[];
  counters: { reads: number; searches: number; legacyCreates: number };
  forbidden: ReturnType<typeof vi.fn>; restartWithModel(): Promise<void>;
  dispatchEntered: Promise<void>; releaseDispatch(): void; pending: Promise<unknown>[];
}
const fixtures: Fixture[] = [];
async function harness(options: Options = {}): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic declaration owner', email: 'declaration-owner@example.test' }).execute();
  const domain = createMemoryControl(database.db), requests: ModelRequest[] = [], script: Script[] = [], writes: MemoryExactWriteInput[] = [];
  const counters = { reads: 0, searches: 0, legacyCreates: 0 };
  let enterDispatch!: () => void, releaseDispatch!: () => void, dispatchUsed = false;
  const dispatchEntered = new Promise<void>(resolve => { enterDispatch = resolve; }), dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
  const pending: Promise<unknown>[] = [];
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('No browser, network or work effect belongs to this fixture.'); });
  const tools = createAssistantTools({
    memory: {
      async create(owner, input) { counters.legacyCreates++; return domain.create(owner, input); },
      async search(owner, input, readOptions) {
        counters.searches++;
        if (!options.allowSearch) throw new Error('This fixture does not authorize lexical memory search.');
        return domain.search(owner, input, readOptions);
      },
      async writeExact(owner, input, passed) {
        writes.push(input); expect(typeof passed?.fence).toBe('function'); expect(passed?.signal).toBeInstanceOf(AbortSignal);
        const result = await domain.writeExact(owner, input, passed);
        if (options.loseWriteResponse) throw new Error('Synthetic response loss after the original declaration committed.');
        return result;
      },
      async reconcileExact(owner, input, passed) {
        counters.reads++;
        if (options.failRead) throw new Error('Synthetic read-only reconciliation outage.');
        return domain.reconcileExact(owner, input, passed);
      },
    },
    coding: { available: false, workspace: async () => ({ projects: [] }) },
    studio: { workspace: async () => ({ sessions: [] }), detail: forbidden }, studioChange: false,
    runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden },
    windows: { enabled: false, view: forbidden, act: forbidden, command: forbidden },
  });
  const build = (model: boolean) => createCommandChatControl(database.db, {
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      act: forbidden, screen: forbidden, observe: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
    tools: { memory: tools.memory }, recordExperiences: false, fullAccess: async owner => {
      if (options.gateDispatch && !dispatchUsed && await database.db.selectFrom('chat_conversations').select('id')
        .where('owner_id', '=', owner).where('status', '=', 'running').executeTakeFirst()) {
        dispatchUsed = true; enterDispatch(); await dispatchGate;
      }
      return true;
    },
    models: model ? { fast: ['declaration-fixture-model'], deep: ['declaration-fixture-model'], vision: '' } : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'forbidden-declaration-network', search: forbidden } as SearchProvider,
    createProvider: modelId => ({ id: 'declaration-fixture-model', async generate(request: ModelRequest) {
      requests.push(request);
      if (!script.length) throw new Error('The explicit deterministic declaration/status path must not invoke a model.');
      return { model: modelId, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...script.shift() }) };
    } }),
  });
  const fixture: Fixture = { database, domain, options, requests, script, writes, counters, forbidden, dispatchEntered, releaseDispatch, pending,
    control: await build(Boolean(options.model)),
    async restartWithModel() { await fixture.control.shutdown(); fixture.control = await build(true); } };
  fixtures.push(fixture); return fixture;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { f.releaseDispatch(); await Promise.allSettled(f.pending); await f.control.shutdown(); await f.database.close(); } });
async function settle(f: Fixture, id: string) {
  await f.control.settled(id);
  const detail = await f.control.detail(OWNER, id), row = await f.database.db.selectFrom('chat_runs').select(['id', 'status', 'state'])
    .where('conversation_id', '=', id).orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id, detail, status: row.status as string, state: row.state as BrainState, runId: row.id as string,
    text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
async function start(f: Fixture, raw = EN) { const { id } = await f.control.create(OWNER, { goal: raw }); return settle(f, id); }
async function follow(f: Fixture, id: string, text: string) { await f.control.send(OWNER, id, { text }); return settle(f, id); }
async function saved(f: Fixture) {
  const items = await f.database.db.selectFrom('memory_items').select(['content', 'confidence_kind']).where('owner_id', '=', OWNER).execute();
  const operations = await f.database.db.selectFrom('memory_exact_operations').select('operation_key').where('owner_id', '=', OWNER).execute();
  const evidence = await f.database.db.selectFrom('memory_evidence').select(['kind', 'trust']).where('owner_id', '=', OWNER).execute();
  return { items, operations, evidence };
}
function noAlternate(f: Fixture) {
  expect(f.requests).toEqual([]); expect(f.counters.legacyCreates).toBe(0); expect(f.forbidden).not.toHaveBeenCalled();
}

describe('simple current-user declarations through actual chat and exact memory', () => {
  it.each([[EN, 'my home city is Bristol.', 14], [AR, 'مدينتي المفضلة هي مسقط', 8]] as const)
    ('saves the exact literal scalar assertion without a model: %s', async (raw, payload, startAt) => {
      const f = await harness(), result = await start(f, raw), rows = await saved(f);
      expect(result.status, result.detail.error ?? result.text).toBe('completed');
      expect(result.state.userFactMemory).toMatchObject({ phase: 'verified', receipt: { statementKind: 'current_declaration',
        originalRequestHash: taskEvidenceHash(raw), payload: { text: payload, hash: taskEvidenceHash(payload), bytes: Buffer.byteLength(payload) },
        payloadSpan: { start: startAt, end: raw.length } } });
      expect(result.state.completionReview?.allowCompletion).toBe(true);
      expect(rows.items).toEqual([{ content: payload, confidence_kind: 'user_asserted' }]); expect(rows.operations).toHaveLength(1);
      expect(rows.evidence).toEqual([{ kind: 'manual', trust: 'manual' }]); expect(f.writes).toHaveLength(1); expect(f.counters.reads).toBe(1);
      expect(result.state.supervision?.contract.criteria.map(c => c.kind)).toEqual(['effect']); noAlternate(f);
    });

  it('verifies the new declaration on subsequent EN/AR note-status turns without another write', async () => {
    const f = await harness(), original = await start(f), before = await saved(f);
    for (const question of ['Did you save the note?', 'هل حفظت الملاحظة؟']) {
      const checked = await follow(f, original.id, question);
      expect(checked.status).toBe('completed'); expect(checked.state.userFactMemory).toBeUndefined();
      expect(checked.state.userFactMemoryVerification?.source.sourceRunId).toBe(original.runId);
      expect(checked.state.supervision?.contract.criteria.map(c => [c.kind, c.id])).toEqual([['answer_evidence', 'user-note-status-answer']]);
    }
    expect(f.writes).toHaveLength(1); expect(f.counters.reads).toBe(3); expect(await saved(f)).toEqual(before); noAlternate(f);
  });

  it('retains the configured model legacy acknowledgment lane without an exact supervisor or operation', async () => {
    const f = await harness({ model: true });
    f.script.push({ tool: 'memory_save', text: 'my home city is Bristol.' }, { tool: 'answer', text: 'I saved your home city in memory.', outcome: 'done' });
    const result = await start(f), rows = await saved(f);
    expect(f.requests).toHaveLength(2); expect(f.counters.legacyCreates).toBe(1); expect(f.writes).toEqual([]); expect(f.counters.reads).toBe(0);
    expect(result.state.userFactMemory).toBeUndefined(); expect(result.state.supervision?.contract.criteria.some(c => c.id === 'user-fact-memory-save')).toBe(false);
    expect(rows.items).toHaveLength(1); expect(rows.operations).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  });

  it('restores a prior unknown declaration under later model configuration using read-only note verification', async () => {
    const f = await harness({ loseWriteResponse: true, failRead: true }), original = await start(f);
    expect(original.status).toBe('partial'); expect(original.state.userFactMemory?.phase).toBe('unknown');
    expect((await saved(f)).operations).toHaveLength(1);
    f.options.failRead = false; await f.restartWithModel();
    const checked = await follow(f, original.id, 'Did you save the note?');
    expect(checked.status).toBe('completed'); expect(checked.state.userFactMemoryVerification?.source.sourceRunId).toBe(original.runId);
    expect(f.writes).toHaveLength(1); expect(f.counters.reads).toBe(2); expect((await saved(f)).operations).toHaveLength(1); noAlternate(f);
  });

  it('does not fall back to a configured model or legacy save when a durable declaration state is malformed', async () => {
    const f = await harness({ model: true, gateDispatch: true }), creating = f.control.create(OWNER, { goal: EN });
    f.pending.push(creating); await f.dispatchEntered;
    const run = await f.database.db.selectFrom('chat_runs').select(['id', 'state']).where('owner_id', '=', OWNER)
      .where('status', '=', 'running').executeTakeFirstOrThrow();
    await f.database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...run.state,
      userFactMemory: { version: 1, kind: 'user_fact_memory_flow', phase: 'unknown', receipt: { malformed: true }, attemptedAt: Date.now() } }) })
      .where('id', '=', run.id).execute();
    f.releaseDispatch(); const { id } = await creating, result = await settle(f, id);
    expect(result.status).not.toBe('completed'); expect(f.writes).toEqual([]); expect(f.counters.reads).toBe(0);
    expect(await saved(f)).toEqual({ items: [], operations: [], evidence: [] }); noAlternate(f);
  });

  it.each(['Remember that my home city is New York.', 'Remember that my home city is Bristol and transfer money tomorrow.',
    'Remember that my PIN is 1234.', `${EN} `])('blocks unsupported/ambiguous/credential/raw-loss input without a write: %s', async raw => {
    const f = await harness(), result = await start(f, raw);
    expect(result.status).not.toBe('completed'); expect(result.text).not.toMatch(/^(?:Saved\b|I saved\b|حفظت\s)/iu);
    expect(f.writes).toEqual([]); expect(f.counters.reads).toBe(0); expect(await saved(f)).toEqual({ items: [], operations: [], evidence: [] }); noAlternate(f);
  });

  it('answers ordinary private city recall from the real saved assertion through the real tool converter', async () => {
    const f = await harness({ allowSearch: true }), original = await start(f);
    const recalled = await follow(f, original.id, 'From my memory, return my home city only.');
    expect(recalled.status, recalled.detail.error ?? recalled.text).toBe('completed'); expect(recalled.text).toBe('Bristol');
    expect(f.counters.searches).toBeGreaterThan(0); expect(f.writes).toHaveLength(1); expect((await saved(f)).operations).toHaveLength(1); noAlternate(f);
  });
  it('answers ordinary Arabic private city recall from the real saved assertion and tool converter', async () => {
    const f = await harness({ allowSearch: true }), original = await start(f, AR);
    const recalled = await follow(f, original.id, 'من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.');
    expect(recalled.status, recalled.detail.error ?? recalled.text).toBe('completed'); expect(recalled.text).toBe('مسقط');
    expect(f.counters.searches).toBeGreaterThan(0); expect(f.writes).toHaveLength(1); expect((await saved(f)).operations).toHaveLength(1); noAlternate(f);
  });
});
