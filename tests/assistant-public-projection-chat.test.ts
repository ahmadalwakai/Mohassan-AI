import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, BrowserError, type AgentAction, type AgentPage, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import type { Decision } from '../apps/server/src/assistant/brain.js';

/** All state is in-memory. No configuration/.env, service, real model or browser is opened. */
const OWNER = 'isolated-public-projection-owner';
const PRIVATE_REFERENCE = 'PRIVATE-DELIVERY-QX-482';
const PUBLIC_URL = 'https://fenwick-library.example/opening-hours';
const PUBLIC_QUESTION = 'What are the opening hours of Fenwick Community Library?';
const PRIVATE_QUESTION = 'What is my saved supplier reference?';
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };
type ScriptedDecision = Partial<Decision> & Pick<Decision, 'tool'>;
const partialAnswer = (): ScriptedDecision => ({ tool: 'answer', text: 'This fixture has no independently verified final answer.', outcome: 'partial' });
const fixtures: Awaited<ReturnType<typeof harness>>[] = [];

async function harness(model = false) {
  const database = await createDatabase({});
  await migrate(database.db);
  const queries: string[] = [], actions: AgentAction[] = [], requests: ModelRequest[] = [];
  let current: AgentPage | null = null;
  const page: AgentPage = {
    id: 'fixture-library-page', hash: 'fixture-library-content-v1', url: PUBLIC_URL,
    title: 'Fenwick Community Library opening hours',
    text: 'Fenwick Community Library opens at 09:30 on weekdays. Opening hours are published by the library.',
    documentStatus: 200, observedAt: new Date().toISOString(),
    elements: [{ ref: 'fixture-search', role: 'searchbox', label: 'Search the public catalogue', field: 'text', inViewport: true }],
    signals: { captcha: false, password: false, otp: false, card: false },
    scroll: { top: 0, height: 200, viewport: 800 },
  };
  const browser = {
    setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return current !== null; },
    async prepareAction() { return null; },
    async observe() { if (!current) throw new Error('No fixture page'); return { page: current, changed: false }; },
    async act(_owner: string, _conversation: string, action: AgentAction) {
      actions.push(action);
      if (action.kind !== 'open' || action.text !== PUBLIC_URL) throw new BrowserError('AGENT_NAVIGATION_FAILED', 'Only the declared fixture URL may be opened.', 502);
      current = page;
      return { page, changed: true };
    },
    async screen() { return null; }, async close() {},
  } as unknown as AgentBrowser;
  const search = vi.fn(async (query: string) => {
    queries.push(query);
    return [{ title: page.title, url: page.url, snippet: page.text }];
  });
  const memory = vi.fn(async () => ({ text: `The supplier reference is ${PRIVATE_REFERENCE}.`, evidence: [`The supplier reference is ${PRIVATE_REFERENCE}.`] }));
  const save = vi.fn(async () => 'Unexpected memory write');
  const script: ScriptedDecision[] = [];
  const control = await createCommandChatControl(database.db, {
    browser, models: model ? { fast: ['fixture-own-model'], deep: ['fixture-own-model'], vision: '' } : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'isolated-projection-search', search } as SearchProvider,
    tools: { memory: { search: memory, save } }, recordExperiences: false,
    ...(model ? { createProvider: (name: string) => ({ id: 'ollama', async generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length > 12) throw new Error('The fixture model must not run an unbounded loop.');
      const decision = script.shift() ?? partialAnswer();
      return { model: name, usage: { inputTokens: 10, outputTokens: 10 }, text: JSON.stringify({ ...BLANK, ...decision }) };
    } }) } : {}),
  });
  return { database, control, queries, actions, requests, script, search, memory, save, modelEnabled: model };
}

async function makeFixture(model = false) {
  const fixture = await harness(model); fixtures.push(fixture); return fixture;
}
async function settle(fixture: Awaited<ReturnType<typeof harness>>, id: string) {
  await fixture.control.settled(id);
  return fixture.control.detail(OWNER, id);
}
async function privateTurn(fixture: Awaited<ReturnType<typeof harness>>) {
  if (fixture.modelEnabled) fixture.script.push({ tool: 'memory_search', text: 'saved supplier reference' }, partialAnswer());
  const conversation = await fixture.control.create(OWNER, { goal: PRIVATE_QUESTION });
  const detail = await settle(fixture, conversation.id);
  expect(detail.status).toBe('idle');
  const run = await fixture.database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', conversation.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  expect(run.state.requestContext?.scope).toBe('private');
  return conversation.id;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.control.shutdown();
    await fixture.database.close();
  }
});

