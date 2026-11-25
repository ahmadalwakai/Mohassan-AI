import { randomUUID } from 'node:crypto';
import { MonitorCardSchema, MonitorListSchema, MonitorV2ControlSchema } from '@mohassan/contracts';
import { SafeNetwork } from '@mohassan/browser';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { monitorChat } from '../apps/server/src/monitors/chat.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';

const origin = 'http://127.0.0.1:3000';
const authSecret = 'monitor-fixture-authentication-secret';
const internalSecret = 'monitor-fixture-internal-only-secret';
const setupToken = 'monitor-fixture-setup-secret-value';
const path = '/api/chat/monitors';
const configuration = { authSecret, internalSecret, setupToken, webOrigin: origin, production: false, runWorker: false };
const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie && { cookie }) });
const search = vi.fn(async () => [{ url: 'https://parks.example.org/permits/a', title: 'Public park permit A', snippet: 'Published permit' }]);

type App = Awaited<ReturnType<typeof createApplication>>;

async function register(app: App, name: string, role: 'owner' | 'member') {
  const credentials = { name, email: `${name.toLowerCase()}@example.test`, password: 'Monitor-Fixture-password-29' };
  if (role === 'owner') {
    const setup = await app.app.inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { ...credentials, setupToken } });
    expect(setup.statusCode, setup.body).toBe(200);
  } else {
    const { user } = await app.auth.api.signUpEmail({ body: credentials });
    await app.database.db.insertInto('workspace_members').values({ user_id: user.id, role }).execute();
  }
  const response = await app.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(),
    payload: { email: credentials.email, password: credentials.password } });
  expect(response.statusCode, response.body).toBe(200);
  return [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
}

async function settle(app: App, id: string, cookie: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await app.app.inject({ url: `/api/chat/conversations/${id}`, headers: headers(cookie) });
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json();
    if (detail.status !== 'running') return detail;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Monitor chat turn did not settle');
}

async function ask(app: App, cookie: string, goal: string) {
  const response = await app.app.inject({ method: 'POST', url: '/api/chat/conversations', headers: headers(cookie), payload: { goal } });
  expect(response.statusCode, response.body).toBe(200);
  return settle(app, response.json().id, cookie);
}

