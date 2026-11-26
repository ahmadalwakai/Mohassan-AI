import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createDatabase, migrate } from '@mohassan/database';
import type { AgentBrowser } from '@mohassan/browser';
import { createChromeExtensionControl } from '../apps/server/src/chrome-extension.js';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { createApplication } from '../apps/server/src/app.js';
import { campaignLines, type AdsBrief } from '../apps/server/src/assistant/ads-model-chat.js';

const lines = ['BUSINESS: Local Tyres', 'SERVICE: Mobile Tyre Fitting', 'GOAL: calls', 'URL: https://localtyres.co.uk/', 'LOCATION: Wigan', 'COUNTRY: GB', 'LANGUAGE: en', 'BUDGET: 20', 'CURRENCY: £', 'H: Mobile Tyre Fitting', 'H: Local Tyres Wigan', 'H: Tyres At Your Home', 'D: Mobile tyre fitting at your home across Wigan.', 'D: Find tyres for your car and arrange a fitting.', 'K: "mobile tyre fitting"', 'N: jobs'].join('\n');
const baseBinding = { clientId: 'chrome-client-fixture-0001', tabId: 17, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0' };
const legacyCampaign = { campaignName: 'Local Tyres - Mobile Tyre Fitting', goal: 'calls', type: 'search', customerId: baseBinding.customerId, currency: 'GBP', dailyBudget: '20', locations: ['Wigan'], countryCode: 'GB', adLanguage: 'en', keywords: ['"mobile tyre fitting"'], negativeKeywords: ['jobs'], headlines: ['Mobile Tyre Fitting', 'Local Tyres Wigan', 'Tyres At Your Home'], descriptions: ['Mobile tyre fitting at your home across Wigan.', 'Find tyres for your car and arrange a fitting.'], finalUrl: 'https://localtyres.co.uk/', paths: [] };
const owner = () => `owner-${randomUUID()}`;
let database: Awaited<ReturnType<typeof createDatabase>>;
let control: Awaited<ReturnType<typeof createChromeExtensionControl>>;
let clock = Date.parse('2026-11-15T12:00:00.000Z');
const chats: Awaited<ReturnType<typeof createCommandChatControl>>[] = [];
beforeAll(async () => {
  database = await createDatabase({});
  await migrate(database.db);
  await sql`CREATE TABLE "user" (id text PRIMARY KEY)`.execute(database.db);
  control = await createChromeExtensionControl(database.db, { now: () => clock });
});
afterAll(async () => { await Promise.all(chats.map(chat => chat.shutdown())); await database?.close(); });
afterEach(() => vi.restoreAllMocks());
async function freshOwner(paired = true) {
  const id = owner();
  await database.db.insertInto('user').values({ id }).execute();
  if (paired) await control.heartbeat(id, baseBinding);
  return id;
}
// Rows represent jobs persisted by the old implementation, never a new queue bypass.
async function legacyJob(ownerId: string, status: 'queued' | 'running' | 'needs_attention' | 'awaiting_review', sourceRunId: string | null = null) {
  const job = { id: randomUUID(), owner_id: ownerId, source_run_id: sourceRunId, idempotency_key: `legacy-${randomUUID()}`, client_id: baseBinding.clientId, tab_id: baseBinding.tabId, customer_id: baseBinding.customerId, currency: baseBinding.currency, status, lease_id: status === 'running' ? randomUUID() : null, lease_expires_at: status === 'running' ? new Date(clock + 600000) : null, campaign: JSON.stringify(legacyCampaign), message: 'Legacy test fixture; not externally verified', steps: JSON.stringify([{ stage: 'budget', message: 'Old local field receipt', fields: ['dailyBudget'] }]), created_at: new Date(++clock), updated_at: new Date(clock) };
  await database.db.insertInto('chrome_extension_jobs').values(job).execute();
  return job;
}

describe('persistent read-only Chrome bridge', () => {
  it('requires an authenticated owner before denying queue access', async () => {
    await expect(control.queueCampaign('missing-owner', lines, 'attempt')).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
  });

  it('never queues or replays an Ads draft even with a Chrome binding, source lease or duplicate key', async () => {
    const id = await freshOwner();
    const old = await legacyJob(id, 'queued');
    for (const key of [old.idempotency_key, 'new-request']) await expect(control.queueCampaign(id, lines, key, { runId: randomUUID(), leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'GOOGLE_ADS_TYPED_API_REQUIRED' });
    expect(await database.db.selectFrom('chrome_extension_jobs').select('id').where('owner_id', '=', id).execute()).toEqual([{ id: old.id }]);
    expect((await control.status(id)).latestJob).toMatchObject({ id: old.id, status: 'stopped', leaseId: null });
  });

  it('does not grant authority from a disconnected connection or a currency mismatch', async () => {
    const id = await freshOwner(false);
    await expect(control.queueCampaign(id, lines.replace('CURRENCY: £', 'CURRENCY: USD'), 'different-currency')).rejects.toMatchObject({ code: 'GOOGLE_ADS_TYPED_API_REQUIRED' });
    expect((await control.status(id)).latestJob).toBeNull();
  });

  it('retires persisted jobs on startup and never claims either old queue or old running work', async () => {
    const a = await freshOwner(), b = await freshOwner();
    const queued = await legacyJob(a, 'queued'), running = await legacyJob(b, 'running');
    const restarted = await createChromeExtensionControl(database.db, { now: () => clock });
    expect((await restarted.status(a)).latestJob).toMatchObject({ id: queued.id, status: 'stopped', leaseId: null });
    const held = (await restarted.status(b)).latestJob!;
    expect(held).toMatchObject({ id: running.id, status: 'needs_attention', leaseId: null });
    expect(held.message).toContain('قد تكون');
    expect(held.steps).toHaveLength(1);
    expect(await Promise.all([restarted.claim(a, { clientId: baseBinding.clientId }), restarted.claim(b, { clientId: baseBinding.clientId })])).toEqual([{ job: null }, { job: null }]);
    expect((await database.db.selectFrom('chrome_extension_jobs').select('lease_expires_at').where('id', '=', running.id).executeTakeFirstOrThrow()).lease_expires_at).toBeNull();
  });

  it('retires a late legacy queue on claim and running work on heartbeat or status', async () => {
    for (const method of ['claim', 'heartbeat', 'status'] as const) {
      const id = await freshOwner();
      const old = await legacyJob(id, method === 'claim' ? 'queued' : 'running');
      if (method === 'claim') expect(await control.claim(id, { clientId: baseBinding.clientId })).toEqual({ job: null });
      else if (method === 'heartbeat') await control.heartbeat(id, baseBinding);
      else await control.status(id);
      expect((await control.status(id)).latestJob).toMatchObject({ id: old.id, status: method === 'claim' ? 'stopped' : 'needs_attention', leaseId: null });
    }
  });

  it('rejects resumed and late results without marking an old page edit saved', async () => {
    const id = await freshOwner();
    const old = await legacyJob(id, 'running');
    await expect(control.result(id, old.id, { clientId: baseBinding.clientId, leaseId: old.lease_id, status: 'awaiting_review', message: 'Local toast only', steps: [] })).rejects.toMatchObject({ code: 'CHROME_RESULT_STALE' });
    await expect(control.resume(id, old.id, { clientId: baseBinding.clientId })).rejects.toMatchObject({ code: 'GOOGLE_ADS_TYPED_API_REQUIRED' });
    expect((await control.status(id)).latestJob).toMatchObject({ id: old.id, status: 'needs_attention', leaseId: null });
    expect(await control.claim(id, { clientId: baseBinding.clientId })).toEqual({ job: null });
  });

  it('isolates owner history, cancellation and resume', async () => {
    const a = await freshOwner(), b = await freshOwner();
    const old = await legacyJob(a, 'needs_attention');
    expect((await control.status(b)).latestJob).toBeNull();
    expect(await control.claim(b, { clientId: baseBinding.clientId })).toEqual({ job: null });
    await expect(control.cancel(b, old.id)).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    await expect(control.resume(b, old.id, { clientId: baseBinding.clientId })).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    await expect(control.result(b, old.id, { clientId: baseBinding.clientId, leaseId: randomUUID(), status: 'stopped', message: 'stop', steps: [] })).rejects.toMatchObject({ code: 'CHROME_JOB_NOT_FOUND' });
    expect((await control.cancel(a, old.id)).latestJob?.status).toBe('needs_attention');
  });

  it('keeps cancellation of legacy queued and running work honest and repeatable', async () => {
    for (const status of ['queued', 'running'] as const) {
      const id = await freshOwner(), old = await legacyJob(id, status);
      const cancelled = await control.cancel(id, old.id);
      expect(cancelled.latestJob).toMatchObject({ id: old.id, status: status === 'queued' ? 'stopped' : 'needs_attention', leaseId: null });
      if (status === 'running') expect(cancelled.latestJob?.message).toContain('قد تكون');
      expect((await control.cancel(id, old.id)).latestJob).toEqual(cancelled.latestJob);
    }
  });

  it('preserves connection reads, expiry and explicit revocation', async () => {
    const id = await freshOwner();
    expect(await control.status(id)).toMatchObject({ connected: true, binding: baseBinding, preferredTransport: 'chrome' });
    clock += 90001;
    expect((await control.status(id)).connected).toBe(false);
    await control.heartbeat(id, baseBinding);
    await control.disconnect(id, { clientId: baseBinding.clientId });
    await expect(control.heartbeat(id, baseBinding)).rejects.toMatchObject({ code: 'CHROME_CONNECTION_REVOKED' });
    const reconnected = { ...baseBinding, clientId: 'chrome-client-fixture-new' };
    await control.heartbeat(id, reconnected);
    await control.preference(id, { transport: 'api' });
    await expect(control.heartbeat(id, reconnected)).rejects.toMatchObject({ code: 'CHROME_CONNECTION_REVOKED' });
    expect(await control.status(id)).toMatchObject({ connected: false, preferredTransport: 'api' });
  });
});

describe('Chrome preference cannot bypass the typed campaign path', () => {
  async function createChat(id: string, typed = false, askFirst = false) {
    const queue = vi.spyOn(control, 'queueCampaign');
    const createPaused = vi.fn(async () => { throw new Error('Legacy direct mutation must never be used'); });
    const account = vi.fn(async () => { throw new Error('Fixture typed account inspection blocked'); });
    let calls = 0;
    const brief: AdsBrief = { url: 'https://localtyres.co.uk/', service: null, serviceChoices: [], locations: ['Wigan'], country: 'GB', budget: { amount: '20', currency: '£', period: 'day' }, goal: null, asked: ['service', 'goal'], rounds: 1 };
    const chat = await createCommandChatControl(database.db, {
      models: { fast: [], deep: [], vision: 'unused' }, chromeExtension: control, recordExperiences: false,
      browser: { setCheckpointStore() {}, bindAccount: async () => {}, hasPage: async () => false, dropHeld: async () => {}, close: async () => {} } as unknown as AgentBrowser,
      ...(typed ? { tools: { ads: { createPaused, connection: async () => ({ state: 'connected', account: baseBinding.customerId }), campaign: { account } } } as any } : {}),
      adsModel: { handle: async () => ++calls === 1 && askFirst ? { status: 'waiting_user', text: 'ما الخدمة والهدف؟', brief, fields: [{ id: 'service', prompt: 'الخدمة', suggestions: [{ label: 'Mobile Tyre Fitting' }] }, { id: 'goal', prompt: 'الهدف', suggestions: [{ label: 'calls' }] }] } : { status: 'completed', text: 'حملة مكتملة محليًا', campaign: lines } },
    });
    chats.push(chat);
    const conversation = await chat.create(id, { goal: 'Create a paused Google Ads campaign for Mobile Tyre Fitting in Wigan; URL: https://localtyres.co.uk/; goal: calls; budget GBP 20 per day.' });
    await chat.settled(conversation.id);
    return { chat, conversation, queue, createPaused, account };
  }

  it('reports the absent typed integration honestly even when Chrome is connected', async () => {
    const id = await freshOwner();
    const { chat, conversation, queue } = await createChat(id);
    const detail = await chat.detail(id, conversation.id);
    expect(detail.status).toBe('idle');
    expect(detail.messages.at(-1)?.text).toContain('لم تُنشأ حملة');
    expect(detail.messages.at(-1)?.text).toContain('الربط الرسمي');
    expect(queue).not.toHaveBeenCalled();
    expect((await control.status(id)).latestJob).toBeNull();
    queue.mockRestore();
  });

  it('uses typed account inspection rather than Chrome or the legacy mutation function', async () => {
    const id = await freshOwner();
    const { chat, conversation, queue, account, createPaused } = await createChat(id, true);
    const detail = await chat.detail(id, conversation.id);
    expect(account).toHaveBeenCalled();
    expect(createPaused).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(detail.messages.at(-1)?.text).toContain('توقفت قبل الكتابة');
    expect((await control.status(id)).latestJob).toBeNull();
    queue.mockRestore();
  });

  it('continues an actual question answer to the typed-integration blocker without queueing', async () => {
    const id = await freshOwner();
    const { chat, conversation, queue } = await createChat(id, false, true);
    expect((await chat.detail(id, conversation.id)).status).toBe('waiting_user');
    await chat.send(id, conversation.id, { text: '1. Mobile Tyre Fitting\n2. calls' });
    await chat.settled(conversation.id);
    expect((await chat.detail(id, conversation.id)).messages.at(-1)?.text).toContain('لم تُنشأ حملة');
    expect(queue).not.toHaveBeenCalled();
    expect((await control.status(id)).latestJob).toBeNull();
    queue.mockRestore();
  });

  it('cancels legacy Chrome work with the chat without replaying a successful page effect', async () => {
    for (const status of ['queued', 'running'] as const) {
      const id = await freshOwner();
      const { chat, conversation, queue } = await createChat(id, false, true);
      const row = await database.db.selectFrom('chat_conversations').select('active_run_id').where('id', '=', conversation.id).executeTakeFirstOrThrow();
      const old = await legacyJob(id, status, row.active_run_id);
      await chat.cancel(id, conversation.id);
      const persisted = await database.db.selectFrom('chrome_extension_jobs').selectAll().where('id', '=', old.id).executeTakeFirstOrThrow();
      expect(persisted.status).toBe(status === 'queued' ? 'stopped' : 'needs_attention');
      expect((await chat.detail(id, conversation.id)).status).toBe('idle');
      expect(queue).not.toHaveBeenCalled();
      expect(await control.claim(id, { clientId: baseBinding.clientId })).toEqual({ job: null });
      queue.mockRestore();
    }
  });

  it('preserves requested currency in proposal text', () => {
    const brief: AdsBrief = { url: 'https://localtyres.co.uk/', service: 'Tyres', serviceChoices: [], locations: ['Wigan'], country: 'GB', budget: { amount: '20', currency: '£', period: 'day' }, goal: 'calls', asked: [], rounds: 0 };
    expect(campaignLines(brief, { business: 'Local Tyres', headlines: ['One', 'Two', 'Three'], descriptions: ['One', 'Two'], keywords: ['tyres'] } as any, { url: brief.url!, host: 'localtyres.co.uk' })).toContain('CURRENCY: £');
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
