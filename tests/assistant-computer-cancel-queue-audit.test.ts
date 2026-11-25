import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { registerWindowsRoutes, windowsMigration } from '@mohassan/windows';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import { migrateAuth } from '../apps/server/src/auth.js';

const OWNER = 'isolated-cancel-queue-owner', SESSION_ID = 'synthetic-cancel-queue-session';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('The cancellation audit reached an unrelated port.'); };
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  app: ReturnType<typeof Fastify>;
  chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  native: Awaited<ReturnType<typeof registerWindowsRoutes>>;
  signals: AbortSignal[];
  entered(): boolean;
  release(): void;
  commands(): Promise<number>;
  frameCapturedAt: string;
  fenceCalls(): number;
  fenceWaitMs(): number;
}
const fixtures: Fixture[] = [];

/** Real controller/adapter/domain and PGlite queue; no connected companion or native input process. */
async function fixture(options: { expireLeaseInQueue?: boolean } = {}): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db); await migrateAuth(database.db); await windowsMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: OWNER, email: `${OWNER}@example.test` }).execute();
  await database.db.insertInto('session').values({ id: SESSION_ID, userId: OWNER, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) }).execute();
  await sql`CREATE TABLE fixture_computer_account(owner_id text PRIMARY KEY, active boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_computer_account').values({ owner_id: OWNER, active: true }).execute();
  const deviceId = randomUUID(), grantId = randomUUID(), targetKey = 'a'.repeat(64), epoch = randomUUID();
  const frame = { id: randomUUID(), targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
    jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'),
    elements: [{ name: 'Confirm', type: 'ControlType.Button', x: 20, y: 20, width: 100, height: 40, password: false }] };
  const state = { approvalNonce: epoch, sessionId: 1, safeDesktop: true, localView: true, localControl: true,
    target: { key: targetKey, mode: 'window', title: 'Synthetic cancellation fixture', width: 800, height: 600 }, status: 'isolated' };
  await database.db.insertInto('windows_devices').values({ id: deviceId, owner_id: OWNER, name: 'Synthetic disconnected companion',
    key_hash: hash('synthetic-unused-device-key'), last_seen_at: new Date(), state: JSON.stringify(state),
    last_frame: JSON.stringify({ ...frame, receivedAt: new Date().toISOString() }) }).execute();
  await database.db.insertInto('windows_grants').values({ id: grantId, owner_id: OWNER, device_id: deviceId, session_binding: `session:${hash(SESSION_ID)}`,
    scope: 'control', target_key: targetKey, approval_nonce: epoch, expires_at: new Date(Date.now() + 30000) }).execute();
  let entered = false, release!: () => void, armed = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Only the Windows domain sees this proxy. Chat cancel uses the real DB and
  // can commit while Windows.act is awaiting admission to its queue transaction.
  const windowsDb = new Proxy(database.db, { get(target, property) {
    if (property === 'transaction') return () => {
      const builder = target.transaction();
      return new Proxy(builder, { get(transaction, member) {
        if (member === 'execute') return async (callback: Parameters<typeof builder.execute>[0]) => {
          if (armed) { armed = false; entered = true; await gate; }
          return builder.execute(callback);
        };
        const value = Reflect.get(transaction, member, transaction); return typeof value === 'function' ? value.bind(transaction) : value;
      } });
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = Fastify({ logger: false });
  const native = await registerWindowsRoutes(app, { db: windowsDb, owner: async () => ({ id: OWNER, sessionId: SESSION_ID }),
    config: { webOrigin: 'http://127.0.0.1:3000', production: false, windowsEnabled: true } });
  await app.ready();
  const tools = createAssistantTools({ memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false,
    runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused }, windows: native });
  const signals: AbortSignal[] = [], computer = tools.computer!, perform = computer.perform;
  let fenceCalls = 0, fenceWaitMs = 0;
  computer.perform = (ownerId, step, signal, inputOptions) => {
    signals.push(signal);
    const originalFence = inputOptions?.fence;
    if (!originalFence) throw new Error('The actual controller must supply a same-transaction input fence.');
    return perform.call(computer, ownerId, step, signal, { ...inputOptions, fence: async transaction => {
      fenceCalls++;
      if (options.expireLeaseInQueue && fenceCalls === 2) {
        const before = Date.now();
        // The first controller fence holds the run lock. Heartbeats cannot
        // renew it while this queue transaction outlives its real 1000ms lease.
        await new Promise<void>(resolve => setTimeout(resolve, 1200)); fenceWaitMs = Date.now() - before;
      }
      await originalFence.call(inputOptions, transaction);
    } });
  };
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: unused, observe: unused, screen: unused, prepareAction: unused } as unknown as AgentBrowser;
  let decisions = 0;
  const chat = await createCommandChatControl(database.db, { browser, tools, fullAccess: async () => true, recordExperiences: false,
    leaseMs: options.expireLeaseInQueue ? 1000 : undefined,
    accountActive: async (ownerId, transaction) => Boolean(await transaction.selectFrom('fixture_computer_account').select('owner_id')
      .where('owner_id', '=', ownerId).where('active', '=', true).forShare().executeTakeFirst()),
    models: { fast: ['cancel-queue-script'], deep: ['cancel-queue-script'], vision: '' },
    searchProvider: { name: 'forbidden-cancel-queue-network', search: unused } as SearchProvider,
    createProvider: model => ({ id: 'isolated-cancel-queue-script', async generate() {
      if (++decisions > 4) throw new Error('Cancellation script exhausted its bounded decisions.');
      const decision = decisions === 1 ? { tool: 'computer_view' } : decisions === 2 ? { tool: 'computer_click', ref: 'w1' }
        : { tool: 'answer', text: 'The fixture has no independently observed desktop result.', outcome: 'partial' };
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }),
  });
  const f: Fixture = { database, app, native, chat, signals, entered: () => entered, release,
    commands: async () => (await database.db.selectFrom('windows_commands').select('id').execute()).length,
    frameCapturedAt: frame.capturedAt, fenceCalls: () => fenceCalls, fenceWaitMs: () => fenceWaitMs };
  fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { const closing = f.chat.shutdown(); f.release(); await closing; await f.app.close(); await f.database.close(); }
});
async function start(f: Fixture) {
  const { id } = await f.native.runInSession(OWNER, SESSION_ID, () => f.chat.create(OWNER, { goal: 'Click the Confirm button in the current PC window.' }));
  await expect.poll(f.entered).toBe(true); expect(await f.commands()).toBe(0); return id;
}

describe('cancel during an already-entered native queue operation, with no companion input', () => {
  it('does not create a Windows command after cancellation committed before the queue transaction began', async () => {
    const f = await fixture(), id = await start(f), before = await f.native.runInSession(OWNER, SESSION_ID, () => f.native.view(OWNER));
    await f.chat.cancel(OWNER, id);
    expect(f.signals[0]?.aborted).toBe(true);
    expect((await f.native.runInSession(OWNER, SESSION_ID, () => f.native.view(OWNER))).origin).toEqual(before.origin);
    expect(Date.now() - Date.parse(f.frameCapturedAt)).toBeLessThan(2500);
    f.release(); await f.chat.settled(id);
    expect(await f.commands(), 'Only queued DB command count is observed; no native execution is connected.').toBe(0);
  });
  it('admits exactly one queued command when cancellation happens only after the queue commit', async () => {
    const f = await fixture(), id = await start(f);
    f.release(); await expect.poll(f.commands).toBe(1);
    // Stop the controller's command polling. A committed queue record is not a
    // claim that a disconnected companion applied any mouse/keyboard input.
    await f.chat.cancel(OWNER, id); await f.chat.settled(id); expect(await f.commands()).toBe(1);
  });
  it('admits no command after account revocation commits while queue admission is gated', async () => {
    const f = await fixture(), id = await start(f);
    // No queue transaction holds a membership/run lock yet; revocation really
    // commits before the native queue transaction is admitted.
    await f.database.db.updateTable('fixture_computer_account').set({ active: false }).where('owner_id', '=', OWNER).execute();
    f.release(); await f.chat.settled(id);
    expect(f.fenceCalls()).toBe(1); expect(await f.commands()).toBe(0);
  });
  it('rolls back queue, sequence and queue audit when the real lease expires before the final in-transaction fence', async () => {
    const f = await fixture({ expireLeaseInQueue: true }), id = await start(f);
    f.release(); await f.chat.settled(id);
    expect(f.fenceCalls()).toBe(2); expect(f.fenceWaitMs()).toBeGreaterThanOrEqual(1150);
    expect(await f.commands()).toBe(0);
    expect(await f.database.db.selectFrom('windows_audit').select('id').where('type', '=', 'input_requested').execute()).toEqual([]);
    expect((await f.database.db.selectFrom('windows_grants').select('next_sequence').executeTakeFirstOrThrow()).next_sequence).toBe(1);
  });
});
