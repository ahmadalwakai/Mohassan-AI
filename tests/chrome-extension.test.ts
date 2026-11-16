import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const campaign = { campaignName: 'Leeds Search', type: 'search', goal: 'leads', customerId: '1234567890', currency: 'GBP', dailyBudget: '20', locations: ['Leeds'], countryCode: 'GB', adLanguage: 'en', keywords: ['plumbing leeds', 'local plumber'], negativeKeywords: [], headlines: ['Local Plumbing Services', 'Plumbing in Leeds', 'Contact Our Team'], descriptions: ['Find local plumbing services in Leeds.', 'Visit our website to request more information.'], finalUrl: 'https://example.org/', paths: [] };
const next = '<button type="button" onclick="window.nextClicks=(window.nextClicks||0)+1">Next</button>';
let browser: Browser, source: string;
async function pageFor(content: string, url = 'https://ads.google.com/aw/campaigns/new/search') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<html><body><header><span class="customer-id">123-456-7890</span></header><main>${content}</main></body></html>` }));
  await page.goto(url); await page.addScriptTag({ content: source }); return page;
}
async function step(page: Page, progress: any = { done: [], snapshots: {} }, data = campaign) { return page.evaluate(async ({ campaign, progress }) => (globalThis as any).__mohassanAdsAdapter.step({ campaign, progress }), { campaign: data, progress }); }
describe('Chrome extension Google Ads adapter (isolated fixture, no Google traffic)', () => {
  beforeAll(async () => { source = await readFile('packages/chrome-extension/ads-adapter.js', 'utf8'); browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });
  it('fills and reads back the ad fields, leaving publish untouched', async () => {
    const content = '<h1>Ads</h1><label>Final URL<input></label>' + campaign.headlines.map((_, i) => `<label>Headline ${i + 1}<input></label>`).join('') + campaign.descriptions.map((_, i) => `<label>Description ${i + 1}<textarea></textarea></label>`).join('') + next + '<button onclick="window.published=true">Publish campaign</button>';
    const page = await pageFor(content), result = await step(page);
    expect(result.status).toBe('continue'); expect(result.progress.done).toContain('ads');
    expect(await page.getByLabel('Final URL', { exact: true }).inputValue()).toBe(campaign.finalUrl);
    expect(await page.getByLabel('Headline 1', { exact: true }).inputValue()).toBe(campaign.headlines[0]);
    expect(await page.evaluate(() => [(window as any).nextClicks, (window as any).published])).toEqual([1, undefined]); await page.close();
  });
  it('stops before changing fields on another account or existing campaign', async () => {
    for (const wrong of ['account', 'route']) {
      const page = await pageFor('<h1>Campaign name</h1><label>Campaign name<input></label>' + next, wrong === 'route' ? 'https://ads.google.com/aw/campaigns/edit/12' : undefined);
      if (wrong === 'account') await page.locator('.customer-id').evaluate(node => { node.textContent = '999-999-9999'; });
      expect((await step(page)).status).toBe('needs_attention'); expect(await page.locator('input').inputValue()).toBe(''); await page.close();
    }
  });
  it('preserves a user-entered budget, rejects currency ambiguity, verifies readback', async () => {
    for (const content of [
      '<h1>Budget</h1><p>GBP</p><label>Average daily budget<input value="35"></label>',
      '<h1>Budget</h1><p>USD</p><label>Average daily budget<input></label>',
      '<h1>Budget</h1><p>GBP</p><label>Average daily budget<input oninput="this.value=\'999\'"></label>',
    ]) {
      const page = await pageFor(content + next), result = await step(page);
      expect(result.status).toBe('needs_attention'); expect(await page.evaluate(() => (window as any).nextClicks)).toBeUndefined(); await page.close();
    }
  });
  it('fills daily budget only when the visible account currency matches', async () => {
    const page = await pageFor('<h1>Budget</h1><p>GBP</p><label>Average daily budget<input></label>' + next);
    expect((await step(page)).status).toBe('continue'); expect(await page.locator('input').inputValue()).toBe('20'); await page.close();
  });
  it('reads a native select label without treating its option text as part of the name', async () => {
    const page = await pageFor('<h1>Languages</h1><label>Languages<select><option value="">Choose a language</option><option value="en">English</option></select></label>' + next);
    expect((await step(page)).status).toBe('continue'); expect(await page.locator('select').inputValue()).toBe('en'); await page.close();
  });
  it('stops on unknown, billing and bidding screens without clicking a generic continue', async () => {
    for (const title of ['Try these recommendations', 'Billing', 'Bidding', 'Conversion goals']) {
      const page = await pageFor(`<h1>${title}</h1>${next}`); expect((await step(page)).status).toBe('needs_attention');
      expect(await page.evaluate(() => (window as any).nextClicks)).toBeUndefined(); await page.close();
    }
  });
  it('recognizes selected objective and Search type without inferring conversion settings', async () => {
    for (const [heading, option] of [['Choose your objective', 'Leads'], ['Select a campaign type', 'Search']]) {
      const page = await pageFor(`<h1>${heading}</h1><button role="radio" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">${option}</button>${next}`);
      expect((await step(page)).status).toBe('continue'); await page.close();
    }
  });
  it('does not mistake unchecked CSS classes for a confirmed selection', async () => {
    const page = await pageFor('<h1>Select a campaign type</h1><button role="radio" class="unselected unchecked" aria-checked="false">Search</button>' + next);
    expect((await step(page)).status).toBe('needs_attention'); expect(await page.evaluate(() => (window as any).nextClicks)).toBeUndefined(); await page.close();
  });
  it('confirms a geographic search result and targeted chip, never types a list into search', async () => {
    const page = await pageFor(`<h1>Locations</h1><label>Enter a location to target or exclude<input></label><div id="results"></div><div id="chips"></div>${next}`);
    await page.locator('input').evaluate(node => node.addEventListener('input', () => {
      const result = document.createElement('div'); result.setAttribute('role', 'option'); result.textContent = 'Leeds, United Kingdom';
      result.onclick = () => { document.getElementById('chips')!.innerHTML = '<div class="location-chip">Leeds, United Kingdom</div>'; };
      document.getElementById('results')!.replaceChildren(result);
    }));
    const result = await step(page); expect(result.status).toBe('continue'); expect(await page.locator('input').inputValue()).toBe('Leeds, United Kingdom'); await page.close();
  });
  it('never advances at review, and reports missing verification honestly', async () => {
    const page = await pageFor('<h1>Review your campaign</h1><button onclick="window.published=true">Publish campaign</button>');
    expect((await step(page)).status).toBe('needs_attention');
    expect((await step(page, { done: ['goal', 'type', 'name', 'locations', 'language', 'budget', 'keywords', 'ads'], snapshots: {} })).status).toBe('awaiting_review');
    expect(await page.evaluate(() => (window as any).published)).toBeUndefined(); await page.close();
  });
  it('rejects extra geographic targets and similarly named cities', async () => {
    for (const [chips, locations] of [
      ['<div class="location-chip">Leeds, United Kingdom</div><div class="location-chip">London, United Kingdom</div>', ['Leeds']],
      ['<div class="location-chip">New York, United States</div>', ['York']],
    ] as const) {
      const page = await pageFor(`<h1>Locations</h1>${chips}${next}`);
      expect((await step(page, undefined, { ...campaign, locations: [...locations] })).status).toBe('needs_attention');
      expect(await page.evaluate(() => (window as any).nextClicks)).toBeUndefined(); await page.close();
    }
  });
  it('rejects extra prefilled ad copy before changing requested fields', async () => {
    const page = await pageFor('<h1>Ads</h1><label>Final URL<input></label><label>Headline 4<input value="Unrequested discount"></label>' + next);
    expect((await step(page)).status).toBe('needs_attention'); expect(await page.getByLabel('Final URL').inputValue()).toBe(''); await page.close();
  });
  it('checks the exact execution lease again between individual fields', async () => {
    const page = await pageFor('<h1>Ads</h1><label>Final URL<input></label><label>Headline 1<input></label>' + next);
    await page.evaluate(() => {
      (window as any).checks = [];
      Object.defineProperty(window, 'chrome', { value: { runtime: { id: 'test-extension', sendMessage: async (message: any) => { (window as any).checks.push(message); return { allowed: (window as any).checks.length === 1 }; } } }, configurable: true });
    });
    const result = await page.evaluate(async campaign => (globalThis as any).__mohassanAdsAdapter.step({ campaign, progress: { done: [], snapshots: {} }, jobId: 'job-1', leaseId: 'lease-one-only' }), campaign);
    expect(result.status).toBe('needs_attention');
    expect(await page.getByLabel('Final URL').inputValue()).toBe(campaign.finalUrl); expect(await page.getByLabel('Headline 1').inputValue()).toBe('');
    expect(await page.evaluate(() => (window as any).checks.map((item: any) => item.leaseId))).toEqual(['lease-one-only', 'lease-one-only']);
    expect(await page.evaluate(() => (window as any).checks[1].progress.snapshots.finalUrl)).toBe(campaign.finalUrl); await page.close();
  });
  it('stops if the owner changes a previously read-back field', async () => {
    const page = await pageFor('<h1>Campaign name</h1><label>Campaign name<input value="Changed by owner"></label>' + next);
    const result = await step(page, { done: [], snapshots: { campaignName: campaign.campaignName } }); expect(result.status).toBe('needs_attention');
    expect(await page.locator('input').inputValue()).toBe('Changed by owner'); await page.close();
  });
  it('checks cancellation before page mutations', async () => {
    const page = await pageFor('<h1>Campaign name</h1><label>Campaign name<input></label>' + next);
    await page.evaluate(() => (globalThis as any).__mohassanAdsAdapter.stop());
    expect((await step(page)).status).toBe('stopped'); expect(await page.locator('input').inputValue()).toBe(''); await page.close();
  });
});
