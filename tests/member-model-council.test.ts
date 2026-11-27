import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatConversationSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { ModelRuntime, type ModelRunResult } from '../packages/model-relations/src/runtime.js';

describe('member model council over signed-in sessions', () => {
  const origin = 'http://127.0.0.1:3000';
  const setupToken = 'member-council-setup-fixture-token-0001';
  const internalSecret = 'member-council-internal-fixture-token-0001';
  const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });
  const owner = { name: 'Owner fixture', email: 'member-council-owner@example.test', password: 'Owner-fixture-password-42' };
  const alice = { name: 'Alice fixture', email: 'member-council-alice@example.test', password: 'Alice-fixture-password-42' };
  const bob = { name: 'Bob fixture', email: 'member-council-bob@example.test', password: 'Bob-fixture-password-42' };
  const conversations = '/api/chat/conversations';
  const discussionText = 'Private council proposal fixture.';
  const modelAbsent: ModelRunResult = { ok: false, reason: 'absent', elapsedMs: 0 };
  const modelAnswer: ModelRunResult = { ok: true, output: { text: discussionText }, elapsedMs: 0 };
  const runModel = vi.spyOn(ModelRuntime.prototype, 'run');
  let application: Awaited<ReturnType<typeof createApplication>>;
  let directory: string;
  let ownerCookie: string, aliceCookie: string, bobCookie: string;

  const get = (url: string, cookie: string) => application.app.inject({ url, headers: headers(cookie) });
  const post = (url: string, cookie: string, payload: object, key?: string) => application.app.inject({
    method: 'POST', url, headers: { ...headers(cookie), ...(key && { 'idempotency-key': key }) }, payload,
  });

  async function signIn({ email, password }: typeof owner) {
    const result = await post('/api/auth/sign-in/email', '', { email, password });
    expect(result.statusCode).toBe(200);
    const cookie = [result.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    expect(cookie).toBeTruthy();
    return cookie;
  }

  async function joinMember({ name, email, password }: typeof owner) {
    const invitation = await post('/api/members/invites', ownerCookie, { name, email });
    expect(invitation.statusCode).toBe(200);
    const token = new URL(invitation.json<{ url: string }>().url).hash.slice('#invite='.length);
    expect((await post('/api/invites/accept', '', { name, password, token })).statusCode).toBe(200);
    return signIn({ name, email, password });
  }

  async function start(goal: string, cookie: string, key = randomUUID()) {
    const response = await post(conversations, cookie, { goal }, key);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  }

  async function finish(id: string, cookie: string) {
    await application.chat.settled(id);
    const response = await get(`${conversations}/${id}`, cookie);
    expect(response.statusCode).toBe(200);
    const reply = ChatConversationSchema.parse(response.json()).messages.at(-1);
    expect(reply?.role).toBe('assistant');
    return reply!;
  }

  async function usage(cookie: string) {
    const response = await get('/api/access', cookie);
    expect(response.statusCode).toBe(200);
    return response.json<{ quota: { used: number } }>().quota.used;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-member-council-'));
    vi.stubEnv('MOHASSAN_MODEL_COUNCIL', 'all');
    vi.stubEnv('MOHASSAN_MODEL_RELATIONS', 'off');
    vi.stubEnv('MOHASSAN_MODELS_ROOT', directory);
    application = await createApplication({ webOrigin: origin, setupToken, internalSecret,
      authSecret: 'member-council-fixture-auth-secret-0001', production: false, runWorker: false,
      browserProfileDir: join(directory, 'browser'), documentsDir: join(directory, 'documents'),
    });
    expect((await post('/api/setup', '', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    aliceCookie = await joinMember(alice);
    bobCookie = await joinMember(bob);
  }, 60_000);

  beforeEach(() => {
    // The council runs v4 when no evidence was read. Stub the local runtime so this exercises chat and deliberation without model weights.
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/server/src/assistant/model-council.ts (retrieved 2026-11-27).
    runModel.mockReset().mockImplementation(async model => model === 'chat-v4' ? modelAnswer : modelAbsent);
  });

  afterAll(async () => {
    runModel.mockRestore();
    vi.unstubAllEnvs();
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('gives an invited member a private council record and charges the turn once, including on retry', async () => {
    const left = 37, right = 24;
    const goal = `Calculate ${left} × ${right}`;
    const key = randomUUID();
    const before = await usage(aliceCookie);
    const id = await start(goal, aliceCookie, key);
    const reply = await finish(id, aliceCookie);
    expect(reply.text).toContain(String(left * right));
    expect(reply.council).toMatchObject({ chosen: 'pipeline', changed: false });
    expect(reply.council?.members).toContainEqual(expect.objectContaining({ model: 'chat-v4', output: discussionText }));
    expect(await start(goal, aliceCookie, key)).toBe(id);
    expect(await usage(aliceCookie)).toBe(before + 1);
    expect(runModel.mock.calls.filter(([model]) => model === 'chat-v4')).toHaveLength(1);

    const diagnostics = await get('/api/models', ownerCookie);
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json().memberCouncil).toEqual({ completed: 1, changed: 0, skippedLoad: 0, skippedDeadline: 0, failed: 0 });
    expect(diagnostics.body).not.toContain(discussionText);
    expect((await get('/api/models', aliceCookie)).statusCode).toBe(403);

    for (const foreignCookie of [bobCookie, ownerCookie]) {
      const foreign = await get(`${conversations}/${id}`, foreignCookie);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain(discussionText);
    }
    const preview = await post(`${conversations}/${id}/share/preview`, aliceCookie, {});
    const transcript = await get(`${conversations}/${id}/export?format=markdown`, aliceCookie);
    for (const response of [preview, transcript]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(discussionText);
    }

    const followUpKey = randomUUID();
    const followUp = () => post(`${conversations}/${id}/messages`, aliceCookie, { text: 'Calculate 3 × 5' }, followUpKey);
    expect((await followUp()).statusCode).toBe(200);
    await finish(id, aliceCookie);
    const receipt = await application.database.db.selectFrom('chat_request_keys').select('response')
      .where('scope', '=', `messages:${id}`).where('request_key', '=', followUpKey).executeTakeFirstOrThrow();
    expect(receipt.response).toEqual({ replayConversationId: id });
    const replay = await followUp();
    expect(replay.statusCode).toBe(200);
    expect(ChatConversationSchema.parse(replay.json()).messages.find(message => message.id === reply.id)?.council).toEqual(reply.council);
    expect(await usage(aliceCookie)).toBe(before + 2);
  });

  it('publishes the pipeline answer and a load note when the active slot and queue are full', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let blockNextModel = true;
    runModel.mockImplementation(async model => {
      if (model !== 'chat-v4') return modelAbsent;
      if (blockNextModel) {
        blockNextModel = false;
        await hold;
      }
      return modelAnswer;
    });
    const left = 13, right = 8;
    const goal = `Calculate ${left} × ${right}`;
    const before = await usage(bobCookie);
    const blocker = await start('Calculate 19 × 23', ownerCookie);
    try {
      await vi.waitFor(() => expect(blockNextModel).toBe(false), { timeout: 5_000 });
      const competitors = await Promise.all([start(goal, bobCookie), start(goal, bobCookie)]);
      const replies = competitors.map(id => finish(id, bobCookie));
      const skipped = await Promise.race(replies);
      expect(skipped.council).toBeUndefined();
      release();
      const discussed = (await Promise.all(replies)).find(reply => reply.council);
      expect(discussed?.text).toContain(String(left * right));
      expect(skipped.text).toBe(`${discussed?.text}\n\nThe models’ discussion was skipped because the server is busy.`);
      expect(await usage(bobCookie)).toBe(before + competitors.length);
    } finally {
      release();
      await application.chat.settled(blocker);
    }
  });
});
