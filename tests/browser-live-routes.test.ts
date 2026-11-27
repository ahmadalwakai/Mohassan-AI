import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserLiveBudget, browserLiveFrameHeader, browserLiveHandoverNote } from '@mohassan/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApplication, type AppConfig } from '../apps/server/src/app.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
}

// Exercises the real auth and member gate, using deterministic SQL rows and an in-memory frame source.
// Status codes follow RFC 9110 (https://www.rfc-editor.org/rfc/rfc9110.html, retrieved 2026-11-27)
// and RFC 6585 §4 (https://www.rfc-editor.org/rfc/rfc6585.html#section-4, retrieved 2026-11-27).
describe('the owner browser live view API', () => {
  const config: AppConfig = {
    webOrigin: 'http://127.0.0.1:3000', internalSecret: 'test-browser-live-api-internal-fixture',
    authSecret: 'test-browser-live-api-auth-fixture', setupToken: 'test-browser-live-api-setup-fixture',
    production: false, runWorker: false,
  };
  const owner = { name: 'Owner Fixture', email: 'browser-live-owner@example.test', password: 'Owner-Live-View-Fixture-1' };
  const member = { name: 'Member Fixture', email: 'browser-live-member@example.test', password: 'Member-Live-View-Fixture-1' };
  const conversations = '/api/chat/conversations';
  const ownerFrame = { id: randomUUID(), bytes: Buffer.from('owner fixture frame') };
  const prompt = 'سجّل الدخول في صفحة الموقع، ثم اضغط متابعة.';
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerSession: Awaited<ReturnType<typeof signIn>>;
  let memberSession: Awaited<ReturnType<typeof signIn>>;

  function inject(method: 'GET' | 'POST', url: string, cookie?: string, payload?: object, app = application.app) {
    return app.inject({ method, url, headers: { origin: config.webOrigin, 'x-mohassan-internal': config.internalSecret,
      ...(cookie ? { cookie } : {}) }, payload });
  }

  async function signIn({ email, password }: typeof owner, app = application.app) {
    const signedIn = await inject('POST', '/api/auth/sign-in/email', undefined, { email, password }, app);
    expect(signedIn.statusCode).toBe(200);
    const cookie = [signedIn.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    const access = await inject('GET', '/api/access', cookie, undefined, app);
    expect(access.statusCode).toBe(200);
    return { cookie, accountId: access.json().user.id as string };
  }

  async function seedRun(session: { cookie: string; accountId: string }, status: 'running' | 'waiting_input' = 'running') {
    const created = await inject('POST', conversations, session.cookie, {});
    expect(created.statusCode).toBe(200);
    const conversationId = created.json().id as string;
    const runId = randomUUID();
    const handoverId = randomUUID();
    const secure = status === 'waiting_input'
      ? { id: handoverId, kind: 'hands_on', site: 'https://example.test', prompt, note: browserLiveHandoverNote, fields: [] } : null;
    await application.database.db.transaction().execute(async tx => {
      await tx.insertInto('chat_runs').values({ id: runId, owner_id: session.accountId, conversation_id: conversationId, status,
        goal: 'Browser live fixture', lease_token: randomUUID(), worker_id: 'browser-live-fixture',
        lease_expires_at: new Date(Date.now() + 60_000) }).execute();
      await tx.updateTable('chat_conversations').set({ active_run_id: runId, status, secure: secure && JSON.stringify(secure) })
        .where('id', '=', conversationId).execute();
    });
    const path = `${conversations}/${conversationId}/browser/live`;
    return { conversationId, runId, handoverId, path, run: `${path}/${runId}` };
  }

  beforeAll(async () => {
    application = await createApplication({ ...config, browserHands: 'on' });
    expect((await inject('POST', '/api/setup', undefined, { ...owner, setupToken: config.setupToken })).statusCode).toBe(200);
    ownerSession = await signIn(owner);
    const invite = await inject('POST', '/api/members/invites', ownerSession.cookie, { name: member.name, email: member.email });
    expect(invite.statusCode).toBe(200);
    const token = new URL(invite.json().url).hash.replace('#invite=', '');
    expect((await inject('POST', '/api/invites/accept', undefined, { name: member.name, password: member.password, token })).statusCode).toBe(200);
    memberSession = await signIn(member);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await application?.app.close(); });

  it('returns the run and its JPEG to the owner, and rejects every endpoint for members and anonymous callers', async () => {
    const owned = await seedRun(ownerSession, 'waiting_input');
    const memberRun = await seedRun(memberSession);
    const frame = vi.spyOn(application.chat.browserLive, 'frame').mockResolvedValue(ownerFrame);
    const input = vi.spyOn(application.chat.browserLive, 'input').mockImplementation(async () => undefined);
    const resume = vi.spyOn(application.chat.browserLive, 'continue').mockImplementation(async () => undefined);
    const current = await inject('GET', owned.path, ownerSession.cookie);
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ runId: owned.runId, handover: { id: owned.handoverId, prompt } });
    const response = await inject('GET', `${owned.run}/frame`, ownerSession.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      [browserLiveFrameHeader]: ownerFrame.id });
    expect(response.rawPayload).toEqual(ownerFrame.bytes);
    expect(frame).toHaveBeenCalledWith(ownerSession.accountId, owned.conversationId, owned.runId, expect.any(AbortSignal));

    const routes = [
      ['GET', owned.path], ['GET', `${owned.run}/frame`],
      ['POST', `${owned.run}/input`, { handoverId: owned.handoverId, frameId: ownerFrame.id, kind: 'pointer', x: 0.5, y: 0.5 }],
      ['POST', `${owned.run}/continue`, { handoverId: owned.handoverId }],
    ] as const;
    for (const [method, url, payload] of routes) {
      expect((await inject(method, url, undefined, payload)).statusCode).toBe(401);
      expect((await inject(method, url, memberSession.cookie, payload)).statusCode).toBe(403);
    }
    expect((await inject('GET', memberRun.path, memberSession.cookie)).statusCode).toBe(403);
    expect((await inject('GET', memberRun.path, ownerSession.cookie)).statusCode).toBe(404);
    expect((await inject('GET', `${memberRun.run}/frame`, ownerSession.cookie)).statusCode).toBe(404);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('requires the selected conversation, exact active run, starter account and an unexpired lease', async () => {
    const owned = await seedRun(ownerSession);
    const other = await seedRun(ownerSession);
    const live = application.chat.browserLive;
    vi.spyOn(live, 'hasPage').mockResolvedValue(true);
    const frame = vi.spyOn(live, 'frame').mockResolvedValue(ownerFrame);
    const snapshot = async () => (await inject('GET', owned.path, ownerSession.cookie)).json();
    const update = (values: { owner_id?: string; lease_expires_at?: Date; conversation_id?: string }) => application.database.db
      .updateTable('chat_runs').set(values).where('id', '=', owned.runId).execute();

    expect(await snapshot()).toEqual({ runId: owned.runId, handover: null });
    const getFrame = (runId: string) => inject('GET', `${owned.path}/${runId}/frame`, ownerSession.cookie);
    expect((await getFrame(other.runId)).statusCode).toBe(404);

    await update({ owner_id: memberSession.accountId });
    expect(await snapshot()).toEqual({ runId: null, handover: null });
    expect((await getFrame(owned.runId)).statusCode).toBe(404);
    await update({ owner_id: ownerSession.accountId, conversation_id: other.conversationId });
    expect((await getFrame(owned.runId)).statusCode).toBe(404);
    await update({ conversation_id: owned.conversationId, lease_expires_at: new Date(Date.now() - 60_000) });
    expect((await getFrame(owned.runId)).statusCode).toBe(404);
    expect(frame).not.toHaveBeenCalled();
  });

  it('admits only one capture at a time, enforces its interval and drops oversize bytes', async () => {
    const owned = await seedRun(ownerSession);
    const { promise, resolve } = deferred<typeof ownerFrame>();
    const started = deferred<void>();
    const frame = vi.spyOn(application.chat.browserLive, 'frame')
      .mockImplementationOnce(() => { started.resolve(); return promise; })
      .mockResolvedValueOnce({ id: randomUUID(), bytes: Buffer.alloc(browserLiveBudget.maxFrameBytes + 1) });
    const fetchFrame = () => inject('GET', `${owned.run}/frame`, ownerSession.cookie);
    const first = fetchFrame().then(response => response);
    await Promise.race([started.promise, first.then(response => { throw new Error(`Capture did not start (${response.statusCode})`); })]);
    try {
      const during = await fetchFrame();
      expect(during.statusCode).toBe(429);
      expect(during.headers['retry-after']).toBe(String(Math.ceil(browserLiveBudget.intervalMs / 1000)));
    } finally {
      resolve({ id: ownerFrame.id, bytes: Buffer.alloc(browserLiveBudget.maxFrameBytes) });
    }
    expect((await first).rawPayload).toHaveLength(browserLiveBudget.maxFrameBytes);
    expect((await fetchFrame()).statusCode).toBe(429);
    expect(frame).toHaveBeenCalledTimes(1);

    await delay(browserLiveBudget.intervalMs);
    const tooLarge = await fetchFrame();
    expect(tooLarge.statusCode).toBe(204);
    expect(tooLarge.rawPayload).toHaveLength(0);
    expect(tooLarge.headers[browserLiveFrameHeader]).toBeUndefined();
    expect(frame).toHaveBeenCalledTimes(2);
  });

  it('discards a capture if the run is replaced while the screenshot is in flight', async () => {
    const owned = await seedRun(ownerSession);
    vi.spyOn(application.chat.browserLive, 'frame').mockImplementationOnce(async () => {
      await application.database.db.updateTable('chat_conversations').set({ active_run_id: null, status: 'idle' })
        .where('id', '=', owned.conversationId).execute();
      return ownerFrame;
    });
    const response = await inject('GET', `${owned.run}/frame`, ownerSession.cookie);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(ownerFrame.bytes.toString());
    expect(response.headers[browserLiveFrameHeader]).toBeUndefined();
  });

  it('discards a capture if the account loses owner access before the response', async () => {
    const role = (role: 'owner' | 'member') => application.database.db.updateTable('workspace_members').set({ role })
      .where('user_id', '=', memberSession.accountId).execute();
    await role('owner');
    try {
      const owned = await seedRun(memberSession);
      const frame = vi.spyOn(application.chat.browserLive, 'frame').mockImplementationOnce(async () => {
        await role('member');
        return ownerFrame;
      });
      const response = await inject('GET', `${owned.run}/frame`, memberSession.cookie);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(ownerFrame.bytes.toString());
      expect(response.headers[browserLiveFrameHeader]).toBeUndefined();
      expect(frame).toHaveBeenCalledTimes(1);
    } finally { await role('member'); }
  });

  it('only sends input and Continue to the current live handover card', async () => {
    const owned = await seedRun(ownerSession, 'waiting_input');
    const running = await seedRun(ownerSession);
    const input = vi.spyOn(application.chat.browserLive, 'input').mockImplementation(async () => undefined);
    const resume = vi.spyOn(application.chat.browserLive, 'continue').mockImplementation(async () => undefined);
    const pointer = { handoverId: owned.handoverId, frameId: ownerFrame.id, kind: 'pointer', x: 0.5, y: 0.5 };
    const post = (path: string, payload: object) => inject('POST', path, ownerSession.cookie, payload);
    expect((await post(`${owned.run}/input`, { ...pointer, handoverId: randomUUID() })).statusCode).toBe(409);
    expect((await post(`${running.run}/input`, pointer)).statusCode).toBe(409);
    expect((await post(`${owned.run}/continue`, { handoverId: randomUUID() })).statusCode).toBe(409);
    expect((await post(`${owned.run}/input`, { ...pointer, x: 2 })).statusCode).toBe(400);
    expect((await post(`${owned.run}/input`, { ...pointer, frameId: undefined })).statusCode).toBe(400);
    expect((await post(`${owned.run}/input`, { handoverId: owned.handoverId, kind: 'keyboard', key: 'Enter' })).statusCode).toBe(400);
    expect(input).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect((await post(`${owned.run}/input`, pointer)).statusCode).toBe(204);
    expect(input).toHaveBeenCalledExactlyOnceWith(ownerSession.accountId, owned.conversationId, owned.runId, pointer, expect.any(AbortSignal));
    expect((await post(`${owned.run}/continue`, { handoverId: owned.handoverId })).statusCode).toBe(204);
    expect(resume).toHaveBeenCalledExactlyOnceWith(ownerSession.accountId, owned.conversationId, owned.runId, owned.handoverId);
  });

  it('is off by default', async () => {
    const { app } = await createApplication(config);
    try {
      expect((await inject('POST', '/api/setup', undefined, { ...owner, setupToken: config.setupToken }, app)).statusCode).toBe(200);
      const { cookie } = await signIn(owner, app);
      const created = await inject('POST', conversations, cookie, {}, app);
      expect(created.statusCode).toBe(200);
      expect((await inject('GET', `${conversations}/${created.json().id}/browser/live`, cookie, undefined, app)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
