import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { chromium, type BrowserContext } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDatabase } from '../packages/database/src/index.js';
import { createChromeExtensionControl, registerChromeExtensionRoutes } from '../apps/server/src/chrome-extension.js';

const ownerId = 'extension-transport-fixture-owner';
const lines = [
  'BUSINESS: Example Movers', 'SERVICE: House removals', 'GOAL: leads',
  'URL: https://example.com/removals', 'LOCATION: Glasgow', 'COUNTRY: GB', 'LANGUAGE: en',
  'BUDGET: 20', 'CURRENCY: GBP', 'H: House Removals Glasgow', 'H: Local Moving Team',
  'H: Plan Your House Move', 'D: Local house removals in Glasgow with a careful moving team.',
  'D: Get in touch to discuss your house move and request a quote.', 'K: "house removals glasgow"',
].join('\n');

describe('installed Chrome extension through the real queue and browser relay', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it('pairs exact tabs for inspection and refuses new or cached campaign edits', async () => {
    const database = await createDatabase({});
    cleanup.push(() => database.close());
    await database.db.schema.createTable('user').addColumn('id', 'text', column => column.primaryKey()).execute();
    await database.db.insertInto('user').values({ id: ownerId }).execute();
    const control = await createChromeExtensionControl(database.db);
    const app = Fastify({ logger: false });
    cleanup.push(() => app.close());
    let origin = '', disconnectUnavailable = false;
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      if (request.headers.cookie !== 'fixture-session=owner') return reply.code(401).send({ error: { message: 'Fixture sign-in required' } });
      if (request.method !== 'GET' && request.headers.origin !== origin) return reply.code(403).send({ error: { message: 'Fixture origin mismatch' } });
      if (disconnectUnavailable && request.url.endsWith('/disconnect')) return reply.code(503).send({ error: { message: 'Fixture server unavailable during stop' } });
    });
    app.setErrorHandler((error: any, _request, reply) => reply.code(error.statusCode ?? 400).send({ error: { message: error.message } }));
    registerChromeExtensionRoutes(app, { control, owner: async () => ({ id: ownerId }) });
    app.get('/', async (_request, reply) => reply.type('text/html').send('<!doctype html><html lang="ar"><body><h1>موحسن — اختبار معزول</h1></body></html>'));
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    expect((await fetch(`${origin}/api/chrome-extension/status`)).status).toBe(401);

    const parent = await realpath(tmpdir());
    const directory = await mkdtemp(join(parent, 'mohassan-chrome-transport-'));
    const canonical = await realpath(directory);
    cleanup.push(async () => {
      if (dirname(directory) !== parent || !basename(directory).startsWith('mohassan-chrome-transport-') || await realpath(directory) !== canonical) throw new Error('Unexpected test cleanup path');
      await rm(directory, { recursive: true, force: false, maxRetries: 4, retryDelay: 200 });
    });
    const extension = join(directory, 'extension');
    await cp(resolve('packages/chrome-extension'), extension, { recursive: true });
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    // Only the disposable test copy grants its fixture origin without a native permission prompt.
    // The shipped manifest keeps Mohassan origins optional and asks the owner normally.
    manifest.host_permissions.push(`${origin}/*`);
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    const context: BrowserContext = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    cleanup.push(() => context.close());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const unexpectedTraffic: string[] = [];
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.origin === 'https://ads.google.com') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><header>123-456-7890 · GBP</header><main><h1>Create a new campaign</h1><h2>Select your campaign objective</h2><button>Leads</button></main></body></html>' });
      unexpectedTraffic.push(url.origin);
      return route.abort();
    });
    await context.addCookies([{ name: 'fixture-session', value: 'owner', url: origin, sameSite: 'Lax', httpOnly: true }]);
    const appPage = await context.newPage();
    await appPage.goto(origin);
    const adsPage = await context.newPage();
    await adsPage.goto('https://ads.google.com/aw/campaigns/new/search');
    const tabs: any[] = await worker.evaluate(() => (globalThis as any).chrome.tabs.query({}));
    const appTab = tabs.find(tab => tab.url === `${origin}/`);
    const adsTab = tabs.find(tab => tab.url?.startsWith('https://ads.google.com/aw/campaigns/new'));
    expect(appTab?.id).toBeTypeOf('number');
    expect(adsTab?.id).toBeTypeOf('number');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const send = (message: object) => popup.evaluate(value => (globalThis as any).chrome.runtime.sendMessage(value), message);
    expect(await send({ kind: 'pair-app', tabId: appTab.id, origin })).toMatchObject({ ok: true });
    expect(await send({ kind: 'pair-ads', tabId: adsTab.id, customerId: '1234567890', currency: 'GBP' })).toMatchObject({ ok: true });
    expect(await control.status(ownerId)).toMatchObject({ connected: true, preferredTransport: 'chrome' });

    // Even a recognized wizard with autosave-capable inputs is observation-only.
    await adsPage.setContent('<!doctype html><html><body><header>123-456-7890 · GBP</header><main><h1>Budget</h1><label>Average daily budget<input value="7" oninput="document.body.dataset.mutated=\'yes\'"></label><button onclick="document.body.dataset.mutated=\'yes\'">Next</button><button onclick="document.body.dataset.published=\'yes\'">Publish campaign</button></main></body></html>');
    await expect(control.queueCampaign(ownerId, lines, 'transport-fixture-campaign')).rejects.toMatchObject({ code: 'GOOGLE_ADS_TYPED_API_REQUIRED' });
    expect((await control.status(ownerId)).latestJob).toBeNull();
    const bound = (await control.status(ownerId)).binding!;
    const campaign = { campaignName: 'Example Movers - House removals', goal: 'leads', type: 'search', customerId: bound.customerId, currency: bound.currency, dailyBudget: '20', locations: ['Glasgow'], countryCode: 'GB', adLanguage: 'en', keywords: ['"house removals glasgow"'], negativeKeywords: [], headlines: ['House Removals Glasgow', 'Local Moving Team', 'Plan Your House Move'], descriptions: ['Local house removals in Glasgow with a careful moving team.', 'Get in touch to discuss your house move and request a quote.'], finalUrl: 'https://example.com/removals', paths: [] };
    const jobId = randomUUID(), leaseId = randomUUID(), at = new Date();
    // Simulate a job and worker journal left behind by a pre-policy deployment.
    await database.db.insertInto('chrome_extension_jobs').values({ id: jobId, owner_id: ownerId, idempotency_key: 'legacy-transport-fixture', source_run_id: null, client_id: bound.clientId, tab_id: bound.tabId, customer_id: bound.customerId, currency: bound.currency, status: 'running', lease_id: leaseId, lease_expires_at: new Date(Date.now() + 600000), campaign: JSON.stringify(campaign), message: 'Legacy fixture only', steps: '[]', created_at: at, updated_at: at }).execute();
    await worker.evaluate(async ({ jobId, leaseId }) => {
      const chrome = (globalThis as any).chrome;
      const state = (await chrome.storage.local.get('mohassan-bridge-v1'))['mohassan-bridge-v1'];
      await chrome.storage.local.set({ 'mohassan-bridge-v1': { ...state, journal: { job: { id: jobId, leaseId }, steps: [], progress: { done: [], snapshots: {} } }, checkpoint: { jobId, leaseId } } });
    }, { jobId, leaseId });
    // The installed relay ticks every five seconds. No adapter step is dispatched.
    await expect.poll(async () => (await send({ kind: 'popup-status' }))?.data?.journal, { timeout: 15000, interval: 300 }).toBeNull();
    const held = (await control.status(ownerId)).latestJob!;
    expect(held).toMatchObject({ id: jobId, status: 'needs_attention', leaseId: null });
    expect(held.message).toContain('قد تكون');
    expect(await control.claim(ownerId, { clientId: bound.clientId })).toEqual({ job: null });
    const resumed = await send({ kind: 'resume' });
    expect(resumed.ok).toBe(false);
    await expect(control.resume(ownerId, jobId, { clientId: bound.clientId })).rejects.toMatchObject({ code: 'GOOGLE_ADS_TYPED_API_REQUIRED' });
    expect(await adsPage.getByLabel('Average daily budget').inputValue()).toBe('7');
    expect(await adsPage.locator('body').getAttribute('data-mutated')).toBeNull();
    expect(await adsPage.locator('body').getAttribute('data-published')).toBeNull();
    expect(unexpectedTraffic).toEqual([]);
    await mkdir(resolve('artifacts/chrome-extension'), { recursive: true });
    await popup.reload();
    await popup.setViewportSize({ width: 380, height: 900 });
    await popup.screenshot({ path: resolve('artifacts/chrome-extension/popup-test.png'), fullPage: true });
    disconnectUnavailable = true;
    expect(await send({ kind: 'stop' })).toMatchObject({ ok: true });
    const stored = await worker.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('mohassan-bridge-v1'))['mohassan-bridge-v1']);
    expect(stored).toMatchObject({ binding: null, journal: null, checkpoint: null });
    expect(await worker.evaluate(() => (globalThis as any).chrome.alarms.get('mohassan-bridge'))).toBeUndefined();
    // The fixture deliberately lost the remote acknowledgement; local revocation is still durable.
    expect((await control.status(ownerId)).connected).toBe(true);
    await control.disconnect(ownerId, { clientId: bound.clientId });
    expect((await control.status(ownerId)).connected).toBe(false);
  }, 90000);
});
