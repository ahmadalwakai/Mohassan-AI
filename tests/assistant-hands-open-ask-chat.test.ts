import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';

const owner = 'isolated-open-ask-owner';

// «افتح X وأخبرني بـY» through the real chat controller with no model: the page opens in the browser, the answer is quoted
// from it, the judge (as it runs for the owner in development) lets it through, and no web search runs. Wording is the test's own.
describe('open a page and answer from it, through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createJudgeShadow>;
  const current = new Map<string, AgentPage>();
  const actions: AgentAction[] = [];
  const searched: string[] = [];
  const docs: AgentPage = {
    id: 'https://sample-docs.test/', url: 'https://sample-docs.test/', title: 'Sample Docs', hash: 'sample-docs',
    text: 'Sample Docs\nGuides for the sample library, version 2.4.1.\nRead the guides',
    elements: [{ ref: 'a1', role: 'link', label: 'Read the guides', href: 'https://sample-docs.test/guides', inViewport: true }],
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1000, viewport: 800 },
    observedAt: '2026-11-22T16:00:00.000Z', documentStatus: 200,
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-open-ask-chat-'));
    shadow = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        actions.push(action);
        if (action.kind !== 'open' || new URL(action.text!).href !== docs.url) throw new Error(`Unexpected browser action: ${action.kind} ${action.text ?? ''}`);
        current.set(id, docs);
        return { page: docs, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = { name: 'isolated-open-ask-search', async search(query) { searched.push(query); return []; } };
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider,
      judgeShadow: shadow, judgeFixForOwner: true, judgeWithholdForOwner: true });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  it('opens the page and quotes its main heading and link text', async () => {
    const { id } = await control.create(owner, { goal: 'افتح الموقع https://sample-docs.test في المتصفح وأخبرني بالعنوان الرئيسي ونص الرابط الموجود فيه' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const reply = detail.messages.filter(message => message.role === 'assistant').at(-1)!.text;
    expect(reply).toBe('من **Sample Docs** (sample-docs.test):\n\nالعنوان الرئيسي:\n> Sample Docs\n\nنص الرابط:\n> Read the guides');
    const run = await database.db.selectFrom('chat_runs').select(['status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(actions.filter(action => action.kind === 'open')).toHaveLength(1);
    expect(searched).toEqual([]);
    await shadow.flush();
    const verdicts = (await readFile(shadow.logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as JudgeShadowLine).filter(line => line.conversationId === id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: 'quote', applied: false });
    expect(verdicts[0]!.decision).not.toBe('withhold');
  });

  it('quotes the version line for a version question about the page', async () => {
    const { id } = await control.create(owner, { goal: 'open https://sample-docs.test and tell me the version mentioned on the page' });
    await control.settled(id);
    const reply = (await control.detail(owner, id)).messages.filter(message => message.role === 'assistant').at(-1)!.text;
    expect(reply).toBe('From **Sample Docs** (sample-docs.test):\n\nThe version the page names:\n> version 2.4.1');
  });
});