describe('smart monitor chat and authenticated API', () => {
  let application: App;
  let owner: string;
  let member: string;

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', '1');
    application = await createApplication({ ...configuration, memberDailyRuns: 3,
      browser: { searchProvider: { name: 'monitor fixture', search } } });
    owner = await register(application, 'MonitorOwner', 'owner');
    member = await register(application, 'MonitorMember', 'member');
  });
  afterAll(async () => { await application?.app.close(); vi.unstubAllEnvs(); });

  const send = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: object) =>
    application.app.inject({ method, url, headers: headers(cookie), ...(payload && { payload }) });

  it('shows the real current value and requires approval before a member can start, pause, resume or stop', async () => {
    const detail = await ask(application, member, 'Watch new results for public park permits and notify me when they appear');
    expect(detail.error).toBeNull();
    expect(detail.capabilities.smartMonitors).toBe(true);
    const proposal = MonitorCardSchema.parse(detail.monitorProposal);
    expect(proposal).toMatchObject({ status: 'proposed', offer: 'explicit', nextCheckAt: null,
      current: { value: ['Public park permit A'] }, spec: { source: { kind: 'search', query: 'public park permits' } } });
    expect(search).toHaveBeenCalledTimes(1);
    const ownList = MonitorListSchema.parse((await send('GET', `${path}?conversationId=${detail.id}`, member)).json());
    expect(ownList.monitors).toEqual([proposal]);
    expect(MonitorListSchema.parse((await send('GET', `${path}?conversationId=${detail.id}`, owner)).json()).monitors).toEqual([]);
    expect((await send('POST', path, owner, { proposalId: proposal.id })).statusCode).toBe(404);
    expect((await send('POST', path, member, { proposalId: proposal.id, userId: randomUUID() })).statusCode).toBe(400);

    const approve = (await send('POST', path, member, { proposalId: proposal.id })).json();
    expect(MonitorCardSchema.parse(approve)).toMatchObject({ id: proposal.id, status: 'active', nextCheckAt: expect.any(String) });
    expect((await send('POST', path, member, { proposalId: proposal.id })).json()).toEqual(approve);
    expect((await send('POST', `${path}/${proposal.id}/pause`, owner)).statusCode).toBe(404);
    expect((await send('POST', `${path}/${proposal.id}/pause`, member)).json()).toMatchObject({ status: 'paused', nextCheckAt: null });
    expect((await send('POST', `${path}/${proposal.id}/resume`, member)).json()).toMatchObject({ status: 'active', nextCheckAt: expect.any(String) });
    expect((await send('POST', `${path}/${proposal.id}/stop`, member)).json()).toMatchObject({ status: 'stopped', nextCheckAt: null });
    expect((await send('POST', `${path}/${proposal.id}/resume`, member)).statusCode).toBe(409);
    const refreshed = await settle(application, detail.id, member);
    expect(refreshed.monitorProposal).toBeUndefined();
    expect(refreshed.monitors).toEqual([expect.objectContaining({ id: proposal.id, status: 'stopped' })]);
  });

  it('offers a follow-up after observing an unpublished public page', async () => {
    const url = 'https://public-gazette.example.org/notice';
    const text = 'Publication status: not published yet';
    const response = await send('POST', '/api/chat/conversations', owner, {});
    const conversationId = response.json().id;
    const account = (await send('GET', '/api/access', owner)).json().user;
    const request = vi.spyOn(SafeNetwork.prototype, 'request').mockImplementation(async (address, options) => {
      await options?.beforeDispatch?.();
      const robots = new URL(address).pathname === '/robots.txt';
      return { status: 200, url: address, headers: { 'content-type': 'text/plain' },
        body: Buffer.from(robots ? 'User-agent: *\nAllow: /' : text) };
    });
    try {
      const offer = await monitorChat(application.database.db)!.forBlockedTurn({ ownerId: account.id, conversationId,
        runId: randomUUID(), text: `Read the published decision at ${url}`, trail: [], pages: [{ url, documentStatus: 200, text }] });
      expect(offer?.text).toMatch(/resume the task/u);
      expect(offer?.proposal).toMatchObject({ offer: 'agent-initiated', observation: { value: 'unpublished', excerpt: text },
        spec: { read: { kind: 'status', label: 'publication' }, condition: { kind: 'equals', value: 'published' } } });
      expect(request).toHaveBeenCalledTimes(2);
    } finally { request.mockRestore(); }
  });

  it('reserves the last member admission atomically across approvals and lets an active approval replay', async () => {
    const cookie = await register(application, 'MonitorQuota', 'member');
    const first = await ask(application, cookie, 'Watch new results for public garden permits and notify me when they appear');
    const second = await ask(application, cookie, 'Watch new results for public festival permits and notify me when they appear');
    const proposals = [first, second].map(detail => MonitorCardSchema.parse(detail.monitorProposal));
    expect(proposals.map(proposal => proposal.status)).toEqual(['proposed', 'proposed']);
    expect((await send('GET', '/api/access', cookie)).json().quota).toEqual({ dailyRuns: 3, used: 2 });

    const approve = (proposalId: string) => send('POST', path, cookie, { proposalId });
    const approvals = await Promise.all(proposals.map(proposal => approve(proposal.id)));
    expect(approvals.map(response => response.statusCode).sort()).toEqual([200, 429]);
    const activeIndex = approvals.findIndex(response => response.statusCode === 200);
    const active = MonitorCardSchema.parse(approvals[activeIndex]!.json());
    const pending = proposals[1 - activeIndex]!;
    expect(active).toMatchObject({ id: proposals[activeIndex]!.id, status: 'active' });
    expect(approvals[1 - activeIndex]!.json()).toMatchObject({ error: { code: 'MEMBER_DAILY_LIMIT' } });
    expect((await approve(active.id)).json()).toEqual(active);
    expect((await approve(pending.id)).statusCode).toBe(429);
    expect((await send('GET', `${path}?conversationId=${pending.conversationId}`, cookie)).json().monitors)
      .toEqual([pending]);
    expect((await send('GET', '/api/access', cookie)).json().quota).toEqual({ dailyRuns: 3, used: 3 });
    const chat = await send('POST', '/api/chat/conversations', cookie, { goal: 'Hello' });
    expect(chat.statusCode).toBe(429);
    expect(chat.json()).toMatchObject({ error: { code: 'MEMBER_DAILY_LIMIT' } });
  });

  it('requires a session on every monitor route', async () => {
    expect((await send('GET', path)).statusCode).toBe(401);
    expect((await send('POST', path, undefined, { proposalId: randomUUID() })).statusCode).toBe(401);
    for (const action of ['pause', 'resume', 'stop']) {
      expect((await send('POST', `${path}/${randomUUID()}/${action}`)).statusCode).toBe(401);
    }
  });

  it('rejects a private address and creates no monitor', async () => {
    const detail = await ask(application, owner, 'Watch https://127.0.0.1/private and tell me when it changes');
    expect(detail.monitorProposal).toBeUndefined();
    expect((await send('GET', `${path}?conversationId=${detail.id}`, owner)).json()).toEqual({ monitors: [] });
  });
});

