import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState, Decision } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-local-observation-scope-owner';
const CANARY = 'SYNTHETIC-PRIVATE-WINDOW-528', URL = `https://controlled-fixture.test/view?title=${CANARY}`;
const REQUEST = 'Read the title of my current computer window.';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type Script = Partial<Decision> & Pick<Decision, 'tool'>;
const fixtures: Array<{ control: Awaited<ReturnType<typeof createCommandChatControl>>; database: Awaited<ReturnType<typeof createDatabase>> }> = [];
async function fixture(script: Script[]) {
  const database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
  const opens: AgentAction[] = [];
  let current: AgentPage | null = null;
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('No actual network, memory write, native input or Runtime belongs to this fixture.'); });
  const view = vi.fn(async () => ({ title: CANARY, jpeg: '', elements: [], canAct: false, hasPasswordField: false }));
  const list = vi.fn(async () => 'Synthetic registered project names.');
  const inventory = vi.fn(async () => [{ id: 'synthetic-inventory-id', name: 'Synthetic project' }]);
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return current !== null; },
    async prepareAction() { return null; }, async screen() { return null; },
    async observe() { if (!current) throw new Error('No synthetic page.'); return { page: current, changed: false }; },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      opens.push(action); current = { id: 'local-scope-synthetic-page', hash: 'a'.repeat(24), url: action.text ?? URL,
        title: 'Synthetic destination', text: 'No URL was fetched.', documentStatus: 200, observedAt: new Date().toISOString(), elements: [],
        signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 200, viewport: 800 } };
      return { page: current, changed: true };
    } } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
    models: { fast: ['local-scope-synthetic-model'], deep: ['local-scope-synthetic-model'], vision: '' },
    searchProvider: { name: 'forbidden-local-scope-network', search: forbidden } as SearchProvider,
    tools: { computer: { view, perform: forbidden }, work: { list, inventory, approve: forbidden, outcome: forbidden, cancel: forbidden } },
    createProvider: model => ({ id: 'local-scope-synthetic-model', async generate() {
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK,
        ...(script.shift() ?? { tool: 'answer', text: 'No further verified result.', outcome: 'partial' }) }) };
    } }),
  });
  fixtures.push({ database, control }); return { database, control, view, list, inventory, opens, forbidden };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown(); await f.database.close(); } });
async function run(f: Awaited<ReturnType<typeof fixture>>, goal = REQUEST) {
  const { id } = await f.control.create(OWNER, { goal }); await f.control.settled(id);
  const row = await f.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
  return { status: row.status, state: row.state as BrainState };
}
describe('local private observation does not authorize unrelated tools', () => {
  it('does not open a model-chosen URL after a private computer observation', async () => {
    const f = await fixture([{ tool: 'computer_view' }, { tool: 'open', url: URL }]);
    const result = await run(f);
    expect(result.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'local_state', scope: 'private', operation: 'lookup' });
    expect(f.view).toHaveBeenCalledTimes(1); expect(f.opens).toEqual([]); expect(f.list).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('does not read unrelated owner projects after a private computer observation', async () => {
    const f = await fixture([{ tool: 'computer_view' }, { tool: 'workspace_list' }]);
    const result = await run(f);
    expect(result.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'local_state', scope: 'private', operation: 'lookup' });
    expect(f.view).toHaveBeenCalledTimes(1); expect(f.list).not.toHaveBeenCalled(); expect(f.opens).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('keeps the requested computer observation available without native input', async () => {
    const f = await fixture([{ tool: 'computer_view' }]); await run(f);
    expect(f.view).toHaveBeenCalledTimes(1); expect(f.list).not.toHaveBeenCalled(); expect(f.opens).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('keeps a standalone explicitly requested browser navigation available', async () => {
    const f = await fixture([]); await run(f, `Open ${URL}`);
    expect(f.opens).toEqual([{ kind: 'open', text: URL }]); expect(f.view).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  });
});