describe('public projection through the real isolated chat controller', () => {
  it('uses current public words after a private turn on the deterministic path', async () => {
    const fixture = await makeFixture();
    const id = await privateTurn(fixture);
    expect(fixture.queries).toEqual([]);
    await fixture.control.send(OWNER, id, { text: PUBLIC_QUESTION });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(detail.error).toBeNull();
    expect(fixture.queries).toEqual([PUBLIC_QUESTION.replace(/\?$/u, '')]);
    expect(fixture.actions).toEqual([{ kind: 'open', text: PUBLIC_URL }]);
    expect(detail.messages.at(-1)?.text).toContain('09:30');
    expect(fixture.queries.join(' ')).not.toContain(PRIVATE_REFERENCE);
    expect(fixture.queries.join(' ')).not.toMatch(/supplier|saved reference/i);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('blocks private context introduced only by a model-synthesized query', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    fixture.requests.length = 0;
    fixture.script.push({ tool: 'search', text: `Fenwick Community Library opening hours ${PRIVATE_REFERENCE}` }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: PUBLIC_QUESTION });
    const detail = await settle(fixture, id);
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests[0]?.goal).toContain(PUBLIC_QUESTION);
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.actions).toEqual([]);
    expect(detail.status).toBe('idle');
    const runs = await fixture.database.db.selectFrom('chat_runs').select('state').where('conversation_id', '=', id).orderBy('created_at', 'desc').execute();
    expect(runs[0]?.state.previousSource?.scope).toBe('private');
  });

  it('permits a model query built solely from the current explicit public task', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    fixture.requests.length = 0;
    const current = 'Find the official opening hours for Fenwick Community Library.';
    fixture.script.push({ tool: 'search', text: 'Fenwick Community Library opening hours' }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: current });
    const detail = await settle(fixture, id);
    expect(fixture.queries).toEqual(['Fenwick Community Library opening hours']);
    expect(fixture.queries.join(' ')).not.toContain(PRIVATE_REFERENCE);
    expect(detail.status).toBe('idle');
  });

  it('does not lose private-history protection after an intervening public turn', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    fixture.script.push({ tool: 'search', text: 'Fenwick Community Library opening hours' }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: 'Find the official opening hours for Fenwick Community Library.' });
    await settle(fixture, id);
    expect(fixture.queries).toEqual(['Fenwick Community Library opening hours']);
    const before = fixture.search.mock.calls.length;
    fixture.script.push({ tool: 'search', text: `Fenwick Community Library return policy ${PRIVATE_REFERENCE}` }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: 'Find the official return policy for Fenwick Community Library.' });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(fixture.search.mock.calls).toHaveLength(before);
    expect(fixture.queries.join(' ')).not.toContain(PRIVATE_REFERENCE);
  });

  it('cannot bypass public-query review by opening a synthesized search URL', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    const leakedQuery = `Fenwick Community Library opening hours ${PRIVATE_REFERENCE}`;
    fixture.script.push({ tool: 'open', url: `https://search-gateway.example/search?q=${encodeURIComponent(leakedQuery)}` }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: PUBLIC_QUESTION });
    await settle(fixture, id);
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.actions).toEqual([]);
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it('does not submit stale private words through a public-task search entry', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    fixture.script.push(
      { tool: 'open', url: PUBLIC_URL },
      { tool: 'type', ref: 'fixture-search', text: `Fenwick Community Library ${PRIVATE_REFERENCE}`, submit: true },
      partialAnswer(),
    );
    await fixture.control.send(OWNER, id, { text: PUBLIC_QUESTION });
    await settle(fixture, id);
    expect(fixture.actions).toEqual([{ kind: 'open', text: PUBLIC_URL }]);
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it('permits public-result query refinement after a private turn without granting private words', async () => {
    const fixture = await makeFixture(true);
    const id = await privateTurn(fixture);
    const firstQuery = 'Fenwick Community Library opening hours';
    const observedQuery = 'Fenwick Community Library 09:30 weekdays';
    fixture.script.push({ tool: 'search', text: firstQuery }, { tool: 'search', text: observedQuery }, partialAnswer());
    await fixture.control.send(OWNER, id, { text: PUBLIC_QUESTION });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(fixture.queries).toEqual([firstQuery, observedQuery]);
    expect(fixture.actions).toEqual([]);
  });

  it('does not grant new query vocabulary merely from an arbitrary browser page body', async () => {
    const fixture = await makeFixture(true);
    fixture.script.push(
      { tool: 'open', url: PUBLIC_URL },
      { tool: 'search', text: 'Fenwick Community Library 09:30 weekdays' },
      partialAnswer(),
    );
    const { id } = await fixture.control.create(OWNER, { goal: PUBLIC_QUESTION });
    await settle(fixture, id);
    expect(fixture.actions).toEqual([{ kind: 'open', text: PUBLIC_URL }]);
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps supplied transformations away from search, model enabled=%s', async model => {
    const fixture = await makeFixture(model);
    const goal = `Rewrite this note more clearly: Our internal delivery reference is ${PRIVATE_REFERENCE}.`;
    fixture.script.push({ tool: 'search', text: `internal delivery reference ${PRIVATE_REFERENCE}` }, partialAnswer());
    const conversation = await fixture.control.create(OWNER, { goal });
    const detail = await settle(fixture, conversation.id);
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.actions).toEqual([]);
    expect(fixture.memory).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(detail.status).not.toBe('running');
    const run = await fixture.database.db.selectFrom('chat_runs').select('state').where('conversation_id', '=', conversation.id).executeTakeFirstOrThrow();
    expect(run.state.requestResolution?.sourceAssessment).toMatchObject({ source: 'supplied_content', operation: 'transform', publicQueryEligible: false });
    if (model) expect(fixture.requests.length).toBeGreaterThan(0);
  });

  it('waits for an unresolved referent without asking a model or public search', async () => {
    const fixture = await makeFixture(true);
    const { id } = await fixture.control.create(OWNER, { goal: 'Summarise the document I mean.' });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.prompt).toBeTruthy();
    expect(fixture.requests).toEqual([]);
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.actions).toEqual([]);
  });

  it('executes a complete public question after a greeting', async () => {
    const fixture = await makeFixture();
    const { id } = await fixture.control.create(OWNER, { goal: `Hello, ${PUBLIC_QUESTION}` });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(detail.error).toBeNull();
    expect(fixture.queries).toEqual([PUBLIC_QUESTION.replace(/\?$/u, '')]);
    expect(fixture.actions).toEqual([{ kind: 'open', text: PUBLIC_URL }]);
    expect(detail.messages.at(-1)?.text).toContain('09:30');
  });

  it('executes an explicit new browser action after discourse filler', async () => {
    const fixture = await makeFixture();
    const { id } = await fixture.control.create(OWNER, { goal: `طيب افتح ${PUBLIC_URL}` });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    expect(detail.error).toBeNull();
    expect(fixture.queries).toEqual([]);
    expect(fixture.actions).toEqual([{ kind: 'open', text: PUBLIC_URL }]);
  });

  it('keeps unsupported self-contained computation non-public and does not invent a result', async () => {
    const fixture = await makeFixture();
    const { id } = await fixture.control.create(OWNER, { goal: 'Find the area of a rectangle 11 metres long and 6 metres wide.' });
    const detail = await settle(fixture, id);
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.actions).toEqual([]);
    expect(fixture.requests).toEqual([]);
    expect(['idle', 'failed']).toContain(detail.status);
    expect(detail.question).toBeNull();
    const run = await fixture.database.db.selectFrom('chat_runs').select(['state', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.state.requestResolution?.intent).toBe('compute');
    expect(run.status).not.toBe('completed');
  });

  it('answers an exact supported conversion before clarification or public fallback', async () => {
    const fixture = await makeFixture();
    const { id } = await fixture.control.create(OWNER, { goal: 'Convert 4.25 kilometres to metres. Only the result.' });
    const detail = await settle(fixture, id);
    expect(detail.status).toBe('idle');
    expect(detail.question).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain('4250');
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.actions).toEqual([]);
    expect(fixture.requests).toEqual([]);
    const run = await fixture.database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
  });
});
