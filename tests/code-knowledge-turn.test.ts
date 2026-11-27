import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { readBundledCorpus } from '@mohassan/code-knowledge';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

const englishQuestion = 'What does Promise.allSettled() return?';
const arabicQuestion = 'ماذا ترجع Promise.allSettled()؟';
// Pinned pages and snapshots in the documentation manifest, retrieved 2026-11-27.
const promisePage = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled';
const allPage = 'https://docs.python.org/release/3.13.9/library/functions.html#all';
const pythonDescription = 'Implement a Python function all() that returns true if all elements of the iterable are true.';

describe('offline programming knowledge through command chat', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let corpus: Awaited<ReturnType<typeof readBundledCorpus>>;
  const search = vi.fn(async () => []);

  beforeAll(async () => {
    corpus = await readBundledCorpus();
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      browser, searchProvider: { name: 'empty-local-test-search', search } as SearchProvider,
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false,
    });
  });

  beforeEach(() => {
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_SHADOW', undefined);
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', undefined);
    search.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await control?.shutdown();
    await database?.close();
  });

  async function ask(goal: string) {
    const owner = randomUUID();
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const { status, state } = await database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.run?.engine.modelCalls).toBe(0);
    return { status, text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', verification: state.codingVerification };
  }

  function versionFor(url: string) {
    const passage = corpus.passages.find(value => value.url === url);
    const source = corpus.sources.find(value => value.id === passage?.sourceId);
    expect(source).toBeDefined();
    return source!.version;
  }

  it('leaves both features off when unset or explicitly zero', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const baseline = await ask(englishQuestion);
    expect(baseline.text).not.toContain(promisePage);
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_SHADOW', '0');
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', '0');
    expect(await ask(englishQuestion)).toEqual(baseline);
    expect(info.mock.calls.some(args => String(args[0]).includes('code_knowledge_shadow'))).toBe(false);
  });

  it('observes the citation in shadow and preserves the normal reply', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const baseline = await ask(englishQuestion);
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_SHADOW', '1');
    expect(await ask(englishQuestion)).toEqual(baseline);
    await vi.waitFor(() => {
      const line = info.mock.calls.map(args => String(args[0])).find(value => value.includes('code_knowledge_shadow'));
      expect(line).toBeDefined();
      const event = JSON.parse(line!);
      expect(event).toMatchObject({ kind: 'explanation', text: expect.stringContaining(promisePage) });
      expect(line).not.toContain(englishQuestion);
    });
  });

  it.each([[englishQuestion, 'Version'], [arabicQuestion, 'الإصدار']])('publishes a versioned documentation citation for %s', async (question, versionLabel) => {
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await ask(question);
    expect(result.status).toBe('completed');
    expect(result.text).toContain(promisePage);
    expect(result.text).toContain(`${versionLabel} ${versionFor(promisePage)}`);
    expect(result.text).not.toContain('```');
    expect(search).not.toHaveBeenCalled();
    expect(info.mock.calls.some(args => String(args[0]).includes('code_knowledge_shadow'))).toBe(false);
  });

  it('withholds an offline reply to a runnable request without assertions', async () => {
    const question = 'How do I get runnable Python code for the all() function?';
    const baseline = await ask(question);
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', '1');
    const result = await ask(question);
    expect(result).toEqual(baseline);
    expect(result.text).not.toContain('```');
  });

  it.skipIf(process.platform !== 'linux' || process.geteuid?.() === 0)('publishes only the exact documented function verified against the supplied assertions', async () => {
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', '1');
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const cases = ['assert all([True, True]) is True', 'assert all([True, False]) is False', 'assert all([]) is True'];
    const result = await ask([pythonDescription, '```python', ...cases, '```'].join('\n'));
    const source = corpus.passages.find(value => value.url === allPage)?.code.find(value => value.language === 'python')?.text;
    expect(source).toBeDefined();
    expect(result.status).toBe('completed');
    expect(result.verification).toEqual({ reason: 'passed' });
    expect(result.text).toContain(allPage);
    expect(result.text).toContain(versionFor(allPage));
    expect(result.text.match(/```python\n([\s\S]*?)```/u)?.[1]).toBe(source);
  });

  it.skipIf(process.platform !== 'linux' || process.geteuid?.() === 0)('keeps a rejected documentation candidate out of the normal synthesis reply', async () => {
    vi.stubEnv('MOHASSAN_CODE_KNOWLEDGE_LIVE', '1');
    vi.stubEnv('TEST_DRIVEN_CODING_ENABLED', 'true');
    const cases = ['assert all([True]) is True', 'assert all([True]) is False'];
    const result = await ask([pythonDescription, '```python', ...cases, '```'].join('\n'));
    expect(result.status).toBe('blocked');
    expect(result.verification?.reason).toBe('assertion-failed');
    expect(result.text).not.toContain(allPage);
    expect(result.text).not.toContain('```');
  });
});
