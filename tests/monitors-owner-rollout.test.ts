import { randomUUID } from 'node:crypto';
import { MonitorCardSchema, MonitorSpecSchema } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';
import { legacyMonitorHandledBySmartChat, monitorChat } from '../apps/server/src/monitors/chat.js';
import { monitorRollout, smartMonitorsEnabled } from '../apps/server/src/monitors/flag.js';
import { monitorPaths } from '../apps/server/src/monitors/route-keys.js';
import { monitorTiming } from '../apps/server/src/monitors/schedule.js';
import { createMonitorStore } from '../apps/server/src/monitors/store.js';

const origin = 'http://127.0.0.1:3000';
const setupToken = 'owner-rollout-test-setup-secret-value';
const config = {
  authSecret: 'owner-rollout-test-authentication-secret',
  internalSecret: 'owner-rollout-test-internal-service-secret',
  setupToken, webOrigin: origin, production: false, runWorker: false, testRequestLimit: 1000,
};
const goal = 'Watch new results for public park permits and notify me when they appear';
const result = { url: 'https://parks.example.org/permits/rollout', title: 'Public park permit', snippet: 'Published permit' };
const search = vi.fn(async () => [result]);

type Application = Awaited<ReturnType<typeof createApplication>>;
type Session = { id: string; cookie: string };

it.each([
  [undefined, 'off'], ['0', 'off'], ['owner', 'owner'], ['1', 'all'], ['true', 'off'],
])('interprets the monitor rollout value %s as %s', (value, mode) => {
  const env = { MOHASSAN_MONITORS_ENABLED: value };
  expect(monitorRollout(env)).toBe(mode);
  expect(smartMonitorsEnabled(env)).toBe(mode !== 'off');
});

