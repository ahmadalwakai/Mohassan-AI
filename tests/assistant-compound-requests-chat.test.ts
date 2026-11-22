import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import type { ModelRequest } from '@mohassan/providers';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/** Isolated host contracts: ephemeral database, no configured real model/network. */
const OWNER = 'isolated-compound-owner';
const fixtures: Awaited<ReturnType<typeof harness>>[] = [];
const BLANK = { thought: null, plan: null, note: null, url: null, ref: null, text: null, submit: null, options: null, sensitive: null, outcome: null };

async function harness(model = false) {
  const database = await createDatabase({});
  await migrate(database.db);
  const open = vi.fn(async () => { throw new Error('This fixture authorizes no browser action'); });
  const search = vi.fn(async () => { throw new Error('This fixture authorizes no public search'); });
  const save = vi.fn(async () => { throw new Error('No partial calculation may silently mutate memory'); });
  const memory = vi.fn(async () => ({ text: 'No fixture record.', evidence: [] }));
  const requests: ModelRequest[] = [];
  const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
    async prepareAction() { return null; }, act: open, async screen() { return null; }, async close() {},
  } as unknown as AgentBrowser;
  const control = await createCommandChatControl(database.db, {
    browser, models: model ? { fast: ['fixture-compound-model'], deep: ['fixture-compound-model'], vision: '' } : { fast: [], deep: [], vision: '' },
    searchProvider: { name: 'isolated-compound-search', search } as SearchProvider,
    tools: { memory: { search: memory, save } }, recordExperiences: false,
    ...(model ? { createProvider: (name: string) => ({ id: 'ollama', async generate(request: ModelRequest) {
      requests.push(request);
      if (requests.length > 4) throw new Error('Fixture model continuation must stay bounded');
      return { model: name, usage: { inputTokens: 10, outputTokens: 10 }, text: JSON.stringify({ ...BLANK,
        tool: 'answer', text: 'The calculation is 2 days. Saving remains pending; nothing was saved.', outcome: 'partial' }) };
    } }) } : {}),
  });
  return { database, control, open, search, save, memory, requests };
}

async function run(request: string, model = false) {
  const fixture = await harness(model); fixtures.push(fixture);
  const conversation = await fixture.control.create(OWNER, { goal: request });
  await fixture.control.settled(conversation.id);
  const detail = await fixture.control.detail(OWNER, conversation.id);
  const run = await fixture.database.db.selectFrom('chat_runs').select(['status', 'state', 'goal']).where('conversation_id', '=', conversation.id)
    .orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  return { ...fixture, detail, run };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.control.shutdown();
    await fixture.database.close();
  }
});

describe('compound intrinsic requests through the actual isolated chat controller', () => {
  it.each([
    ['How many days between 2024-02-28 and 2024-03-01? Then save the result.', '2'],
    ['What date is 10 days after 2026-11-21? Then remind me.', '2026-12-01'],
    ['Convert 3.5 kilometres to metres, then send the result to my colleague.', '3500'],
    ['Calculate 13 + 17, then open Wikipedia.', '30'],
  ])('finishes only a truthful partial without silently dispatching the next action: %s', async (request, value) => {
    const fixture = await run(request);
    expect(fixture.run.status).toBe('partial');
    expect(fixture.detail.status).toBe('idle');
    expect(fixture.detail.messages.at(-1)?.text).toContain(value);
    expect(fixture.detail.messages.at(-1)?.text).toContain('No follow-up action was performed');
    expect(fixture.run.goal).toBe(request);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.memory).not.toHaveBeenCalled();
  });

  it('does not turn a negative constraint into an unfulfilled required action', async () => {
    const fixture = await run('How many days between 2024-02-28 and 2024-03-01? Then do not send it.');
    expect(fixture.run.status).toBe('completed');
    expect(fixture.detail.messages.at(-1)?.text).toContain('2');
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });
  it('continues the complete model-backed objective and supplies only the calculated subtask as evidence', async () => {
    const request = 'How many days between 2024-02-28 and 2024-03-01? Then save the result.';
    const fixture = await run(request, true);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].goal).toContain(request);
    expect(fixture.requests[0].goal).toContain('local_computation');
    expect(fixture.requests[0].goal).toContain('remainingActionsPerformed');
    expect(fixture.run.status).toBe('partial');
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it.each(['Calculate 2².', 'Calculate 2₃.'])('keeps unsupported original glyph syntax out of fabricated completion and public search: %s', async request => {
    const fixture = await run(request);
    expect(['partial', 'blocked']).toContain(fixture.run.status);
    expect(fixture.detail.status).toBe('idle');
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.detail.messages.at(-1)?.text).not.toMatch(/(?:=\s*22|=\s*23)/u);
  });

  it.each([
    ['حوّل خَمس ساعات إلى دقائق', '300'],
    ['حوّل سبع ساعات إلى دقائق', '420'],
    ['حوّل خُمس ساعة إلى دقيقة', '12'],
    ['Convert 2 m² to cm².', '20000'],
  ])('preserves original lexical distinctions through the host: %s', async (request, value) => {
    const fixture = await run(request);
    expect(fixture.run.status).toBe('completed');
    expect(fixture.detail.messages.at(-1)?.text).toContain(value);
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
