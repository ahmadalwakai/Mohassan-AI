import { randomUUID } from 'node:crypto';
import { MonitorCardSchema, MonitorListSchema } from '@mohassan/contracts';
import { SafeNetwork } from '@mohassan/browser';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { monitorChat } from '../apps/server/src/monitors/chat.js';

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
    application = await createApplication({ ...configuration, browser: { searchProvider: { name: 'monitor fixture', search } } });
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
