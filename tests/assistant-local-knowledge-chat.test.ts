import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { LocalKnowledgeDocument } from '../apps/server/src/assistant/local-knowledge.js';

describe('evaluated knowledge in the main conversation', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let documents: LocalKnowledgeDocument[] = [];
  const search = vi.fn(async () => { throw new Error('This private document must not be searched publicly.'); });
  const memory = vi.fn(async () => ({ text: 'no matching memory', evidence: [] as string[] }));
  const knowledge = vi.fn(async (_ownerId: string, _query: string) => documents);

  beforeAll(async () => {
    database = await createDatabase(); await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      browser, models: { fast: [], deep: [], vision: '' }, knowledgeSearch: knowledge,
      searchProvider: { name: 'forbidden-private-document-search', search } as SearchProvider,
      tools: { memory: { search: memory, async save() { throw new Error('Read-only knowledge cannot save memory.'); } } },
    });
  });
  beforeEach(() => { documents = []; vi.clearAllMocks(); });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  async function run(goal: string) {
    const { id } = await control.create('isolated-knowledge-owner', { goal });
    await control.settled(id);
    const detail = await control.detail('isolated-knowledge-owner', id);
    const run = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    return { detail, run };
  }

  it('reads the requested evaluated document before an unrelated memory lookup', async () => {
    documents = [{ title: 'South Hall operations handbook', source: 'knowledge:hall:2#0', text: 'The hall capacity is 176 people.' }];
    const { detail, run: result } = await run('What is the capacity in my South Hall operations handbook?');
    expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('176 people');
    expect(detail.messages.at(-1)?.text).toContain('South Hall operations handbook');
    expect(result.status).toBe('completed');
    expect(result.state.trail).toMatchObject([{ action: 'knowledge_search' }]);
    expect(result.state.completionReview.status).toBe('verified');
    expect(memory).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });

  it('keeps a missing private document local and does not invent an answer', async () => {
    const { detail, run: result } = await run('What is the capacity in my South Hall operations handbook?');
    expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('evaluated documents');
    expect(result.status).toBe('blocked');
    expect(result.state.completionReview.allowCompletion).toBe(false);
    expect(search).not.toHaveBeenCalled(); expect(memory).not.toHaveBeenCalled();
  });

  it('reports conflicting document facts as partial without certifying the objective', async () => {
    documents = [
      { title: 'South Hall handbook', source: 'knowledge:hall:1#0', text: 'The hall capacity is 176 people.' },
      { title: 'South Hall inspection', source: 'knowledge:hall:2#0', text: 'The hall capacity is 182 people.' },
    ];
    const { detail, run: result } = await run('What is the capacity in my South Hall documents?');
    expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('176');
    expect(detail.messages.at(-1)?.text).toContain('182');
    expect(result.status).toBe('partial');
    expect(result.state.completionReview.allowCompletion).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it('does not present an answer to another document field as completed', async () => {
    documents = [{ title: 'South Hall operations handbook', source: 'knowledge:hall:2#0', text: 'The hall manager name is Nora Vale.' }];
    const { detail, run: result } = await run('What is the capacity in my South Hall operations handbook?');
    expect(result.status).toBe('blocked');
    expect(detail.messages.at(-1)?.text).not.toContain('Nora Vale');
    expect(search).not.toHaveBeenCalled();
  });

  it('routes an explicit summary locally and verifies quotes against the named source', async () => {
    documents = [{ title: 'Moss Track handbook', source: 'knowledge:moss:4#0', text: 'The lower trail opens at dawn. Staff inspect the bridge weekly.' }];
    const { detail, run: result } = await run('Summarize our uploaded Moss Track handbook in two sentences.');
    expect(result.status).toBe('completed');
    expect(result.state.completionReview.status).toBe('verified');
    expect(result.state.trail).toMatchObject([{ action: 'knowledge_search' }]);
    expect(detail.messages.at(-1)?.text).toContain('Staff inspect the bridge weekly');
    expect(memory).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('keeps a dialect request for an evaluated document away from public search and memory', async () => {
    documents = [{ title: 'تقرير أمين المكتبة', source: 'knowledge:library:2#0', text: 'الاسم المعتمد لأمين المكتبة هو هدى خالد.' }];
    const { detail, run: result } = await run('من تقريري المخزن، خبرني عن اسم أمين المكتبة.');
    expect(result.status).toBe('completed');
    expect(detail.messages.at(-1)?.text).toContain('هدى خالد');
    expect(memory).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
