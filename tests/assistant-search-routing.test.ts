import { afterEach, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { WIKI_SEARCH } from '../apps/server/src/assistant/hands.js';

const owner = 'isolated-search-route-owner';
let database: Awaited<ReturnType<typeof createDatabase>> | undefined;
let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;

afterEach(async () => {
  await control?.shutdown();
  await database?.close();
});

it('uses shared search for a new chat question after an explicit Wikipedia search', async () => {
  database = await createDatabase();
  await migrate(database.db);
  const wiki = WIKI_SEARCH('اليابان');
  const govUrl = 'https://www.gov.uk/passport-fees';
  const secondUrl = 'https://www.passport.service.gov.uk/help/fees';
  const page = (url: string, text: string, elements: AgentPage['elements'] = []): AgentPage => ({
    id: url, hash: url, url, text, title: url === govUrl ? 'UK passport renewal fees - GOV.UK' : 'Wikipedia search', elements,
    signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: new Date().toISOString(),
  });
  const wikiPage = page(wiki, '', [
    { ref: 'wiki-box', role: 'searchbox', label: 'Search Wikipedia', inViewport: true },
    { ref: 'japan', role: 'link', label: 'اليابان', href: 'https://ar.wikipedia.org/wiki/اليابان', inViewport: true },
  ]);
  const govPage = page(govUrl, 'UK passport renewal fees depend on whether you apply online or by post.');
  const secondPage = page(secondUrl, 'UK passport renewal fees are shown before an application is submitted.');
  let current: AgentPage | null = null;
  const actions: AgentAction[] = [];
  const queries: string[] = [];
  const searchProvider: SearchProvider = {
    name: 'isolated-public-search',
    async search(query) {
      queries.push(query);
      return [{ title: govPage.title, url: govUrl, snippet: govPage.text }, { title: 'UK passport renewal fees explained', url: secondUrl, snippet: secondPage.text }];
    },
  };
  const browser = {
    setCheckpointStore() {},
    async bindAccount() {},
    async hasPage() { return current !== null; },
    async observe() { return { page: current!, changed: false }; },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      if (action.kind !== 'open') throw new Error(`Unexpected browser action: ${action.kind}`);
      current = action.text === wiki ? wikiPage : action.text === govUrl ? govPage : action.text === secondUrl ? secondPage : null;
      if (!current) throw new Error(`Unexpected navigation: ${action.text}`);
      return { page: current, changed: true };
    },
    async close() {},
  } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser, searchProvider,
  });
  const { id } = await control.create(owner, { goal: 'ابحث في ويكيبيديا عن اليابان' });
  await control.settled(id);
  expect((await control.detail(owner, id)).error).toBeNull();
  expect(queries).toEqual([]);

  await control.send(owner, id, { text: 'UK passport renewal fees' });
  await control.settled(id);
  const result = await control.detail(owner, id);
  expect(result.status).toBe('idle');
  expect(result.error).toBeNull();
  expect(queries).toEqual(['UK passport renewal fees']);
  expect(actions).toEqual([{ kind: 'open', text: wiki }, { kind: 'open', text: govUrl }]);
  expect(result.browser?.url).toBe(govUrl);
  expect(result.messages.at(-1)?.text).toContain('UK passport renewal fees depend on');
  expect(result.messages.at(-1)?.text).toContain(govUrl);
  await control.send(owner, id, { text: 'افتح النتيجة الثانية' });
  await control.settled(id);
  const followed = await control.detail(owner, id);
  expect(followed.error).toBeNull();
  expect(followed.browser?.url).toBe(secondUrl);
  expect(actions.at(-1)).toEqual({ kind: 'open', text: secondUrl });
  expect(queries).toEqual(['UK passport renewal fees']);
  const runs = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).execute();
  expect(runs.map(run => run.status)).toEqual(['completed', 'completed', 'completed']);
});
