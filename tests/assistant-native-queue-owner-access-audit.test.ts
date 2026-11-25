import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { registerWindowsRoutes, windowsMigration } from '@mohassan/windows';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import { migrateMembers, roleOf } from '../apps/server/src/members.js';
import { lockOwnerToolAccess } from '../apps/server/src/owner-tool-authorization.js';

const OWNER = 'isolated-native-role-queue-owner', SESSION_ID = 'synthetic-native-role-queue-session';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const fixtures: Array<{ chat: Awaited<ReturnType<typeof createCommandChatControl>>; app: ReturnType<typeof Fastify>;
  database: Awaited<ReturnType<typeof createDatabase>> }> = [];

/** Real Windows domain queue and controller; fake frames, no companion polling or native process. */
async function run(downgradeAtQueueEntry: boolean, grantPath: 'policy' | 'primary' | 'additional' = 'policy') {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded');
  await migrateAuth(database.db); await migrateMembers(database.db); await migrate(database.db); await windowsMigration(database.db);
  for (const id of [OWNER, 'isolated-other-primary-owner']) await database.db.insertInto('user').values({ id, name: id, email: `${id}@example.test` }).execute();
  await database.db.insertInto('session').values({ id: SESSION_ID, userId: OWNER, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) }).execute();
  if (grantPath !== 'policy') {
    await database.db.insertInto('workspace_owner').values({ id: 1, owner_id: grantPath === 'primary' ? OWNER : 'isolated-other-primary-owner' }).execute();
    if (grantPath === 'additional') await database.db.insertInto('workspace_members').values({ user_id: OWNER, role: 'owner', disabled_at: null }).execute();
  }
  await sql`CREATE TABLE fixture_native_role(owner_id text PRIMARY KEY,active boolean NOT NULL,full_access boolean NOT NULL)`.execute(database.db);
  await database.db.insertInto('fixture_native_role').values({ owner_id: OWNER, active: true, full_access: true }).execute();
  const deviceId = randomUUID(), grantId = randomUUID(), targetKey = 'b'.repeat(64), epoch = randomUUID();
  const frame = { id: randomUUID(), targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
    jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'),
    elements: [{ name: 'Confirm', type: 'ControlType.Button', x: 20, y: 20, width: 100, height: 40, password: false }] };
  const deviceState = { approvalNonce: epoch, sessionId: 1, safeDesktop: true, localView: true, localControl: true,
    target: { key: targetKey, mode: 'window', title: 'Synthetic role queue fixture', width: 800, height: 600 }, status: 'isolated' };
  await database.db.insertInto('windows_devices').values({ id: deviceId, owner_id: OWNER, name: 'Synthetic disconnected role companion',
    key_hash: hash('synthetic-unused-role-device-key'), last_seen_at: new Date(), state: JSON.stringify(deviceState),
    last_frame: JSON.stringify({ ...frame, receivedAt: new Date().toISOString() }) }).execute();
  await database.db.insertInto('windows_grants').values({ id: grantId, owner_id: OWNER, device_id: deviceId, session_binding: `session:${hash(SESSION_ID)}`,
    scope: 'control', target_key: targetKey, approval_nonce: epoch, expires_at: new Date(Date.now() + 30000) }).execute();
  let entered = false, roleChangeCommitted = false, performCalls = 0, fenceCalls = 0, accountChecks = 0, forbiddenCalls = 0;
  const roleFenceTransactions: unknown[] = [];
  const fullAccessReads: boolean[] = [], performScope = new AsyncLocalStorage<boolean>();
  const windowsDb = new Proxy(database.db, { get(target, member) {
    if (member === 'transaction') return () => {
      const builder = target.transaction();
      return new Proxy(builder, { get(transaction, field) {
        if (field === 'execute') return async (callback: Parameters<typeof builder.execute>[0]) => {
          // The disconnected domain's cleanup timer is outside this async scope.
          // Only the actual computer.perform queue path can trigger this change.
          if (!entered && performScope.getStore()) {
            entered = true; expect(performCalls).toBe(1); expect(fullAccessReads.at(-1)).toBe(true);
            if (downgradeAtQueueEntry) {
              // No Windows queue transaction or role lock exists yet: this policy
              // change really commits BEFORE admission, with account still active.
              if (grantPath === 'additional') await database.db.updateTable('workspace_members').set({ role: 'member' }).where('user_id', '=', OWNER).execute();
              else {
                expect(grantPath).toBe('policy');
                await database.db.updateTable('fixture_native_role').set({ full_access: false }).where('owner_id', '=', OWNER).execute();
              }
              roleChangeCommitted = true;
            }
          }
          return builder.execute(callback);
        };
        const value = Reflect.get(transaction, field, transaction); return typeof value === 'function' ? value.bind(transaction) : value;
      } });
    };
    const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const app = Fastify({ logger: false });
  const native = await registerWindowsRoutes(app, { db: windowsDb, owner: async () => ({ id: OWNER, sessionId: SESSION_ID }),
    config: { webOrigin: 'http://127.0.0.1:3000', production: false, windowsEnabled: true } });
  await app.ready();
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error('No unrelated external or native input process belongs to this audit.'); };
  const tools = createAssistantTools({ memory: { search: forbidden, create: forbidden }, coding: { available: false, workspace: forbidden },
    studio: { workspace: forbidden, detail: forbidden }, studioChange: false,
    runtime: { createTask: forbidden, approve: forbidden, cancel: forbidden, detail: forbidden }, windows: native,
    commandWaitMs: 20 }); // Bounds acknowledgement polling only; queue admission remains real.
  const computer = tools.computer!, originalPerform = computer.perform;
  computer.perform = (owner, step, signal, options) => {
    performCalls++; expect(signal.aborted).toBe(false);
    const originalFence = options?.fence; if (!originalFence) throw new Error('A same-transaction host fence is required.');
    return performScope.run(true, () => originalPerform.call(computer, owner, step, signal, { ...options,
      fence: async tx => { fenceCalls++; await originalFence.call(options, tx); } }));
  };
  let decisions = 0;
  const chat = await createCommandChatControl(database.db, { tools, recordExperiences: false,
    browser: { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return false; },
      act: forbidden, observe: forbidden, screen: forbidden, prepareAction: forbidden } as unknown as AgentBrowser,
    fullAccess: async owner => {
      const full = grantPath === 'policy'
        ? Boolean((await database.db.selectFrom('fixture_native_role').select('full_access').where('owner_id', '=', owner).executeTakeFirstOrThrow()).full_access)
        : await roleOf(database.db, owner) === 'owner';
      fullAccessReads.push(full); return full;
    },
    accountActive: async (owner, tx) => {
      accountChecks++;
      if (grantPath !== 'policy') {
        const role = await roleOf(tx, owner); if (role !== 'member') return role !== null;
        return Boolean(await tx.selectFrom('workspace_members').select('user_id').where('user_id', '=', owner)
          .where('role', '=', 'member').where('disabled_at', 'is', null).forShare().executeTakeFirst());
      }
      return Boolean(await tx.selectFrom('fixture_native_role').select('owner_id').where('owner_id', '=', owner)
        .where('active', '=', true).forShare().executeTakeFirst());
    },
    accountFullAccess: async (owner, tx) => {
      roleFenceTransactions.push(tx);
      if (grantPath !== 'policy') return lockOwnerToolAccess(tx, owner); // Exact production app binding, with instrumentation only.
      return Boolean(await tx.selectFrom('fixture_native_role').select('owner_id').where('owner_id', '=', owner)
        .where('active', '=', true).where('full_access', '=', true).forShare().executeTakeFirst());
    },
    models: { fast: ['native-role-queue-fixture'], deep: ['native-role-queue-fixture'], vision: '' },
    searchProvider: { name: 'forbidden-native-role-network', search: forbidden } as SearchProvider,
    createProvider: model => ({ id: 'native-role-queue-fixture', async generate() {
      if (++decisions > 4) throw new Error('Bounded native role fixture exhausted.');
      const decision = decisions === 1 ? { tool: 'computer_view' } : decisions === 2 ? { tool: 'computer_click', ref: 'w1' }
        : { tool: 'answer', text: 'No native execution result was observed.', outcome: 'partial' };
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }),
  });
  fixtures.push({ database, app, chat });
  const { id } = await native.runInSession(OWNER, SESSION_ID, () => chat.create(OWNER, { goal: 'Click the Confirm button in the current PC window.' })); await chat.settled(id);
  const canonical = grantPath === 'policy' ? undefined : await roleOf(database.db, OWNER);
  const role = grantPath === 'policy'
    ? await database.db.selectFrom('fixture_native_role').select(['active', 'full_access']).where('owner_id', '=', OWNER).executeTakeFirstOrThrow()
    : { active: canonical !== null, full_access: canonical === 'owner' };
  const commands = await database.db.selectFrom('windows_commands').select(['status', 'owner_id']).execute();
  const inputAudit = await database.db.selectFrom('windows_audit').select('id').where('type', '=', 'input_requested').execute();
  const grant = await database.db.selectFrom('windows_grants').select('next_sequence').where('id', '=', grantId).executeTakeFirstOrThrow();
  const run = await database.db.selectFrom('chat_runs').select('state').where('conversation_id', '=', id).executeTakeFirstOrThrow();
  const inputPhases = (run.state as BrainState).actionCompletion?.events.filter(item => item.event.kind === 'computer_click').map(item => item.event.phase) ?? [];
  expect(entered).toBe(true); expect(performCalls).toBe(1); expect(accountChecks).toBeGreaterThan(0); expect(forbiddenCalls).toBe(0);
  expect(role.active).toBe(true); expect(roleChangeCommitted).toBe(downgradeAtQueueEntry);
  return { downgradeAtQueueEntry, grantPath, canonical, role, fullAccessReads, accountChecks, performCalls, fenceCalls,
    roleFenceCalls: roleFenceTransactions.length, sameRoleFenceTransaction: roleFenceTransactions.length === 2
      && roleFenceTransactions[0] === roleFenceTransactions[1], commands, inputAuditCount: inputAudit.length, nextSequence: grant.next_sequence, inputPhases,
    scope: 'Queue admission only; no companion ever polls or applies a command.' };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.chat.shutdown(); await f.app.close(); await f.database.close(); } });

