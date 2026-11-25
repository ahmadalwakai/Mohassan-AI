import { describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, AgentPage, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { completeQuestionRewrite } from '../apps/server/src/assistant/question-rewrite-chat.js';
import { parseQuestionRewriteRequest } from '../apps/server/src/assistant/question-rewrite-request.js';
import { decideRequestRoute } from '../apps/server/src/assistant/routing-decision.js';

const supplied = [
  'Please restate the last question so it is self-contained. Omit the final question mark.',
  'Article title: Mina Solano',
  'Section title: Sound archives',
  'Previous question 1: Which project did Mina Solano present at the spring festival?',
  'Previous answer 1: The Harbour Voices collection.',
  'Do not open any archives; this excerpt is part of the transcript.',
  'Current question: When did she start cataloguing field recordings?',
].join('\n');

describe('supplied question rewrite', () => {
  it('parses labelled context and routes to local writing without a model', () => {
    expect(parseQuestionRewriteRequest(supplied)).toEqual({
      question: 'When did she start cataloguing field recordings?', omitEndingPunctuation: true,
      history: { articleTitle: 'Mina Solano', sectionTitle: 'Sound archives', turns: [{
        question: 'Which project did Mina Solano present at the spring festival?',
        answer: 'The Harbour Voices collection. Do not open any archives; this excerpt is part of the transcript.',
      }] },
    });
    expect(decideRequestRoute({ text: supplied, capabilities: { writerModel: false } })).toMatchObject({
      route: 'writing', handler: 'writing', availability: 'ready', publicQuery: null,
      resolution: { kind: 'new', scope: 'private', query: null },
      sourceAssessment: { source: 'supplied_content', operation: 'transform', publicQueryEligible: false },
    });
  });

  it('requires a rewrite instruction and valid, ordered context labels', () => {
    expect(parseQuestionRewriteRequest(supplied.replace('Previous answer 1:', 'Current question:'))).toBeNull();
    expect(parseQuestionRewriteRequest(supplied.replace(/^[^\n]+/u, 'Look up a public record for this question.'))).toBeNull();
    expect(parseQuestionRewriteRequest(supplied.replace(/\nCurrent question:.*/u, ''))).toBeNull();
  });

  it('clears a superseded held action before publishing the local rewrite', async () => {
    const state = { routing: { handler: 'writing' as const }, dropHeld: true };
    const dropHeld = vi.fn(async () => {});
    const finish = vi.fn(async () => { expect(dropHeld).toHaveBeenCalledOnce(); });
    await expect(completeQuestionRewrite(supplied, state, dropHeld, finish)).resolves.toBe(true);
    expect(state.dropHeld).toBe(false);
    expect(finish).toHaveBeenCalledWith('When did Mina Solano start cataloguing field recordings');
  });
});

it('returns just the supplied rewrite through chat and rewrites public live turns only with the flag', async () => {
  const database = await createDatabase();
  const owner = 'question-rewrite-test-owner';
  const url = 'https://question-rewrite.invalid/profiles/mina-solano';
  const page: AgentPage = {
    id: url, hash: url, url, title: 'Mina Solano', documentStatus: 200,
    text: 'Mina Solano curates the Harbour Voices sound archive. Mina Solano started cataloguing field recordings in 2016.',
    elements: [], signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 1000, viewport: 800 }, observedAt: new Date().toISOString(),
  };
  const pages = new Set<string>();
  const search = vi.fn<SearchProvider['search']>(async () => [{ url, title: page.title, snippet: page.text }]);
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async close() {},
    async hasPage(_owner: string, id: string) { return pages.has(id); },
    async observe() { return { page, changed: false }; },
    async act(_owner: string, id: string) { pages.add(id); return { page, changed: true }; },
  } as unknown as AgentBrowser;
  let control: Awaited<ReturnType<typeof createCommandChatControl>> | undefined;
  try {
    vi.stubEnv('MOHASSAN_QUESTION_REWRITER', undefined);
    await migrate(database.db);
    control = await createCommandChatControl(database.db, { browser, searchProvider: { name: 'fixture', search },
      models: { fast: [], deep: [], vision: '' }, recordExperiences: false });

    const explicit = await control.create(owner, { goal: supplied });
    await control.settled(explicit.id);
    const detail = await control.detail(owner, explicit.id);
    expect(detail.run?.verdict?.status).toBe('completed');
    expect(detail.messages.at(-1)?.text).toBe('When did Mina Solano start cataloguing field recordings');
    expect(search).not.toHaveBeenCalled();

    for (const enabled of [false, true]) {
      if (enabled) vi.stubEnv('MOHASSAN_QUESTION_REWRITER', '1');
      const live = await control.create(owner, { goal: 'Which community archive does Mina Solano curate?' });
      await control.settled(live.id);
      const raw = 'When did she start cataloguing field recordings?';
      await control.send(owner, live.id, { text: raw });
      await control.settled(live.id);
      const row = await database.db.selectFrom('chat_runs').select(['goal', 'state'])
        .where('conversation_id', '=', live.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
      expect(row.goal).toBe(raw);
      if (enabled) {
        expect(row.state.routing).toMatchObject({ route: 'web_search', reason: 'rewritten_question' });
        expect(row.state.requestResolution).toMatchObject({ original: raw, query: 'When did Mina Solano start cataloguing field recordings?' });
        expect(search.mock.calls.some(([query]) => /Mina Solano.*cataloguing/iu.test(query))).toBe(true);
        search.mockClear();
        await control.send(owner, live.id, { text: 'How many hours ahead is Novigrad from my current location?' });
        await control.settled(live.id);
        expect(await control.detail(owner, live.id)).toMatchObject({
          status: 'waiting_user', question: { prompt: expect.stringMatching(/city or time zone/iu) },
        });
        expect(search).not.toHaveBeenCalled();
      } else {
        expect(row.state.routing?.reason).not.toBe('rewritten_question');
      }
    }
  } finally {
    vi.unstubAllEnvs();
    await control?.shutdown();
    await database.close();
  }
});
