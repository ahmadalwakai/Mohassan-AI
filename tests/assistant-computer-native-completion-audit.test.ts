import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { registerWindowsRoutes, windowsMigration } from '@mohassan/windows';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import { migrateAuth } from '../apps/server/src/auth.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-native-completion-owner', SESSION_ID = 'synthetic-native-completion-session';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('This native queue audit has no external or unrelated port.'); };
const CLAIM = 'The requested input was applied.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  app: ReturnType<typeof Fastify>;
  chat: Awaited<ReturnType<typeof createCommandChatControl>>;
  native: Awaited<ReturnType<typeof registerWindowsRoutes>>;
  commandsRead: string[];
  modelCalls(): number;
}
const fixtures: Fixture[] = [];

/** Real queue/status domain, real adapter/controller, no poller, companion or desktop process. */
async function fixture(input: Partial<Decision>): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db); await migrateAuth(database.db); await windowsMigration(database.db);
  await database.db.insertInto('user').values({ id: OWNER, name: OWNER, email: `${OWNER}@example.test` }).execute();
  await database.db.insertInto('session').values({ id: SESSION_ID, userId: OWNER, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) }).execute();
  const deviceId = randomUUID(), grantId = randomUUID(), targetKey = 'b'.repeat(64), epoch = randomUUID();
  const frame = { id: randomUUID(), targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
    jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'),
    elements: [{ name: 'Confirm', type: 'ControlType.Button', x: 20, y: 20, width: 100, height: 40, password: false }] };
  const state = { approvalNonce: epoch, sessionId: 1, safeDesktop: true, localView: true, localControl: true,
    target: { key: targetKey, mode: 'window', title: 'Synthetic disconnected native fixture', width: 800, height: 600 }, status: 'isolated' };
  await database.db.insertInto('windows_devices').values({ id: deviceId, owner_id: OWNER, name: 'Synthetic disconnected device',
    key_hash: hash('synthetic-unused-device-key'), last_seen_at: new Date(), state: JSON.stringify(state),
    last_frame: JSON.stringify({ ...frame, receivedAt: new Date().toISOString() }) }).execute();
  await database.db.insertInto('windows_grants').values({ id: grantId, owner_id: OWNER, device_id: deviceId, session_binding: `session:${hash(SESSION_ID)}`,
    scope: 'control', target_key: targetKey, approval_nonce: epoch, expires_at: new Date(Date.now() + 30000) }).execute();
  const app = Fastify({ logger: false });
  const native = await registerWindowsRoutes(app, { db: database.db, owner: async () => ({ id: OWNER, sessionId: SESSION_ID }),
    lockOwnerAccess: async (_tx, id) => id === OWNER,
    config: { webOrigin: 'http://127.0.0.1:3000', production: false, windowsEnabled: true } });
  await app.ready();
  const commandsRead: string[] = [];
  const tools = createAssistantTools({ memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false, runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused },
    commandWaitMs: 300, windows: { ...native, async command(ownerId, id) {
      const command = await native.command(ownerId, id); commandsRead.push(command.status); return command;
    } } });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: unused, observe: unused, screen: unused, prepareAction: unused } as unknown as AgentBrowser;
  let modelCalls = 0;
  const chat = await createCommandChatControl(database.db, { browser, tools, fullAccess: async () => true, recordExperiences: false,
    models: { fast: ['native-completion-script'], deep: ['native-completion-script'], vision: '' },
    searchProvider: { name: 'forbidden-native-completion-network', search: unused } as SearchProvider,
    createProvider: model => ({ id: 'native-completion-script', async generate() {
      if (++modelCalls > 3) throw new Error('Native completion script exhausted.');
      const decision = modelCalls === 1 ? { tool: 'computer_view' } : modelCalls === 2 ? input : { tool: 'answer', text: CLAIM, outcome: 'done' };
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }),
  });
  const f: Fixture = { database, app, chat, native, commandsRead, modelCalls: () => modelCalls }; fixtures.push(f); return f;
}

afterEach(async () => { for (const f of fixtures.splice(0)) { await f.chat.shutdown(); await f.app.close(); await f.database.close(); } });

describe('native queue admission is not an applied-input acknowledgment', () => {
  it.each([
    { input: { tool: 'computer_click', ref: 'w1' }, kind: 'computer_click', request: 'Click the Confirm button in the current PC window.' },
    { input: { tool: 'computer_type', text: 'NATIVE-AUDIT-TEXT' }, kind: 'computer_type', request: 'Type NATIVE-AUDIT-TEXT into the current PC window.' },
    { input: { tool: 'computer_key', text: 'Escape' }, kind: 'computer_key', request: 'Press Escape in the current PC window.' },
  ] as const)('keeps unconfirmed $kind unknown, never completed, and never retries the committed queue command', async entry => {
    const f = await fixture(entry.input), { id } = await f.native.runInSession(OWNER, SESSION_ID, () => f.chat.create(OWNER, { goal: entry.request }));
    await f.chat.settled(id);
    const detail = await f.chat.detail(OWNER, id);
    const run = await f.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    const state = run.state as BrainState;
    const events = state.actionCompletion?.events.map(record => record.event).filter(event => event.kind === entry.kind);
    expect(detail.status).toBe('failed'); expect(run.status).toBe('failed');
    expect(detail.error).toBe('نتيجة الإجراء غير محسومة. لم أكرره؛ راجع النتيجة قبل أي محاولة جديدة.');
    expect(detail.messages.some(message => message.role === 'assistant' && message.text.includes(CLAIM))).toBe(false);
    expect(events?.map(event => [event.phase, event.proof])).toEqual([['started', 'none'], ['unknown', 'none']]);
    expect(f.modelCalls()).toBe(2); // The fake "done" answer is never requested.
    expect(f.commandsRead.length).toBeGreaterThanOrEqual(2); expect(new Set(f.commandsRead)).toEqual(new Set(['queued']));
    const commands = await f.database.db.selectFrom('windows_commands').select(['status', 'payload']).where('owner_id', '=', OWNER).execute();
    expect(commands).toHaveLength(1); expect(commands[0]?.status).toBe('queued');
  });
});
