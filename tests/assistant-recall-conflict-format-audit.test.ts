import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

/** Real controller with synthetic retrieved assertions; no provider, network or write. */
describe('requested recall format when stored assertions disagree', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let notes: string[] = [];
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error('This read-only fixture has no external or write capability.'); });
  beforeAll(async () => {
    database = await createDatabase({}); expect(database.mode).toBe('embedded'); await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {},
      act: forbidden, prepareAction: forbidden, screen: forbidden, observe: forbidden } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, recordExperiences: false,
      models: { fast: [], deep: [], vision: '' },
      searchProvider: { name: 'forbidden-conflict-format-network', search: forbidden } as SearchProvider,
      tools: { memory: { async search() { return { text: notes.join('\n'), evidence: [...notes] }; }, save: forbidden } },
    });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });
  async function run(request: string, evidence: string[]) {
    notes = evidence;
    const { id } = await control.create('isolated-recall-conflict-format-owner', { goal: request });
    await control.settled(id);
    const detail = await control.detail('isolated-recall-conflict-format-owner', id);
    const row = await database.db.selectFrom('chat_runs').select('status').where('conversation_id', '=', id).executeTakeFirstOrThrow();
    expect(detail.error).toBeNull(); expect(forbidden).not.toHaveBeenCalled();
    return { status: row.status, text: detail.messages.filter(item => item.role === 'assistant').at(-1)?.text ?? '' };
  }

  it.each([
    { request: 'From my memory, return my home city only.', evidence: ['My home city is Bristol.', 'My home city is Leeds.'], values: ['Bristol', 'Leeds'] },
    { request: 'من ذاكرتي، ما مدينتي المفضلة؟ أعد المدينة فقط.', evidence: ['مدينتي المفضلة هي مسقط.', 'مدينتي المفضلة هي صحار.'], values: ['مسقط', 'صحار'] },
  ])('does not complete a scalar-only request with conflicting values: $request', async ({ request, evidence, values }) => {
    const result = await run(request, evidence);
    expect(result.status, result.text).toBe('partial');
    for (const value of values) expect(result.text).toContain(value);
    expect(result.text).toMatch(/conflict|disagree|متعارض|تعارض/iu);
  });

  it('does not complete JSON-only output by silently choosing one conflicting field', async () => {
    const result = await run('Search my memory, return JSON only with keys "color" as a string and "quantity" as a number.',
      ['The color is Indigo.', 'The color is Amber.', 'The quantity is 21.']);
    expect(result.status, result.text).toBe('partial');
    for (const value of ['Indigo', 'Amber', '21']) expect(result.text).toContain(value);
    expect(result.text).toMatch(/conflict|disagree/iu);
  });

  it('accepts repeated equal values without inventing a conflict', async () => {
    expect(await run('From my memory, return my home city only.', ['My home city is Bristol.', 'My home city is Bristol.']))
      .toEqual({ status: 'completed', text: 'Bristol' });
  });

  it('keeps the existing complete unformatted comparison of both recorded claims', async () => {
    const result = await run('What is my depot capacity from memory?', ['My depot capacity is 20 vans.', 'My depot capacity is 24 vans.']);
    expect(result.status).toBe('completed'); expect(result.text).toContain('20 vans'); expect(result.text).toContain('24 vans');
  });

  it('does not treat a different subject as a conflicting value for the requested subject', async () => {
    expect(await run('From my memory, return my home city only.', ['My home city is Bristol.', 'My workshop city is Leeds.']))
      .toEqual({ status: 'completed', text: 'Bristol' });
  });
});
