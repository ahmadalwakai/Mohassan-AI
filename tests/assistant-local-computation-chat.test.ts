import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

describe('local calculations through the real chat controller', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  const search = vi.fn(async () => { throw new Error('A local calculation must not search the web.'); });
  const act = vi.fn(async () => { throw new Error('A local calculation must not act in the browser.'); });

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; },
      act, async close() {},
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: '' }, browser,
      searchProvider: { name: 'forbidden-computation-search', search } as SearchProvider,
    });
  });

  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  it.each([
    ['كم ١٢٫٥٪ من ٤٨٠؟', '60'],
    ['Convert 3.5 kilometres to metres. Only the result.', '3500'],
    ['How many days between 2024-02-28 and 2024-03-01?', '2'],
    ['Calculate -3^2.', '-9'],
    ['كم تساوي ٩٨٫٦ درجة فهرنهايت بالمئوية؟', '98.6 درجة فهرنهايت = 37'],
    ['How much is 0 degrees Celsius in Fahrenheit?', '0 degrees Celsius = 32 Fahrenheit'],
    ['Convert 32° F to ° C.', '32 ° F = 0 ° C'],
    ['Convert 33.8 F to Celsius.', '33.8 F = 1 Celsius'],
    ['What is the boiling point of water in Fahrenheit?', '212 Fahrenheit'],
  ])('answers %s without a model or web request', async (goal, expected) => {
    const { id } = await control.create('isolated-local-computation-owner', { goal });
    await control.settled(id);
    const detail = await control.detail('isolated-local-computation-owner', id);
    expect(detail.status).toBe('idle');
    expect(detail.error).toBeNull();
    expect(detail.messages.at(-1)?.text).toContain(expected);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status).toBe('completed');
    expect(run.state.trail).toMatchObject([{ action: 'calculate' }]);
    expect(await database.db.selectFrom('chat_model_receipts').select('id').where('run_id', '=', run.id).execute()).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it.each([
    ['احسب 15% من 2450 ثم اقسم الناتج على 7', ['15% * 2450 = 367.5', '= 52.5']],
    ['Calculate 8 + 2, then multiply it by 3.', ['8 + 2 = 10', '= 30']],
    ['Calculate 8 + 2, then divide by 2.', ['8 + 2 = 10', '= 5']],
    ['Calculate 1e-8 + 1e-8, then multiply it by 5e7.', ['1e-8 + 1e-8 = 0.00000002', '= 1']],
    ['احسب ٦ × ٧ ثم أضف ٨ إليه ثم اقسمه على ٢', ['6 * 7 = 42', '= 50', '= 25']],
    ['Calculate 14 + 3, then calculate 7 * 6.', ['14 + 3 = 17', '7 * 6 = 42']],
  ])('completes each local calculation in order for %s', async (goal, equations) => {
    const owner = 'isolated-local-computation-owner';
    const { id } = await control.create(owner, { goal });
    await control.settled(id);
    const detail = await control.detail(owner, id);
    const run = await database.db.selectFrom('chat_runs').select(['id', 'status']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(run.status, detail.messages.at(-1)?.text).toBe('completed');
    const lines = detail.messages.at(-1)!.text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(equations.length);
    equations.forEach((equation, index) => expect(lines[index]).toContain(equation));
    expect(await database.db.selectFrom('chat_model_receipts').select('id').where('run_id', '=', run.id).execute()).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('keeps an invalid operation blocked instead of announcing success', async () => {
    const { id } = await control.create('isolated-local-computation-owner', { goal: 'احسب ٧ ÷ ٠' });
    await control.settled(id);
    const detail = await control.detail('isolated-local-computation-owner', id);
    expect(detail.messages.at(-1)?.text).toContain('صفر');
    expect((await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow()).status).toBe('blocked');
    expect(search).not.toHaveBeenCalled();
  });
});
