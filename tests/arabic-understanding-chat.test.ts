import { expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

// Agent-written development case, with an injected search provider and no model or network calls.
it('passes the selected dialect view from chat ingress through the public search guard', async () => {
  vi.stubEnv('MOHASSAN_ARABIC_UNDERSTANDING', '1');
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const database = await createDatabase();
  let chat: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    await migrate(database.db);
    const queries: string[] = [];
    const searchProvider: SearchProvider = {
      name: 'arabic-understanding-test',
      async search(query) { queries.push(query); return []; },
    };
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
    } as unknown as AgentBrowser;
    chat = await createCommandChatControl(database.db, { models: { fast: [], deep: [], vision: '' }, browser, searchProvider });

    const owner = 'arabic-understanding-test-owner';
    const goal = 'مرحبا فين تقع كندا؟';
    const { id } = await chat.create(owner, { goal });
    await chat.settled(id);
    const detail = await chat.detail(owner, id);
    expect(detail.error).toBeNull();
    expect(detail.messages.find(message => message.role === 'user')?.text).toBe(goal);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]).toMatch(/أين تقع كندا/u);
    expect(log.mock.calls.filter(([entry]) => JSON.parse(String(entry)).event === 'arabic_understanding_shadow_difference')).toHaveLength(1);

    const before = queries.length;
    const historical = await chat.create(owner, { goal: 'مرحبا، لماذا تهاجر الطيور؟' });
    await chat.settled(historical.id);
    expect((await chat.detail(owner, historical.id)).error).toBeNull();
    expect(queries.slice(before)).toContain('لماذا تهاجر الطيور');

    const publicQueries = queries.length;
    const mixed = await chat.create(owner, { goal: 'Confidential: Project Phoenix launches on Tuesday. Where is Paris?' });
    await chat.settled(mixed.id);
    expect(queries).toHaveLength(publicQueries);
  } finally {
    await chat?.shutdown();
    await database.close();
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
