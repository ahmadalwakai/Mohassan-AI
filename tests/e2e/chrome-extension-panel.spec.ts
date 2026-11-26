import { expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

const now = '2026-11-15T10:00:00.000Z';
const clientId = '11111111-2222-4333-8444-111111111111';
const jobId = '11111111-2222-4333-8444-222222222222';
const campaign = {
  campaignName: 'Mobile tyres Leeds', type: 'search', goal: 'calls', customerId: '1234567890', currency: 'GBP', dailyBudget: '20',
  locations: ['Leeds'], countryCode: 'GB', adLanguage: 'en', keywords: ['mobile tyres'], negativeKeywords: [],
  headlines: ['Mobile Tyres Leeds', 'Local Tyre Fitting', 'Tyres At Your Door'], descriptions: ['Mobile tyre fitting in Leeds.', 'Local tyre fitting at your door.'], finalUrl: 'https://example.org/', paths: [],
};

/** The Chrome tool is intentionally absent from unrelated/empty chat. */
async function openAdsFixtureConversation(page: Page) {
  const id = '11111111-2222-4333-8444-333333333333';
  const title = 'مسودة حملة Chrome التجريبية';
  const summary = { id, title, status: 'idle', updatedAt: now, browserAccount: null };
  const conversation = { ...summary, messages: [{ id: '11111111-2222-4333-8444-444444444444', role: 'user', text: 'جهز مسودة حملة بحث في حساب Google Ads.', createdAt: now }],
    question: null, approval: null, secure: null, browser: null, progress: null, steps: [], error: null, configured: true };
  await page.route('**/api/chat/conversations**', route => {
    expect(route.request().method()).toBe('GET');
    return new URL(route.request().url()).pathname.endsWith(id)
      ? route.fulfill({ json: conversation }) : route.fulfill({ json: { conversations: [summary] } });
  });
  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('region', { name: 'إضافة Chrome', exact: true })).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1280) < 600) await page.getByRole('button', { name: 'فتح القائمة', exact: true }).click();
  await page.getByRole('navigation', { name: 'المحادثات' }).getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('region', { name: 'إضافة Chrome', exact: true })).toBeVisible();
}

test('Chrome connection offers only the official API and cannot resume a historical campaign task', async ({ page }, testInfo) => {
  let status: Record<string, unknown> = { connected: false, binding: null, lastSeenAt: null, latestJob: null, preferredTransport: 'chrome' };
  const mutations: Array<{ path: string; body: unknown }> = [];
  await page.route('**/api/chrome-extension/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      mutations.push({ path, body });
      if (path.endsWith('/preference')) status = { ...status, preferredTransport: body.transport };
      if (path.endsWith('/cancel')) status = { ...status, latestJob: { ...(status.latestJob as object), status: 'needs_attention', message: 'طُلب إيقاف المهمة السابقة.' } };
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: status });
  });
  await openAdsFixtureConversation(page);
  const panel = page.getByRole('region', { name: 'إضافة Chrome', exact: true });
  await panel.getByRole('button', { name: /Chrome بانتظار الربط/ }).click();
  await expect(panel.getByRole('button', { name: 'إضافة Chrome', exact: true })).toHaveCount(0);
  await expect(panel.getByText(/تعبئة حملات Google Ads واستئنافها عبر الإضافة غير مدعومين/)).toBeVisible();
  await panel.getByRole('button', { name: 'استخدام الربط الرسمي', exact: true }).click();
  expect(mutations[0]).toEqual({ path: '/api/chrome-extension/preference', body: { transport: 'api' } });

  status = { ...status, connected: true, binding: { clientId, tabId: 12, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0' }, lastSeenAt: now,
    latestJob: { id: jobId, clientId, tabId: 12, customerId: '1234567890', currency: 'GBP', leaseId: clientId, status: 'running', campaign, message: 'رسالة محفوظة من الإصدار السابق.', steps: [{ stage: 'budget', message: 'سجل سابق لقراءة حقل.', fields: ['dailyBudget'] }], createdAt: now, updatedAt: now } };
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  await expect(panel.getByText('123-456-7890', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('سجل سابق: تنفيذ غير محسوم');
  await expect(panel.getByRole('button', { name: 'استخدام الربط الرسمي', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'إيقاف المهمة السابقة' }).click();
  await expect(panel.getByRole('status')).toHaveText('سجل سابق: يحتاج مراجعتك');
  await expect(panel.getByText('راجع أثر المهمة السابقة في حساب Google Ads قبل طلب جديد. استئناف التعبئة عبر الإضافة غير متاح.')).toBeVisible();
  expect(mutations.at(-1)).toEqual({ path: `/api/chrome-extension/jobs/${jobId}/cancel`, body: {} });
  await expect(panel.getByRole('button', { name: /أكمل التعبئة|استأنف/ })).toHaveCount(0);
  const count = mutations.length;
  await panel.getByRole('button', { name: 'تحديث الحالة' }).click();
  expect(mutations).toHaveLength(count);
  expect(mutations.some(item => item.path.endsWith('/resume') || item.path.endsWith('/claim'))).toBe(false);
  expect(mutations.some(item => (item.body as { transport?: string }).transport === 'chrome')).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('chrome-panel-history-only.png'), fullPage: true });
});
test('Chrome instructions remain usable in a narrow window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.route('**/api/chrome-extension/status', route => route.fulfill({ json: { connected: false, binding: null, lastSeenAt: null, latestJob: null, preferredTransport: 'chrome' } }));
  await openAdsFixtureConversation(page);
  const panel = page.getByRole('region', { name: 'إضافة Chrome', exact: true });
  await panel.getByRole('button', { name: /Chrome بانتظار الربط/ }).click();
  await panel.getByText('chrome://extensions', { exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByText('chrome://extensions', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'رسالتك' })).toBeInViewport();
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({ path: testInfo.outputPath('chrome-panel-narrow.png'), fullPage: true });
});
