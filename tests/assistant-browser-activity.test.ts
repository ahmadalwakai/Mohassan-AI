import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatBrowserActivitySchema, type ChatBrowserActivity } from '@mohassan/contracts';
import type { AgentBrowser } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl, registerCommandChatRoutes } from '../apps/server/src/command-chat.js';

const OWNER = 'isolated-browser-activity-owner';
const telemetry: ChatBrowserActivity = { sequence: 7, cursor: { x: .25, y: .75, action: 'click', phase: 'done', updatedAt: '2026-11-21T10:00:00.000Z' } };

describe('owned live browser activity', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let control: Awaited<ReturnType<typeof createCommandChatControl>>;
  let app: ReturnType<typeof Fastify>;
  let id: string;
  const activity = vi.fn(async () => structuredClone(telemetry) as ChatBrowserActivity | null);
  beforeAll(async () => {
    database = await createDatabase({}); await migrate(database.db);
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async hasPage() { return false; }, async close() {}, activity } as unknown as AgentBrowser;
    control = await createCommandChatControl(database.db, { browser, recordExperiences: false, models: { fast: [], deep: [], vision: '' } });
    id = (await control.create(OWNER, { goal: 'مرحبا' })).id;
    await control.settled(id);
    app = Fastify();
    await registerCommandChatRoutes(app, { control, owner: async request => {
      if (request.headers['x-fixture-owner'] !== OWNER) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
      return { id: OWNER };
    } });
  });
  afterAll(async () => { await app?.close(); await control?.shutdown(); await database?.close(); });

  it('returns host coordinates with no caching and checks authentication before telemetry', async () => {
    activity.mockClear();
    const url = `/api/chat/conversations/${id}/browser/activity`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(activity).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'GET', url, headers: { 'x-fixture-owner': OWNER } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(telemetry);
    expect(activity).toHaveBeenCalledWith(OWNER, id);
  });

  it('does not expose another owner or a missing conversation to the activity provider', async () => {
    activity.mockClear();
    await expect(control.browserActivity('different-owner', id)).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    await expect(control.browserActivity(OWNER, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'CHAT_NOT_FOUND' });
    expect(activity).not.toHaveBeenCalled();
  });

  it('returns null for an absent live page, without trying to start or restore it', async () => {
    activity.mockResolvedValueOnce(null);
    expect(await control.browserActivity(OWNER, id)).toBeNull();
    activity.mockResolvedValueOnce(null);
    const response = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}/browser/activity`, headers: { 'x-fixture-owner': OWNER } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it('retains a fast input event after navigation clears the current pointer', async () => {
    const value: ChatBrowserActivity = { sequence: 9, sessionId: '00000000-0000-4000-8000-000000000001', cursor: null,
      events: [
        { sequence: 8, cursor: { ...telemetry.cursor!, action: 'type' }, updatedAt: '2026-11-21T10:00:00.000Z' },
        { sequence: 9, cursor: null, updatedAt: '2026-11-21T10:00:00.001Z' },
      ] };
    activity.mockResolvedValueOnce(value);
    const response = await app.inject({ method: 'GET', url: `/api/chat/conversations/${id}/browser/activity`, headers: { 'x-fixture-owner': OWNER } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(value);
  });

  it('rejects non-normalized coordinates and fields that could contain typed secrets', () => {
    for (const invalid of [
      { ...telemetry, cursor: { ...telemetry.cursor, x: 1.1 } },
      { ...telemetry, cursor: { ...telemetry.cursor, y: Number.NaN } },
      { ...telemetry, cursor: { ...telemetry.cursor, text: 'must-not-be-transmitted' } },
      { ...telemetry, screenshot: 'must-not-be-transmitted' },
      { ...telemetry, events: [{ sequence: 8, cursor: { ...telemetry.cursor, text: 'must-not-be-transmitted' }, updatedAt: '2026-11-21T10:00:00.000Z' }] },
      { ...telemetry, events: Array.from({ length: 33 }, (_unused, sequence) => ({ sequence, cursor: null, updatedAt: '2026-11-21T10:00:00.000Z' })) },
    ]) expect(ChatBrowserActivitySchema.safeParse(invalid).success).toBe(false);
  });
});
