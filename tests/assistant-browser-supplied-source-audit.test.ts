import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { assessRequestScope, isEntireLiteralRequest } from '../apps/server/src/assistant/request-scope.js';
import { reviewBrowserRequestScope } from '../apps/server/src/assistant/browser-request-scope.js';
import type { BrainState } from '../apps/server/src/assistant/brain.js';

const OWNER = 'isolated-supplied-browser-authority-owner';
const URL = 'https://supplied-scope-fixture.test/should-not-open';
const UUID_MESSAGE = 'This message contains "Prepare a skill run for 5b43a480-6527-4f5b-a0c6-3d2637b91724." Is it clear?';
const ARITHMETIC_MESSAGE = 'The supplied note has "7 + 8". Is its wording clear?';
// This is a synthetic credential marker, never a real account value.
const UNKNOWN_MESSAGE = 'Here is a password: "password=synthetic-value-739". Is the wording clear?';
const LITERAL_MESSAGE = `"Open ${URL}"`;
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
  const makePage = (url: string): AgentPage => ({ id: 'supplied-authority-fake-page', hash: 'a'.repeat(24),
    url, title: 'Synthetic controller boundary; no network', text: 'No URL was fetched.', documentStatus: 200,
    observedAt: new Date().toISOString(), elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 200, viewport: 800 } });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async hasPage() { return Boolean(current); },
    async prepareAction() { return null; }, async screen() { return null; },
    async observe() { if (!current) throw new Error('No synthetic page.');return { page: current, changed: false }; },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      if (action.kind !== 'open' || !action.text) throw new Error('This fake port only records open actions; it never accesses the network.');
      current = makePage(action.text);return { page: current, changed: true };
    },
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
    models: { fast: ['supplied-browser-audit'], deep: ['supplied-browser-audit'], vision: '' },
    searchProvider: { name: 'synthetic-no-network', async search() { searchCalls.count++;throw new Error('No public search belongs to this audit.'); } } as SearchProvider,
    createProvider: model => ({ id: 'supplied-browser-audit', async generate(request: ModelRequest) {
      modelRequests.push(request);
      if (modelRequests.length > 3) throw new Error('Bounded scripted model exhausted.');
      return { model, usage: { inputTokens: 1, outputTokens: 1 }, text: JSON.stringify({ ...BLANK,
        ...(modelRequests.length === 1 ? { tool: 'open', url: URL }
          : { tool: 'answer', text: 'No further verified result is available in this synthetic audit.', outcome: 'partial' }),
      }) };
    } }),
  });
  const f: Fixture = { database, control, actions, modelRequests, searchCalls };fixtures.push(f);return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.control.shutdown();await f.database.close(); } });
async function run(f: Fixture, goal: string) {
  const { id } = await f.control.create(OWNER, { goal });await f.control.settled(id);
  const row = await f.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
  return { status: row.status as string, state: row.state as BrainState };
}

describe('independent supplied-source browser audit: data never supplies current navigation authority', () => {
  it.each([
    [UUID_MESSAGE, 'compute'], [ARITHMETIC_MESSAGE, 'compute'], [UNKNOWN_MESSAGE, 'unknown'], [LITERAL_MESSAGE, 'unknown'],
  ] as const)('vetoes supplied data regardless of inferred operation: %s', (request, operation) => {
    expect(assessRequestScope(request)).toMatchObject({ source: 'supplied_content', scope: 'private', operation });
    for (const capability of ['browser_navigation', 'browser_action'] as const)
      expect(reviewBrowserRequestScope(request, capability).allowed).toBe(false);
  });

  it.each([UUID_MESSAGE, ARITHMETIC_MESSAGE, UNKNOWN_MESSAGE])('does not dispatch model-proposed navigation for a literal data question: %s', async goal => {
    expect(isEntireLiteralRequest(goal)).toBe(false);
    const f = await fixture(), result = await run(f, goal);
    expect(result.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'supplied_content', scope: 'private' });
    expect(f.actions, `Actual fake-port dispatches=${JSON.stringify(f.actions)}; modelCalls=${f.modelRequests.length}; run=${result.status}`).toEqual([]);
    expect(f.searchCalls.count).toBe(0);
  });

  it('retains the earlier whole-literal clarification fence without invoking the model or browser', async () => {
    const f = await fixture(), result = await run(f, LITERAL_MESSAGE);
    expect(result.status).toBe('waiting_user');expect(f.modelRequests).toHaveLength(0);expect(f.actions).toEqual([]);
    expect(f.searchCalls.count).toBe(0);
  });
  it('keeps a supplied transformation read-only even when the model proposes opening its quoted URL', async () => {
    const f = await fixture();await run(f, `Translate "Open ${URL}" into Arabic.`);
    expect(f.actions).toEqual([]);expect(f.searchCalls.count).toBe(0);
  });
  it('preserves an explicit current-user OpenURL request as the positive control', async () => {
    const f = await fixture();await run(f, `Open ${URL}`);
    expect(f.actions).toEqual([{ kind: 'open', text: URL }]);expect(f.searchCalls.count).toBe(0);
  });
  it('preserves the explicit outer URL-open after a current computation imperative', async () => {
    const f = await fixture();await run(f, `Calculate 2 + 3, then open ${URL}.`);
    expect(f.actions).toEqual([{ kind: 'open', text: URL }]);expect(f.searchCalls.count).toBe(0);
  });
});
