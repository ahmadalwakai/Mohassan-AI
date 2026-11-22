import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createMemoryControl, memoryMigration, type MemoryExactReconcileInput, type MemoryExactWriteInput } from '@mohassan/memory';
import { migrateAuth } from '../apps/server/src/auth.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { recordActionCompletionEvent } from '../apps/server/src/assistant/action-completion.js';

const OWNER = 'isolated-clarification-time-owner';
// London crosses midnight in two seconds, within the real clarification lease.
// The implicit source-zone date then changes the noon conversion across DST.
const BEFORE = Date.UTC(2026, 9, 24, 22, 59, 59);
const AFTER = BEFORE + 2000;
const PRIMARY = 'Convert 12:00 Europe/London to UTC.';
const COMPOUND = 'Convert 12:00 Europe/London to UTC, then remember the result in my memory.';
const BEFORE_QUOTE = '12:00 Europe/London = 11:00 UTC (2026-10-24)';
const AFTER_QUOTE = '12:00 Europe/London = 12:00 UTC (2026-10-25)';
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  writes: MemoryExactWriteInput[];
  reads: MemoryExactReconcileInput[];
  otherCalls: { browser: number; search: number; legacySave: number; legacyRead: number };
  hooks: { bind: number; hasPage: number };
  gateNextDispatch(): { ready: Promise<void>; release(): void };
}
const fixtures: Fixture[] = [];

/** Read-only audit of production source; all I/O is an isolated local fixture. */
async function harness(): Promise<Fixture> {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrate(database.db); await memoryMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: 'Synthetic clock audit', email: 'clarification-clock@example.test' }).execute();
  const memory = createMemoryControl(database.db);
  const writes: MemoryExactWriteInput[] = [], reads: MemoryExactReconcileInput[] = [];
  const otherCalls = { browser: 0, search: 0, legacySave: 0, legacyRead: 0 };
  const hooks = { bind: 0, hasPage: 0 };
  let nextGate: { wait: Promise<void>; ready(): void } | null = null;
  const browserIO = async () => { otherCalls.browser++; throw new Error('No browser belongs to the relative-time audit.'); };
  const browser = { setCheckpointStore() {}, async bindAccount() { hooks.bind++; }, async hasPage() { hooks.hasPage++; return false; }, async close() {},
    act: browserIO, observe: browserIO, screen: browserIO, prepareAction: browserIO } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    async fullAccess() { if (nextGate) { const gate = nextGate; nextGate = null; gate.ready(); await gate.wait; } return true; },
    searchProvider: { name: 'no-network-clock-audit', async search() { otherCalls.search++; throw new Error('No public search belongs to this audit.'); } } as SearchProvider,
    tools: { memory: {
      async save() { otherCalls.legacySave++; throw new Error('Legacy write is not exact persistence.'); },
      async search() { otherCalls.legacyRead++; throw new Error('Lexical recall is not exact status verification.'); },
      async writeExact(ownerId, input, options) { writes.push(input); return memory.writeExact(ownerId, input, options); },
      async reconcileExact(ownerId, input, options) { reads.push(input); return memory.reconcileExact(ownerId, input, options); },
    } },
  });
  const fixture: Fixture = { database, control, writes, reads, otherCalls, hooks,
    gateNextDispatch() {
      let release!: () => void, ready!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; }), readiness = new Promise<void>(resolve => { ready = resolve; });
      nextGate = { wait, ready }; return { ready: readiness, release };
    },
  }; fixtures.push(fixture); return fixture;
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); }
  vi.useRealTimers();
});