describe('rollout disabled by default', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('adds no chat capability, proposal, or monitor routes', async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', undefined);
    const app = await createApplication(configuration);
    try {
      expect(monitorChat(app.database.db)).toBeUndefined();
      expect(app.routes.has(`GET ${path}`)).toBe(false);
      const owner = await register(app, 'MonitorOff', 'owner');
      const reply = await ask(app, owner, 'Hello');
      expect(reply.capabilities.smartMonitors).toBeUndefined();
      expect(reply.monitorProposal).toBeUndefined();
    } finally { await app.app.close(); }
  });
});

describe('version 2 conversational management and offer settings', () => {
  let application: App;
  let owner: string;
  let member: string;
  let ownerId: string;
  let conversationId: string;

  const send = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    application.app.inject({ method, url, headers: headers(cookie), ...(payload && { payload }) });
  const draft = async () => (await send('POST', '/api/chat/conversations', owner, {})).json().id as string;
  const controlState = async (id: string, cookie = owner) => MonitorV2ControlSchema.parse((await send('GET', `${path}?control=v2&conversationId=${id}`, cookie)).json());
  async function talk(id: string, text: string) {
    const response = await send('POST', `/api/chat/conversations/${id}/messages`, owner, { text });
    expect(response.statusCode, response.body).toBe(200);
    return settle(application, id, owner);
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', '1');
    vi.stubEnv('MOHASSAN_MONITORS_V2', '1');
    vi.stubEnv('MOHASSAN_MONITORS_GITHUB', '1');
    application = await createApplication({ ...configuration, browser: { searchProvider: { name: 'monitor fixture', search } } });
    owner = await register(application, 'MonitorV2Owner', 'owner');
    member = await register(application, 'MonitorV2Member', 'member');
    ownerId = (await send('GET', '/api/access', owner)).json().user.id;
    conversationId = await draft();
  });
  afterAll(async () => { await application?.app.close(); vi.unstubAllEnvs(); });

  it('lists monitors in Arabic and fences a threshold edit and a stop behind separate confirmations', async () => {
    const controls = monitorChat(application.database.db)!;
    const now = new Date();
    const proposal = await controls.store.propose(ownerId, { conversationId, observation: { value: 3.75, excerpt: 'USD/SAR', observedAt: now.toISOString() },
      spec: { title: 'USD/SAR', message: 'The exchange rate fell.', language: 'en', source: { kind: 'currency', base: 'USD', quote: 'SAR' },
        read: { kind: 'number' }, condition: { kind: 'crossing', direction: 'below', value: 3.7, hysteresis: 0.01 },
        timing: monitorTiming('currency', 'normal', { now }) } });
    await controls.store.approve(ownerId, proposal.id);
    const listed = await talk(conversationId, 'ماذا تراقب لي؟');
    expect(listed.capabilities.smartMonitorsV2).toBe(true);
    expect(listed.messages.at(-1)?.text).toContain('USD/SAR (نشطة)');
    expect((await controlState(conversationId)).action).toBeUndefined();

    await talk(conversationId, 'غيّر الحد إلى ۳٫۶۵');
    const edit = (await controlState(conversationId)).action!;
    expect(edit.question).toContain('3.65');
    expect((await controls.store.list(ownerId, conversationId))[0].spec.condition).toMatchObject({ value: 3.7 });
    expect((await controlState(conversationId, member)).action).toBeUndefined();
    expect((await send('POST', path, member, { actionId: edit.id, approved: true })).statusCode).toBe(404);
    const updated = await send('POST', path, owner, { actionId: edit.id, approved: true });
    expect(updated.json()).toMatchObject({ monitor: { id: proposal.id, status: 'active', spec: { condition: { value: 3.65 } } } });
    expect((await send('POST', path, owner, { actionId: edit.id, approved: true })).json()).toEqual({});

    await talk(conversationId, 'أوقف مراقبة الدولار');
    const stop = (await controlState(conversationId)).action!;
    expect(stop.question).toContain('USD/SAR');
    expect((await controls.store.list(ownerId, conversationId))[0].status).toBe('active');
    expect((await send('POST', path, owner, { actionId: stop.id, approved: true })).json()).toMatchObject({ monitor: { status: 'stopped' } });
  });

  it('changes item delivery to a daily digest only after confirmation', async () => {
    const result = await ask(application, owner, 'Notify me every time a new item appears in public search results for park permits');
    const proposal = MonitorCardSchema.parse(result.monitorProposal);
    expect((await send('POST', path, owner, { proposalId: proposal.id })).json()).toMatchObject({ status: 'active' });
    await talk(result.id, 'أرسل لي ملخصًا يوميًا بدل كل تنبيه');
    const pending = (await controlState(result.id)).action!;
    expect(pending.question).toContain('ملخصًا يوميًا');
    const saved = await send('POST', path, owner, { actionId: pending.id, approved: true });
    expect(saved.json()).toMatchObject({ monitor: { spec: { v2: { delivery: 'daily' } } } });
  });

  it('offers a GitHub watch only for the grounded topic and writes one proposal', async () => {
    const db = application.database.db;
    const controls = monitorChat(db)!;
    const id = await draft();
    const url = 'https://github.com/owner/repo/pull/42';
    const offer = (answer: string, pages = [{ url, text: 'PR 42 is still open.', documentStatus: 200 }]) =>
      db.transaction().execute(tx => controls.publishAnswerOffer(tx, {
        ownerId, conversationId: id, runId: randomUUID(), text: 'Has PR 42 in owner/repo merged?', pages,
      }, answer));
    expect(await offer('I could not verify PR 42.', [])).toBe('');
    expect(await offer('PR 43 is open.')).toBe('');
    expect(await offer('PR 42 is still open.')).toContain('Would you like');
    expect(await offer('PR 42 is still open.')).toBe('');
    expect((await controls.view(ownerId, id)).monitorProposal).toMatchObject({
      status: 'proposed', offer: 'agent-initiated',
      spec: { source: { kind: 'github', owner: 'owner', repo: 'repo', watch: { kind: 'pull-request', number: 42 } },
        condition: { kind: 'equals', value: 'merged' } },
    });
  });

  it('publishes one offer per topic and obeys the account setting across conversations', async () => {
    const controls = monitorChat(application.database.db)!;
    const db = application.database.db;
    const id = await draft();
    const another = await draft();
    const url = 'https://products.example.org/workshop-kit';
    const offer = (conversationId: string) => db.transaction().execute(tx => controls.publishAnswerOffer(tx, {
      ownerId, conversationId, runId: randomUUID(), text: `Is the product in stock at ${url}?`,
      pages: [{ url, text: 'Workshop kit sold out.', documentStatus: 200 }],
    }, 'The workshop kit is sold out.'));
    expect(await offer(id)).toContain('Would you like');
    expect((await controls.view(ownerId, id)).monitorProposal).toMatchObject({ status: 'proposed', offer: 'agent-initiated', current: { value: 'out of stock' } });
    expect(await offer(id)).toBe('');
    expect((await send('POST', path, owner, { proactiveOffers: false })).json()).toEqual({ proactiveOffers: false });
    expect((await controlState(another)).proactiveOffers).toBe(false);
    expect((await controlState(another, member)).proactiveOffers).toBe(true);
    expect(await offer(another)).toBe('');
    expect((await controls.view(ownerId, another)).monitorProposal).toBeUndefined();
  });
});
