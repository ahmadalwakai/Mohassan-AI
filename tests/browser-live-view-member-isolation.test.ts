import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBrowser } from '@mohassan/browser';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../apps/server/src/app.ts';

describe('browser live view routes enforce conversation ownership', () => {
  const origin = 'http://127.0.0.1:3000';
  const internalSecret = 'browser-live-isolation-fixture-internal';
  const setupToken = 'browser-live-isolation-fixture-setup';
  const owner = { name: 'Browser owner fixture', email: 'browser-owner@example.test', password: 'Browser-Owner-Fixture-45' };
  const member = { name: 'Browser member fixture', email: 'browser-member@example.test', password: 'Browser-Member-Fixture-45' };
  const ownerFrame = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
  const memberFrame = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
  const conversations = '/api/chat/conversations';
  let directory: string | undefined;
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerSession: Awaited<ReturnType<typeof signIn>>;
  let memberSession: Awaited<ReturnType<typeof signIn>>;
  let ownerWaiting: Awaited<ReturnType<typeof seedRun>>;
  let ownerApproval: Awaited<ReturnType<typeof seedRun>>;
  let memberWaiting: Awaited<ReturnType<typeof seedRun>>;
  let memberRunning: Awaited<ReturnType<typeof seedRun>>;

  const screen = vi.spyOn(AgentBrowser.prototype, 'screen').mockImplementation(async (_accountId, id) => id === memberWaiting.id ? memberFrame : ownerFrame);
  const activity = vi.spyOn(AgentBrowser.prototype, 'activity').mockImplementation(async (_accountId, id) => ({ sequence: id === memberWaiting.id ? 2 : 1, cursor: null }));
  const pointer = vi.spyOn(AgentBrowser.prototype, 'pointer').mockResolvedValue();
  const keyboard = vi.spyOn(AgentBrowser.prototype, 'keyboard').mockResolvedValue();
  vi.spyOn(AgentBrowser.prototype, 'hasPage').mockResolvedValue(true);

  function inject(method: 'GET' | 'POST', url: string, cookie = '', payload?: object) {
    return application.app.inject({ method, url, headers: { origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) }, payload });
  }

  async function signIn(credentials: { email: string; password: string }) {
    const response = await inject('POST', '/api/auth/sign-in/email', '', { email: credentials.email, password: credentials.password });
    expect(response.statusCode).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const access = await inject('GET', '/api/access', cookie);
    expect(access.statusCode).toBe(200);
    return { cookie, accountId: access.json().user.id as string, role: access.json().role as string };
  }

  async function seedRun(session: { cookie: string; accountId: string }, status: 'running' | 'waiting_input' | 'waiting_approval') {
    const created = await inject('POST', conversations, session.cookie, {});
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const runId = randomUUID(), requestId = randomUUID();
    const site = 'https://example.test';
    const secure = status === 'waiting_input' ? { id: requestId, kind: 'login', site, prompt: 'Sign in to this fixture', note: null, fields: [] } : null;
    const approval = status === 'waiting_approval' ? { id: requestId, prompt: 'Review the fixture action', detail: '' } : null;
    const browser = { url: site, title: 'Browser live fixture', observedAt: new Date().toISOString(), version: 'fixture' };
    await application.database.db.transaction().execute(async tx => {
      await tx.insertInto('chat_runs').values({ id: runId, owner_id: session.accountId, conversation_id: id, status, goal: 'Browser live fixture',
        lease_token: randomUUID(), worker_id: 'browser-live-isolation-fixture-worker', lease_expires_at: new Date(Date.now() + 600_000) }).execute();
      await tx.updateTable('chat_conversations').set({ active_run_id: runId, status, browser_state: JSON.stringify(browser),
        secure: secure && JSON.stringify(secure), approval: approval && JSON.stringify(approval) }).where('id', '=', id).execute();
    });
    return { id, runId, requestId, path: `${conversations}/${id}` };
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-live-view-isolation-'));
    application = await createApplication({ authSecret: 'browser-live-isolation-fixture-auth-secret', internalSecret, setupToken,
      webOrigin: origin, production: false, runWorker: false, browserProfileDir: join(directory, 'browser') });
    expect((await inject('POST', '/api/setup', '', { ...owner, setupToken })).statusCode).toBe(200);
    ownerSession = await signIn(owner);
    const invited = await inject('POST', '/api/members/invites', ownerSession.cookie, { name: member.name, email: member.email });
    expect(invited.statusCode).toBe(200);
    const token = new URL(invited.json().url).hash.replace('#invite=', '');
    expect((await inject('POST', '/api/invites/accept', '', { name: member.name, password: member.password, token })).statusCode).toBe(200);
    memberSession = await signIn(member);
    expect(memberSession.role).toBe('member');

    ownerWaiting = await seedRun(ownerSession, 'waiting_input');
    ownerApproval = await seedRun(ownerSession, 'waiting_approval');
    memberWaiting = await seedRun(memberSession, 'waiting_input');
    memberRunning = await seedRun(memberSession, 'running');
  });

  afterEach(() => vi.clearAllMocks());
  afterAll(async () => {
    try { await application?.app.close(); }
    finally {
      vi.restoreAllMocks();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('only delivers the member’s own detail, frame and activity', async () => {
    const listing = await inject('GET', conversations, memberSession.cookie);
    expect(listing.statusCode).toBe(200);
    expect(listing.json().conversations.map((conversation: { id: string }) => conversation.id).sort()).toEqual([memberWaiting.id, memberRunning.id].sort());

    const own = await inject('GET', memberWaiting.path, memberSession.cookie);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: memberWaiting.id, browser: { live: true }, visibility: { code: 'needs_login', level: 3 } });
    const ownFrame = await inject('GET', `${memberWaiting.path}/screen`, memberSession.cookie);
    expect(ownFrame.statusCode).toBe(200);
    expect(ownFrame.headers['content-type']).toContain('image/jpeg');
    expect(ownFrame.rawPayload).toEqual(memberFrame);
    const ownActivity = await inject('GET', `${memberWaiting.path}/browser/activity`, memberSession.cookie);
    expect(ownActivity.statusCode).toBe(200);
    expect(ownActivity.json()).toEqual({ sequence: 2, cursor: null });

    const visibleToOwner = await inject('GET', `${ownerWaiting.path}/screen`, ownerSession.cookie);
    expect(visibleToOwner.statusCode).toBe(200);
    expect(visibleToOwner.rawPayload).toEqual(ownerFrame);
    for (const suffix of ['', '/screen', '/browser/activity']) {
      const denied = await inject('GET', `${ownerWaiting.path}${suffix}`, memberSession.cookie);
      expect(denied.statusCode, suffix).toBe(404);
      expect(denied.json().error.code, suffix).toBe('CHAT_NOT_FOUND');
    }
    expect((await inject('GET', `${memberWaiting.path}/screen`)).statusCode).toBe(401);
    expect(screen.mock.calls).toEqual([[memberSession.accountId, memberWaiting.id], [ownerSession.accountId, ownerWaiting.id]]);
    expect(activity.mock.calls).toEqual([[memberSession.accountId, memberWaiting.id]]);
  });

  it('rejects take-over input, continuation and cancellation for the owner’s runs', async () => {
    const requests = [
      [`${ownerWaiting.path}/browser/pointer`, { x: 0.25, y: 0.5 }],
      [`${ownerWaiting.path}/browser/keyboard`, { text: 'foreign fixture input' }],
      [`${ownerWaiting.path}/browser/keyboard`, { wheel: { x: 0.25, y: 0.5, deltaX: 0, deltaY: 72 } }],
      [`${ownerWaiting.path}/secure`, { requestId: ownerWaiting.requestId, action: 'done' }],
      [`${ownerApproval.path}/approve`, { approvalId: ownerApproval.requestId, approved: true }],
      [`${ownerWaiting.path}/cancel`, {}],
    ] as const;
    for (const [path, payload] of requests) {
      const denied = await inject('POST', path, memberSession.cookie, payload);
      expect(denied.statusCode, path).toBe(404);
      expect(denied.json().error.code, path).toBe('CHAT_NOT_FOUND');
    }
    expect(pointer).not.toHaveBeenCalled();
    expect(keyboard).not.toHaveBeenCalled();
    const ownerState = await inject('GET', ownerWaiting.path, ownerSession.cookie);
    expect(ownerState.json()).toMatchObject({ status: 'waiting_input', secure: { id: ownerWaiting.requestId } });
    const approvalState = await inject('GET', ownerApproval.path, ownerSession.cookie);
    expect(approvalState.json()).toMatchObject({ status: 'waiting_approval', approval: { id: ownerApproval.requestId } });
  });

  it('forwards owned input while paused and refuses it while the agent is running', async () => {
    const text = 'ephemeral fixture keyboard entry';
    const click = { x: 0.25, y: 0.5 };
    const wheel = { ...click, deltaX: 0, deltaY: 72 };
    expect((await inject('POST', `${memberWaiting.path}/browser/pointer`, memberSession.cookie, click)).json()).toEqual({ ok: true });
    expect((await inject('POST', `${memberWaiting.path}/browser/keyboard`, memberSession.cookie, { text })).json()).toEqual({ ok: true });
    expect((await inject('POST', `${memberWaiting.path}/browser/keyboard`, memberSession.cookie, { wheel })).json()).toEqual({ ok: true });
    const busy = await inject('POST', `${memberRunning.path}/browser/keyboard`, memberSession.cookie, { text });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('CHAT_BUSY');
    expect(pointer.mock.calls).toEqual([[memberSession.accountId, memberWaiting.id, click.x, click.y]]);
    expect(keyboard.mock.calls).toEqual([
      [memberSession.accountId, memberWaiting.id, { text }],
      [memberSession.accountId, memberWaiting.id, { wheel }],
    ]);
    const detail = await inject('GET', memberWaiting.path, memberSession.cookie);
    expect(detail.json()).toMatchObject({ status: 'waiting_input', secure: { id: memberWaiting.requestId } });
    expect(detail.body).not.toContain(text);
    const events = await application.database.db.selectFrom('chat_events').selectAll().where('conversation_id', '=', memberWaiting.id).execute();
    expect(JSON.stringify(events)).not.toContain(text);
  });
});
