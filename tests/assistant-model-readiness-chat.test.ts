import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const fixtures: { control: Awaited<ReturnType<typeof createCommandChatControl>>; database: Awaited<ReturnType<typeof createDatabase>> }[] = [];
const owner = 'model-readiness-fixture';
async function fixture(models: { fast: string[]; deep: string[]; vision: string }) {
  const database = await createDatabase(); await migrate(database.db);
  const generate = vi.fn(async (_request: ModelRequest) => ({ model: 'fixture-chat', usage: { inputTokens: 10, outputTokens: 10 },
    text: JSON.stringify({ thought: null, plan: null, note: null, url: null, ref: null, submit: null, options: null, sensitive: null,
      tool: 'answer', text: 'A stack removes the most recently added item first.', outcome: 'done' }) }));
  const createProvider = vi.fn((name: string) => ({ id: 'ollama', generate }));
  const search = vi.fn(async () => { throw new Error('This readiness check requires no public search.'); });
  const control = await createCommandChatControl(database.db, { models, createProvider, recordExperiences: false,
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser,
    searchProvider: { name: 'forbidden-readiness-search', search } as SearchProvider });
  fixtures.push({ database, control }); return { database, control, generate, createProvider, search };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.control.shutdown(); await item.database.close(); } });

describe('chat model readiness is independent of vision provider presence', () => {
  it('does not route a partial calculation to a vision-only provider', async () => {
    const { control, database, generate, search } = await fixture({ fast: [], deep: [], vision: 'fixture-vision' });
    expect((await control.list(owner)).configured).toBe(false);
    const { id } = await control.create(owner, { goal: 'Calculate 2 + 3, then remind me tomorrow.' });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.configured).toBe(false); expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('5');
    expect((await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow()).status).toBe('partial');
    expect(generate).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
    expect(await database.db.selectFrom('chat_model_receipts').selectAll().execute()).toEqual([]);
  });
  it('does not construct empty model names or treat them as generation capability', async () => {
    const { control, createProvider, generate } = await fixture({ fast: [''], deep: [], vision: '' });
    expect((await control.list(owner)).configured).toBe(false);
    expect(createProvider).not.toHaveBeenCalled();
    const { id } = await control.create(owner, { goal: 'Write a poem about the sea.' }); await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull(); expect(detail.messages.at(-1)?.text).toContain('writing model');
    expect(generate).not.toHaveBeenCalled();
  });
  it('uses a declared chat provider for a supported model decision', async () => {
    const { control, generate } = await fixture({ fast: ['fixture-chat'], deep: ['fixture-chat'], vision: '' });
    expect((await control.list(owner)).configured).toBe(true);
    const { id } = await control.create(owner, { goal: 'Explain why a stack uses LIFO.' }); await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull(); expect(detail.configured).toBe(true);
    expect(detail.messages.at(-1)?.text).toContain('most recently added'); expect(generate).toHaveBeenCalledTimes(1);
  });
});
