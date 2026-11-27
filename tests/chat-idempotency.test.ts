import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';

/**
 * An optional Idempotency-Key on the chat's changing routes (2026-11-23), so a phone can resend after a lost reply without
 * the server running the request twice. The controller is the real one on an embedded database with no model; arithmetic
 * is answered locally.
 */
describe('chat requests with an Idempotency-Key', () => {
  const OWNER = 'isolated-chat-idempotency-owner';
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let app: ReturnType<typeof Fastify>;
  let failBrowserDetailFor: string | undefined;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = {
      setCheckpointStore() {}, async bindAccount() {}, async close() {}, async closeConversation() {},
      async hasPage(_ownerId: string, id: string) {
        if (failBrowserDetailFor === id) {
          failBrowserDetailFor = undefined;
          throw new Error('Local fixture: response construction failed');
        }
        return false;
      },
    } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
    app = Fastify();
    await registerCommandChatRoutes(app, { control, owner: async () => ({ id: OWNER }) });
  });
  afterAll(async () => { await app?.close(); await control?.shutdown(); await database?.close(); });

  const post = (url: string, payload: unknown, key?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: key ? { 'idempotency-key': key } : {} });
  const conversations = async () => (await control.list(OWNER)).conversations.length;
  const userMessages = async (id: string) => (await control.detail(OWNER, id)).messages.filter(message => message.role === 'user').length;

  it('creates one conversation for two calls with the same key and returns the same answer', async () => {
    const before = await conversations();
    const first = await post('/api/chat/conversations', { goal: 'احسب 2 + 3' }, 'phone-create-0001');
    const second = await post('/api/chat/conversations', { goal: 'احسب 2 + 3' }, 'phone-create-0001');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await conversations()).toBe(before + 1);
    await control.settled(first.json().id);
  });

  it('adds one message for two sends with the same key', async () => {
    const { id } = (await post('/api/chat/conversations', { goal: 'احسب 4 + 4' })).json();
    await control.settled(id);
    const before = await userMessages(id);
    const first = await post(`/api/chat/conversations/${id}/messages`, { text: 'احسب 6 + 7' }, 'phone-send-00001');
    await control.settled(id);
    const second = await post(`/api/chat/conversations/${id}/messages`, { text: 'احسب 6 + 7' }, 'phone-send-00001');
    await control.settled(id);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await userMessages(id)).toBe(before + 1);
  });

  it('replays a committed turn if constructing the first response failed', async () => {
    const { id } = (await post('/api/chat/conversations', {})).json();
    const browserState = { url: 'about:blank', title: 'Local test', observedAt: new Date().toISOString(), version: 'test' };
    await database.db.updateTable('chat_conversations').set({ browser_state: JSON.stringify(browserState) }).where('id', '=', id).execute();
    failBrowserDetailFor = id;
    const endpoint = `/api/chat/conversations/${id}/messages`;
    const body = { text: 'احسب 2 + 2' };
    const key = 'phone-reply-interrupted';
    const first = await post(endpoint, body, key);
    expect(first.statusCode).toBe(500);
    await control.settled(id);

    const retried = await post(endpoint, body, key);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(id);
    expect(await userMessages(id)).toBe(1);
    const runs = await database.db.selectFrom('chat_runs').select('id').where('conversation_id', '=', id).execute();
    expect(runs).toHaveLength(1);
  });

  it('keeps the retry receipt while removing the cached conversation text on deletion', async () => {
    const endpoint = '/api/chat/conversations';
    const body = { goal: 'احسب 2 + 2' };
    const key = 'phone-delete-fixture';
    const first = await post(endpoint, body, key);
    expect(first.statusCode).toBe(200);
    const id = first.json().id;
    await control.settled(id);
    await control.remove(OWNER, id);
    const row = await database.db.selectFrom('chat_request_keys').select('response')
      .where('owner_id', '=', OWNER).where('request_key', '=', key).executeTakeFirst();
    expect(row?.response).toEqual({ replayConversationId: id });
    expect((await post(endpoint, body, key)).statusCode).toBe(404);
  });

  it('keeps only the conversation reference for a reply with a council record', async () => {
    const { id } = (await post('/api/chat/conversations', {})).json();
    const key = 'phone-council-record';
    const response = { id, messages: [{ role: 'assistant', council: { reason: 'Private fixture note' } }] };
    expect(await control.once(OWNER, 'fixture', key, {}, async () => response)).toEqual(response);

    const receipt = await database.db.selectFrom('chat_request_keys').select('response')
      .where('owner_id', '=', OWNER).where('request_key', '=', key).executeTakeFirstOrThrow();
    expect(receipt.response).toEqual({ replayConversationId: id });
  });

  it('rebuilds a reply from current conversation data when an older receipt cached a council record', async () => {
    const { id } = (await post('/api/chat/conversations', {})).json();
    const key = 'phone-older-council-record';
    await control.once(OWNER, 'fixture', key, {}, async () => ({ id }));
    await database.db.updateTable('chat_request_keys').set({
      response: JSON.stringify({ id, messages: [{ role: 'assistant', council: { reason: 'Private fixture note' } }] }),
    }).where('owner_id', '=', OWNER).where('request_key', '=', key).execute();

    const originalWork = async () => { throw new Error('A replay must not run the original work.'); };
    expect(await control.once(OWNER, 'fixture', key, {}, originalWork)).toEqual(
      await control.detail(OWNER, id),
    );
  });

  it('refuses the same key for a different body', async () => {
    await post('/api/chat/conversations', { goal: 'احسب 1 + 1' }, 'phone-create-0002');
    const reused = await post('/api/chat/conversations', { goal: 'احسب 9 + 9' }, 'phone-create-0002');
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe('CHAT_REQUEST_KEY_REUSED');
  });

  it('tells a repeat to wait while the first call still runs', async () => {
    await database.db.insertInto('chat_request_keys').values({ owner_id: OWNER, request_key: 'phone-running-001', scope: 'create',
      body_hash: 'x'.repeat(64), status: 'running' }).execute();
    const waiting = await post('/api/chat/conversations', { goal: 'احسب 3 + 3' }, 'phone-running-001');
    expect(waiting.statusCode).toBe(409);
    expect(['CHAT_REQUEST_IN_PROGRESS', 'CHAT_REQUEST_KEY_REUSED']).toContain(waiting.json().code);
  });

  it('frees the key of a call that failed, so the corrected call runs', async () => {
    const { id } = (await post('/api/chat/conversations', { goal: 'احسب 5 + 5' })).json();
    await control.settled(id);
    const invalid = await post(`/api/chat/conversations/${id}/messages`, { text: 'x', unexpected: true }, 'phone-send-00002');
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const keyRows = await database.db.selectFrom('chat_request_keys').select('request_key').where('request_key', '=', 'phone-send-00002').execute();
    expect(keyRows).toHaveLength(0);
  });

  it('keeps calls without a key exactly as before', async () => {
    const before = await conversations();
    const first = await post('/api/chat/conversations', { goal: 'احسب 8 + 1' });
    const second = await post('/api/chat/conversations', { goal: 'احسب 8 + 1' });
    expect(first.json().id).not.toBe(second.json().id);
    expect(await conversations()).toBe(before + 2);
    await control.settled(first.json().id);
    await control.settled(second.json().id);
  });

  it('refuses a malformed key before running anything', async () => {
    const before = await conversations();
    const bad = await post('/api/chat/conversations', { goal: 'احسب 2 + 2' }, 'bad key!');
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(await conversations()).toBe(before);
  });

  it('tells clients in the list that keyed resends are honoured', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/chat/conversations' });
    expect(list.statusCode).toBe(200);
    expect(list.json().requestKeys).toBe(true);
  });
});