describe('owner-only monitor rollout', () => {
  let application: Application;
  let owner: Session;
  let member: Session;

  function request(method: 'GET' | 'POST', url: string, session?: Session, payload?: object) {
    return application.app.inject({
      method, url, headers: { origin, 'x-mohassan-internal': config.internalSecret, ...(session && { cookie: session.cookie }) },
      ...(payload && { payload }),
    });
  }

  async function signIn(name: string, role: 'owner' | 'member'): Promise<Session> {
    const credentials = { name, email: `${name.toLowerCase()}@example.test`, password: 'Owner-Rollout-Fixture-29' };
    if (role === 'owner') {
      const setup = await request('POST', '/api/setup', undefined, { ...credentials, setupToken });
      expect(setup.statusCode, setup.body).toBe(200);
    } else {
      const { user } = await application.auth.api.signUpEmail({ body: credentials });
      await application.database.db.insertInto('workspace_members').values({ user_id: user.id, role }).execute();
    }
    const response = await request('POST', '/api/auth/sign-in/email', undefined, { email: credentials.email, password: credentials.password });
    expect(response.statusCode, response.body).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const session = { id: response.json().user.id, cookie };
    const access = await request('GET', '/api/access', session);
    expect(access.statusCode, access.body).toBe(200);
    expect(access.json().role).toBe(role);
    return session;
  }

  async function detail(session: Session, conversationId: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await request('GET', `/api/chat/conversations/${conversationId}`, session);
      expect(response.statusCode, response.body).toBe(200);
      const conversation = response.json();
      if (conversation.status !== 'running') return conversation;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Owner rollout fixture conversation did not settle');
  }

  async function conversation(session: Session, payload: object = {}) {
    const response = await request('POST', '/api/chat/conversations', session, payload);
    expect(response.statusCode, response.body).toBe(200);
    return detail(session, response.json().id);
  }

  beforeAll(async () => {
    vi.stubEnv('MOHASSAN_MONITORS_ENABLED', 'owner');
    vi.stubEnv('MOHASSAN_LONG_RUN_ENABLED', '0');
    application = await createApplication({ ...config, browser: { searchProvider: { name: 'owner rollout fixture', search } } });
    owner = await signIn('RolloutOwner', 'owner');
    member = await signIn('RolloutMember', 'member');
  });

  afterAll(async () => {
    await application?.app.close();
    vi.unstubAllEnvs();
  });

  it('admits owner detection and routes and rejects member sessions before request validation', async () => {
    const db = application.database.db;
    const ownerChat = await conversation(owner, { goal });
    const proposal = MonitorCardSchema.parse(ownerChat.monitorProposal);
    expect(ownerChat.capabilities.smartMonitors).toBe(true);
    expect(proposal).toMatchObject({ status: 'proposed', offer: 'explicit', current: { value: [result.title] } });
    expect(search).toHaveBeenCalledTimes(1);
    expect((await request('GET', '/api/chat/conversations', owner)).json().capabilities.smartMonitors).toBe(true);
    expect((await request('GET', monitorPaths.base, owner)).json().monitors).toContainEqual(proposal);
    expect((await request('POST', monitorPaths.base, owner, { proposalId: proposal.id })).json()).toMatchObject({ status: 'active' });

    const memberChat = await conversation(member, { goal });
    expect(memberChat.capabilities.smartMonitors).toBeUndefined();
    expect(memberChat.monitorProposal).toBeUndefined();
    expect(memberChat.monitors).toBeUndefined();
    expect((await request('GET', '/api/chat/conversations', member)).json().capabilities.smartMonitors).toBeUndefined();
    expect(await db.selectFrom('smart_monitor_budgets').select('previews').where('user_id', '=', member.id).executeTakeFirst()).toBeUndefined();
    await expect(legacyMonitorHandledBySmartChat(db, owner.id, goal)).resolves.toBe(true);
    await expect(legacyMonitorHandledBySmartChat(db, member.id, goal)).resolves.toBe(false);

    expect((await request('GET', monitorPaths.base)).statusCode).toBe(401);
    const blocked = [
      await request('GET', `${monitorPaths.base}?conversationId=bad`, member),
      await request('POST', monitorPaths.base, member, {}),
      await request('POST', `${monitorPaths.base}/alerts/${randomUUID()}/feedback`, member, {}),
      ...await Promise.all(['pause', 'resume', 'stop'].map(action => request('POST', `${monitorPaths.base}/bad/${action}`, member, {}))),
    ];
    for (const response of blocked) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.code).toBe('MONITOR_FORBIDDEN');
    }
  });

  it('keeps existing member due checks and queued notices untouched while an owner check runs', async () => {
    const db = application.database.db;
    const monitor = monitorChat(db)!;
    await monitor.runtime.runOnce();
    const ownerChat = await conversation(owner);
    const memberChat = await conversation(member);
    const priorRolloutStore = createMonitorStore(db);
    const spec = MonitorSpecSchema.parse({
      source: { kind: 'search', query: 'public park permits' }, read: { kind: 'items' }, condition: { kind: 'new-item' },
      timing: monitorTiming('search', 'normal', { now: new Date() }), language: 'en', title: 'Park permits', message: 'Public permit published.',
    });
    const observation = { value: [result.title], excerpt: result.title, url: result.url, observedAt: new Date().toISOString() };
    const ownerMonitor = await priorRolloutStore.propose(owner.id, { conversationId: ownerChat.id, spec, observation });
    const memberMonitor = await priorRolloutStore.propose(member.id, { conversationId: memberChat.id, spec, observation });
    const memberNotice = await priorRolloutStore.propose(member.id, { conversationId: memberChat.id,
      spec: { ...spec, source: { kind: 'search', query: 'public town hall notices' } }, observation });
    await priorRolloutStore.approve(owner.id, ownerMonitor.id);
    await priorRolloutStore.approve(member.id, memberMonitor.id);
    const due = new Date(Date.now() - 60_000);
    const eventId = randomUUID();
    await db.updateTable('smart_monitors').set({ next_check_at: due }).where('id', 'in', [ownerMonitor.id, memberMonitor.id]).execute();
    await db.updateTable('smart_monitors').set({ status: 'completed', notice_due_at: due,
      pending_notice: JSON.stringify({ eventId, outcome: 'completed', message: 'Recorded monitor result', happenedAt: due.toISOString() }),
    }).where('id', '=', memberNotice.id).execute();
    const memberRows = () => db.selectFrom('smart_monitors').selectAll().where('user_id', '=', member.id).orderBy('id').execute();
    const before = await memberRows();
    search.mockClear();
    await monitor.runtime.runOnce();
    expect(search).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom('smart_monitors').select('checks').where('id', '=', ownerMonitor.id).executeTakeFirst()).toEqual({ checks: 1 });
    expect(await memberRows()).toEqual(before);
    expect(await db.selectFrom('chat_notifications').select('task_id').where('task_id', '=', eventId).executeTakeFirst()).toBeUndefined();
    expect((await detail(member, memberChat.id)).monitors).toBeUndefined();
  });
});
