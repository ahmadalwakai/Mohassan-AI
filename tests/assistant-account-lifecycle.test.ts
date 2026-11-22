import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration } from '@mohassan/memory';
import type { ModelRequest } from '@mohassan/providers';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-account-lifecycle-owner';
const MODEL = 'isolated-account-lifecycle-model';
const GOAL = 'Explain how rainbows form in clear terms.';
const LATE_ANSWER = 'LATE ACCOUNT ANSWER MUST NEVER APPEAR';
const ACCOUNT_DISABLED = 'توقف التشغيل لأن الحساب لم يعد نشطًا. لم أستأنف أي إجراء.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type ModelMode = 'answer_gate' | 'tool_gate' | 'abort_gate' | 'ask' | 'none';
interface FixtureOptions { model?: ModelMode; readGate?: boolean; leaseMs?: number }
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  requests: ModelRequest[];
  calls: { browser: number; search: number; legacyRead: number; legacyWrite: number; exactRead: number; exactWrite: number };
  ready: Promise<void>;
  release(): void;
  setActive(active: boolean): Promise<void>;
}
const fixtures: Fixture[] = [];

/** Ephemeral PGlite, same-transaction account locks, synthetic bounded ports only. */
async function harness(options: FixtureOptions = {}): Promise<Fixture> {
  const database = await createDatabase({});
  expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic account lifecycle owner', email: 'account-lifecycle@example.test' }).execute();
  await sql`CREATE TABLE fixture_account_access(owner_id text PRIMARY KEY, active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_account_access').values({ owner_id: OWNER, active: true }).execute();
  let release!: () => void, markReady!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const requests: ModelRequest[] = [];
  const calls: Fixture['calls'] = { browser: 0, search: 0, legacyRead: 0, legacyWrite: 0, exactRead: 0, exactWrite: 0 };
  const domain = createMemoryControl(database.db);
  const browserIO = async () => { calls.browser++; throw new Error('Unexpected browser action in account lifecycle fixture.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: browserIO, observe: browserIO, screen: browserIO, prepareAction: browserIO } as unknown as AgentBrowser;
  const model = options.model ?? 'answer_gate';
  const control = await createCommandChatControl(database.db, {
    browser, recordExperiences: false, leaseMs: options.leaseMs,
    accountActive: async (ownerId, tx) => Boolean(await tx.selectFrom('fixture_account_access').select('owner_id')
      .where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    models: model === 'none' ? { fast: [], deep: [], vision: '' } : { fast: [MODEL], deep: [MODEL], vision: '' },
    searchProvider: { name: 'isolated-account-search', async search() {
      calls.search++; return [{ title: 'Synthetic public source', url: 'https://account-fixture.test/public', snippet: 'Synthetic public fixture.' }];
    } } as SearchProvider,
    tools: { memory: {
      async search() { calls.legacyRead++; return 'Synthetic memory port must not run after revocation.'; },
      async save() { calls.legacyWrite++; return 'Synthetic memory port must not run after revocation.'; },
      async writeExact(ownerId, input, passedOptions) { calls.exactWrite++; return domain.writeExact(ownerId, input, passedOptions); },
      async reconcileExact(ownerId, input, passedOptions) {
        calls.exactRead++;
        const result = await domain.reconcileExact(ownerId, input, passedOptions);
        if (options.readGate) { markReady(); await gate; }
        return result;
      },
    } },
    ...(model === 'none' ? {} : { createProvider: (name: string) => ({ id: 'ollama' as const, async generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length > 3) throw new Error('Exceeded bounded account lifecycle model calls.');
      let decision: Partial<Decision> & Pick<Decision, 'tool'>;
      if (model === 'ask') decision = { tool: 'ask_user', text: 'Which explanation would you prefer?', options: ['Brief', 'Detailed'] };
      else {
        markReady();
        if (model === 'abort_gate') await new Promise<void>((resolve, reject) => {
          const signal = request.signal;
          if (!signal) { reject(new Error('Expected the host execution signal.')); return; }
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          void gate.then(() => { signal.removeEventListener('abort', abort); resolve(); });
          if (signal.aborted) abort();
        });
        // Other modes deliberately ignore abort: host fencing must reject a late result.
        else await gate;
        decision = model === 'tool_gate' ? { tool: 'search', text: 'Hillmere Library' }
          : { tool: 'answer', text: LATE_ANSWER, outcome: 'done' };
      }
      return { model: name, usage: { inputTokens: 10, outputTokens: 10 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }) }),
  });
  const fixture: Fixture = { database, control, requests, calls, ready, release,
    async setActive(active) { await database.db.transaction().execute(async tx => {
      await tx.updateTable('fixture_account_access').set({ active }).where('owner_id', '=', OWNER).execute();
    }); },
  };
  fixtures.push(fixture); return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const closing = fixture.control.shutdown();
    fixture.release(); await closing; await fixture.database.close();
  }
});

async function snapshot(fixture: Fixture) {
  const [conversations, runs, messages, modelReceipts, effectReceipts] = await Promise.all([
    fixture.database.db.selectFrom('chat_conversations').selectAll().orderBy('id').execute(),
    fixture.database.db.selectFrom('chat_runs').selectAll().orderBy('id').execute(),
    fixture.database.db.selectFrom('chat_messages').selectAll().orderBy('id').execute(),
    fixture.database.db.selectFrom('chat_model_receipts').selectAll().orderBy('id').execute(),
    fixture.database.db.selectFrom('chat_effect_receipts').selectAll().orderBy('id').execute(),
  ]);
  return { conversations, runs, messages, modelReceipts, effectReceipts };
}
async function run(fixture: Fixture, id: string) {
  const row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: row.id as string, status: row.status as string, lease_token: row.lease_token as string, state: row.state as BrainState };
}
function noLateOutput(messages: { text: string }[]) {
  expect(messages.some(message => message.text.includes(LATE_ANSWER))).toBe(false);
}
function noDispatchedAction(fixture: Fixture) {
  expect(fixture.calls).toMatchObject({ browser: 0, search: 0, legacyRead: 0, legacyWrite: 0 });
}
async function expectInterrupted(fixture: Fixture, id: string) {
  await fixture.control.settled(id);
  const [conversation, stored] = await Promise.all([
    fixture.database.db.selectFrom('chat_conversations').selectAll().where('id', '=', id).executeTakeFirstOrThrow(), run(fixture, id),
  ]);
  expect(stored.status).toBe('interrupted');
  expect(conversation.status).toBe('failed'); expect(conversation.active_run_id).toBeNull();
  expect(conversation.question).toBeNull(); expect(conversation.approval).toBeNull(); expect(conversation.secure).toBeNull();
  expect(conversation.error).toBe(ACCOUNT_DISABLED);
  const detail = await fixture.control.detail(OWNER, id);
  noLateOutput(detail.messages); noDispatchedAction(fixture);
  return { conversation, stored, detail };
}

describe('inactive-account entry points make no chat state mutation', () => {
  it.each([{}, { goal: GOAL }])('rejects create before a conversation, message or run exists: %j', async input => {
    const fixture = await harness(); await fixture.setActive(false);
    const before = await snapshot(fixture);
    await expect(fixture.control.create(OWNER, input)).rejects.toMatchObject({ code: 'CHAT_ACCOUNT_INACTIVE', statusCode: 403 });
    expect(await snapshot(fixture)).toEqual(before); expect(fixture.requests).toEqual([]); noDispatchedAction(fixture);
  });

  it('rejects send without changing the idle conversation, messages or lease', async () => {
    const fixture = await harness(), conversation = await fixture.control.create(OWNER);
    await fixture.setActive(false); const before = await snapshot(fixture);
    await expect(fixture.control.send(OWNER, conversation.id, { text: GOAL })).rejects.toMatchObject({ code: 'CHAT_ACCOUNT_INACTIVE', statusCode: 403 });
    expect(await snapshot(fixture)).toEqual(before); expect(fixture.requests).toEqual([]); noDispatchedAction(fixture);
  });

  it.each(['respond', 'send'] as const)('rejects inactive %s resume without consuming the question or changing the token', async method => {
    const fixture = await harness({ model: 'ask' }), conversation = await fixture.control.create(OWNER, { goal: GOAL });
    await fixture.control.settled(conversation.id);
    const detail = await fixture.control.detail(OWNER, conversation.id);
    expect(detail.status).toBe('waiting_user'); expect(detail.question?.options).toHaveLength(2);
    await fixture.setActive(false); const before = await snapshot(fixture), calls = fixture.requests.length;
    const operation = method === 'respond'
      ? fixture.control.respond(OWNER, conversation.id, { questionId: detail.question!.id, optionId: detail.question!.options[0]!.id })
      : fixture.control.send(OWNER, conversation.id, { questionId: detail.question!.id, text: 'Brief please.' });
    await expect(operation).rejects.toMatchObject({ code: 'CHAT_ACCOUNT_INACTIVE', statusCode: 403 });
    expect(await snapshot(fixture)).toEqual(before); expect(fixture.requests).toHaveLength(calls); noDispatchedAction(fixture);
  });
});

describe('revocation fences late results and preserves durable state', () => {
  it('preserves the account-disabled reason when a heartbeat aborts an awaited model call', async () => {
    const fixture = await harness({ model: 'abort_gate', leaseMs: 1000 });
    const conversation = await fixture.control.create(OWNER, { goal: GOAL }); await fixture.ready;
    await fixture.setActive(false);
    let fallbackReleased = false;
    const fallback = setTimeout(() => { fallbackReleased = true; fixture.release(); }, 4000);
    try {
      await expectInterrupted(fixture, conversation.id);
      expect(fallbackReleased).toBe(false); expect(fixture.requests[0]!.signal?.aborted).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    } finally { clearTimeout(fallback); }
  });

  it.each(['answer_gate', 'tool_gate'] as const)('interrupts a revoked run before its late %s result is used', async model => {
    const fixture = await harness({ model });
    const goal = model === 'tool_gate' ? 'Search public facts about Hillmere Library.' : GOAL;
    const conversation = await fixture.control.create(OWNER, { goal }); await fixture.ready;
    const before = await run(fixture, conversation.id);
    await fixture.setActive(false); fixture.release();
    const result = await expectInterrupted(fixture, conversation.id);
    expect(result.stored.id).toBe(before.id); expect(result.stored.state).toEqual(before.state);
    expect(fixture.requests).toHaveLength(1);
    expect(result.conversation.error).not.toContain(LATE_ANSWER);
    expect((await snapshot(fixture)).modelReceipts.every(receipt => receipt.status !== 'started')).toBe(true);
  });

  it('preserves a committed exact-save receipt when revocation wins before fresh readback is accepted', async () => {
    const fixture = await harness({ model: 'none', readGate: true });
    const conversation = await fixture.control.create(OWNER, { goal: 'Calculate 617 + 29, then remember the result in my memory.' });
    await fixture.ready;
    const before = await run(fixture, conversation.id);
    expect(before.state.computationMemory).toMatchObject({ phase: 'unknown', commitReceipt: { ownerId: OWNER } });
    expect(before.state.memorySaves).toBe(1);
    const operationsBefore = await fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute();
    expect(operationsBefore).toHaveLength(1);
    await fixture.setActive(false); fixture.release();
    const result = await expectInterrupted(fixture, conversation.id);
    expect(result.stored.state.computationMemory).toEqual(before.state.computationMemory);
    expect(result.stored.state.memorySaves).toBe(1); expect(fixture.calls.exactWrite).toBe(1); expect(fixture.calls.exactRead).toBe(1);
    expect(await fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute()).toEqual(operationsBefore);
    expect(result.detail.messages.filter(message => message.role === 'assistant')).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it('does not overwrite a user cancellation when the old gated model returns after revocation', async () => {
    const fixture = await harness(), conversation = await fixture.control.create(OWNER, { goal: GOAL }); await fixture.ready;
    await fixture.setActive(false); await fixture.control.cancel(OWNER, conversation.id);
    const cancelled = await snapshot(fixture);
    expect(cancelled.runs[0]!.status).toBe('cancelled');
    fixture.release(); await fixture.control.settled(conversation.id);
    const after = await snapshot(fixture);
    expect(after.conversations).toEqual(cancelled.conversations); expect(after.runs).toEqual(cancelled.runs);
    expect(after.messages).toEqual(cancelled.messages); expect(after.effectReceipts).toEqual(cancelled.effectReceipts);
    // A genuinely returned provider response may settle usage/schema metadata.
    // It cannot publish a reply, dispatch a tool, or change cancelled ownership.
    expect(after.modelReceipts.every(receipt => receipt.status !== 'started')).toBe(true);
    noDispatchedAction(fixture);
    noLateOutput((await fixture.control.detail(OWNER, conversation.id)).messages);
  });

  it('does not overwrite a newer worker token, state or conversation during stale revocation cleanup', async () => {
    const fixture = await harness(), conversation = await fixture.control.create(OWNER, { goal: GOAL }); await fixture.ready;
    const original = await run(fixture, conversation.id), newerToken = randomUUID();
    await fixture.setActive(false);
    await fixture.database.db.transaction().execute(async tx => {
      await tx.selectFrom('chat_conversations').select('id').where('id', '=', conversation.id).forUpdate().executeTakeFirstOrThrow();
      await tx.updateTable('chat_runs').set({ lease_token: newerToken, worker_id: 'newer-isolated-account-worker',
        lease_expires_at: new Date(Date.now() + 60000), state: JSON.stringify({ ...original.state, note: 'newer worker sentinel' }) })
        .where('id', '=', original.id).execute();
      await tx.updateTable('chat_conversations').set({ progress: 'newer worker owns this run' }).where('id', '=', conversation.id).execute();
    });
    const newer = await snapshot(fixture); fixture.release(); await fixture.control.settled(conversation.id);
    const after = await snapshot(fixture);
    expect(after.runs).toEqual(newer.runs); expect(after.conversations).toEqual(newer.conversations); expect(after.messages).toEqual(newer.messages);
    expect(after.runs[0]).toMatchObject({ status: 'running', lease_token: newerToken, worker_id: 'newer-isolated-account-worker' });
    noDispatchedAction(fixture); noLateOutput((await fixture.control.detail(OWNER, conversation.id)).messages);
  });
});
