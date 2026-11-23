import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { CHAT_WAIT_MAX_MS, ChatWaitQuerySchema, waitForChange } from '../apps/server/src/chat-wait.js';
import { createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';

/**
 * Waiting for a conversation to change instead of polling it (2026-11-23), and the newest 300 messages in a long
 * conversation. The controller is the real one on an embedded database with no model; arithmetic is answered locally.
 */
describe('waitForChange', () => {
  const reads = (values: (string | null)[]) => { let at = 0; const read = async () => values[Math.min(at++, values.length - 1)]!; return { read, count: () => at }; };

  it('answers at once when the mark already differs, and when the conversation is gone', async () => {
    expect(await waitForChange(reads(['b']).read, 'a', 5000)).toBe('changed');
    expect(await waitForChange(reads([null]).read, 'a', 5000)).toBe('changed');
  });

  it('keeps reading until the mark changes', async () => {
    const probe = reads(['a', 'a', 'a', 'b']);
    const started = Date.now();
    expect(await waitForChange(probe.read, 'a', 5000, { intervalMs: 10 })).toBe('changed');
    expect(probe.count()).toBe(4);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up after the wait with the mark unchanged', async () => {
    const started = Date.now();
    expect(await waitForChange(reads(['a']).read, 'a', 120, { intervalMs: 10 })).toBe('unchanged');
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('stops when the caller goes away', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const started = Date.now();
    expect(await waitForChange(reads(['a']).read, 'a', 5000, { intervalMs: 10, signal: controller.signal })).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('accepts only a 24-hex mark and a wait up to the cap', () => {
    expect(ChatWaitQuerySchema.parse({ since: 'a'.repeat(24), wait: '8000' })).toMatchObject({ since: 'a'.repeat(24), wait: 8000 });
    expect(() => ChatWaitQuerySchema.parse({ since: 'a'.repeat(24), wait: String(CHAT_WAIT_MAX_MS + 1) })).toThrow();
    expect(() => ChatWaitQuerySchema.parse({ since: 'not-a-mark', wait: '100' })).toThrow();
    expect(ChatWaitQuerySchema.parse({})).toEqual({});
  });
});

describe('the conversation mark and the held request, through the real chat controller', () => {
  const OWNER = 'isolated-chat-wait-owner';
  const OTHER = 'isolated-chat-wait-other-owner';
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;

  beforeAll(async () => {
    database = await createDatabase();
    await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {} } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, models: { fast: [], deep: [], vision: '' }, recordExperiences: false });
  });
  afterAll(async () => { await control?.shutdown(); await database?.close(); });

  async function ask(goal: string) {
    const { id } = await control.create(OWNER, { goal });
    await control.settled(id);
    return id;
  }

  it('gives every detail a mark that stays the same until the conversation changes', async () => {
    const id = await ask('احسب 37 * 24');
    const first = await control.detail(OWNER, id);
    expect(first.version).toMatch(/^[0-9a-f]{24}$/u);
    expect(first.olderMessages).toBeUndefined();
    expect((await control.detail(OWNER, id)).version).toBe(first.version);
    await control.send(OWNER, id, { text: 'احسب 12 * 9' });
    await control.settled(id);
    const next = await control.detail(OWNER, id);
    expect(next.version).not.toBe(first.version);
    expect(next.messages.at(-1)?.text).toContain('108');
  });

  it('holds until a reply is written, then answers before the wait runs out', async () => {
    const id = await ask('احسب 5 + 5');
    const before = await control.detail(OWNER, id);
    const started = Date.now();
    const held = control.waitForChange(OWNER, id, before.version!, 6000);
    setTimeout(() => { void control.send(OWNER, id, { text: 'احسب 6 + 6' }); }, 150);
    expect(await held).toBe('changed');
    expect(Date.now() - started).toBeLessThan(3000);
    await control.settled(id);
  });

  it('answers «unchanged» after the wait when nothing happens', async () => {
    const id = await ask('احسب 1 + 1');
    const before = await control.detail(OWNER, id);
    const started = Date.now();
    expect(await control.waitForChange(OWNER, id, before.version!, 300)).toBe('unchanged');
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  it('never holds a request for another account’s conversation', async () => {
    const id = await ask('احسب 2 + 2');
    const mark = (await control.detail(OWNER, id)).version!;
    const started = Date.now();
    expect(await control.waitForChange(OTHER, id, mark, 6000)).toBe('changed');
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(control.detail(OTHER, id)).rejects.toThrow();
  });

  it('shows the newest 300 messages of a longer conversation and counts the rest', async () => {
    const id = await ask('احسب 3 + 3');
    const base = Date.now() + 60_000;
    await database.db.insertInto('chat_messages').values(Array.from({ length: 320 }, (_, index) => ({
      id: randomUUID(), conversation_id: id, role: index % 2 ? 'assistant' : 'user', text: `رسالة ${index + 1}`, created_at: new Date(base + index * 1000),
    }))).execute();
    const detail = await control.detail(OWNER, id);
    expect(detail.messages).toHaveLength(300);
    expect(detail.messages.at(-1)?.text).toBe('رسالة 320');
    expect(detail.messages[0]?.text).toBe('رسالة 21');
    // The two messages of the first turn and the first twenty inserted are left out.
    expect(detail.olderMessages).toBe(22);
  });

  it('the GET route holds with ?since&wait and answers at once without them', async () => {
    const app = Fastify();
    await registerCommandChatRoutes(app, { control, owner: async () => ({ id: OWNER }) });
    try {
      const id = await ask('احسب 4 + 4');
      const mark = (await control.detail(OWNER, id)).version!;
      let started = Date.now();
      const plain = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}` });
      expect(plain.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
      started = Date.now();
      const held = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}?since=${mark}&wait=400` });
      expect(held.statusCode).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(390);
      expect(held.json().version).toBe(mark);
      const bad = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}?since=${mark}&wait=60000` });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    } finally { await app.close(); }
  });
});
