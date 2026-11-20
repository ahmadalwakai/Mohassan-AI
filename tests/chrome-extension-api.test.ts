import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, migrate } from '@mohassan/database';
import type { AgentBrowser } from '@mohassan/browser';
import { createChromeExtensionControl } from '../apps/server/src/chrome-extension.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createApplication } from '../apps/server/src/app.js';
import { campaignLines, type AdsBrief } from '../apps/server/src/assistant/ads-model-chat.js';

const lines = ['BUSINESS: Local Tyres', 'SERVICE: Mobile Tyre Fitting', 'GOAL: calls', 'URL: https://localtyres.co.uk/', 'LOCATION: Wigan', 'COUNTRY: GB', 'LANGUAGE: en', 'BUDGET: 20', 'CURRENCY: £', 'H: Mobile Tyre Fitting', 'H: Local Tyres Wigan', 'H: Tyres At Your Home', 'D: Mobile tyre fitting at your home across Wigan.', 'D: Find tyres for your car and arrange a fitting.', 'K: "mobile tyre fitting"', 'N: jobs'].join('\n');
const baseBinding = { clientId: 'chrome-client-fixture-0001', tabId: 17, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0' };
const owner = () => `owner-${randomUUID()}`;
let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createChromeExtensionControl>>;
let clock = Date.parse('2026-11-15T12:00:00.000Z');
const chats: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];
beforeAll(async () => {
  database = await createDatabase();
  await migrate(database.db);
  await sql`CREATE TABLE "user" (id text PRIMARY KEY)`.execute(database.db);
  control = await createChromeExtensionControl(database.db, { now: () => clock });
});
afterAll(async () => { await Promise.all(chats.map(chat => chat.shutdown())); await database?.close(); });
async function freshOwner(paired = true) {
  const id = owner();
  await database.db.insertInto('user').values({ id }).execute();
  if (paired) await control.heartbeat(id, baseBinding);
  return id;
}

