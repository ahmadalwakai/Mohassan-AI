import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateWordProblemGrammar } from '../apps/server/src/assistant/word-problem.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('arithmetic word problems through the chat controller', () => {
  const owner = 'isolated-word-problem-owner';
  const search = vi.fn(async () => { throw new Error('Unexpected web search'); });
  const act = vi.fn(async () => { throw new Error('Unexpected browser action'); });
  const fetch = vi.fn(async () => { throw new Error('Unexpected network request'); });
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      act, async close() {},
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser, fetch, recordExperiences: false,
      searchProvider: { name: 'forbidden-word-problem-search', search },
    });
  });

  beforeEach(() => { search.mockClear(); act.mockClear(); fetch.mockClear(); });

  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  async function ask(goal: string) {
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    expect(detail.error).toBeNull();
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status', 'state'])
      .where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(await database.db.selectFrom('chat_model_receipts').select('id')
      .where('run_id', '=', run.id).execute()).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    return { text: detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', run };
  }

  it('calculates a rate, shows the arithmetic, and verifies the completed answer', async () => {
    const { text, run } = await ask('A printer makes 12 labels per minute. How many labels does it make in 7 minutes?');
    expect(text.split('\n').at(-1)).toBe('Final answer = 84');
    expect(text.split('\n').slice(0, -1).join('\n')).toMatch(/\b12\s*[×*]\s*7\b|\b7\s*[×*]\s*12\b/u);
    expect(run.status).toBe('completed');
    expect(run.state.routing).toMatchObject({ route: 'compute', handler: 'local_computation' });
    expect(run.state.trail.map((entry: { action: string }) => entry.action)).toEqual(['calculate']);
    expect(run.state.supervision?.steps).toMatchObject([{
      tool: 'calculate', result: 'succeeded',
      observations: [{ criterionId: 'computed-answer', source: 'computation', independentlyVerified: true }],
    }]);
    expect(run.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
  });

  it('searches after the grammar abstains and verifies the selected steps', async () => {
    const story = 'A workshop has 8 rolls with 14 meters of ribbon per roll. The ribbon is divided equally into 4 display frames. How many meters of ribbon go on each frame?';
    vi.stubEnv('MOHASSAN_ARITHMETIC_SEARCH', undefined);
    expect(evaluateWordProblemGrammar(story)).toMatchObject({ status: 'blocked', abstained: true });
    const defaultReply = await ask(story);
    expect(defaultReply.text).not.toContain('Final answer');
    expect(defaultReply.run.status).toBe('blocked');
    vi.stubEnv('MOHASSAN_ARITHMETIC_SEARCH', '1');
    const { text, run } = await ask(story);
    expect(text.split('\n')).toEqual(['8 × 14 = 112', '112 ÷ 4 = 28', 'Final answer = 28']);
    expect(run.status).toBe('completed');
    expect(run.state.routing).toMatchObject({ route: 'compute', handler: 'local_computation' });
    expect(run.state.trail.map((entry: { action: string }) => entry.action)).toEqual(['calculate']);
    expect(run.state.completionReview).toMatchObject({ status: 'verified', allowCompletion: true });
  });

  it('asks one question about an unknown time span without returning a number as the answer', async () => {
    const { text, run } = await ask('A printer makes 12 labels per minute. How many labels does it make in 7 shifts?');
    expect(text).toMatch(/\breliably\b/iu);
    expect(text).toMatch(/\b12\b/u);
    expect(text.match(/\?/gu)).toHaveLength(1);
    expect(text.split('\n').at(-1)).toMatch(/\b(?:minute|shift|duration|period)\w*\b.*\?$/iu);
    expect(text).not.toMatch(/final answer/iu);
    expect(run.status).toBe('blocked');
    expect(run.state.routing).toMatchObject({ route: 'compute', handler: 'local_computation' });
    expect(run.state.trail.map((entry: { action: string }) => entry.action)).not.toContain('calculate');
    expect(run.state.completionReview).toMatchObject({ status: 'unverified', allowCompletion: false });
  });
});
