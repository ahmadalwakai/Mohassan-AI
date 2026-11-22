import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createConversationShadow, type ConversationShadowLine } from '../apps/server/src/assistant/conversation-state-shadow.js';

const owner = 'isolated-conversation-shadow-owner';

// Conversation state v2 runs in shadow through the real chat controller: it logs what it understood and changes no reply.
describe('conversation state v2 shadow through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let directory: string;
  let shadow: ReturnType<typeof createConversationShadow>;
  const current = new Map<string, AgentPage>();
  const queries: string[] = [];
  let sequence = 0;

  const page = (url: string, title: string): AgentPage => ({
    id: url, hash: url, url, title,
    text: `The independently observed fixture page contains the requested public information about ${title}.`,
    documentStatus: 200, elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-conversation-shadow-chat-'));
    shadow = createConversationShadow({ logFile: join(directory, 'shadow.jsonl') });
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {},
      async hasPage(_owner: string, id: string) { return current.has(id); },
      async observe(_owner: string, id: string) { return { page: current.get(id)!, changed: false }; },
      async act(_owner: string, id: string, action: AgentAction) {
        if (action.kind !== 'open') throw new Error(`Unexpected fixture action: ${action.kind}`);
        const observed = page(action.text!, action.text!);
        current.set(id, observed);
        return { page: observed, changed: true };
      },
      async close() {},
    } as unknown as AgentBrowser;
    const searchProvider: SearchProvider = {
      name: 'isolated-conversation-shadow-search',
      async search(query) {
        queries.push(query);
        const url = `https://conversation-fixtures.test/result/${++sequence}`;
        return [{ title: query, url, snippet: page(url, query).text }];
      },
    };
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, searchProvider, conversationShadow: shadow });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); await rm(directory, { recursive: true, force: true }); });

  async function lines() {
    await shadow.flush();
    return (await readFile(shadow.logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ConversationShadowLine);
  }

  it('logs each user turn with v2 next to v1 and keeps the conversation thread', async () => {
    const { id } = await control.create(owner, { goal: 'ما عاصمة اليابان؟' });
    await control.settled(id);
    await control.send(owner, id, { text: 'وكم عدد سكانها؟' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine.map(line => line.text)).toEqual(['ما عاصمة اليابان؟', 'وكم عدد سكانها؟']);
    expect(mine[0]).toMatchObject({ type: 'new_request', property: 'capital', entity: 'اليابان', v1: { kind: 'new', intent: 'web_search' } });
    expect(mine[1]).toMatchObject({ type: 'follow_up_property', property: 'population', query: 'عدد سكان عاصمة اليابان', v1: { kind: 'follow_up' } });
    expect(mine[1]!.turnId).not.toBe(mine[0]!.turnId);
    expect(shadow.state(id)?.topics.at(-1)).toMatchObject({ entity: 'عاصمة اليابان', property: 'population' });
  });

  it('does not change the reply: the chat still searches with its own query', async () => {
    const before = queries.length;
    const { id } = await control.create(owner, { goal: 'متى مباراة الهلال؟' });
    await control.settled(id);
    await control.send(owner, id, { text: 'طيب ومباراة النصر؟' });
    await control.settled(id);
    expect(queries.length).toBe(before + 2);
    expect(queries.at(-1)).toContain('النصر');
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine.at(-1)).toMatchObject({ type: 'follow_up_entity', entity: 'النصر', query: 'مباراة النصر' });
  });

  it('keeps conversations apart and a private topic without a public query', async () => {
    const { id } = await control.create(owner, { goal: 'من ذاكرتي، ما مدينتي المفضلة؟' });
    await control.settled(id);
    const mine = (await lines()).filter(line => line.conversationId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: 'new_request', query: null, v1: { scope: 'private' } });
  });
});
