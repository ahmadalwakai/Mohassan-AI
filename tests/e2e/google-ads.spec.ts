import { test, expect, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

const closed = { available: false, gates: [{ id: 'server_switch', passed: false, detail: 'GOOGLE_ADS_PUBLISHING_ENABLED ليس true' }] };
const status = (state: string, extra: object = {}) => ({ state, message: 'رسالة الحالة', missingSettings: [], retryAfterSeconds: null, account: null, connectedAt: null, lastCheckedAt: null, publishing: closed, ...extra });
const account = { customerId: '1234567890', name: 'MA Removals', currency: 'GBP', timeZone: 'Europe/London', testAccount: false, loginCustomerId: null };

/** The real API answers the not-configured state; other states are served to the page, since this server has no Google. */
async function serve(page: Page, routes: Record<string, unknown>) {
  await page.route('**/api/google-ads/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/google-ads/', '');
    const body = routes[path];
    if (body === undefined) return route.fulfill({ status: 500, json: { error: { code: 'X', message: `no fixture for ${path}` } } });
    return route.fulfill({ json: body });
  });
}
const open = async (page: Page) => {
  await signInAsFixtureOwner(page);
  await page.getByRole('button', { name: 'Google Ads', exact: true }).click();
  return page.getByRole('region', { name: 'Google Ads', exact: true });
};

test('shows the real not-configured state from the API, with setting names only', async ({ page }) => {
  const section = await open(page);
  await expect(section.getByRole('heading', { name: 'يحتاج الخادم إعداد Google Cloud' })).toBeVisible();
  await expect(section.getByText('GOOGLE_ADS_CLIENT_ID')).toBeVisible();
});

test('shows disconnected, unauthorized and account choice states', async ({ page }) => {
  await serve(page, { status: status('disconnected') });
  const section = await open(page);
  await expect(section.getByRole('button', { name: 'الربط مع Google' })).toBeVisible();
  await page.unroute('**/api/google-ads/**');
  await serve(page, { status: status('unauthorized') });
  await page.getByRole('button', { name: 'نظرة عامة', exact: true }).click();
  await page.getByRole('button', { name: 'Google Ads', exact: true }).click();
  await expect(section.getByRole('button', { name: 'إعادة الربط' })).toBeVisible();
  await page.unroute('**/api/google-ads/**');
  await serve(page, { status: status('needs_account'), accounts: { items: [{ ...account, manager: false, status: 'ENABLED' }, { ...account, customerId: '9999999999', name: 'Manager', manager: true, status: 'ENABLED' }] } });
  await page.getByRole('button', { name: 'نظرة عامة', exact: true }).click();
  await page.getByRole('button', { name: 'Google Ads', exact: true }).click();
  await expect(section.getByRole('button', { name: /MA Removals/ })).toBeEnabled();
  await expect(section.getByRole('button', { name: /Manager/ })).toBeDisabled();
});

test('connected: separates measured figures, keeps publishing visibly closed, and needs explicit approval', async ({ page }) => {
  const report = { customerId: account.customerId, currency: 'GBP', timeZone: 'Europe/London', range: { start: '2026-10-07', end: '2026-11-05', days: 30 }, fetchedAt: '2026-11-06T10:00:00.000Z', basis: 'observed', empty: false, totals: { impressions: 4200, clicks: 310, costMicros: '412500000', conversions: 18, conversionsValue: 0 }, campaigns: [{ id: '100', name: 'Existing Search', status: 'ENABLED', channel: 'SEARCH', bidding: 'MAXIMIZE_CONVERSIONS', dailyBudgetMicros: '30000000', impressions: 4200, clicks: 310, costMicros: '412500000', conversions: 18, conversionsValue: 0, searchImpressionShare: 0.42, budgetLostImpressionShare: 0.31, rankLostImpressionShare: 0.12 }], conversionActions: [], bookings: { mapped: false, services: [], unmappedActions: [] }, mismatches: [{ kind: 'ad_language_vs_location', campaignId: '100', campaignName: 'Existing Search', basis: 'assumption', message: 'لغة الإعلانات ليست شائعة هنا.' }], notes: [] };
  const brief = { businessName: 'MA Removals', service: 'House removals', goal: 'bookings', landingPageUrl: 'https://maremovals.example.com/', locations: ['Glasgow'], countryCode: 'GB', adLanguage: 'en', dailyBudget: '20', ownerFacts: [], headlines: ['Glasgow Removals', 'Local Movers', 'Book Online'], descriptions: ['Careful house removals.', 'Book your move.'], paths: [], keywords: ['"house removals"'], negativeKeywords: [] };
  const summary = { customerId: account.customerId, campaignName: 'House removals | Glasgow [m-abc]', initialStatus: 'PAUSED', dailyBudgetMicros: '20000000', bidding: 'MANUAL_CPC', locations: ['Glasgow'], keywords: brief.keywords, negativeKeywords: [], headlines: brief.headlines, descriptions: brief.descriptions, finalUrl: brief.landingPageUrl, operationCount: 7, maxDailySpendMicros: '40000000', maxMonthlySpendMicros: '608000000' };
  const draft = { id: '11111111-2222-4333-8444-555555555555', customerId: account.customerId, state: 'verified', revision: 5, brief, draftHash: 'a'.repeat(64), bidding: 'MANUAL_CPC', summary, strategy: { recommendations: [{ title: 'لا توقع للنقرات أو التكلفة', reason: 'لا توجد تقديرات.', basis: 'observed', source: 'Keyword Planner' }], blockers: [] }, validation: { passed: true, checkedAt: '2026-11-06T10:00:00.000Z', draftHash: 'a'.repeat(64), issues: [], landing: null, geoTargets: [] }, verification: { passed: true, checkedAt: '2026-11-06T10:00:00.000Z', draftHash: 'a'.repeat(64), checks: [{ id: 'conversion_tracking', passed: true, detail: '1 of 1' }] }, campaignResourceName: null, error: null, createdAt: '2026-11-06T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z' };
  await serve(page, { status: status('connected', { account }), recommendations: { report, items: [] }, drafts: { items: [draft] } });
  const section = await open(page);
  await expect(section.getByRole('heading', { name: 'النشر مغلق' })).toBeVisible();
  await expect(section.getByText('مرصود').first()).toBeVisible();
  await expect(section.getByText('افتراض', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/google-ads-section.png', fullPage: true });
  await section.getByRole('tab', { name: 'الحملات' }).click();
  await section.getByRole('button', { name: /House removals/ }).click();
  await expect(section.getByText('متوقفة، لا إنفاق')).toBeVisible();
  const approve = section.getByRole('button', { name: 'أوافق على النشر' });
  await expect(approve).toBeDisabled();
  await section.getByRole('checkbox').check();
  await expect(approve).toBeEnabled();
  await page.screenshot({ path: 'artifacts/google-ads-approval.png', fullPage: true });
});

test('rate limit shows a wait and stays usable at phone width', async ({ page }) => {
  await serve(page, { status: status('rate_limited', { account, retryAfterSeconds: 30 }) });
  await signInAsFixtureOwner(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole('button', { name: 'فتح القائمة' }).click();
  await page.getByRole('button', { name: 'Google Ads', exact: true }).click();
  const section = page.getByRole('region', { name: 'Google Ads', exact: true });
  await expect(section.getByText(/أعد المحاولة بعد/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/google-ads-phone.png', fullPage: true });
});
