import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { replayConversationTranscript } from '../apps/server/src/assistant/conversation-state-chat.js';
import type { ConversationEntity } from '../apps/server/src/assistant/conversation-state-entities.js';
import { planPublicConversationRead } from '../apps/server/src/assistant/conversation-state-public-read.js';
import { understandTurn } from '../apps/server/src/assistant/conversation-state.js';

const owner = 'public-read-conversation-owner';
const firstQuestion = 'Which city is the capital of Uruguay?';
const page = {
  url: 'https://en.wikipedia.org/wiki/Uruguay', title: 'Uruguay', status: 200,
  text: 'Montevideo is the capital city of Uruguay. The Uruguayan peso is the currency used in Uruguay.',
};

let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createCommandChatControl>>;
const read = vi.fn(async (url: string) => url === page.url ? page : null);
const search = vi.fn(async () => [{ url: page.url, title: page.title, snippet: page.text }]);

beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
  control = await createCommandChatControl(database.db, {
    browser, models: { fast: [], deep: [], vision: '' }, searchProvider: { name: 'isolated-public-read', search },
    recordExperiences: false, readPage: read,
  });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await control?.shutdown();
  await database?.close();
});

it('reads the prior public source for a deictic attribute of the user’s original subject', async () => {
  vi.stubEnv('MOHASSAN_CONVERSATION_SHADOW', 'decide');
  const { id } = await control.create(owner, { goal: firstQuestion });
  await control.settled(id);
  expect((await control.detail(owner, id)).messages.at(-1)?.text).toContain('Montevideo');
  read.mockClear();
  search.mockClear();

  await control.send(owner, id, { text: 'Which currency is used there?' });
  await control.settled(id);
  const detail = await control.detail(owner, id);
  expect(detail.run?.phase).toBe('completed');
  expect(detail.messages.at(-1)?.text).toContain('Uruguayan peso');
  expect(detail.messages.at(-1)?.text).toContain(page.url);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0]).toBe(page.url);
  expect(search).not.toHaveBeenCalled();
});

it('keeps a separately named subject and an unrelated antecedent out of the prior page', () => {
  const state = replayConversationTranscript([
    { id: 'user', role: 'user', text: firstQuestion },
    { id: 'assistant', role: 'assistant', text: 'Montevideo is the capital of Uruguay.' },
  ]);
  const previous = { previous: firstQuestion, topic: state.topics.at(-1), found: { url: page.url, title: page.title, lines: [page.text] } };
  for (const text of ['And which currency does Croatia use?', 'Who designed its most famous cathedral?']) {
    expect(planPublicConversationRead({ ...previous, text, understanding: understandTurn(state, text, 'new') })).toBeNull();
  }
});

it.each([
  ['the Republic of Uruguay', undefined, true], ['the Oriental Republic', 'Uruguay', false],
])('reuses the same observed page for the subject named %s', (name, aliasOf, priorUserTopic) => {
  const text = 'When was it founded?';
  const state = replayConversationTranscript([{ id: 'user', role: 'user', text: firstQuestion }]);
  const current = understandTurn(state, text, 'follow-up');
  const reference: ConversationEntity = { text: name, aliasOf, kind: 'place', role: 'user', turnId: 'user', salience: 0.9, publicLookup: true };
  const understanding = { ...current, decision: { ...current.decision, type: 'follow_up' as const, reference, references: [reference] } };
  const found = { url: page.url, title: page.title, lines: [page.text] };
  const latestTopic = state.topics.at(-1);
  const topic = priorUserTopic && latestTopic ? { ...latestTopic, entity: name, entityOrigin: 'user' as const } : latestTopic;
  expect(planPublicConversationRead({ text, previous: firstQuestion, topic, understanding, found })).toMatchObject({
    plan: { steps: [{ kind: 'ask_page', conversationPage: { expectedUrl: page.url, readPublic: true } }] },
  });
  if (priorUserTopic) {
    expect(planPublicConversationRead({ text, previous: firstQuestion, topic: latestTopic, understanding, found })).toBeNull();
  }
});