describe('persistent Chrome bridge', () => {
  it('queues a bounded campaign once, claims once, and rejects replayed results', async () => {
    const id = await freshOwner();
    const queued = await control.queueCampaign(id, lines, 'same-chat-run');
    expect(queued).toMatchObject({ status: 'queued', leaseId: null, customerId: baseBinding.customerId, campaign: { type: 'search', currency: 'GBP', dailyBudget: '20' } });
    expect((await control.queueCampaign(id, lines, 'same-chat-run')).id).toBe(queued.id);
    await expect(control.queueCampaign(id, lines, 'another-run')).rejects.toMatchObject({ code: 'CHROME_JOB_BUSY' });
    const [first, second] = await Promise.all([control.claim(id, { clientId: baseBinding.clientId }), control.claim(id, { clientId: baseBinding.clientId })]);
    const job = first.job ?? second.job!;
    expect([first.job, second.job].filter(Boolean)).toHaveLength(1);
    const result = { clientId: baseBinding.clientId, leaseId: job.leaseId!, status: 'awaiting_review', message: 'Stopped at review before publication.', steps: [{ stage: 'budget', message: 'Verified daily budget', fields: ['dailyBudget'] }] };
    expect((await control.result(id, job.id, result)).latestJob?.status).toBe('awaiting_review');
    await expect(control.result(id, job.id, result)).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
    const restarted = await createChromeExtensionControl(database.db, { now: () => clock });
    expect((await restarted.status(id)).latestJob?.id).toBe(job.id);
    expect((await restarted.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
  });

  it('isolates owners, pins the target, and refuses a foreign lease or account currency', async () => {
    const a = await freshOwner(), b = await freshOwner();
    const job = await control.queueCampaign(a, lines, 'owned');
    expect((await control.status(b)).latestJob).toBeNull();
    expect((await control.claim(b, { clientId: baseBinding.clientId })).job).toBeNull();
    await expect(control.cancel(b, job.id)).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    await expect(control.heartbeat(a, { ...baseBinding, tabId: 18 })).rejects.toMatchObject({ code: 'CHROME_TARGET_BUSY' });
    await expect(control.queueCampaign(b, lines.replace('CURRENCY: £', 'CURRENCY: USD'), 'wrong-currency')).rejects.toMatchObject({ code: 'CHROME_CURRENCY_MISMATCH' });
    const claimed = (await control.claim(a, { clientId: baseBinding.clientId })).job!;
    await expect(control.result(b, job.id, { clientId: baseBinding.clientId, leaseId: claimed.leaseId, status: 'stopped', message: 'stop', steps: [] })).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    await expect(control.result(a, job.id, { clientId: baseBinding.clientId, leaseId: randomUUID(), status: 'stopped', message: 'stop', steps: [] })).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
  });

  it('never replays a stale running job after reconnecting', async () => {
    const id = await freshOwner();
    await control.queueCampaign(id, lines, 'stale-run');
    const job = (await control.claim(id, { clientId: baseBinding.clientId })).job!;
    clock += 90_001;
    expect(await control.status(id)).toMatchObject({ connected: false, latestJob: { status: 'needs_attention' } });
    await control.heartbeat(id, baseBinding);
    expect((await control.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
    await expect(control.result(id, job.id, { clientId: baseBinding.clientId, leaseId: job.leaseId, status: 'awaiting_review', message: 'late', steps: [] })).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
  });

  it('expires an execution lease even while heartbeats remain fresh', async () => {
    const id = await freshOwner();
    await control.queueCampaign(id, lines, 'lease');
    await control.claim(id, { clientId: baseBinding.clientId });
    for (let tick = 0; tick < 11; tick++) { clock += 60_000; await control.heartbeat(id, baseBinding); }
    expect((await control.status(id)).latestJob?.status).toBe('needs_attention');
    expect((await control.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
  });

  it('cancels queued work and invalidates running work without claiming it was undone', async () => {
    const id = await freshOwner();
    const queued = await control.queueCampaign(id, lines, 'queued');
    expect((await control.cancel(id, queued.id)).latestJob?.status).toBe('stopped');
    expect((await control.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
    clock++;
    const next = await control.queueCampaign(id, lines, 'running');
    const running = (await control.claim(id, { clientId: baseBinding.clientId })).job!;
    const stopped = await control.cancel(id, next.id);
    expect(stopped.latestJob?.status).toBe('needs_attention');
    expect(stopped.latestJob?.message).toContain('قد تكون');
    await expect(control.result(id, next.id, { clientId: baseBinding.clientId, leaseId: running.leaseId, status: 'awaiting_review', message: 'late', steps: [] })).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
  });

  it('keeps explicit disconnection and API choice from being undone by old heartbeats', async () => {
    const id = await freshOwner();
    await control.disconnect(id, { clientId: baseBinding.clientId });
    await expect(control.heartbeat(id, baseBinding)).rejects.toMatchObject({ code: 'CHROME_CONNECTION_REVOKED' });
    expect(await control.status(id)).toMatchObject({ connected: false, preferredTransport: 'chrome' });
    const reconnected = { ...baseBinding, clientId: 'chrome-client-fixture-new' };
    await control.heartbeat(id, reconnected);
    await control.preference(id, { transport: 'api' });
    await expect(control.heartbeat(id, reconnected)).rejects.toMatchObject({ code: 'CHROME_CONNECTION_REVOKED' });
    expect(await control.status(id)).toMatchObject({ connected: false, preferredTransport: 'api' });
  });

  it('resumes only explicitly reviewed work with the same binding and a new one-shot lease', async () => {
    const id = await freshOwner(), foreign = await freshOwner();
    const queued = await control.queueCampaign(id, lines, 'resumable');
    const first = (await control.claim(id, { clientId: baseBinding.clientId })).job!;
    const reported = { clientId: baseBinding.clientId, leaseId: first.leaseId!, status: 'needs_attention', message: 'Inspect conversion choice.', steps: [{ stage: 'goal', message: 'Goal selected', fields: ['goal'] }] };
    await control.result(id, queued.id, reported);
    await expect(control.resume(foreign, queued.id, { clientId: baseBinding.clientId })).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    await expect(control.resume(id, queued.id, { clientId: 'other-client-fixture-00001' })).rejects.toMatchObject({ code: 'CHROME_BINDING_CHANGED' });
    const resumed = await control.resume(id, queued.id, { clientId: baseBinding.clientId });
    expect(resumed.latestJob).toMatchObject({ id: queued.id, status: 'queued', leaseId: null, steps: reported.steps });
    await expect(control.resume(id, queued.id, { clientId: baseBinding.clientId })).rejects.toMatchObject({ code: 'CHROME_RESUME_INVALID' });
    const second = (await control.claim(id, { clientId: baseBinding.clientId })).job!;
    expect(second.leaseId).not.toBe(first.leaseId);
    await expect(control.result(id, queued.id, reported)).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
    await control.result(id, queued.id, { ...reported, leaseId: second.leaseId, status: 'awaiting_review' });
    await expect(control.resume(id, queued.id, { clientId: baseBinding.clientId })).rejects.toMatchObject({ code: 'CHROME_RESUME_INVALID' });
  });
});

describe('Chrome campaign chat continuation', () => {
  async function createChat(id: string, askFirst: boolean, options: { queue?: typeof control.queueCampaign; wait?: boolean } = {}) {
    const createPaused = vi.fn(async () => { throw new Error('API fallback must never be used'); });
    let calls = 0;
    const brief: AdsBrief = { url: 'https://localtyres.co.uk/', service: null, serviceChoices: [], locations: ['Wigan'], country: 'GB', budget: { amount: '20', currency: '£', period: 'day' }, goal: null, asked: ['service', 'goal'], rounds: 1 };
    const chat = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: 'unused' }, chromeExtension: { ...control, queueCampaign: options.queue ?? control.queueCampaign }, recordExperiences: false,
      browser: { setCheckpointStore() {}, bindAccount: async () => {}, hasPage: async () => false, close: async () => {} } as unknown as AgentBrowser,
      tools: { ads: { createPaused } } as any,
      adsModel: { handle: async () => ++calls === 1 && askFirst ? { status: 'waiting_user', text: 'ما الخدمة والهدف؟', brief, fields: [{ id: 'service', prompt: 'الخدمة', suggestions: [{ label: 'Mobile Tyre Fitting' }] }] } : { status: 'completed', text: 'حملة مكتملة محليًا', campaign: lines } },
    });
    chats.push(chat);
    const conversation = await chat.create(id, { goal: 'make ads for localtyres.co.uk in Wigan, £20 a day' });
    if (options.wait !== false) await chat.settled(conversation.id);
    return { chat, conversation, createPaused, count: () => calls };
  }
  it('queues automatically after the question-card answer without API sign-in or account-created claims', async () => {
    const id = await freshOwner();
    const { chat, conversation, createPaused } = await createChat(id, true);
    expect((await chat.detail(id, conversation.id)).status).toBe('waiting_user');
    await chat.send(id, conversation.id, { text: '1. Mobile Tyre Fitting\n2. calls' });
    await chat.settled(conversation.id);
    const detail = await chat.detail(id, conversation.id);
    expect(detail.status).toBe('idle');
    expect(detail.messages.at(-1)?.text).toContain('أُرسلت الحملة إلى إضافة Chrome');
    expect(detail.messages.at(-1)?.text).not.toContain('أُنشئت الحملة في حسابك');
    expect((await control.status(id)).latestJob?.status).toBe('queued');
    expect(createPaused).not.toHaveBeenCalled();
  });
  it('waits for selected but disconnected Chrome and resumes the saved campaign without API fallback', async () => {
    const id = await freshOwner(false);
    await control.preference(id, { transport: 'chrome' });
    const { chat, conversation, createPaused, count } = await createChat(id, false);
    let detail = await chat.detail(id, conversation.id);
    expect(detail.status).toBe('waiting_user');
    expect(detail.question?.options.some(option => option.id === 'chrome_retry')).toBe(true);
    // The owner sees the draft before being asked to connect Chrome, once.
    expect(detail.messages.at(-1)?.text).toContain('حملة مكتملة محليًا');
    await chat.respond(id, conversation.id, { questionId: detail.question!.id, optionId: 'chrome_retry' });
    await chat.settled(conversation.id);
    detail = await chat.detail(id, conversation.id);
    expect(detail.status).toBe('waiting_user');
    expect(detail.messages.at(-1)?.text).not.toContain('حملة مكتملة محليًا');
    await control.heartbeat(id, baseBinding);
    await chat.respond(id, conversation.id, { questionId: detail.question!.id, optionId: 'chrome_retry' });
    await chat.settled(conversation.id);
    expect((await control.status(id)).latestJob?.status).toBe('queued');
    detail = await chat.detail(id, conversation.id);
    expect(detail.messages.at(-1)?.text).toContain('أُرسلت الحملة إلى إضافة Chrome');
    expect(detail.messages.filter(message => message.text.includes('حملة مكتملة محليًا'))).toHaveLength(1);
    expect(count()).toBe(1);
    expect(createPaused).not.toHaveBeenCalled();
  });
  it('preserves requested currency in the campaign text', () => {
    const brief: AdsBrief = { url: 'https://localtyres.co.uk/', service: 'Tyres', serviceChoices: [], locations: ['Wigan'], country: 'GB', budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls', asked: [], rounds: 0 };
    const output = campaignLines(brief, { business: 'Local Tyres', headlines: ['One', 'Two', 'Three'], descriptions: ['One', 'Two'], keywords: ['tyres'] } as any, { url: brief.url!, host: 'localtyres.co.uk' });
    expect(output).toContain('CURRENCY: £');
  });
  it('does not enqueue after cancellation between the chat check and the queue transaction', async () => {
    const id = await freshOwner();
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue: typeof control.queueCampaign = async (...args) => { reached(); await gate; return control.queueCampaign(...args); };
    const { chat, conversation } = await createChat(id, false, { queue, wait: false });
    await entered;
    await chat.cancel(id, conversation.id);
    release();
    await chat.settled(conversation.id);
    expect((await control.status(id)).latestJob).toBeNull();
    expect((await control.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
    expect((await chat.detail(id, conversation.id)).status).toBe('idle');
  });
  it('cancels already queued or claimed Chrome work in the same transaction as chat cancellation', async () => {
    for (const claimed of [false, true]) {
      const id = await freshOwner();
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const queue: typeof control.queueCampaign = async (...args) => { const job = await control.queueCampaign(...args); reached(); await gate; return job; };
      const { chat, conversation } = await createChat(id, false, { queue, wait: false });
      await entered;
      const running = claimed ? (await control.claim(id, { clientId: baseBinding.clientId })).job! : null;
      await chat.cancel(id, conversation.id);
      release();
      await chat.settled(conversation.id);
      expect((await control.status(id)).latestJob?.status).toBe(claimed ? 'needs_attention' : 'stopped');
      expect((await control.claim(id, { clientId: baseBinding.clientId })).job).toBeNull();
      if (running) await expect(control.result(id, running.id, { clientId: baseBinding.clientId, leaseId: running.leaseId, status: 'awaiting_review', message: 'late', steps: [] })).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
    }
  });
});

it('registers every Chrome route behind the existing session, owner and origin gates', async () => {
  const secret = 'chrome-fixture-internal-0000000000001', origin = 'http://127.0.0.1:3000', setupToken = 'chrome-fixture-setup-000000000000001';
  const app = await createApplication({ authSecret: 'chrome-fixture-auth-secret-0000000001', internalSecret: secret, setupToken, webOrigin: origin, production: false, runWorker: false, testRequestLimit: 2000 });
  try {
    const headers = { 'x-mohassan-internal': secret, origin };
    const account = { name: 'Owner', email: 'chrome@example.test', password: 'Chrome-fixture-password-42' };
    await app.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { ...account, setupToken } });
    const login = await app.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: account });
    const cookie = [login.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    for (const [method, url, payload] of [
      ['GET', '/api/chrome-extension/status', undefined], ['POST', '/api/chrome-extension/heartbeat', baseBinding], ['POST', '/api/chrome-extension/preference', { transport: 'chrome' }], ['POST', '/api/chrome-extension/disconnect', { clientId: baseBinding.clientId }], ['POST', '/api/chrome-extension/jobs/claim', { clientId: baseBinding.clientId }], ['POST', `/api/chrome-extension/jobs/${randomUUID()}/result`, {}], ['POST', `/api/chrome-extension/jobs/${randomUUID()}/cancel`, {}], ['POST', `/api/chrome-extension/jobs/${randomUUID()}/resume`, { clientId: baseBinding.clientId }],
    ] as const) {
      expect((await app.app.inject({ method, url, headers, ...(payload ? { payload } : {}) })).statusCode, url).toBe(401);
    }
    expect((await app.app.inject({ method: 'POST', url: '/api/chrome-extension/heartbeat', headers: { ...headers, cookie, origin: 'https://untrusted.example' }, payload: baseBinding })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url: '/api/chrome-extension/heartbeat', headers: { ...headers, cookie }, payload: baseBinding })).statusCode).toBe(200);
    expect((await app.app.inject({ url: '/api/chrome-extension/status', headers: { ...headers, cookie } })).json().connected).toBe(true);
    const user = await app.database.db.selectFrom('user').select('id').where('email', '=', account.email).executeTakeFirstOrThrow();
    await app.database.db.updateTable('workspace_owner').set({ owner_id: null }).where('id', '=', 1).execute();
    await app.database.db.insertInto('workspace_members').values({ user_id: user.id, role: 'member' }).onConflict(oc => oc.column('user_id').doUpdateSet({ role: 'member' })).execute();
    expect((await app.app.inject({ url: '/api/chrome-extension/status', headers: { ...headers, cookie } })).statusCode).toBe(403);
    expect((await app.app.inject({ method: 'POST', url: '/api/chrome-extension/heartbeat', headers: { ...headers, cookie }, payload: baseBinding })).statusCode).toBe(403);
  } finally { await app.app.close(); }
});