async function latest(fixture: Fixture, id: string) {
  const row = await fixture.database.db.selectFrom('chat_runs').selectAll().where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
  return { id: row.id as string, goal: row.goal as string, createdAt: new Date(row.created_at).getTime(), status: row.status as string, state: row.state as BrainState };
}
async function clarifyAfterMidnight(fixture: Fixture, request: string) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BEFORE);
  const conversation = await fixture.control.create(OWNER, { goal: 'What about it?' });
  await fixture.control.settled(conversation.id);
  const paused = await fixture.control.detail(OWNER, conversation.id), original = await latest(fixture, conversation.id);
  expect(paused.status).toBe('waiting_user'); expect(paused.question).not.toBeNull(); expect(original.createdAt).toBe(BEFORE);
  expect(fixture.writes).toEqual([]); expect(fixture.reads).toEqual([]);
  vi.setSystemTime(AFTER);
  await fixture.control.send(OWNER, conversation.id, { questionId: paused.question!.id, text: request });
  await fixture.control.settled(conversation.id);
  return { id: conversation.id, original, current: await latest(fixture, conversation.id), detail: await fixture.control.detail(OWNER, conversation.id) };
}
function noOtherIO(fixture: Fixture) { expect(fixture.otherCalls).toEqual({ browser: 0, search: 0, legacySave: 0, legacyRead: 0 }); }

describe('clarified primary date versus preserved historical receipt date', () => {
  it('evaluates a newly supplied plain conversion on the clarification date, across a still-live lease', async () => {
    const fixture = await harness(), result = await clarifyAfterMidnight(fixture, PRIMARY);
    expect(result.current.status).toBe('completed'); expect(result.detail.error).toBeNull();
    expect(result.detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe(AFTER_QUOTE);
    expect(fixture.writes).toEqual([]); expect(fixture.reads).toEqual([]); noOtherIO(fixture);
  });

  it('uses the same clarification date for a newly supplied conversion that explicitly saves its result', async () => {
    const fixture = await harness(), result = await clarifyAfterMidnight(fixture, COMPOUND);
    expect(result.current.status).toBe('completed'); expect(result.detail.error).toBeNull();
    expect(fixture.writes).toHaveLength(1); expect(fixture.reads).toHaveLength(1); noOtherIO(fixture);
    const item = await fixture.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).executeTakeFirstOrThrow();
    // Correct new-primary semantics: the user supplied this computation AFTER
    // midnight; no earlier receipt/action existed that could pin yesterday.
    expect(item.content).toBe(AFTER_QUOTE);
    expect(fixture.writes[0]!.payload).toBe(AFTER_QUOTE);
    expect(result.detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain(AFTER_QUOTE);
    expect(result.current.state.computationMemory?.receipt.evaluatedAt).toBe(AFTER);
  });

  it('reverifies the newly clarified save with its message-bound effective time and no second write', async () => {
    const fixture = await harness(), result = await clarifyAfterMidnight(fixture, COMPOUND);
    expect(result.current.state.computationMemory?.receipt.evaluatedAt).toBe(AFTER);
    vi.setSystemTime(AFTER + 1000);
    await fixture.control.send(OWNER, result.id, { text: 'Did you save the result?' }); await fixture.control.settled(result.id);
    const verification = await latest(fixture, result.id);
    expect(verification.status).toBe('completed'); expect(verification.state.memoryVerification?.source).toMatchObject({
      sourceRunId: result.current.id, sourceCreatedAt: BEFORE, sourceEvaluatedAt: AFTER,
    });
    expect(verification.state.computationMemory).toBeUndefined(); expect(fixture.writes).toHaveLength(1); expect(fixture.reads).toHaveLength(2);
    expect(await fixture.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).executeTakeFirstOrThrow()).toEqual({ content: AFTER_QUOTE });
    noOtherIO(fixture);
  });

  it.each(['deleted', 'retimed'] as const)('cannot verify a clarified source after its exact bound user message was %s', async change => {
    const fixture = await harness(), result = await clarifyAfterMidnight(fixture, COMPOUND);
    const messageId = result.current.state.clarifiedRequestSource!.messageId;
    if (change === 'deleted') await fixture.database.db.deleteFrom('chat_messages').where('id', '=', messageId).execute();
    else await fixture.database.db.updateTable('chat_messages').set({ created_at: new Date(BEFORE + 1000) }).where('id', '=', messageId).execute();
    vi.setSystemTime(AFTER + 1000);
    await fixture.control.send(OWNER, result.id, { text: 'Did you save the result?' }); await fixture.control.settled(result.id);
    const verification = await latest(fixture, result.id), detail = await fixture.control.detail(OWNER, result.id);
    expect(verification.status).toBe('blocked'); expect(fixture.writes).toHaveLength(1); expect(fixture.reads).toHaveLength(1);
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).not.toContain(AFTER_QUOTE);
    noOtherIO(fixture);
  });

  it('accepts a second allowed full rewrite without reusing a stale empty action contract', async () => {
    const fixture = await harness(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BEFORE);
    const conversation = await fixture.control.create(OWNER, { goal: 'What about it?' }); await fixture.control.settled(conversation.id);
    const first = await fixture.control.detail(OWNER, conversation.id); expect(first.status).toBe('waiting_user');
    vi.setSystemTime(BEFORE + 1000);
    await fixture.control.send(OWNER, conversation.id, { questionId: first.question!.id, text: '"Convert 12:00 Europe/London to UTC."' });
    await fixture.control.settled(conversation.id);
    const second = await fixture.control.detail(OWNER, conversation.id); expect(second.status).toBe('waiting_user');
    expect(second.question!.id).not.toBe(first.question!.id); expect(fixture.writes).toEqual([]); expect(fixture.reads).toEqual([]);
    vi.setSystemTime(AFTER);
    await fixture.control.send(OWNER, conversation.id, { questionId: second.question!.id, text: PRIMARY });
    await fixture.control.settled(conversation.id);
    const current = await latest(fixture, conversation.id), detail = await fixture.control.detail(OWNER, conversation.id);
    expect(current.status).toBe('completed'); expect(detail.question).toBeNull(); expect(detail.error).toBeNull();
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe(AFTER_QUOTE);
    expect(current.state.clarifiedRequest).toBe(PRIMARY); noOtherIO(fixture);
  });

  it('verifies an actually completed earlier save without recomputing or rewriting its original date', async () => {
    const fixture = await harness(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BEFORE);
    const conversation = await fixture.control.create(OWNER, { goal: COMPOUND }); await fixture.control.settled(conversation.id);
    const original = await latest(fixture, conversation.id);
    expect(original.status).toBe('completed'); expect(fixture.writes).toHaveLength(1); expect(fixture.writes[0]!.payload).toBe(BEFORE_QUOTE);
    expect(original.state.computationMemory?.receipt.evaluatedAt).toBe(BEFORE);
    const operationsBefore = await fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute();
    vi.setSystemTime(AFTER);
    await fixture.control.send(OWNER, conversation.id, { text: 'Did you save the result?' }); await fixture.control.settled(conversation.id);
    const verification = await latest(fixture, conversation.id), detail = await fixture.control.detail(OWNER, conversation.id);
    expect(verification.status).toBe('completed'); expect(verification.state.memoryVerification?.source.sourceRunId).toBe(original.id);
    expect(verification.state.memoryVerification?.source.sourceCreatedAt).toBe(BEFORE);
    expect(verification.state.computationMemory).toBeUndefined(); expect(fixture.writes).toHaveLength(1); expect(fixture.reads).toHaveLength(2);
    expect(await fixture.database.db.selectFrom('memory_items').select('content').where('owner_id', '=', OWNER).executeTakeFirstOrThrow()).toEqual({ content: BEFORE_QUOTE });
    expect(await fixture.database.db.selectFrom('memory_exact_operations').selectAll().where('owner_id', '=', OWNER).execute()).toEqual(operationsBefore);
    expect(detail.messages.filter(message => message.role === 'assistant').at(-1)?.text).toBe('Yes. I verified that the saved result is currently active in your memory.');
    noOtherIO(fixture);
  });
});

