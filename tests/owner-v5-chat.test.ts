import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatConversationSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { getConfig } from '../apps/server/src/config.js';
import { generateV5ChatReply, isV5ChatReady, V5_CHAT_LABEL } from '../apps/server/src/v5-chat.js';

vi.mock('../apps/server/src/v5-chat.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../apps/server/src/v5-chat.js')>(),
  generateV5ChatReply: vi.fn(),
  isV5ChatReady: vi.fn(),
}));

describe('owner-only v5 chat over signed-in sessions', () => {
  const webOrigin = 'http://127.0.0.1:3000';
  const setupToken = 'v5-setup-fixture-token-000000000001';
  const headers = (cookie = '') => ({ origin: webOrigin, cookie, 'x-mohassan-internal': 'v5-internal-fixture-token-000000001' });
  const owner = { name: 'Owner Fixture', email: 'v5-owner@example.test', password: 'V5-Owner-Fixture-Password-42' };
  const member = { name: 'Member Fixture', email: 'v5-member@example.test', password: 'V5-Member-Fixture-Password-42' };
  const goal = 'Write a poem about a silver moon.';
  const body = 'ضوء القمر فوق التلال.';
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie: string;
  let memberCookie: string;
  const mockGenerate = vi.mocked(generateV5ChatReply);
  const mockReady = vi.mocked(isV5ChatReady);

  async function signIn({ email, password }: typeof owner) {
    const result = await application.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: { email, password } });
    expect(result.statusCode).toBe(200);
    return [result.headers['set-cookie']].flat().map(value => String(value).split(';')[0]).join('; ');
  }

  async function detail(id: string, cookie: string) {
    await application.chat.settled(id);
    const result = await application.app.inject({ url: `/api/chat/conversations/${id}`, headers: headers(cookie) });
    expect(result.statusCode).toBe(200);
    return ChatConversationSchema.parse(result.json());
  }

  async function sendNew(text: string, cookie: string, requestKey?: string) {
    const result = await application.app.inject({ method: 'POST', url: '/api/chat/conversations',
      headers: { ...headers(cookie), ...(requestKey && { 'idempotency-key': requestKey }) }, payload: { goal: text } });
    expect(result.statusCode).toBe(200);
    return detail(result.json().id, cookie);
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_V5_CHAT', 'owner');
    vi.stubEnv('MOHASSAN_MODEL_WORKER', '1');
    const { v5Chat } = getConfig();
    application = await createApplication({ setupToken, webOrigin, v5Chat, production: false, runWorker: false,
      authSecret: 'v5-auth-fixture-secret-0000000000001', internalSecret: headers()['x-mohassan-internal'] });
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    const invite = await application.app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie), payload: { name: member.name, email: member.email } });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await application.app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(),
      payload: { token, name: member.name, password: member.password } })).statusCode).toBe(200);
    memberCookie = await signIn(member);
  });

  beforeEach(() => {
    mockReady.mockReset().mockReturnValue(true);
    mockGenerate.mockReset().mockResolvedValue(body);
  });

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
  });

  it('reports readiness to the owner only and keeps the member no-model reply', async () => {
    const route = '/api/chat/conversations';
    const ownerList = await application.app.inject({ url: route, headers: headers(ownerCookie) });
    const memberList = await application.app.inject({ url: route, headers: headers(memberCookie) });
    expect(ownerList.json()).toMatchObject({ configured: true, capabilities: { chatModel: true } });
    expect(memberList.json()).toMatchObject({ configured: false, capabilities: { chatModel: false } });
    const memberChat = await sendNew(goal, memberCookie);
    expect(memberChat.configured).toBe(false);
    expect(memberChat.messages.at(-1)?.text).toContain('Mohassan has no writing model yet');
    expect(memberChat.messages.at(-1)).not.toHaveProperty('experiment');
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockReady).toHaveBeenCalledTimes(1);
  });

  it('labels the owner reply, reuses recent conversation turns, and keeps text in the conversation', async () => {
    const conversation = await sendNew(goal, ownerCookie, 'v5-owner-write');
    expect(conversation.configured).toBe(true);
    expect(conversation.messages.at(-1)).toMatchObject({ role: 'assistant', experiment: 'v5', text: `${body}\n\n${V5_CHAT_LABEL}` });
    expect(mockGenerate.mock.calls[0]?.[1]).toEqual([{ role: 'user', content: goal }]);
    const receipt = await sql<{ response: unknown }>`SELECT response FROM chat_request_keys WHERE request_key = 'v5-owner-write'`.execute(application.database.db);
    expect(receipt.rows[0]?.response).toEqual({ replayConversationId: conversation.id });
    const experiences = await sql`SELECT source_id FROM experiences WHERE source_id = ${conversation.run?.id}`.execute(application.database.db);
    expect(experiences.rows).toHaveLength(0);
    const share = await application.app.inject({ method: 'POST', url: `/api/chat/conversations/${conversation.id}/share/preview`,
      headers: headers(ownerCookie), payload: {} });
    expect(share.statusCode).toBe(409);
    expect(share.json().error.code).toBe('CONVERSATION_SHARE_EXPERIMENTAL');

    const followup = 'Write a poem about the sea.';
    const result = await application.app.inject({ method: 'POST', url: `/api/chat/conversations/${conversation.id}/messages`,
      headers: headers(ownerCookie), payload: { text: followup } });
    expect(result.statusCode).toBe(200);
    await detail(conversation.id, ownerCookie);
    expect(mockGenerate.mock.calls[1]?.[1]).toEqual([
      { role: 'user', content: goal }, { role: 'assistant', content: body }, { role: 'user', content: followup },
    ]);

    const shorten = await application.app.inject({ method: 'POST', url: `/api/chat/conversations/${conversation.id}/messages`,
      headers: headers(ownerCookie), payload: { text: 'Make it shorter.' } });
    expect(shorten.statusCode).toBe(200);
    const shortened = await detail(conversation.id, ownerCookie);
    expect(shortened.messages.at(-1)?.text).toContain('no earlier answer');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('answers from v5 when a conversational request reaches the general no-model fallback', async () => {
    const question = 'What do you think about teamwork?';
    const conversation = await sendNew(question, ownerCookie);
    expect(conversation.messages.at(-1)).toMatchObject({ experiment: 'v5', text: `${body}\n\n${V5_CHAT_LABEL}` });
    expect(mockGenerate.mock.calls[0]?.[1]).toEqual([{ role: 'user', content: question }]);
  });

  it('lets local answers win and keeps the old no-model answer when the worker is unavailable', async () => {
    const greeting = await sendNew('مرحبًا', ownerCookie);
    expect(greeting.messages.at(-1)?.role).toBe('assistant');
    expect(greeting.messages.at(-1)).not.toHaveProperty('experiment');
    const calculation = await sendNew('احسب 37 × 24', ownerCookie);
    expect(calculation.messages.at(-1)?.text).toContain('888');
    const missingMemory = await sendNew('ما هي لغتي المفضلة؟', ownerCookie);
    expect(missingMemory.steps.map(step => step.text)).toContain('memory_search');
    expect(missingMemory.messages.at(-1)).not.toHaveProperty('experiment');
    expect(missingMemory.run?.verdict).toMatchObject({ status: 'blocked' });
    expect(mockGenerate).not.toHaveBeenCalled();

    mockReady.mockReturnValue(false);
    mockGenerate.mockResolvedValue(undefined);
    const unavailable = await sendNew(goal, ownerCookie);
    expect(unavailable.configured).toBe(false);
    expect(unavailable.messages.at(-1)?.text).toContain('Mohassan has no writing model yet');
    expect(unavailable.messages.at(-1)).not.toHaveProperty('experiment');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });
});