describe('owner-only role changes at the real Windows queue transaction boundary', () => {
  it('does not admit an input when owner-only access was withdrawn before the native queue transaction begins', async () => {
    const result = await run(true); expect(result.role.full_access).toBe(false);
    expect(result.commands, JSON.stringify(result)).toEqual([]); expect(result.inputAuditCount).toBe(0); expect(result.nextSequence).toBe(1);
    expect(result.roleFenceCalls).toBe(1); expect(result.inputPhases).toContain('denied'); expect(result.inputPhases).not.toContain('unknown');
  });
  it('retains one queued command when the same owner role remains allowed, without claiming native execution', async () => {
    const result = await run(false); expect(result.role.full_access).toBe(true);
    expect(result.commands).toHaveLength(1); expect(result.commands[0]?.owner_id).toBe(OWNER);
    expect(result.inputAuditCount).toBe(1); expect(result.nextSequence).toBe(2); expect(result.fenceCalls).toBe(2);
    expect(result.roleFenceCalls).toBe(2); expect(result.sameRoleFenceTransaction).toBe(true);
  });
  it.each(['primary', 'additional'] as const)('composes the real production %s grant helper with actual native admission', async grantPath => {
    const result = await run(false, grantPath);
    expect(result.canonical).toBe('owner'); expect(result.role.full_access).toBe(true);
    expect(result.commands).toHaveLength(1); expect(result.inputAuditCount).toBe(1); expect(result.nextSequence).toBe(2);
    expect(result.roleFenceCalls).toBe(2); expect(result.sameRoleFenceTransaction).toBe(true);
  });
  it('uses the real production helper to deny a committed additional-owner downgrade while preserving member account access', async () => {
    const result = await run(true, 'additional');
    expect(result.canonical).toBe('member'); expect(result.role).toEqual({ active: true, full_access: false });
    expect(result.commands, JSON.stringify(result)).toEqual([]); expect(result.inputAuditCount).toBe(0); expect(result.nextSequence).toBe(1);
    expect(result.roleFenceCalls).toBe(1); expect(result.inputPhases).toContain('denied'); expect(result.inputPhases).not.toContain('unknown');
  });
});
