import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBrowser, SearchProvider } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
async function fixture(options: { member?: boolean; model?: boolean; brain?: 'A' | 'B' } = {}) {
  const database = await createDatabase(); await migrate(database.db);
  const calls = vi.fn(async () => { throw new Error('Host status must not dispatch a tool or model request.'); });
  const control = await createCommandChatControl(database.db, {
    browser: { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, act: calls, async close() {} } as unknown as AgentBrowser,
    models: { fast: options.model ? ['fixture-generation'] : [], deep: [], vision: '' },
    ...(options.model ? { createProvider: () => ({ id: 'ollama', generate: calls }) } : {}),
    fullAccess: async () => !options.member, brainVersion: options.brain ?? 'A', recordExperiences: false,
    searchProvider: { name: 'forbidden-host-status-search', search: calls } as SearchProvider,
    knowledgeSearch: calls,
    tools: { memory: { search: calls, save: calls }, computer: { view: calls, perform: calls } },
  });
  return { database, control, calls };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.control.shutdown(); await item.database.close(); } });

describe('host status through the real chat', () => {
  it.each(['ماهو الدماغ الحالي ؟؟', 'هل الدماغ متصل ب النموذج قبل وبعد و أثناء الجواب ؟', 'هل الذاكرة متاحة؟', 'What model are you using?'])
    ('answers %s from host facts without public lookup or inference', async goal => {
      const item = await fixture(); fixtures.push(item);
      const { id } = await item.control.create('status-owner', { goal }); await item.control.settled(id);
      const detail = await item.control.detail('status-owner', id);
      expect(detail.error).toBeNull(); expect(detail.messages.at(-1)?.text).toContain('Mohassan');
      const run = await item.database.db.selectFrom('chat_runs').select(['status', 'state']).where('conversation_id', '=', id).executeTakeFirstOrThrow();
      expect(run.status).toBe('completed');
      expect(run.state.routing).toMatchObject({ route: 'chat', handler: 'local_status' });
      expect(run.state.requestResolution).toMatchObject({ query: null, scope: 'unknown', sourceAssessment: { publicQueryEligible: false } });
      expect(run.state.completionReview.status).toBe('unscoped');
      expect(item.calls).not.toHaveBeenCalled();
      expect(await item.database.db.selectFrom('chat_model_receipts').selectAll().execute()).toEqual([]);
    });
  it('reports the actual coordinator version and distinguishes configured generation from verified operation', async () => {
    const item = await fixture({ model: true, brain: 'B' }); fixtures.push(item);
    const { id } = await item.control.create('status-owner', { goal: 'What is your current brain?' }); await item.control.settled(id);
    const text = (await item.control.detail('status-owner', id)).messages.at(-1)?.text ?? '';
    expect(text).toContain('coordinator revision: B'); expect(text).toContain('Chat generation: configured');
    expect(text).toContain('operation unverified'); expect(text).toContain('Active model explicitly identified by the host: unknown');
    expect(item.calls).not.toHaveBeenCalled();
  });
  it('filters computer access by the current account without reading the desktop', async () => {
    const item = await fixture({ member: true }); fixtures.push(item);
    const { id } = await item.control.create('status-member', { goal: 'Can you control my computer?' }); await item.control.settled(id);
    const text = (await item.control.detail('status-member', id)).messages.at(-1)?.text ?? '';
    expect(text).toContain('Computer control: configured; account access denied');
    expect(item.calls).not.toHaveBeenCalled();
  });
});
