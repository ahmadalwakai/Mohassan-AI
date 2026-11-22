import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { WindowsOrigin, WindowsView } from '@mohassan/windows';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools } from '../apps/server/src/assistant/tools.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

type Modules = Parameters<typeof createAssistantTools>[0];
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
const OWNER = 'isolated-computer-scope-chat-owner';
const CLAIM = 'The requested computer input completed.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('No unrelated module, network or real desktop belongs to this scope fixture.'); };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  initial: WindowsOrigin; fresh: WindowsOrigin; script: Script[]; models: ModelRequest[];
  reads: WindowsView[]; queued: { frameId: string; expected?: WindowsOrigin; action: unknown }[];
}
const fixtures: Fixture[] = [];
async function harness(change: 'none' | 'window' | 'grant' | 'device' = 'none'): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db);
  const initial = { deviceId: randomUUID(), grantId: randomUUID(), targetKey: 'a'.repeat(64) };
  const fresh = { ...initial, ...(change === 'none' ? {} : { grantId: randomUUID() }),
    ...(change === 'window' ? { targetKey: 'b'.repeat(64) } : change === 'device' ? { deviceId: randomUUID() } : {}) };
  const reads: WindowsView[] = [], queued: Fixture['queued'] = [], script: Script[] = [], models: ModelRequest[] = [];
  const observations = [initial, fresh].map((origin, index): WindowsView => ({ scope: 'control', origin,
    target: { title: `Synthetic window ${index}`, width: index ? 1000 : 800, height: 600 },
    frame: { id: randomUUID(), targetKey: origin.targetKey, capturedAt: new Date().toISOString(), width: 800, height: 600,
      jpeg: Buffer.from('synthetic frame boundary; no actual pixels'.repeat(4)).toString('base64'),
      elements: [{ name: 'Confirm', type: 'ControlType.Button', x: 500, y: 20, width: 100, height: 40, password: false }] } }));
  const windows: Modules['windows'] = { enabled: true, requiresViewOrigin: true,
    async view() { const observed = observations[Math.min(reads.length, 1)]!; reads.push(observed); return observed; },
    async act(_owner, frameId, action, expected) { queued.push({ frameId, action, expected }); return { id: randomUUID(), status: 'queued' }; },
    async command() { return { status: 'applied', code: null }; } };
  const tools = createAssistantTools({ memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false, runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused }, windows });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: unused, observe: unused, screen: unused, prepareAction: unused } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, tools, fullAccess: async () => true, recordExperiences: false,
    models: { fast: ['scope-chat-script'], deep: ['scope-chat-script'], vision: '' },
    searchProvider: { name: 'forbidden-scope-chat-network', search: unused } as SearchProvider,
    createProvider: model => ({ id: 'isolated-scope-script', async generate(request: ModelRequest) {
      models.push(request); if (models.length > 8) throw new Error('Bounded scope script exhausted.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK,
        ...(script.shift() ?? { tool: 'answer', text: CLAIM, outcome: 'done' }) }) };
    } }),
  });
  const f: Fixture = { database, control, initial, fresh, script, models, reads, queued }; fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown(); await f.database.close(); } });
async function settle(f: Fixture, id: string) {
  await f.control.settled(id); const detail = await f.control.detail(OWNER, id);
  const row = await f.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  return { id, detail, status: row.status as string, state: row.state as BrainState,
    text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
async function start(f: Fixture, request = 'Click the Confirm button in the current PC window.') {
  const { id } = await f.control.create(OWNER, { goal: request }); return settle(f, id);
}
function denied(result: Awaited<ReturnType<typeof settle>>) {
  expect(result.status).not.toBe('completed'); expect(result.text).not.toContain(CLAIM);
  expect(result.state.actionCompletion?.events.some(record => record.event.phase === 'denied')).toBe(true);
  expect(result.state.actionCompletion?.events.some(record => record.event.phase === 'unknown')).toBe(false);
}

describe('native scope through actual isolated controller and assistant adapter', () => {
  it.each(['window', 'grant', 'device'] as const)('does not rebind the old click to a new %s after computer_view', async changed => {
    const f = await harness(changed); f.script.push({ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w1' });
    denied(await start(f)); expect(f.queued).toEqual([]); expect(f.reads).toHaveLength(2);
  });
  it.each([{ tool: 'computer_type', text: 'AUDIT-TEXT', request: 'Type AUDIT-TEXT into the current PC window.' },
    { tool: 'computer_key', text: 'Escape', request: 'Press Escape in the current PC window.' }] as const)
    ('forwards stored view origin for %s and does not input under a replacement grant', async entry => {
      const f = await harness('grant'); f.script.push({ tool: 'computer_view' }, { tool: entry.tool, text: entry.text });
      denied(await start(f, entry.request)); expect(f.queued).toEqual([]);
    });
  it('rejects native model input before any explicit view instead of obtaining authority from an internal refresh', async () => {
    const f = await harness(); f.script.push({ tool: 'computer_type', text: 'AUDIT-TEXT' });
    denied(await start(f, 'Type AUDIT-TEXT into the current PC window.')); expect(f.queued).toEqual([]); expect(f.reads).toEqual([]);
  });
  it.each([{ tool: 'computer_click', ref: 'w1', request: 'Click the Confirm button in the current PC window.' },
    { tool: 'computer_type', text: 'AUDIT-TEXT', request: 'Type AUDIT-TEXT into the current PC window.' },
    { tool: 'computer_key', text: 'Escape', request: 'Press Escape in the current PC window.' }] as const)
    ('allows a same-scope fresh-frame %s with the original expected origin', async entry => {
      const f = await harness(); f.script.push({ tool: 'computer_view' }, { tool: entry.tool, ...('ref' in entry ? { ref: entry.ref } : { text: entry.text }) });
      const result = await start(f, entry.request); expect(result.status).toBe('completed'); expect(f.queued).toHaveLength(1);
      expect(f.queued[0]?.expected).toEqual(f.initial); expect(f.queued[0]?.frameId).toBe(f.reads[1]!.frame.id);
      expect(result.state.computerOrigin).toEqual(f.initial);
    });
  it('preserves the observed origin through pending approval and refuses a changed scope on resume', async () => {
    const f = await harness('grant'); f.script.push({ tool: 'computer_view' }, { tool: 'computer_click', ref: 'w1', sensitive: true });
    const waiting = await start(f); expect(waiting.detail.status).toBe('waiting_approval');
    expect(waiting.state.pendingComputer?.step.origin).toEqual(f.initial); expect(f.queued).toEqual([]);
    await f.control.approve(OWNER, waiting.id, { approvalId: waiting.detail.approval!.id, approved: true });
    denied(await settle(f, waiting.id)); expect(f.queued).toEqual([]);
  });
});
