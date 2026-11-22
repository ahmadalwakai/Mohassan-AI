import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { WindowsView } from '@mohassan/windows';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createAssistantTools, elementCenter } from '../apps/server/src/assistant/tools.js';
import { actionOperandHash } from '../apps/server/src/assistant/action-completion.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

type Element = WindowsView['frame']['elements'][number];
type Modules = Parameters<typeof createAssistantTools>[0];
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
const OWNER = 'isolated-computer-target-chat-owner';
const CLAIM = 'I clicked the requested button successfully.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
const target = { title: 'Synthetic current PC window', width: 800, height: 600 };
const element = (name = 'Continue', x = 20, overrides: Partial<Element> = {}): Element =>
  ({ name, type: 'ControlType.Button', x, y: 20, width: 100, height: 40, password: false, ...overrides });
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  script: Script[]; requests: ModelRequest[];
  frames: WindowsView['frame'][];
  queued: { ownerId: string; frameId: string; action: unknown }[];
  reads: { ownerId: string; frameId: string }[];
}
const fixtures: Fixture[] = [];
const unused = async (..._args: unknown[]): Promise<never> => { throw new Error('The isolated computer-target fixture reached an unrelated module or network.'); };

/** Real chat controller + real assistant adapter; fake Windows port never sends desktop input. */
async function harness(initial: Element[], fresh: Element[] = initial): Promise<Fixture> {
  const database = await createDatabase({}); await migrate(database.db);
  const frames = [initial, fresh].map(elements => ({ id: randomUUID(), targetKey: 'b'.repeat(64), capturedAt: new Date().toISOString(),
    width: 800, height: 600, jpeg: Buffer.from('synthetic frame boundary; no user pixels'.repeat(4)).toString('base64'), elements }));
  const queued: Fixture['queued'] = [], reads: Fixture['reads'] = [], requests: ModelRequest[] = [], script: Script[] = [];
  const windows: Modules['windows'] = { enabled: true,
    async view(ownerId) { const frame = frames[Math.min(reads.length, 1)]!; reads.push({ ownerId, frameId: frame.id }); return { scope: 'control', target, frame }; },
    async act(ownerId, frameId, action) { queued.push({ ownerId, frameId, action }); return { id: randomUUID(), status: 'queued' }; },
    async command() { return { status: 'applied', code: null }; } };
  const tools = createAssistantTools({ memory: { search: unused, create: unused }, coding: { available: false, workspace: unused },
    studio: { workspace: unused, detail: unused }, studioChange: false,
    runtime: { createTask: unused, approve: unused, cancel: unused, detail: unused }, windows });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    act: unused, observe: unused, prepareAction: unused, screen: unused } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, tools, fullAccess: async () => true, recordExperiences: false,
    models: { fast: ['synthetic-target-model'], deep: ['synthetic-target-model'], vision: '' },
    searchProvider: { name: 'forbidden-computer-target-network', search: unused } as SearchProvider,
    createProvider: model => ({ id: 'isolated-target-script', async generate(request: ModelRequest) {
      requests.push(request); if (requests.length > 8) throw new Error('Bounded target script exhausted its model allowance.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK,
        ...(script.shift() ?? { tool: 'answer', text: 'The fixture has no further verified result.', outcome: 'partial' }) }) };
    } }),
  });
  const fixture: Fixture = { database, control, script, requests, frames, queued, reads }; fixtures.push(fixture); return fixture;
}
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); } });
async function run(fixture: Fixture, name = 'Continue', ref = 'w2') {
  fixture.script.push({ tool: 'computer_view' }, { tool: 'computer_click', ref },
    ...Array.from({ length: 3 }, () => ({ tool: 'answer' as const, text: CLAIM, outcome: 'done' as const })));
  const { id } = await fixture.control.create(OWNER, { goal: `Click the ${name} button in the current PC window.` });
  await fixture.control.settled(id);
  const detail = await fixture.control.detail(OWNER, id);
  const row = await fixture.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id)
    .orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  return { detail, status: row.status as string, state: row.state as BrainState,
    text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '' };
}
function denied(completed: Awaited<ReturnType<typeof run>>) {
  expect(completed.status).not.toBe('completed'); expect(completed.text).not.toContain(CLAIM);
  expect(completed.state.actionCompletion?.events.some(record => record.event.kind === 'computer_click' && record.event.phase === 'denied')).toBe(true);
  expect(completed.state.actionCompletion?.events.some(record => record.event.kind === 'computer_click' && record.event.phase === 'unknown')).toBe(false);
}

