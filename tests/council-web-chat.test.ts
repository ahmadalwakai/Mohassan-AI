import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { ModelCouncilService } from '../apps/server/src/assistant/model-council.js';

// Fictional catalog and council output. The ordering and publication assertions use only these fixtures.
const title = 'Marlow Library';
const date = '2083';
const url = 'https://catalog.example.test/marlow';
const pageText = `${title} was founded in ${date}. The catalog records the library’s founding separately from its opening.`;
const question = 'When was Marlow Library founded? site:catalog.example.test';
const decision = `${date}\n\n**Source:** ${url}`;
const owner = 'answer-mode-owner';
const member = 'answer-mode-member';

const dispose: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of dispose.reverse()) await close();
  dispose.length = 0;
  vi.unstubAllEnvs();
});

async function harness(mode?: string, options: { holdSearch?: Promise<void>; pageUrl?: string; canPublish?: () => boolean } = {}) {
  vi.stubEnv('MOHASSAN_ANSWER_MODE', mode);
  const database = await createDatabase();
  dispose.push(() => database.close());
  await migrate(database.db);
  const calls: string[] = [];
  const search: SearchProvider['search'] = vi.fn(async () => {
    calls.push('search');
    await options.holdSearch;
    return [{ url, title, snippet: pageText }];
  });
  const readPage = vi.fn(async () => {
    calls.push('read');
    return { url: options.pageUrl ?? url, title, text: pageText, status: 200 };
  });
  const deliberate: ModelCouncilService['deliberate'] = vi.fn(async input => {
    calls.push('council');
    const chosen = input.webDeliberation && input.evidence.length ? 'reader-fixture' : 'pipeline';
    const text = chosen === 'pipeline' ? input.pipeline.text : decision;
    const status = chosen === 'pipeline' ? input.pipeline.status : 'completed';
    return { text, status, chosen, changed: text !== input.pipeline.text,
      council: { version: 1 as const, members: [], elapsedMs: 0, reason: 'Fixture decision.', chosen, changed: text !== input.pipeline.text } };
  });
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    models: { fast: [], deep: [], vision: '' }, browser, searchProvider: { name: 'fixture', search }, readPage, modelCouncil: { deliberate },
    fullAccess: async id => id === owner, accountFullAccess: async id => id === owner && (options.canPublish?.() ?? true),
  });
  dispose.push(() => control.shutdown());
  const send = async (goal: string, id = owner) => {
    const thread = await control.create(id, { goal });
    await control.settled(thread.id);
    return (await control.detail(id, thread.id)).messages.at(-1);
  };
  return { control, calls, deliberate, search, readPage, send };
}

it('plans and reads before council, exposes progress and stores the council decision with its label', async () => {
  let releaseSearch!: () => void;
  const holdSearch = new Promise<void>(resolve => { releaseSearch = resolve; });
  const { control, calls, deliberate, search } = await harness('council-web', { holdSearch });
  const thread = await control.create(owner, { goal: question });
  try {
    await vi.waitFor(() => expect(calls).toEqual(['search']));
    expect((await control.detail(owner, thread.id)).progress).toBe('Searching web sources…');
  } finally {
    releaseSearch();
  }
  await control.settled(thread.id);
  const result = await control.detail(owner, thread.id);
  expect(calls).toEqual(['search', 'read', 'council']);
  expect(search).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(AbortSignal),
    expect.objectContaining({ plan: expect.objectContaining({ explicitSites: ['catalog.example.test'] }) }));
  expect(deliberate).toHaveBeenCalledWith(expect.objectContaining({
    evidence: [{ kind: 'page', url, title, text: pageText }], webDeliberation: expect.any(Object),
  }));
  expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', text: `${decision}\n\nChecked by the model council after a web search.`, council: { chosen: 'reader-fixture' } });
  expect(result.progress).toBeNull();
}, 20_000);

it('keeps arithmetic out of planned search and leaves member turns outside the owner-only council', async () => {
  const { send, calls, deliberate } = await harness('council-web');
  expect(await send('Calculate 37 × 24')).toMatchObject({ text: expect.stringContaining(String(37 * 24)) });
  expect(calls).toEqual([]);
  expect(await send(question, member)).not.toHaveProperty('council');
  expect(deliberate).not.toHaveBeenCalled();
}, 20_000);

it('gives the council no snippets or out-of-plan redirected pages', async () => {
  const { send, deliberate } = await harness('council-web', { pageUrl: 'https://other.example.test/marlow' });
  const reply = await send(question);
  expect(deliberate).toHaveBeenCalledWith(expect.objectContaining({ evidence: [], pipeline: { text: '', status: 'blocked' } }));
  expect(reply?.text).toContain('could not find usable evidence');
  expect(reply?.text).not.toContain(date);
}, 20_000);

it('rechecks owner access in the transaction that stores the decision', async () => {
  const { send } = await harness('council-web', { canPublish: () => false });
  const reply = await send(question);
  expect(reply?.text).toContain('access to the council changed');
  expect(reply).not.toHaveProperty('council');
}, 20_000);

it('uses the same legacy council and reply for explicit off and an unset switch', async () => {
  const explicit = await harness('off');
  const defaults = await harness();
  const goal = 'Calculate 37 × 24';
  const explicitReply = await explicit.send(goal);
  const defaultReply = await defaults.send(goal);
  expect(explicitReply?.text).toBe(defaultReply?.text);
  expect(explicitReply?.council).toEqual(defaultReply?.council);
  expect(explicit.calls).toEqual(['council']);
  expect(defaults.calls).toEqual(explicit.calls);
  expect(explicit.deliberate).toHaveBeenCalledWith(expect.not.objectContaining({ webDeliberation: expect.anything() }));
}, 20_000);