describe('invalid clarified request provenance stops before private or browser I/O', () => {
  it.each(['denied', 'unknown'] as const)('cannot rebind away a prior %s action while accepting a new clarification', async phase => {
    const fixture = await harness(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BEFORE);
    const conversation = await fixture.control.create(OWNER, { goal: 'What about it?' }); await fixture.control.settled(conversation.id);
    const paused = await fixture.control.detail(OWNER, conversation.id), original = await latest(fixture, conversation.id);
    let ledger = original.state.actionCompletion!;
    const event = { attemptId: 'synthetic-previous-attempt', kind: 'memory_write' as const, targetHash: ledger.contract.requestHash, proof: 'none' as const };
    if (phase === 'unknown') {
      const started = recordActionCompletionEvent(ledger, { ...event, phase: 'started' });
      expect(started.accepted).toBe(true); ledger = started.ledger!;
    }
    const recorded = recordActionCompletionEvent(ledger, { ...event, phase }); expect(recorded.accepted).toBe(true);
    await fixture.database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...original.state, actionCompletion: recorded.ledger }) }).where('id', '=', original.id).execute();
    const beforeRun = await fixture.database.db.selectFrom('chat_runs').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow();
    const beforeConversation = await fixture.database.db.selectFrom('chat_conversations').selectAll().where('id', '=', conversation.id).executeTakeFirstOrThrow();
    const beforeMessages = await fixture.database.db.selectFrom('chat_messages').selectAll().where('conversation_id', '=', conversation.id).orderBy('id').execute();
    vi.setSystemTime(AFTER);
    await expect(fixture.control.send(OWNER, conversation.id, { questionId: paused.question!.id, text: COMPOUND }))
      .rejects.toMatchObject({ code: 'CHAT_CLARIFICATION_CHANGED', statusCode: 409 });
    expect(await fixture.database.db.selectFrom('chat_runs').selectAll().where('id', '=', original.id).executeTakeFirstOrThrow()).toEqual(beforeRun);
    expect(await fixture.database.db.selectFrom('chat_conversations').selectAll().where('id', '=', conversation.id).executeTakeFirstOrThrow()).toEqual(beforeConversation);
    expect(await fixture.database.db.selectFrom('chat_messages').selectAll().where('conversation_id', '=', conversation.id).orderBy('id').execute()).toEqual(beforeMessages);
    expect(fixture.writes).toEqual([]); expect(fixture.reads).toEqual([]); noOtherIO(fixture);
  });

  it.each(['deleted', 'text', 'hash', 'before_run', 'future', 'other_owner', 'other_conversation'] as const)('rejects %s source evidence without a legacy time fallback', async change => {
    const fixture = await harness(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(BEFORE);
    const conversation = await fixture.control.create(OWNER, { goal: 'What about it?' }); await fixture.control.settled(conversation.id);
    const paused = await fixture.control.detail(OWNER, conversation.id); expect(paused.status).toBe('waiting_user');
    vi.setSystemTime(AFTER);
    const gate = fixture.gateNextDispatch(), resuming = fixture.control.send(OWNER, conversation.id, { questionId: paused.question!.id, text: COMPOUND });
    await gate.ready;
    const beforeHooks = { ...fixture.hooks };
    try {
      const stored = await latest(fixture, conversation.id), pointer = stored.state.clarifiedRequestSource!;
      expect(pointer).toMatchObject({ version: 1 });
      if (change === 'deleted') await fixture.database.db.deleteFrom('chat_messages').where('id', '=', pointer.messageId).execute();
      if (change === 'text') await fixture.database.db.updateTable('chat_messages').set({ text: `${COMPOUND} Changed.` }).where('id', '=', pointer.messageId).execute();
      if (change === 'before_run' || change === 'future') await fixture.database.db.updateTable('chat_messages')
        .set({ created_at: new Date(change === 'before_run' ? BEFORE - 1 : AFTER + 1) }).where('id', '=', pointer.messageId).execute();
      if (change === 'hash') await fixture.database.db.updateTable('chat_runs').set({ state: JSON.stringify({ ...stored.state,
        clarifiedRequestSource: { ...pointer, requestHash: '0'.repeat(64) } }) }).where('id', '=', stored.id).execute();
      if (change === 'other_owner' || change === 'other_conversation') {
        const other = randomUUID();
        await fixture.database.db.insertInto('chat_conversations').values({ id: other, owner_id: change === 'other_owner' ? 'foreign-clock-owner' : OWNER,
          title: 'Synthetic foreign message source', status: 'idle' }).execute();
        await fixture.database.db.updateTable('chat_messages').set({ conversation_id: other }).where('id', '=', pointer.messageId).execute();
      }
    } finally { gate.release(); await resuming; }
    await fixture.control.settled(conversation.id);
    const current = await latest(fixture, conversation.id);
    expect(current.status).toBe('blocked'); expect(fixture.writes).toEqual([]); expect(fixture.reads).toEqual([]);
    expect(fixture.hooks).toEqual(beforeHooks); noOtherIO(fixture);
  });
});