describe('computer target binding through the real isolated chat', () => {
  it('does not silently click w1 when the model selected an ambiguously named w2', async () => {
    const fixture = await harness([element('Continue', 20), element('Continue', 520)]);
    const completed = await run(fixture); denied(completed); expect(fixture.queued).toEqual([]);
    expect(completed.state.computerElements?.every(entry => entry.ambiguous === true)).toBe(true);
  });
  it('preserves observed ambiguity when one duplicate disappears before the action', async () => {
    const left = element('Continue', 20), right = element('Continue', 520), fixture = await harness([left, right], [left]);
    denied(await run(fixture)); expect(fixture.queued).toEqual([]);
  });
  it('forwards ambiguity computed before the listing cap even if the visible list has only one matching name', async () => {
    const old = [element('Continue', 20), ...Array.from({ length: 23 }, (_, index) => element(`Other ${index}`, 200)), element('Continue', 520)];
    const fixture = await harness(old, [old.at(-1)!]); const completed = await run(fixture, 'Continue', 'w1');
    denied(completed); expect(fixture.queued).toEqual([]);
    expect(completed.state.computerElements?.filter(entry => entry.name === 'Continue')).toEqual([{ ref: 'w1', name: 'Continue', type: 'Button', ambiguous: true }]);
  });
  it('rejects newly ambiguous fresh matches as a known pre-queue denial rather than an unknown effect', async () => {
    const selected = element('Continue', 520), fixture = await harness([selected], [element('Continue', 20), selected]);
    denied(await run(fixture, 'Continue', 'w1')); expect(fixture.queued).toEqual([]); expect(fixture.reads).toHaveLength(2);
  });
  it('uses the full requested long name for both the actual target and acknowledged action hash', async () => {
    const prefix = 'P'.repeat(150), left = element(`${prefix}-left`, 20), right = element(`${prefix}-right`, 520);
    const fixture = await harness([left, right]); const completed = await run(fixture, right.name);
    expect(completed.status).toBe('completed'); expect(fixture.queued).toEqual([{ ownerId: OWNER, frameId: fixture.frames[1]!.id,
      action: { type: 'click', button: 'left', ...elementCenter(right, target) } }]);
    expect(completed.state.actionCompletion?.events.some(record => record.event.phase === 'acknowledged'
      && record.event.kind === 'computer_click' && record.event.targetHash === actionOperandHash('computer_click', right.name))).toBe(true);
  });
  it('does not click a remaining common-prefix element after the selected full-name target disappears', async () => {
    const prefix = 'P'.repeat(50), left = element(`${prefix}-left`, 20), right = element(`${prefix}-right`, 520);
    const fixture = await harness([left, right], [left]); denied(await run(fixture, right.name)); expect(fixture.queued).toEqual([]);
  });
  it('does not click a different renamed target whose first 50 characters happen to match', async () => {
    const prefix = 'P'.repeat(50), selected = element(`${prefix}-right`, 520), fixture = await harness([selected], [element(`${prefix}-replacement`, 20)]);
    denied(await run(fixture, selected.name, 'w1')); expect(fixture.queued).toEqual([]);
  });
  it('excludes an invisible duplicate instead of clicking its zero-width rectangle', async () => {
    const shown = element('Continue', 520), fixture = await harness([element('Continue', 20, { width: 0 }), shown]);
    const completed = await run(fixture, 'Continue', 'w1');
    expect(completed.status).toBe('completed'); expect(fixture.queued[0]).toEqual({ ownerId: OWNER, frameId: fixture.frames[1]!.id,
      action: { type: 'click', button: 'left', ...elementCenter(shown, target) } });
  });
  it('keeps the selected uniquely named target across a harmless reordered fresh frame', async () => {
    const back = element('Back', 20), selected = element('Continue', 520), fixture = await harness([back, selected], [selected, back]);
    const completed = await run(fixture);
    expect(completed.status).toBe('completed'); expect(fixture.queued[0]).toEqual({ ownerId: OWNER, frameId: fixture.frames[1]!.id,
      action: { type: 'click', button: 'left', ...elementCenter(selected, target) } });
  });
});
