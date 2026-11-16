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

  it('pairs exact tabs, pauses on an unknown screen, then explicitly resumes through review without publishing', async () => {
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

    // Google changes its wizard after pairing. No fixture-only selector is available to the adapter.
    await adsPage.setContent('<!doctype html><html><body><header>123-456-7890 · GBP</header><main><h1>An unfamiliar campaign screen</h1><button onclick="document.body.dataset.published=\'yes\'">Publish campaign</button><input aria-label="Unrecognized setting" value="keep me"></main></body></html>');
    const job = await control.queueCampaign(ownerId, lines, 'transport-fixture-campaign');
    await expect.poll(async () => (await control.status(ownerId)).latestJob?.status, { timeout: 30000, interval: 500 }).toBe('needs_attention');
    const finished = (await control.status(ownerId)).latestJob!;
    expect(finished.id).toBe(job.id);
    expect(finished.steps.length).toBeGreaterThan(0);
    expect(await adsPage.locator('body').getAttribute('data-published')).toBeNull();
    expect(await adsPage.getByLabel('Unrecognized setting').inputValue()).toBe('keep me');
    expect((await control.queueCampaign(ownerId, lines, 'transport-fixture-campaign')).id).toBe(job.id);
    expect(await control.claim(ownerId, { clientId: finished.clientId })).toEqual({ job: null });

    // After inspecting the stopped page, the owner returns to the recognized wizard.
    // Exercise all layers using the actual installed worker, not a mocked Chrome API.
    await expect.poll(async () => (await send({ kind: 'popup-status' }))?.data?.checkpoint?.jobId, { timeout: 5000 }).toBe(job.id);
    await adsPage.evaluate(campaign => {
      const screens = [
        '<h1>Choose your objective</h1><button role="radio" aria-checked="false">Leads</button>',
        '<h1>Select a campaign type</h1><button role="radio" aria-checked="false">Search</button>',
        '<h1>Campaign name</h1><label>Campaign name<input></label>',
        '<h1>Locations</h1><div class="location-chip">Glasgow, United Kingdom</div>',
        '<h1>Languages</h1><label>Languages<select><option value=""></option><option value="en">English</option></select></label>',
        '<h1>Budget</h1><p>GBP</p><label>Average daily budget<input></label>',
        '<h1>Keywords</h1><label>Enter keywords<textarea></textarea></label>',
        '<h1>Ads</h1><label>Final URL<input></label>' + campaign.headlines.map((_, i) => `<label>Headline ${i + 1}<input></label>`).join('') + campaign.descriptions.map((_, i) => `<label>Description ${i + 1}<textarea></textarea></label>`).join(''),
        '<h1>Review your campaign</h1><button id="publish">Publish campaign</button>',
      ];
      let index = 0;
      (window as any).observedFields = {};
      const render = () => {
        document.body.innerHTML = '<header><span class="customer-id">123-456-7890</span></header><main>' + screens[index] + (index < screens.length - 1 ? '<button id="next">Next</button>' : '') + '</main>';
        document.querySelector('[role="radio"]')?.addEventListener('click', event => (event.currentTarget as HTMLElement).setAttribute('aria-checked', 'true'));
        document.getElementById('publish')?.addEventListener('click', () => { document.body.dataset.published = 'yes'; });
        document.getElementById('next')?.addEventListener('click', () => {
          for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')) {
            const name = field.labels?.[0]?.textContent ?? '';
            (window as any).observedFields[name.replace(/English$/, '').trim()] = field.value;
          }
          index += 1; render();
        });
      };
      render();
    }, job.campaign);
    const resume = await appPage.evaluate(async ({ jobId, clientId }) => {
      const response = await fetch(`/api/chrome-extension/jobs/${jobId}/resume`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId }) });
      return response.status;
    }, { jobId: job.id, clientId: finished.clientId });
    expect(resume).toBe(200);
    await expect.poll(async () => {
      const status = (await control.status(ownerId)).latestJob?.status;
      return status === 'queued' || status === 'running' ? 'active' : status;
    }, { timeout: 45000, interval: 500 }).not.toBe('active');
    const reviewed = (await control.status(ownerId)).latestJob!;
    expect(reviewed.status, JSON.stringify({ message: reviewed.message, steps: reviewed.steps })).toBe('awaiting_review');
    expect(reviewed.id).toBe(job.id);
    expect(reviewed.leaseId).not.toBe(finished.leaseId);
    expect(await adsPage.evaluate(() => (window as any).observedFields)).toMatchObject({
      'Campaign name': job.campaign.campaignName, 'Average daily budget': '20',
      'Enter keywords': job.campaign.keywords.join('\n'), 'Final URL': job.campaign.finalUrl,
      'Headline 1': job.campaign.headlines[0], 'Description 2': job.campaign.descriptions[1],
    });
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
    await control.disconnect(ownerId, { clientId: finished.clientId });
    expect((await control.status(ownerId)).connected).toBe(false);
  }, 90000);
});
