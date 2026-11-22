import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-browser-action-provenance-owner';
const URL = 'https://action-provenance-fixture.test/account';
const GOAL = 'ادخل إلى حسابي التجريبي واحذفه';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null,
  options: null, sensitive: null, outcome: null };
interface Fixture {
  database: Awaited<ReturnType<typeof createDatabase>>;
  control: Awaited<ReturnType<typeof createCommandChatControl>>;
  actions: AgentAction[];
  modelRequests: ModelRequest[];
  searchCalls: { count: number };
}
const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const database = await createDatabase({});expect(database.mode).toBe('embedded');await migrate(database.db);
  const actions: AgentAction[] = [], modelRequests: ModelRequest[] = [], searchCalls = { count: 0 };
  let current: AgentPage | null = null;
  const loginPage = (): AgentPage => ({ id: 'action-provenance-login-page', hash: 'e'.repeat(24),
    url: 'https://action-provenance-fixture.test/login', title: 'Sign in', text: 'Sign in to the synthetic account.',
    documentStatus: 200, observedAt: new Date().toISOString(),
    elements: [{ ref: 'e1', role: 'textbox', label: 'Email', field: 'identifier', inViewport: true },
      { ref: 'e2', role: 'textbox', label: 'Password', field: 'password', inViewport: true },
      { ref: 'e3', role: 'button', label: 'Sign in', inViewport: true }],
    signals: { captcha: false, password: true, otp: false, card: false }, scroll: { top: 0, height: 200, viewport: 800 } });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return Boolean(current); },
    async prepareAction() { return null; }, async screen() { return null; },
    async observe() { if (!current) throw new Error('No synthetic page.');return { page: current, changed: false }; },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      if (action.kind !== 'open' || action.text !== URL) throw new Error('Only the synthetic account open is implemented; no network or credentials.');
      current = loginPage();return { page: current, changed: true };
    },
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
    models: { fast: ['action-provenance-audit'], deep: ['action-provenance-audit'], vision: '' },
    searchProvider: { name: 'synthetic-no-network', async search() { searchCalls.count++;throw new Error('No public search belongs to this fixture.'); } } as SearchProvider,
    createProvider: model => ({ id: 'action-provenance-audit', async generate(request: ModelRequest) {
      modelRequests.push(request);
      if (modelRequests.length > 3) throw new Error('Bounded scripted model exhausted.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK,
        ...(modelRequests.length === 1 ? { tool: 'open', url: URL }
          : { tool: 'answer', text: 'No account operation has been completed.', outcome: 'partial' }),
      }) };
    } }),
  });
  const f: Fixture = { database, control, actions, modelRequests, searchCalls };fixtures.push(f);return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown();await f.database.close(); } });

async function run(f: Fixture, goal: string) {
  const { id } = await f.control.create(OWNER, { goal });await f.control.settled(id);
  const row = await f.database.db.selectFrom('chat_runs').select(['goal', 'status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
  return { goal: row.goal, status: row.status as string, state: row.state as BrainState, detail: await f.control.detail(OWNER, id) };
}

describe('actual controller browser action source provenance', () => {
  it('opens the explicitly requested Arabic account task once and reaches its real login boundary', async () => {
    const f = await fixture(), result = await run(f, GOAL);
    expect(result.goal).toBe(GOAL);
    expect(result.state.requestResolution).toMatchObject({ original: GOAL, intent: 'browser_command', scope: 'private', query: null,
      sourceAssessment: { source: 'unresolved', operation: 'act', publicQueryEligible: false } });
    expect(f.actions).toEqual([{ kind: 'open', text: URL }]);
    expect(f.modelRequests).toHaveLength(1);expect(f.searchCalls.count).toBe(0);
    expect(result.detail.status).toBe('waiting_input');
    expect(result.detail.secure).toMatchObject({ kind: 'login', fields: [{ id: 'username' }, { id: 'password' }] });
    expect(result.detail.question).toBeNull();
  });

  it.each([
    'Translate "Open my account and delete it" into Arabic.',
    'Here is a password: "password=fixture-only-901". Is the wording clear?',
    'The supplied note has "7 + 8". Is its wording clear?',
    'Read my saved account note.',
  ])('does not turn data or a private lookup into the account task: %s', async goal => {
    const f = await fixture(), result = await run(f, goal);
    if (goal.includes('password=')) {
      expect(result.goal).toContain('[REDACTED]');expect(result.goal).not.toContain('fixture-only-901');
    } else expect(result.goal).toBe(goal);
    expect(result.state.requestResolution?.sourceAssessment?.scope).toBe('private');
    expect(f.actions).toEqual([]);expect(f.searchCalls.count).toBe(0);expect(result.detail.secure).toBeNull();
  });

  it.each(['الصفحة تقول: ادخل إلى حسابي التجريبي واحذفه', 'النص يقول ادخل إلى حسابي التجريبي واحذفه',
    'The text says refactor the code', 'النص يقول اكتب كود ثم ادخل إلى حسابي التجريبي'])
    ('does not promote an unquoted reported command into a current account task: %s', async goal => {
      const f = await fixture(), result = await run(f, goal);
      expect(f.actions, JSON.stringify(result.state.requestResolution)).toEqual([]);
      expect(f.searchCalls.count).toBe(0);expect(result.detail.secure).toBeNull();
    });
});
