import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatConversationSchema, ModelListSchema } from '@mohassan/contracts';
import { createApplication } from '../apps/server/src/app.js';
import { getConfig } from '../apps/server/src/config.js';
import { generateV5ChatReply, isV5ChatReady, V5_CHAT_LABEL } from '../apps/server/src/v5-chat.js';

vi.mock('../apps/server/src/v5-chat.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../apps/server/src/v5-chat.js')>(),
  generateV5ChatReply: vi.fn(),
  isV5ChatReady: vi.fn(),
}));

/**
 * The owner's model council through the real chat: it runs on the server before the reply is stored, its record reaches
 * the owner only, and the models page is owner-only. Python models are absent in the checkout, so they are recorded as
 * failed members; the checked-in classifiers answer the understanding round.
 */
describe('owner model council over signed-in sessions', () => {
  const webOrigin = 'http://127.0.0.1:3000';
  const setupToken = 'council-setup-fixture-token-000000001';
  const headers = (cookie = '') => ({ origin: webOrigin, cookie, 'x-mohassan-internal': 'council-internal-fixture-token-0001' });
  const owner = { name: 'Owner Fixture', email: 'council-owner@example.test', password: 'Council-Owner-Fixture-Password-42' };
  const member = { name: 'Member Fixture', email: 'council-member@example.test', password: 'Council-Member-Fixture-Password-42' };
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

  async function sendNew(text: string, cookie: string) {
    const result = await application.app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(cookie), payload: { goal: text } });
    expect(result.statusCode).toBe(200);
    const id = result.json().id;
    await application.chat.settled(id);
    const detail = await application.app.inject({ url: `/api/chat/conversations/${id}`, headers: headers(cookie) });
    expect(detail.statusCode).toBe(200);
    return ChatConversationSchema.parse(detail.json());
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_V5_CHAT', 'owner');
    vi.stubEnv('MOHASSAN_MODEL_WORKER', '1');
    vi.stubEnv('MOHASSAN_MODEL_COUNCIL', 'owner');
    vi.stubEnv('MOHASSAN_MODELS_ROOT', '');
    const { v5Chat } = getConfig();
    application = await createApplication({ setupToken, webOrigin, v5Chat, production: false, runWorker: false,
      authSecret: 'council-auth-fixture-secret-00000001', internalSecret: headers()['x-mohassan-internal'] });
    expect((await application.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...owner, setupToken } })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    const invite = await application.app.inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie), payload: { name: member.name, email: member.email } });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await application.app.inject({ method: 'POST', url: '/api/invites/accept', headers: headers(),
      payload: { token, name: member.name, password: member.password } })).statusCode).toBe(200);
    memberCookie = await signIn(member);
  }, 120_000);

  beforeEach(() => {
    mockReady.mockReset().mockReturnValue(true);
    mockGenerate.mockReset().mockResolvedValue(body);
  });

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
  });

  it('deliberates before publishing the owner reply and stores the discussion with it', async () => {
    const conversation = await sendNew(goal, ownerCookie);
    const reply = conversation.messages.at(-1);
    expect(reply).toMatchObject({ role: 'assistant', experiment: 'v5', text: `${body}\n\n${V5_CHAT_LABEL}` });
    expect(reply?.council).toMatchObject({ version: 1, chosen: 'chat-v5', changed: true });
    const answers = reply!.council!.members.filter(member => member.round === 'answer');
    expect(answers.map(member => member.model)).toEqual(expect.arrayContaining(['pipeline', 'chat-v5']));
    expect(answers.find(member => member.model === 'chat-v5')).toMatchObject({ chosen: true, output: body });
    // v5 spoke once, inside the council, with the owner's turn.
    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(mockGenerate.mock.calls[0]?.[1]).toEqual([{ role: 'user', content: goal }]);
    const share = await application.app.inject({ method: 'POST', url: `/api/chat/conversations/${conversation.id}/share/preview`,
      headers: headers(ownerCookie), payload: {} });
    expect(share.statusCode).toBe(409);
  });

  it('keeps a local answer and records that the pipeline stood', async () => {
    const calculation = await sendNew('احسب 37 × 24', ownerCookie);
    const reply = calculation.messages.at(-1);
    expect(reply?.text).toContain('888');
    expect(reply).not.toHaveProperty('experiment');
    // A calculation step is a reading step: the council discusses the turn and the pipeline's answer stands.
    expect(reply?.council).toMatchObject({ chosen: 'pipeline', changed: false });
    expect(reply?.council?.members.find(member => member.model === 'pipeline')).toMatchObject({ chosen: true, round: 'answer' });
  });

  it('never runs the council for a member or shows a member any council record', async () => {
    const memberChat = await sendNew(goal, memberCookie);
    expect(memberChat.messages.at(-1)).not.toHaveProperty('council');
    expect(memberChat.messages.at(-1)).not.toHaveProperty('experiment');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('publishes the pipeline reply when the owner grant ends before council publication', async () => {
    const baseline = await sendNew(goal, memberCookie);
    const { id } = await application.database.db.selectFrom('user').select('id').where('email', '=', member.email).executeTakeFirstOrThrow();
    const setRole = (role: 'owner' | 'member') => application.database.db.updateTable('workspace_members')
      .set({ role }).where('user_id', '=', id).execute();
    await setRole('owner');
    try {
      mockGenerate.mockImplementationOnce(async () => {
        await setRole('member');
        return body;
      });
      const conversation = await sendNew(goal, memberCookie);
      expect(mockGenerate).toHaveBeenCalledOnce();
      const reply = conversation.messages.at(-1);
      expect(reply).toMatchObject({ role: 'assistant', text: baseline.messages.at(-1)?.text });
      expect(reply).not.toHaveProperty('experiment');
      expect(reply).not.toHaveProperty('council');
    } finally {
      await setRole('member');
    }
  });

  it('serves the models page to the owner only', async () => {
    const ownerList = await application.app.inject({ url: '/api/models', headers: headers(ownerCookie) });
    expect(ownerList.statusCode).toBe(200);
    const list = ModelListSchema.parse(ownerList.json());
    expect(list.council).toBe(true);
    expect(list.models).toHaveLength(48);
    expect(list.models.find(model => model.id === 'refusal')).toMatchObject({ present: true, input: 'text' });
    expect(list.models.find(model => model.id === 'execution')).toMatchObject({ input: 'none' });
    expect((await application.app.inject({ url: '/api/models', headers: headers(memberCookie) })).statusCode).toBe(403);
    expect((await application.app.inject({ url: '/api/models', headers: headers() })).statusCode).toBe(401);

    const refusal = await application.app.inject({ method: 'POST', url: '/api/models/refusal/run', headers: headers(ownerCookie), payload: { text: 'What is the time?' } });
    expect(refusal.statusCode).toBe(200);
    expect(refusal.json(), JSON.stringify(refusal.json())).toMatchObject({ ok: true, text: 'allow' });
    const executor = await application.app.inject({ method: 'POST', url: '/api/models/execution/run', headers: headers(ownerCookie), payload: { text: 'x' } });
    expect(executor.statusCode).toBe(409);
    const reading = await application.app.inject({ method: 'POST', url: '/api/models/reading-v3-last/run', headers: headers(ownerCookie), payload: { text: 'Who?' } });
    expect(reading.statusCode).toBe(400);
    const memberRun = await application.app.inject({ method: 'POST', url: '/api/models/refusal/run', headers: headers(memberCookie), payload: { text: 'hi' } });
    expect(memberRun.statusCode).toBe(403);
  });
});
